/**
 * DSH 转交链路测试（零依赖，node test/dsh.mjs）：
 *   1. 起假模型 + 假 dsh 命令（node 脚本，打印几行进 stdout）
 *   2. 临时数据目录启动 bot（面板 7880 / OneBot 反向 WS 7881）
 *   3. 私聊发一句普通消息，把会话设为主对话
 *   4. 发「dsh 帮我整理三条需求」→ 断言：先回「收到」，跑完后发出 image 段（base64://）
 *   5. 断言输出截图真的落盘、结论文字含「做完了」、/api/dsh/jobs 期间有 running 记录
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PANEL = Number(process.env.DSH_PANEL || 7880);
const ONEBOT = Number(process.env.DSH_ONEBOT || 7881);
const MOCK = Number(process.env.DSH_MOCK || 7882);
const SELF_ID = 10001;
const USER_ID = 21001;

const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 60000, interval = 150, label = 'condition' } = {}) {
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
            /* 非 JSON */
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-dsh-'));
const mockScript = path.join(dataDir, 'fake-dsh.mjs');
fs.writeFileSync(
  mockScript,
  `import fs from 'node:fs';
const file = process.argv[2];
const prompt = fs.readFileSync(file, 'utf8');
console.log('DSH 收到任务：' + prompt.slice(0, 40));
console.log('分析中……');
console.log('1) 第一条需求');
console.log('2) 第二条需求');
console.log('3) 第三条需求');
console.log('完成');
`,
  'utf8'
);

let child;
let ws;
let llmServer;
const outSegments = [];
const kindOf = (segs) => (Array.isArray(segs) ? segs : []).map((s) => s.type).join(',');

function privateEvent(text) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: SELF_ID,
    user_id: USER_ID,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: USER_ID, nickname: '转交测试员' },
  };
}

async function main() {
  llmServer = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: '好的。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 3 },
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
      api_key: 'sk-dsh-test',
      cooldown_ms: 0,
      split_reply: false,
      segment_delay_min: 0,
      segment_delay_max: 0,
      sticker_enabled: false,
      dsh_enabled: true,
      dsh_keywords: 'dsh,harness',
      dsh_command: `"${process.execPath}" "${mockScript}" "{prompt_file}"`,
      dsh_timeout_ms: 60000,
      dsh_cwd: '',
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
    if (d.action === 'get_login_info') return reply({ user_id: SELF_ID, nickname: '转交机器人' });
    if (d.action === 'send_private_msg' || d.action === 'send_group_msg') {
      outSegments.push(d.params.message);
      return reply({ message_id: Math.floor(Math.random() * 10000) });
    }
    return reply({});
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitFor(async () => (await api('/api/status')).data.onebot.connected === true, { label: 'OneBot 连接' });

  // 先来一句普通消息，建立会话
  ws.send(JSON.stringify(privateEvent('你好')));
  const conv = await waitFor(async () => {
    const list = (await api('/api/conversations')).data.conversations;
    return list.find((c) => String(c.peer_id) === String(USER_ID));
  }, { label: '会话建立' });
  check('会话已建立', Boolean(conv?.id));

  const mainRes = await api(`/api/conversations/${conv.id}/main`, { method: 'POST' });
  check('设为主对话成功', mainRes.data?.ok === true, JSON.stringify(mainRes.data));
  check('状态里 dsh 已配置', (await api('/api/status')).data.dsh.configured === true);

  outSegments.length = 0;
  ws.send(JSON.stringify(privateEvent('dsh 帮我把需求整理成三条')));

  // 收到「收到」
  await waitFor(() => outSegments.some((s) => kindOf(s) === 'text'), { label: '收到回执' });
  const ackText = outSegments.find((s) => kindOf(s) === 'text')?.[0]?.data?.text || '';
  check('先回了「收到」', ackText.includes('收到') && ackText.includes('DSH'), ackText);

  // 等 image 段
  const imageSeg = await waitFor(
    () => outSegments.flat().find((seg) => seg?.type === 'image' && String(seg.data?.file || '').startsWith('base64://')),
    { label: 'DSH 输出截图' }
  );
  check('发出了 image 段（base64://）', Boolean(imageSeg));
  check('图片 base64 内容足够长', String(imageSeg.data.file).length > 5000, `len=${String(imageSeg.data.file).length}`);

  const doneText = await waitFor(
    () => outSegments.flat().find((seg) => seg?.type === 'text' && String(seg.data?.text || '').includes('做完了')),
    { label: '完成结论' }
  );
  check('结论文字含「做完了」', Boolean(doneText), JSON.stringify(outSegments).slice(0, 300));
  check('结论里带了输出尾巴', String(doneText.data.text).includes('第三条需求'));

  const files = fs.readdirSync(path.join(dataDir, 'dsh')).filter((f) => f.endsWith('.png'));
  check('输出截图已落盘', files.length >= 1, files.join(','));
  const png = files.length ? fs.readFileSync(path.join(dataDir, 'dsh', files[0])) : Buffer.alloc(0);
  check('截图是有效 PNG', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');

  const jobs = (await api('/api/dsh/jobs')).data.jobs;
  check('任务列表已清空（跑完就出队）', Array.isArray(jobs) && jobs.length === 0, JSON.stringify(jobs));
}

main()
  .catch((err) => {
    console.error('测试异常：', err?.message || err);
    failures.push('异常退出');
  })
  .finally(async () => {
    try {
      ws?.close();
    } catch {}
    llmServer?.close();
    child?.kill();
    await sleep(400);
    if (!process.env.DSH_DATA_DIR) fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('');
    if (failures.length) {
      console.log(`失败 ${failures.length} 项：${failures.join(' / ')}`);
      process.exit(1);
    }
    console.log('DSH 转交测试全部通过 ✅');
  });
