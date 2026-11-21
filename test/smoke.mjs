/**
 * 端到端冒烟测试（零依赖，node test/smoke.mjs）：
 *   1. 起一个假的 OpenAI 兼容模型服务
 *   2. 用临时数据目录启动 bot（面板 7810 / OneBot 反向 WS 7811）
 *   3. 模拟 NapCat：以反向 WS 客户端身份连接 ws://127.0.0.1:7811/onebot
 *   4. 发一条私聊消息，断言：收到开场白 + 模型回复、消息落库、面板接口可查
 *   5. 断言面板代发、群聊 @ 触发、导出接口
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PANEL = Number(process.env.SMOKE_PANEL || 7810);
const ONEBOT = Number(process.env.SMOKE_ONEBOT || 7811);
const MOCK = Number(process.env.SMOKE_MOCK || 7802);
const SELF_ID = 10001;
const USER_ID = 20002;
const GROUP_ID = 30003;
const KEEP_DATA = Boolean(process.env.SMOKE_DATA_DIR) || process.env.SMOKE_KEEP === '1';
const REPLY = '**你好**呀，我在的～'; // 含 Markdown，预期被转成「你好呀，我在的～」
const CLEAN_REPLY = '你好呀，我在的～';

const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 12000, interval = 80, label = 'condition' } = {}) {
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
            /* text response */
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
const dataDir = process.env.SMOKE_DATA_DIR
  ? path.resolve(process.env.SMOKE_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-smoke-'));
const outMessages = []; // bot 发给 QQ 的消息
let llmCalls = 0;

function sendToBot(payload) {
  ws.send(JSON.stringify(payload));
}

function privateEvent(text) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: SELF_ID,
    user_id: USER_ID,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: USER_ID, nickname: '冒烟测试员' },
  };
}

