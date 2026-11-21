/**
 * 主对话 / 主动消息的端到端测试（零依赖）：
 *   假模型服务记录每次请求体 → 起 bot → 模拟 OneBot 私聊 → 设为主对话 →
 *   断言：主对话全量历史、主动消息真的发出并落库、可解除。
 * 运行：node test/main-chat.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PANEL = Number(process.env.MAIN_PANEL || 7830);
const ONEBOT = Number(process.env.MAIN_ONEBOT || 7831);
const MOCK = Number(process.env.MAIN_MOCK || 7832);
const SELF_ID = 10001;
const USER_ID = 20002;
const REPLY = '收到，我在。';
const PROACTIVE_REPLY = '刚看到楼下便利店换了招牌，突然想起你之前提过想喝那个新出的酸奶。';
const HISTORY_TURNS = 4; // 故意设小，用来证明主对话不受它限制

const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 80, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-main-'));
let child;
let ws;
let llmServer;
const prompts = []; // 每次模型请求的 body

async function main() {
  llmServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    prompts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-main',
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 6 },
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

  await waitFor(async () => (await api('/health')).status === 200, { label: '面板启动' });
  console.log('面板已就绪');

  await api('/api/settings', {
    method: 'PUT',
    body: {
      api_base: `http://127.0.0.1:${MOCK}/v1`,
      api_key: 'sk-main-test',
      cooldown_ms: 0,
      split_reply: false,
      segment_delay_min: 0,
      segment_delay_max: 0,
      history_turns: HISTORY_TURNS,
      proactive_enabled: true,
      proactive_quiet_start: '00:00',
      proactive_quiet_end: '00:00',
      proactive_idle_minutes: 1,
      proactive_daily_cap: 10,
    },
  });

  ws = new WebSocket(`ws://127.0.0.1:${ONEBOT}/onebot`, {
    headers: { 'X-Self-ID': String(SELF_ID), 'X-Client-Role': 'Universal' },
  });
  const inbound = [];
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.action === 'get_login_info') {
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF_ID, nickname: '主对话测试' }, echo: msg.echo }));
    } else {
      inbound.push(msg);
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: inbound.length }, echo: msg.echo }));
    }
  });
  await waitFor(() => ws.readyState === WebSocket.OPEN, { label: 'OneBot 连接' });
  await sleep(300);

  const send = (text, i) =>
    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        self_id: SELF_ID,
        user_id: USER_ID,
        message: [{ type: 'text', data: { text } }],
        sender: { user_id: USER_ID, nickname: '主对话测试员' },
        time: Math.floor(Date.now() / 1000),
        message_id: 1000 + i,
      })
    );

  // ——— 攒一段历史：6 轮对话 ———
  for (let i = 1; i <= 6; i++) {
    send(`第 ${i} 句话：最近在忙什么`, i);
    await waitFor(() => inbound.length >= i, { label: `第 ${i} 轮回复` });
    await sleep(120);
  }
  check('私聊共收到 6 条回复', inbound.length === 6, String(inbound.length));

  const convs = await api('/api/conversations');
  const conv = convs.data.conversations[0];
  check('会话已创建', Boolean(conv?.id), JSON.stringify(convs.data));
  check('初始不是主对话', conv.is_main === false);

  const msgsBefore = await api(`/api/conversations/${conv.id}/messages?limit=100`);
  const beforeCount = msgsBefore.data.messages.length;
  check('消息已落库（>=12 条）', beforeCount >= 12, String(beforeCount));

  // ——— 设为主对话 ———
  const setMain = await api(`/api/conversations/${conv.id}/main`, { method: 'POST' });
  check('设为主对话成功', setMain.status === 200 && setMain.data.ok === true, JSON.stringify(setMain.data));
  const afterList = await api('/api/conversations');
  check('列表标记 is_main', afterList.data.conversations[0].is_main === true);
  const settings = await api('/api/settings');
  check('settings.main_conversation_id 已写入', Number(settings.data.settings.main_conversation_id) === conv.id);

  // ——— 普通回复也走主对话历史：应超过 history_turns 条 ———
  inbound.length = 0;
  prompts.length = 0;
  send('主对话里再说一句', 99);
  await waitFor(() => inbound.length >= 1, { label: '主对话回复' });
  const normalPrompt = prompts[0];
  const normalHistory = normalPrompt.messages.filter((m) => m.role !== 'system');
  check('普通回复系统提示含主对话说明', String(normalPrompt.messages[0].content).includes('【这是你们的主对话】'));
  check(
    `主对话历史不受 history_turns(${HISTORY_TURNS}) 限制`,
    normalHistory.length > HISTORY_TURNS * 2,
    `实际 ${normalHistory.length} 条`
  );

  // ——— 主动消息 ———
  inbound.length = 0;
  prompts.length = 0;
  const proactive = await api('/api/proactive/now', { method: 'POST' });
  check('主动消息接口 ok', proactive.status === 200 && proactive.data.ok === true, JSON.stringify(proactive.data).slice(0, 200));
  check('真的发到了 QQ', inbound.length >= 1, String(inbound.length));
  const proactivePrompt = prompts[0];
  check('主动提示词含「轮到你主动开口」', String(proactivePrompt.messages[0].content).includes('【现在轮到你主动开口】'));

  const afterMsgs = await api(`/api/conversations/${conv.id}/messages?limit=100`);
  const last = afterMsgs.data.messages[afterMsgs.data.messages.length - 1];
  check('主动消息落库并标记 sender=主动', last?.role === 'assistant' && last?.sender === '主动', JSON.stringify(last));

  // ——— 解除主对话 ———
  const unset = await api(`/api/conversations/${conv.id}/main`, { method: 'DELETE' });
  check('解除主对话成功', unset.status === 200 && unset.data.ok === true);
  const finalSettings = await api('/api/settings');
  check('main_conversation_id 归零', Number(finalSettings.data.settings.main_conversation_id) === 0);
}

try {
  await main();
} catch (err) {
  failures.push(err.message);
  console.log(`✗ 异常：${err.stack || err.message}`);
} finally {
  try {
    ws?.close();
  } catch {}
  try {
    child?.kill('SIGTERM');
  } catch {}
  await sleep(400);
  try {
    child?.kill('SIGKILL');
  } catch {}
  try {
    llmServer?.close();
  } catch {}
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}

console.log('');
if (failures.length) {
  console.log(`主对话测试失败 ${failures.length} 项 ❌`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log('主对话测试全部通过 ✅');
}
