/**
 * 追问测试（node test/followup.mjs）：
 *   1. 先让机器人回一条私聊消息（这样最后一条是 assistant）
 *   2. 把这个会话设为主对话，把「等多久没回就追问」调到 1 秒级
 *   3. POST /api/proactive/now（等同于面板「现在试一条」）→ 应该走追问，而不是找新话题
 *   4. 连续追问到达上限后，不再追问
 *   5. 关掉追问开关后又恢复正常主动消息
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PANEL = Number(process.env.FU_PANEL || 7870);
const ONEBOT = Number(process.env.FU_ONEBOT || 7871);
const MOCK = Number(process.env.FU_MOCK || 7872);
const SELF_ID = 10001;
const USER_ID = 20002;

const failures = [];
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 80, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}

function api(pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PANEL, path: pathname, method, headers: body ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            /* text */
          }
          resolve({ status: res.statusCode, data, text });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let child;
let ws;
let llmServer;
const dataDir = process.env.FU_DATA_DIR
  ? path.resolve(process.env.FU_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-fu-'));
const prompts = [];
const sent = [];

function privateEvent(text) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: SELF_ID,
    user_id: USER_ID,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: USER_ID, nickname: '追问测试员' },
  };
}

async function main() {
  llmServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let content = '好呀，我在的';
    try {
      const body = JSON.parse(raw || '{}');
      const sys = String(body.messages?.[0]?.content || '');
      prompts.push(sys);
      if (sys.includes('对方好一会儿没回你')) content = '怎么不理我';
      else if (sys.includes('刚才那个话题已经聊完了')) content = '在干嘛呢';
      else if (sys.includes('现在轮到你主动开口')) content = '在干嘛呢';
    } catch {
      /* ignore */
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    );
  });
  await new Promise((r) => llmServer.listen(MOCK, '127.0.0.1', r));

  child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, BOT_DATA_DIR: dataDir, BOT_PORT: String(PANEL), BOT_ONEBOT_PORT: String(ONEBOT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logBuf = [];
  child.stdout.on('data', (b) => logBuf.push(String(b)));
  child.stderr.on('data', (b) => logBuf.push(String(b)));

  await waitFor(async () => (await api('/health')).status === 200, { label: '面板启动' }).catch((err) => {
    throw new Error(`${err.message}\n${logBuf.join('')}`);
  });

  await api('/api/settings', {
    method: 'PUT',
    body: {
      api_base: `http://127.0.0.1:${MOCK}/v1`,
      api_key: 'sk-followup-test',
      cooldown_ms: 0,
      split_reply: false,
      segment_delay_min: 0,
      segment_delay_max: 0,
      sticker_enabled: false,
      followup_enabled: true,
      followup_minutes: 0.02, // ≈1.2 秒
      followup_max: 2,
      proactive_enabled: true,
      proactive_quiet_start: '23:59',
      proactive_quiet_end: '23:59',
    },
  });

  ws = new WebSocket(`ws://127.0.0.1:${ONEBOT}/onebot`, {
    headers: { 'X-Self-ID': String(SELF_ID), 'X-Client-Role': 'Universal' },
  });
  ws.on('message', (raw) => {
    let d;
    try {
      d = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (d.echo == null) return;
    const reply = (data) => ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: d.echo }));
    if (d.action === 'get_login_info') return reply({ user_id: SELF_ID, nickname: '追问机器人' });
    if (d.action === 'send_private_msg') {
      sent.push(d.params.message.map((s) => s.data?.text || s.type).join(''));
      return reply({ message_id: Math.floor(Math.random() * 1000) });
    }
    return reply({});
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitFor(async () => (await api('/api/status')).data.onebot.connected === true, { label: 'OneBot 连接' });

  // 先聊一句，让最后一条消息是 assistant
  ws.send(JSON.stringify(privateEvent('在吗')));
  await waitFor(async () => {
    const convs = await api('/api/conversations');
    return convs.data.conversations[0] ? convs.data.conversations[0] : null;
  }, { label: '会话已创建' });
  const convs = await api('/api/conversations');
  const convId = convs.data.conversations[0].id;
  await waitFor(async () => (await api(`/api/conversations/${convId}/messages?limit=10`)).data.messages.some((m) => m.role === 'assistant'), { label: '机器人已回复' });

  const main = await api(`/api/conversations/${convId}/main`, { method: 'POST' });
  check('设为主对话成功', main.data?.ok === true || main.status === 200);

  // ——— 第一次追问 ———
  await sleep(1600);
  const first = await api('/api/proactive/now', { method: 'POST' });
  check('第一次触发走「追问」', first.data?.followup === true, JSON.stringify(first.data));
  check('追问内容像人话', String(first.data?.text || '').includes('怎么不理我'), JSON.stringify(first.data));
  check('追问提示词含「对方好一会儿没回你」', prompts.some((p) => p.includes('对方好一会儿没回你')));

  let msgs = await api(`/api/conversations/${convId}/messages?limit=10`);
  const followups = msgs.data.messages.filter((m) => m.content === '怎么不理我');
  check('追问已落库', followups.length === 1, String(followups.length));
  check('追问被标记为 sender=主动', followups[0]?.sender === '主动', String(followups[0]?.sender));

  // ——— 第二次追问（上限 2）———
  await sleep(1600);
  const second = await api('/api/proactive/now', { method: 'POST' });
  check('第二次仍可追问（上限 2）', second.data?.followup === true, JSON.stringify(second.data));

  // ——— 第三次：超过上限，不再追问 ———
  await sleep(1600);
  const third = await api('/api/proactive/now', { method: 'POST' });
  check('超过上限后不再追问', third.data?.followup !== true, JSON.stringify(third.data));
  check('超过上限后改发新话题', String(third.data?.text || '') === '在干嘛呢', JSON.stringify(third.data));

  msgs = await api(`/api/conversations/${convId}/messages?limit=20`);
  check('追问总条数不超过上限', msgs.data.messages.filter((m) => m.content === '怎么不理我').length === 2);

  // ——— 话题已经聊完（对方只回了「嗯」）→ 应该起新话题，而不是再催 ———
  ws.send(JSON.stringify(privateEvent('嗯')));
  await waitFor(async () => {
    const m = await api(`/api/conversations/${convId}/messages?limit=6`);
    return m.data.messages.filter((x) => x.role === 'assistant').length >= 3;
  }, { label: '对方回「嗯」后机器人已回' });
  await sleep(1600);
  const closed = await api('/api/proactive/now', { method: 'POST' });
  check('话题收尾后不发追问', closed.data?.followup !== true, JSON.stringify(closed.data));
  check('话题收尾后起新话题', String(closed.data?.text || '') === '在干嘛呢', JSON.stringify(closed.data));
  check('新话题提示词含「刚才那个话题已经聊完了」', prompts.some((p) => p.includes('刚才那个话题已经聊完了')));

  // ——— 关掉追问 ———
  await api('/api/settings', { method: 'PUT', body: { followup_enabled: false } });
  await sleep(1600);
  const off = await api('/api/proactive/now', { method: 'POST' });
  check('关掉开关后不再追问', off.data?.followup !== true, JSON.stringify(off.data));

  // ——— 安静时段：非强制 tick 不会打扰 ———
  await api('/api/settings', {
    method: 'PUT',
    body: { followup_enabled: true, proactive_quiet_start: '00:00', proactive_quiet_end: '23:59' },
  });
  await api('/api/proactive/reschedule', { method: 'POST' }).catch(() => null);
  check('设置里能保存安静时段', (await api('/api/settings')).data.settings.proactive_quiet_end === '23:59');

  console.log('');
  if (failures.length) {
    console.log(`追问测试失败 ${failures.length} 项：${failures.join('、')}`);
    process.exitCode = 1;
  } else {
    console.log('追问测试全部通过 ✅');
  }
}

async function cleanup() {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
  try {
    llmServer?.close();
  } catch {
    /* ignore */
  }
  await sleep(300);
  if (!process.env.FU_DATA_DIR) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main()
  .catch((err) => {
    console.log(`\n测试异常：${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
