/**
 * 表情包链路测试（零依赖，node test/stickers.mjs）：
 *   1. 本地起一个图片服务（模拟 QQ 表情 CDN）与假模型服务
 *   2. 用临时数据目录启动 bot（面板 7850 / OneBot 反向 WS 7851）
 *   3. 模拟 NapCat 反向连接：fetch_custom_face 返回两个图片 URL
 *   4. 调 POST /api/stickers 同步 → 文件落盘、入库、能经面板接口读取
 *   5. 模型回复带 [[sticker]] 标记 → 断言真的发出了 image 段（base64://）、并落库「[表情包]」
 *   6. 停用表情后再回一次 → 断言不再发图
 *   7. 删除表情 → 库里清零
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PANEL = Number(process.env.STK_PANEL || 7850);
const ONEBOT = Number(process.env.STK_ONEBOT || 7851);
const MOCK = Number(process.env.STK_MOCK || 7852);
const IMG = Number(process.env.STK_IMG || 7853);
const SELF_ID = 10001;
const USER_ID = 20002;

// 4x4 透明 PNG，够用来校验文件写入与 Content-Type
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
  'base64'
);
// 1x1 GIF：内容与上面的 PNG 不同，用来验证按 hash 去重与扩展名推断
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

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

function api(pathname, { method = 'GET', body, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PANEL, path: pathname, method, headers: body ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (raw) return resolve({ status: res.statusCode, buf, headers: res.headers });
          let data = null;
          try {
            data = JSON.parse(buf.toString('utf8'));
          } catch {
            /* text */
          }
          resolve({ status: res.statusCode, data, text: buf.toString('utf8') });
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
let imgServer;
const dataDir = process.env.STK_DATA_DIR
  ? path.resolve(process.env.STK_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-stk-'));

const outSegments = []; // bot 发给 QQ 的所有消息段
let llmCalls = 0;
let replyWithSticker = true;

function privateEvent(text) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: SELF_ID,
    user_id: USER_ID,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: USER_ID, nickname: '表情测试员' },
  };
}