async function main() {
  // ——— 假模型服务 ———
  llmServer = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    llmCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-1',
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      })
    );
  });
  await new Promise((r) => llmServer.listen(MOCK, '127.0.0.1', r));

  // ——— 启动 bot ———
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, BOT_DATA_DIR: dataDir, BOT_PORT: String(PANEL), BOT_ONEBOT_PORT: String(ONEBOT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logBuf = [];
  child.stdout.on('data', (b) => logBuf.push(String(b)));
  child.stderr.on('data', (b) => logBuf.push(String(b)));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`[server exit ${code}]\n${logBuf.join('')}`);
  });

  await waitFor(
    async () => (await api('/health')).status === 200,
    { label: '面板启动', timeout: 15000 }
  ).catch((err) => {
    throw new Error(`${err.message}\n${logBuf.join('')}`);
  });
  console.log('面板已就绪');

  // ——— 配置模型 ———
  const put = await api('/api/settings', {
    method: 'PUT',
    body: {
      api_base: `http://127.0.0.1:${MOCK}/v1`,
      api_key: 'sk-smoke-test',
      model: 'deepseek-chat',
      cooldown_ms: 0,
      split_reply: false,
      segment_delay_min: 0,
      segment_delay_max: 0,
      history_turns: 8,
    },
  });
  check('PUT /api/settings 成功', put.status === 200 && put.data.settings.api_key === 'sk-smoke-test');

  const status = await api('/api/status');
  check('模型状态 ready', status.data.llm.ready === true);
  check('OneBot 监听端口 = 7811', status.data.onebot.listen_port === ONEBOT, JSON.stringify(status.data.onebot));

  const personas = await api('/api/personas');
  check('预设人格已初始化（>=3）', personas.data.personas.length >= 3, String(personas.data.personas.length));
  const defId = put.data.settings.default_persona_id;
  const persona = personas.data.personas.find((p) => p.id === defId) || personas.data.personas[0];
  check('默认人格有开场白', Boolean(persona?.greeting));

  // ——— 人格 CRUD ———
  const created = await api('/api/personas', {
    method: 'POST',
    body: { name: '冒烟人格', emoji: '🧪', description: '测试用', system_prompt: '你是测试人格。', greeting: '嗨', temperature: 0.5 },
  });
  const tmpId = created.data?.persona?.id;
  check('新建人格成功', created.status === 200 && Boolean(tmpId), JSON.stringify(created.data));

  const updated = await api(`/api/personas/${tmpId}`, { method: 'PATCH', body: { name: '冒烟人格2', temperature: '' } });
  check('编辑人格成功且清空温度 = 跟随全局', updated.data?.persona?.name === '冒烟人格2' && updated.data?.persona?.temperature === null, JSON.stringify(updated.data?.persona));

  const llmTest = await api('/api/llm/test', { method: 'POST' });
  check('模型测试接口可用', llmTest.status === 200 && llmTest.data.ok === true, JSON.stringify(llmTest.data));

  const delPersona = await api(`/api/personas/${tmpId}`, { method: 'DELETE' });
  check('删除人格成功', delPersona.status === 200 && delPersona.data.ok === true);
  const afterDelete = await api('/api/personas');
  check('默认人格未指向已删除的人格', afterDelete.data.personas.every((p) => p.id !== tmpId));

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
    if (d.echo == null) return; // 事件推送，忽略
    if (d.action === 'get_login_info') {
      sendToBot({ status: 'ok', retcode: 0, data: { user_id: SELF_ID, nickname: '冒烟号' }, echo: d.echo });
      return;
    }
    if (d.action === 'send_private_msg' || d.action === 'send_group_msg') {
      const seg = d.params?.message;
      const text = Array.isArray(seg) ? seg.map((s) => s?.data?.text || '').join('') : String(seg || '');
      outMessages.push({ action: d.action, target: d.params.user_id || d.params.group_id, text });
      sendToBot({ status: 'ok', retcode: 0, data: { message_id: Math.floor(Math.random() * 1e6) }, echo: d.echo });
      return;
    }
    sendToBot({ status: 'ok', retcode: 0, data: {}, echo: d.echo });
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const conn = await waitFor(
    async () => ((await api('/api/status')).data.onebot.connected ? true : null),
    { label: 'OneBot 反向连接被服务端接受' }
  );
  check('OneBot 反向连接已建立', Boolean(conn));
  const st2 = await api('/api/status');
  check('昵称同步为 冒烟号', st2.data.onebot.nickname === '冒烟号', JSON.stringify(st2.data.onebot));

  // ——— 私聊消息 → 开场白 + 模型回复 ———
  sendToBot(privateEvent('你好呀'));
  await waitFor(() => outMessages.length >= 2, { label: '收到两条回复（开场白+模型）' });
  await sleep(400);

  const priv = outMessages.filter((m) => m.action === 'send_private_msg');
  check('私聊共发送 2 条', priv.length >= 2, JSON.stringify(priv));
  check('第一条是人格开场白', priv[0]?.text === persona.greeting, priv[0]?.text);
  check('第二条是模型回复（已转纯文本）', priv[1]?.text === CLEAN_REPLY, priv[1]?.text);
  check('模型被调用', llmCalls >= 1, String(llmCalls));

  const convs = await api('/api/conversations');
  const privConv = convs.data.conversations.find((c) => c.kind === 'private' && c.peer_id === String(USER_ID));
  check('私聊会话已创建', Boolean(privConv), JSON.stringify(convs.data.conversations));
  check('会话消息数 = 3', privConv?.message_count === 3, String(privConv?.message_count));
  check('会话带人格名', Boolean(privConv?.persona_name), privConv?.persona_name);

  const msgs = await api(`/api/conversations/${privConv.id}/messages`);
  const roles = msgs.data.messages.map((m) => m.role);
  check('消息顺序 user→assistant→assistant', JSON.stringify(roles) === '["user","assistant","assistant"]', JSON.stringify(roles));
  check('用户消息内容正确', msgs.data.messages[0]?.content === '你好呀');
  check('用户昵称已记录', msgs.data.messages[0]?.sender === '冒烟测试员');

  const users = await api('/api/users');
  check('联系人已记录', users.data.users.some((u) => u.id === String(USER_ID)), JSON.stringify(users.data.users.map((u) => u.id)));

  const patched = await api(`/api/conversations/${privConv.id}`, { method: 'PATCH', body: { notes: '他喜欢猫', pinned: 1 } });
  check('会话记忆 / 置顶可保存', patched.data?.conversation?.notes === '他喜欢猫' && patched.data?.conversation?.pinned === 1, JSON.stringify(patched.data?.conversation));

  const userPatch = await api(`/api/users/${USER_ID}`, { method: 'PATCH', body: { notes: '老同学', nickname: '冒烟测试员' } });
  check('用户备注可保存', userPatch.data?.user?.notes === '老同学', JSON.stringify(userPatch.data?.user));

  const exported = await api(`/api/conversations/${privConv.id}/export`);
  check('导出接口返回文本', exported.status === 200 && exported.text.includes('你好呀'));

  const before = outMessages.length;
  const manual = await api('/api/send', { method: 'POST', body: { kind: 'private', peer_id: String(USER_ID), text: '面板代发测试' } });
  check('面板代发成功', manual.status === 200 && manual.data.ok === true, JSON.stringify(manual.data));
  const sentText = outMessages.slice(before).filter((m) => m.action === 'send_private_msg').map((m) => m.text);
  check('代发内容已发给 QQ', sentText.includes('面板代发测试'), JSON.stringify(sentText));

  // ——— 群聊 @ 触发 ———
  sendToBot({
    post_type: 'message',
    message_type: 'group',
    self_id: SELF_ID,
    group_id: GROUP_ID,
    group_name: '冒烟群',
    user_id: 40004,
    raw_message: `[CQ:at,qq=${SELF_ID}] 在吗`,
    message: [
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: ' 在吗' } },
    ],
    sender: { user_id: 40004, nickname: '群友甲', card: '群友甲' },
  });
  await waitFor(() => outMessages.filter((m) => m.action === 'send_group_msg').length >= 2, { label: '群聊收到回复' });
  const grp = outMessages.filter((m) => m.action === 'send_group_msg');
  check('群聊回复已发出', grp.length >= 2 && grp.every((m) => Number(m.target) === GROUP_ID), JSON.stringify(grp.map((m) => m.text)));
  check('群聊模型回复正确', grp.some((m) => m.text === CLEAN_REPLY), JSON.stringify(grp.map((m) => m.text)));

  const convs2 = await api('/api/conversations?kind=group');
  check('群聊会话已创建', convs2.data.conversations.some((c) => c.peer_id === String(GROUP_ID)), JSON.stringify(convs2.data.conversations));

  // ——— 面板联动：日志、统计 ———
  const logs = await api('/api/logs?limit=5');
  check('日志接口可用', logs.status === 200 && Array.isArray(logs.data.logs));
  const st3 = await api('/api/status');
  check('统计已更新', st3.data.stats.conversations >= 2 && st3.data.stats.messages >= 5, JSON.stringify(st3.data.stats));

  // ——— 清理会话（顺带验证删除） ———
  if (process.env.SMOKE_NO_DELETE !== '1') {
    const del = await api(`/api/conversations/${privConv.id}`, { method: 'DELETE' });
    check('删除会话成功', del.status === 200 && del.data.ok === true);
  }
}
main()
  .catch((err) => {
    failures.push(`异常：${err.message}`);
    console.log(`\n✗ 异常：${err.stack || err.message}`);
  })
  .finally(async () => {
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
    await sleep(200);
    try {
      llmServer?.close();
    } catch {
      /* ignore */
    }
    try {
      if (!KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    console.log(failures.length ? `\n冒烟测试失败：${failures.length} 项 — ${failures.join('；')}` : '\n冒烟测试全部通过 ✅');
    process.exit(failures.length ? 1 : 0);
  });
