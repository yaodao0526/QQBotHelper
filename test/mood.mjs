/**
 * 情绪条测试（node test/mood.mjs）：
 *   1. 冷淡的短回复会让心情下降，「夸她」会让心情回升
 *   2. 情绪强度拉高后，同一条回复会被拆成多条气泡（活人感）
 *   3. 系统提示里注入【你现在的心情】，但发给 QQ 的文字里不出现情绪数值
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PANEL = Number(process.env.MD_PANEL || 7910);
const ONEBOT = Number(process.env.MD_ONEBOT || 7911);
const MOCK = Number(process.env.MD_MOCK || 7912);
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
const dataDir = process.env.MD_DATA_DIR ? path.resolve(process.env.MD_DATA_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-md-'));
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
    sender: { user_id: USER_ID, nickname: '情绪测试员' },
  };
}

async function main() {
  llmServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let content = '第一句接住你的话' + String.fromCharCode(10) + '第二句说我的想法' + String.fromCharCode(10) + '第三句再补一句';
    try {
      const body = JSON.parse(raw || '{}');
      prompts.push(String(body.messages?.[0]?.content || ''));
    } catch {
      /* ignore */
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
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
      api_key: 'sk-mood-test',
      cooldown_ms: 0,
      split_reply: true,
      reply_max_parts: 1,
      segment_delay_min: 0,
      segment_delay_max: 0,
      sticker_enabled: false,
      proactive_enabled: false,
      continue_enabled: false,
      mood_enabled: true,
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
    if (d.action === 'get_login_info') return reply({ user_id: SELF_ID, nickname: '情绪机器人' });
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

  // 建会话
  ws.send(JSON.stringify(privateEvent('在吗')));
  const conv = await waitFor(async () => {
    const r = await api('/api/conversations');
    return r.data.conversations[0] || null;
  }, { label: '会话已创建' });
  const convId = conv.id;
  await waitFor(async () => (await api(`/api/conversations/${convId}/messages?limit=6`)).data.messages.some((m) => m.role === 'assistant'), {
    label: '首条回复',
  });

  const base = await api(`/api/mood/${convId}`);
  check('情绪接口可用', base.status === 200 && typeof base.data.mood.valence === 'number', JSON.stringify(base.data));
  const v0 = base.data.mood.valence;
  check('默认只发一条（情绪平稳）', sent.filter((t) => t.includes('第一句')).length === 1, JSON.stringify(sent));

  // 冷淡 ×3 → 心情下降
  for (let i = 0; i < 3; i++) {
    sent.length = 0;
    ws.send(JSON.stringify(privateEvent('嗯')));
    await waitFor(async () => sent.length > 0, { label: `冷淡第 ${i + 1} 轮回复` });
    await sleep(120);
  }
  const cold = await api(`/api/mood/${convId}`);
  check('被敷衍后心情下降', cold.data.mood.valence < v0, `${v0} → ${cold.data.mood.valence}`);

  // 夸她 → 心情回升
  const before = cold.data.mood.valence;
  sent.length = 0;
  ws.send(JSON.stringify(privateEvent('姐姐真可爱，最喜欢你了')));
  await waitFor(async () => sent.length > 0, { label: '夸奖后的回复' });
  await sleep(150);
  const warm = await api(`/api/mood/${convId}`);
  check('被夸后心情回升', warm.data.mood.valence > before, `${before} → ${warm.data.mood.valence}`);
  check('系统提示里注入了心情段', prompts.some((p) => p.includes('【你现在的心情】')));
  check('发给 QQ 的文字不含情绪数值', sent.every((t) => !/\d+\/100/.test(t)), JSON.stringify(sent));

  // ——— 一段话分几条发（reply_max_parts=3）———
  await api('/api/settings', { method: 'PUT', body: { reply_max_parts: 3, segment_delay_min: 0, segment_delay_max: 0 } });
  await api(`/api/mood/${convId}`, { method: 'PATCH', body: { arousal: 40, valence: 60 } });
  sent.length = 0;
  ws.send(JSON.stringify(privateEvent('你说吧')));
  await waitFor(async () => sent.length >= 3, { timeout: 8000, label: '分三条发送' }).catch(() => null);
  check('一次回复拆成三条气泡', sent.length === 3, JSON.stringify(sent));
  check('第一条先接上文', String(sent[0] || '').includes('第一句'));

  // 拉高情绪强度 → 连发多条
  await api(`/api/mood/${convId}`, { method: 'PATCH', body: { arousal: 92, valence: 80 } });
  sent.length = 0;
  ws.send(JSON.stringify(privateEvent('你说吧')));
  await waitFor(async () => sent.length >= 2, { timeout: 8000, label: '情绪上头连发' }).catch(() => null);
  check('情绪上头时拆成多条气泡', sent.length >= 2, JSON.stringify(sent));

  console.log('');
  if (failures.length) {
    console.log(`情绪条测试失败 ${failures.length} 项：${failures.join('、')}`);
    process.exitCode = 1;
  } else {
    console.log('情绪条测试全部通过 ✅');
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
  if (!process.env.MD_DATA_DIR) {
    setTimeout(() => {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }, 300);
  }
}

main()
  .catch((err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await sleep(150);
    await cleanup();
  });