async function main() {
  // 假表情 CDN
  imgServer = http.createServer((req, res) => {
    if (req.url?.endsWith('.gif')) {
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': GIF.length });
      return res.end(GIF);
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
    res.end(PNG);
  });
  await new Promise((r) => imgServer.listen(IMG, '127.0.0.1', r));

  // 假模型
  llmServer = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    llmCalls++;
    const content = replyWithSticker ? '笑死我了[[sticker]]' : '笑死我了';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
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
  console.log('面板已就绪');

  await api('/api/settings', {
    method: 'PUT',
    body: {
      api_base: `http://127.0.0.1:${MOCK}/v1`,
      api_key: 'sk-sticker-test',
      cooldown_ms: 0,
      split_reply: false,
      segment_delay_min: 0,
      segment_delay_max: 0,
      sticker_enabled: true,
      sticker_chance: 0, // 只认模型主动标记，避免随机干扰断言
    },
  });

  // ——— 模拟 NapCat 反向连接 ———
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

    if (d.action === 'get_login_info') return reply({ user_id: SELF_ID, nickname: '表情机器人' });
    if (d.action === 'send_private_msg' || d.action === 'send_group_msg') {
      outSegments.push(d.params.message);
      return reply({ message_id: Math.floor(Math.random() * 10000) });
    }
    if (d.action === 'fetch_custom_face') {
      return reply([`http://127.0.0.1:${IMG}/a.png`, `http://127.0.0.1:${IMG}/b.gif`]);
    }
    return reply({});
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitFor(async () => (await api('/api/status')).data.onebot.connected === true, { label: 'OneBot 连接' });
  check('OneBot 反向连接已建立', true);

  // ——— 同步表情 ———
  const sync = await api('/api/stickers', { method: 'POST', body: { count: 50 } });
  check('同步接口返回 fetched=2', sync.data?.fetched === 2, JSON.stringify(sync.data));
  check('落库 2 个表情', sync.data?.saved === 2 && sync.data?.total === 2, JSON.stringify(sync.data));

  const pack = await api('/api/stickers');
  check('GET /api/stickers 总数=2 启用=2', pack.data?.total === 2 && pack.data?.enabled === 2, JSON.stringify(pack.data));
  check('开关与概率已透出', pack.data?.on === true && pack.data?.chance === 0);

  const first = pack.data.stickers[0];
  const ext = String(first.file).split('.').pop();
  const onDisk = path.join(dataDir, 'stickers', first.file);
  check('表情文件已落盘', fs.existsSync(onDisk) && fs.statSync(onDisk).size === PNG.length, onDisk);
  check('文件扩展名跟随 Content-Type', ext === 'png' || ext === 'gif', ext);

  const fileRes = await api(`/api/stickers/${first.id}/file`, { raw: true });
  check('面板能读回表情文件（MIME 正确）', fileRes.status === 200 && /^image\//.test(String(fileRes.headers['content-type'])), JSON.stringify(fileRes.headers));

  // 去重：重复同步不应新增
  const sync2 = await api('/api/stickers', { method: 'POST', body: { count: 50 } });
  check('重复同步按 hash 去重', sync2.data?.saved === 0 && sync2.data?.skipped === 2, JSON.stringify(sync2.data));

  // ——— 带标记回复 → 应发文字 + 图片 ———
  outSegments.length = 0;
  ws.send(JSON.stringify(privateEvent('哈哈哈哈')));
  await waitFor(() => outSegments.some((segs) => segs.some((s) => s.type === 'image')), { label: '发出表情包' });

  const flat = outSegments.flat();
  const imageSeg = flat.find((s) => s.type === 'image');
  check('图片段用 base64:// 发送', String(imageSeg?.data?.file || '').startsWith('base64://'));
  check('base64 内容非空', String(imageSeg?.data?.file || '').length > 40);
  const texts = flat.filter((s) => s.type === 'text').map((s) => String(s.data.text || '').trim());
  check('正文里不再出现 [[sticker]] 标记', texts.every((t) => !/\[\[/.test(t)), JSON.stringify(texts));

  const convs = await api('/api/conversations');
  const convId = convs.data.conversations[0]?.id;
  const msgs = await api(`/api/conversations/${convId}/messages?limit=50`);
  const list = msgs.data?.messages || [];
  check('数据库里有「[表情包]」记录', list.some((m) => m.content === '[表情包]' && m.role === 'assistant'));
  check('表情记录 sender 为空（不是主动消息）', list.filter((m) => m.content === '[表情包]').every((m) => !m.sender));

  // ——— 停用后不应再发 ———
  for (const st of (await api('/api/stickers')).data.stickers) {
    await api(`/api/stickers/${st.id}`, { method: 'PATCH', body: { enabled: false } });
  }
  const off = await api('/api/stickers');
  check('停用后启用数=0', off.data?.enabled === 0);

  outSegments.length = 0;
  ws.send(JSON.stringify(privateEvent('再笑一个')));
  await waitFor(() => outSegments.flat().some((s) => s.type === 'text'), { label: '停用后的回复' });
  await sleep(600);
  check('停用后只发文字、不发图片', outSegments.flat().every((s) => s.type !== 'image'), JSON.stringify(outSegments));

  // ——— 删除 ———
  const del = await api(`/api/stickers/${first.id}`, { method: 'DELETE' });
  const after = await api('/api/stickers');
  check('删除表情成功', del.data?.ok === true && after.data?.total === 1, JSON.stringify(after.data));
  check('删除后文件也被清掉', !fs.existsSync(onDisk));

  console.log('');
  if (failures.length) {
    console.log(`表情包链路测试失败 ${failures.length} 项：${failures.join('、')}`);
    process.exitCode = 1;
  } else {
    console.log('表情包链路测试全部通过 ✅');
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
  for (const s of [llmServer, imgServer]) {
    try {
      s?.close();
    } catch {
      /* ignore */
    }
  }
  await sleep(300);
  if (!process.env.STK_DATA_DIR) {
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
