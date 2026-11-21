/**
 * 用 CDP 驱动 headless Edge，验证面板的真实交互：
 *   人格页「新建人格」弹窗 → 填写 → 保存 → 卡片出现
 *   对话记录 → 记忆抽屉 → 人格下拉有选项
 * 仅用于本地开发验证，不参与打包。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const EDGE = process.env.UI_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.UI_BASE || 'http://127.0.0.1:7920';
const DBG = Number(process.env.UI_DEBUG_PORT || 9333);
const PROFILE = path.join(os.tmpdir(), 'qqbot-ui-cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures.push(name);
};

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  }
}

let edge;
let cdp;
let created;

async function poll(expr, label, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await cdp.eval(expr)) return true;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
}

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error(`没有找到浏览器：${EDGE}（可用 UI_EDGE 指定 Edge/Chrome 路径）`);
  // 清掉上一次失败留下的测试人格
  try {
    const list = await (await fetch(`${BASE}/api/personas`)).json();
    for (const p of list.personas.filter((x) => x.name.startsWith('CDP 测试人格'))) {
      await fetch(`${BASE}/api/personas/${p.id}`, { method: 'DELETE' });
    }
  } catch {
    /* server maybe not up yet */
  }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--remote-debugging-port=${DBG}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ]);

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw new Error('Edge 调试端口没起来');
  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // —— 人格页：新建人格 ——
  await cdp.send('Page.navigate', { url: `${BASE}/#/personas` });
  await poll(`!!document.querySelector('#btn-new-persona')`, '人格页渲染');
  check('人格页渲染出卡片', (await cdp.eval(`document.querySelectorAll('.persona-card').length`)) >= 3);

  await cdp.eval(`document.querySelector('#btn-new-persona').click(); true`);
  await poll(`!!document.querySelector('#pf-name')`, '新建人格弹窗');
  check('弹窗字段齐全', await cdp.eval(`['#pf-name','#pf-emoji','#pf-desc','#pf-prompt','#pf-greeting','#pf-temp','#pf-model','#pf-enabled'].every(s=>!!document.querySelector(s))`));

  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('#pf-name', 'CDP 测试人格');
    set('#pf-desc', '自动化检查用');
    set('#pf-prompt', '你是一个只用于自动化测试的人格，回复永远带一个 ✅。');
    set('#pf-greeting', '嗨，测试一下');
    return true;
  })()`);
  await cdp.eval(`document.querySelector('[data-save]').click(); true`);
  const cardAppeared = await poll(
    `[...document.querySelectorAll('.persona-card h4')].some(h => h.textContent.trim() === 'CDP 测试人格') && !document.querySelector('#pf-name')`,
    '保存后卡片出现'
  );
  check('保存后面板出现新人格卡片', Boolean(cardAppeared));

  const createdResp = await cdp.eval(`fetch('/api/personas').then(r=>r.json())`);
  created = createdResp.personas.find((p) => p.name === 'CDP 测试人格');
  check('新人格已写入数据库', Boolean(created), JSON.stringify(createdResp.personas.map((p) => p.name)));

  // —— 对话记录：记忆抽屉 ——
  const convs = await cdp.eval(`fetch('/api/conversations').then(r=>r.json())`);
  const conv = convs.conversations[0];
  if (conv) {
    await cdp.send('Page.navigate', { url: `${BASE}/#/chats?c=${conv.id}` });
    await poll(`!!document.querySelector('#chat-pane .chat-body, #chat-body')`, '会话页渲染');
    await cdp.eval(`document.querySelector('#btn-memory').click(); true`);
    await poll(`!!document.querySelector('#drawer-root .drawer') || /会话记忆/.test(document.querySelector('#drawer-root').innerHTML)`, '记忆抽屉打开');
    const personaOptions = await cdp.eval(`document.querySelectorAll('#drawer-root select option').length`);
    check('记忆抽屉里人格下拉有选项', personaOptions >= 3, String(personaOptions));
    check('记忆抽屉有会话记忆输入框', await cdp.eval(`!!document.querySelector('#drawer-root textarea')`));
  } else {
    check('存在可打开的会话', false, '演示库里没有会话');
  }
}

main()
  .catch((err) => {
    failures.push(`异常：${err.message}`);
    console.log(`✗ ${err.stack || err.message}`);
  })
  .finally(async () => {
    if (created) {
      await fetch(`${BASE}/api/personas/${created.id}`, { method: 'DELETE' }).catch(() => {});
    }
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    try {
      edge?.kill();
    } catch {
      /* ignore */
    }
    console.log(failures.length ? `\nUI 检查失败：${failures.join('；')}` : '\nUI 检查全部通过 ✅');
    process.exit(failures.length ? 1 : 0);
  });
