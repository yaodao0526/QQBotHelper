/**
 * 识图链路测试（node test/vision.mjs）：
 *   1. 假 OneBot 发一条带图片的私聊消息，get_image 返回本地图片地址
 *   2. 假「识图模型」与假「主模型」各起一个服务，记录收到的请求体
 *   3. 断言：图片被识别成中文描述、入库内容变成「[图片：…]」、主模型提示词里带这句描述
 *   4. 关掉识图后同样发图 → 内容保持「[图片]」，且不会去调识图模型
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PANEL = Number(process.env.VIS_PANEL || 7860);
const ONEBOT = Number(process.env.VIS_ONEBOT || 7861);
const MOCK = Number(process.env.VIS_MOCK || 7862);
const IMG = Number(process.env.VIS_IMG || 7864);
const SELF_ID = 10001;
const USER_ID = 20002;
const CAPTION = '一只橘猫趴在键盘上，配字「今天也要上班」';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
  'base64'
);

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
let visionServer;
let imgServer;
const dataDir = process.env.VIS_DATA_DIR
  ? path.resolve(process.env.VIS_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-vis-'));

const mainPrompts = [];
let visionCalls = 0;

function imageEvent() {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: SELF_ID,
    user_id: USER_ID,
    raw_message: '[CQ:image,file=cat.png] 你看这个',
    message: [
      { type: 'image', data: { file: 'cat.png', url: '' } },
      { type: 'text', data: { text: ' 你看这个' } },
    ],
    sender: { user_id: USER_ID, nickname: '识图测试员' },
  };
}

async function main() {
  imgServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
    res.end(PNG);
  });
  await new Promise((r) => imgServer.listen(IMG, '127.0.0.1', r));

  // 主对话模型（文本）：记录提示词
  llmServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const body = JSON.parse(raw || '{}');
      mainPrompts.push(JSON.stringify(body.messages || []));
    } catch {
      mainPrompts.push('');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: '这猫好胖' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    );
  });
  await new Promise((r) => llmServer.listen(MOCK, '127.0.0.1', r));

  // 识图模型（多模态）：断言收到 image_url 段
  visionServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    visionCalls++;
    const ok = raw.includes('data:image/');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'v',
        model: 'mock-vl',
        choices: [{ index: 0, message: { role: 'assistant', content: CAPTION }, finish_reason: 'stop' }],
      })
    );
  });
  await new Promise((r) => visionServer.listen(MOCK + 1, '127.0.0.1', r));

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
      api_key: 'sk-vision-test',
      cooldown_ms: 0,
      split_reply: false,
      segment_delay_min: 0,
      segment_delay_max: 0,
      sticker_enabled: false,
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
    if (d.action === 'get_login_info') return reply({ user_id: SELF_ID, nickname: '识图机器人' });
    if (d.action === 'get_image') return reply({ file: `http://127.0.0.1:${IMG}/cat.png` });
    if (d.action === 'send_private_msg') return reply({ message_id: 1 });
    return reply({});
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitFor(async () => (await api('/api/status')).data.onebot.connected === true, { label: 'OneBot 连接' });

  // ——— 未配识图：保持占位符 ———
  let status = await api('/api/status');
  check('未配识图时 ready=false', status.data.vision?.ready === false, JSON.stringify(status.data.vision));
  ws.send(JSON.stringify(imageEvent()));
  await waitFor(() => mainPrompts.length > 0, { label: '第一次回复' });
  let convs = await api('/api/conversations');
  let convId = convs.data.conversations[0].id;
  let msgs = await api(`/api/conversations/${convId}/messages?limit=20`);
  check('没开识图时内容仍是「[图片]」', msgs.data.messages.some((m) => m.content.includes('[图片]') && !m.content.includes('图片：')));
  check('没开识图时不去调识图模型', visionCalls === 0);

  // ——— 配置识图 ———
  const put = await api('/api/settings', {
    method: 'PUT',
    body: {
      vision_enabled: true,
      vision_model: 'mock-vl',
      vision_api_base: `http://127.0.0.1:${MOCK + 1}/v1`,
      vision_api_key: 'sk-vision',
    },
  });
  check('保存识图配置成功', put.data?.settings?.vision_model === 'mock-vl');
  status = await api('/api/status');
  check('识图状态 ready=true', status.data.vision?.ready === true, JSON.stringify(status.data.vision));
  check('识图状态不回显 Key', !JSON.stringify(status.data.vision).includes('sk-vision'));

  mainPrompts.length = 0;
  ws.send(JSON.stringify(imageEvent()));
  await waitFor(() => mainPrompts.length > 0, { label: '识图后的回复' });

  check('识图模型被调用', visionCalls >= 1, String(visionCalls));
  msgs = await api(`/api/conversations/${convId}/messages?limit=20`);
  const enriched = msgs.data.messages.find((m) => m.role === 'user' && m.content.includes('图片：'));
  check('入库内容含图片描述', Boolean(enriched) && enriched.content.includes(CAPTION.slice(0, 10)), enriched?.content);
  check('主模型提示词里带这句描述', mainPrompts.some((p) => p.includes('橘猫')));

  // 只看「用户消息」那一条：知识层里本身会讲解 [图片] 占位符，不能拿整段提示词判断
  const lastPrompt = mainPrompts[mainPrompts.length - 1];
  let userMsg = '';
  try {
    const arr = JSON.parse(lastPrompt);
    const users = arr.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
    userMsg = users[users.length - 1] || '';
  } catch {
    /* ignore */
  }
  check('用户消息里的 [图片] 已被描述替换', userMsg.includes('图片：') && !/\[图片\]/.test(userMsg), userMsg.slice(0, 120));

  // ——— 关掉识图 ———
  await api('/api/settings', { method: 'PUT', body: { vision_enabled: false } });
  const callsBefore = visionCalls;
  mainPrompts.length = 0;
  ws.send(JSON.stringify(imageEvent()));
  await waitFor(() => mainPrompts.length > 0, { label: '关闭识图后的回复' });
  check('关掉识图后不再调用识图模型', visionCalls === callsBefore);

  console.log('');
  if (failures.length) {
    console.log(`识图链路测试失败 ${failures.length} 项：${failures.join('、')}`);
    process.exitCode = 1;
  } else {
    console.log('识图链路测试全部通过 ✅');
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
  for (const s of [llmServer, visionServer, imgServer]) {
    try {
      s?.close();
    } catch {
      /* ignore */
    }
  }
  await sleep(300);
  if (!process.env.VIS_DATA_DIR) {
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
