/* QQ 人格机 · 管理面板（零依赖，原生 ES Module） */

const state = {
  route: 'dashboard',
  status: null,
  settings: null,
  personas: [],
  conversations: [],
  activeConvId: null,
  conv: null,
  messages: [],
  convFilter: 'all',
  search: '',
  typing: false,
  loadingChat: false,
  ws: null,
  wsRetry: 0,
  logs: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = () => $('#view');

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
const pad = (n) => String(n).padStart(2, '0');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return '今天';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return fmtTime(ts);
  return `${new Date(ts).getMonth() + 1}/${new Date(ts).getDate()}`;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = { error: `响应解析失败（HTTP ${res.status}）` };
  }
  if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

let toastTimer = null;
function toast(text, kind = '') {
  const node = $('#toast');
  node.textContent = text;
  node.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.className = 'toast'), 2600);
}

function copyText(text) {
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动复制', ok ? 'ok' : 'err');
    } catch {
      toast('复制失败，请手动复制', 'err');
    }
  };
  if (!navigator.clipboard?.writeText) return fallback();
  navigator.clipboard.writeText(text).then(() => toast('已复制到剪贴板', 'ok'), fallback);
}

/* ————————————————— 弹窗 ————————————————— */

function openModal({ title, body, footer = '', width = 680, onMount }) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="overlay" data-overlay>
      <div class="modal" style="width:min(${width}px,100%)">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="close-x" data-close>×</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  $('[data-overlay]', root).addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  $('[data-close]', root).addEventListener('click', close);
  onMount?.({ root, close });
  return close;
}

function confirmDialog(title, text, confirmLabel = '确定') {
  return new Promise((resolve) => {
    const close = openModal({
      title,
      body: `<p style="margin:0;line-height:1.75;color:var(--text-2)">${text}</p>`,
      footer: `<button class="btn" data-no>取消</button><button class="btn danger" data-yes>${esc(confirmLabel)}</button>`,
      width: 440,
      onMount: ({ root }) => {
        $('[data-no]', root).onclick = () => {
          close();
          resolve(false);
        };
        $('[data-yes]', root).onclick = () => {
          close();
          resolve(true);
        };
      },
    });
  });
}

function openDrawer({ title, body, onMount }) {
  const root = $('#drawer-root');
  root.innerHTML = `
    <div class="overlay" data-overlay style="background:rgba(5,8,14,.45)">
      <div class="drawer">
        <div class="drawer-head"><h3 style="font-size:15px">${esc(title)}</h3><button class="close-x" data-close>×</button></div>
        <div class="drawer-body">${body}</div>
      </div>
    </div>`;
  const close = () => (root.innerHTML = '');
  $('[data-close]', root).onclick = close;
  $('[data-overlay]', root).addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  onMount?.({ root, close });
  return close;
}

/* ————————————————— WebSocket ————————————————— */

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/panel`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsRetry = 0;
  };
  ws.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    onEvent(data);
  };
  ws.onclose = () => {
    state.ws = null;
    const delay = Math.min(8000, 600 * ++state.wsRetry);
    setTimeout(connectWs, delay);
  };
}

let convRefreshTimer = null;
let moodRefreshTimer = null;
let dashRefreshTimer = null;

function onEvent(data) {
  if (data.type === 'message') {
    if (state.route === 'main' && data.conversation_id === state.activeConvId) {
      clearTimeout(moodRefreshTimer);
      moodRefreshTimer = setTimeout(() => loadMood(data.conversation_id), 600);
    }
    if (state.route === 'chats') {
      clearTimeout(convRefreshTimer);
      convRefreshTimer = setTimeout(loadConversations, 250);
      if (data.conversation_id === state.activeConvId) appendBubble(data);
    }
    if (state.route === 'dashboard') {
      clearTimeout(dashRefreshTimer);
      dashRefreshTimer = setTimeout(renderDashboard, 400);
    }
    return;
  }
  if (data.type === 'typing') {
    if (data.conversation_id === state.activeConvId) setTyping(Boolean(data.on));
    return;
  }
  if (data.type === 'status') {
    refreshStatus();
    return;
  }
  if (data.type === 'conversation_deleted' && data.conversation_id === state.activeConvId) {
    state.activeConvId = null;
    renderChats();
  }
}

/* ————————————————— 状态 ————————————————— */

function connPill() {
  const node = $('#conn-pill');
  const st = state.status;
  if (!st) return;
  const on = st.onebot?.connected;
  node.classList.toggle('online', Boolean(on));
  const label = on
    ? `${st.onebot.nickname || '机器人'} · ${st.onebot.self_id || ''}`
    : '未连接 OneBot';
  node.innerHTML = `<i class="dot"></i><span>${esc(label)}</span>`;
}

async function refreshStatus() {
  try {
    state.status = await api('/status');
  } catch {
    state.status = null;
  }
  connPill();
  if (state.route === 'dashboard') {
    const badge = $('#dash-badges');
    if (badge) badge.innerHTML = statusBadges();
  }
}

function statusBadges() {
  const st = state.status;
  if (!st) return '';
  return `
    <span class="badge ${st.onebot.connected ? 'ok' : 'err'}">${
      st.onebot.connected ? `OneBot 在线 · ${esc(st.onebot.mode)}` : 'OneBot 未连接'
    }</span>
    <span class="badge ${st.llm.ready ? 'accent' : 'warn'}">模型 ${esc(st.llm.model || '未配置')}</span>`;
}

/* ————————————————— 路由 ————————————————— */

const PAGES = {
  main: { title: '主对话', sub: '' },
  dashboard: { title: '概览', sub: '机器人运行状态与最近动态' },
  personas: { title: '人格', sub: '每套人设都是一段可随时切换的剧本' },
  chats: { title: '其他会话', sub: '群聊、其他私聊——附带看看，长期记忆都在主对话' },
  rules: { title: '触发规则', sub: '决定机器人什么时候开口、对谁开口' },
  link: { title: '连接', sub: '机器人、DSH、以及它们之间那条链路' },
  settings: { title: '设置', sub: '模型 API 与 OneBot 连接参数' },
};

const RENDERERS = {
  main: renderMain,
  dashboard: renderDashboard,
  personas: renderPersonas,
  chats: renderChats,
  rules: renderRules,
  link: renderLink,
  settings: renderSettings,
};

/* ————————————————— 连接 ————————————————— */

const LINK_SKELETON = `
  <div class="link-grid">
    <div class="card">
      <div class="card-head">
        <div><h3>机器人</h3><div class="sub">OneBot 连接与模型状态</div></div>
        <span class="badge" id="lk-ob-badge">—</span>
      </div>
      <div class="kv"><span class="k">账号</span><span class="v" id="lk-account">—</span></div>
      <div class="kv"><span class="k">连接方式</span><span class="v" id="lk-mode">—</span></div>
      <div class="kv"><span class="k">最近一条消息</span><span class="v" id="lk-last">—</span></div>
      <div class="kv"><span class="k">模型</span><span class="v" id="lk-llm">—</span></div>
      <div class="kv"><span class="k">识图</span><span class="v" id="lk-vision">—</span></div>
      <div class="kv"><span class="k">主对话</span><span class="v" id="lk-main">—</span></div>
      <div class="kv"><span class="k">运行时长</span><span class="v" id="lk-uptime">—</span></div>
    </div>

    <div class="card">
      <div class="card-head">
        <div><h3>DSH 通道</h3><div class="sub">关键词转交与本机 CLI</div></div>
        <span class="badge" id="lk-dsh-badge">—</span>
      </div>
      <div class="kv"><span class="k">开关</span><span class="v" id="lk-dsh-on">—</span></div>
      <div class="kv"><span class="k">触发词</span><span class="v" id="lk-dsh-kw">—</span></div>
      <div class="kv cmd-row"><span class="k">命令</span><span class="v mono" id="lk-dsh-cmd">—</span></div>
      <div class="kv"><span class="k">工作目录</span><span class="v" id="lk-dsh-cwd">—</span></div>
      <div class="kv"><span class="k">单次超时</span><span class="v" id="lk-dsh-timeout">—</span></div>
      <div class="kv"><span class="k">主动消息</span><span class="v" id="lk-pro">—</span></div>
      <div class="kv"><span class="k">没回就追问</span><span class="v" id="lk-follow">—</span></div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-head">
      <div><h3>任务流水</h3><div class="sub">最近的 DSH 转交（面板重启会清空，只保留内存里 20 条）</div></div>
      <span class="badge" id="lk-jobs-badge">—</span>
    </div>
    <table class="jobs">
      <thead><tr><th>时间</th><th>来源</th><th>内容</th><th>状态</th><th>耗时</th><th>退出码</th></tr></thead>
      <tbody id="lk-jobs"><tr><td colspan="6" class="muted">还没有任务。主对话里发一句带「dsh」的话就会出现在这里。</td></tr></tbody>
    </table>
    <div class="link-hint" id="lk-hint"></div>
  </div>`;

function dot(on) {
  return `<span class="dot ${on ? 'ok' : 'off'}"></span>`;
}

function uptimeText(sec) {
  const n = Math.max(0, Number(sec) || 0);
  if (n < 60) return `${n} 秒`;
  const mins = Math.round(n / 60);
  if (mins < 60) return `${mins} 分钟`;
  return `${Math.floor(mins / 60)} 小时 ${mins % 60} 分`;
}

function fmtAgo(ms) {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  if (!Number.isFinite(diff) || diff < 0) return '刚刚';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function jobsSignature(jobs) {
  return jobs.map((j) => `${j.id}:${j.status}`).join('|');
}

function paintJobs(jobs) {
  const tbody = $('#lk-jobs');
  if (!tbody) return;
  const sig = jobsSignature(jobs);
  if (tbody.dataset.sig === sig) return;
  tbody.dataset.sig = sig;
  if (!jobs.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="muted">还没有任务。主对话里发一句带「dsh」的话就会出现在这里。</td></tr>';
    return;
  }
  tbody.innerHTML = jobs
    .map((job) => {
      const when = job.started_at ? new Date(job.started_at) : null;
      const time = when
        ? `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
        : '—';
      const status = job.running
        ? '<span class="badge accent">运行中</span>'
        : job.status === 'done'
          ? '<span class="badge ok">完成</span>'
          : '<span class="badge err">失败</span>';
      const title = String(job.prompt || '').replace(/\s+/g, ' ').slice(0, 60);
      return `<tr>
        <td class="mono">${time}</td>
        <td>${esc(job.kind === 'group' ? '群' : '私聊')} ${esc(job.peer_id || '')}</td>
        <td class="job-title" title="${esc(job.prompt || '')}">${esc(title)}</td>
        <td>${status}</td>
        <td class="mono">${job.running ? '—' : `${job.secs ?? '—'}s`}</td>
        <td class="mono">${job.running ? '—' : job.exit_code ?? '—'}</td>
      </tr>`;
    })
    .join('');
}

function paintLink(d) {
  const ob = d.onebot || {};
  const set = (id, html) => {
    const el = $('#' + id);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  };

  const badge = $('#lk-ob-badge');
  if (badge) {
    const label = ob.connected ? '已连接' : '未连接';
    if (badge.textContent !== label) badge.textContent = label;
    const cls = `badge ${ob.connected ? 'ok' : 'err'}`;
    if (badge.className !== cls) badge.className = cls;
  }
  set('lk-account', `${esc(ob.nickname || '—')} ${esc(ob.self_id || '')}`);
  set('lk-mode', `${esc(ob.mode || '—')} · 端口 ${esc(ob.listen_port ?? '—')}`);
  set('lk-last', ob.last_event_at ? fmtAgo(ob.last_event_at) : '—');
  set('lk-llm', `${dot(d.llm?.ready)}${esc(d.llm?.model || '—')}`);
  set('lk-vision', `${dot(d.vision?.ready)}${esc(d.vision?.model || '未配置')}`);
  set('lk-main', esc(d.main?.title || '未设置'));
  set('lk-uptime', `${uptimeText(d.uptime)} · node ${esc(d.node || '')}`);

  const jobs = d.dsh?.jobs || [];
  const running = jobs.filter((j) => j.running).length;
  const dshBadge = $('#lk-dsh-badge');
  if (dshBadge) {
    const label = d.dsh?.configured ? '命令就绪' : '未配置命令';
    if (dshBadge.textContent !== label) dshBadge.textContent = label;
    const cls = `badge ${d.dsh?.configured ? 'ok' : 'warn'}`;
    if (dshBadge.className !== cls) dshBadge.className = cls;
  }
  set('lk-dsh-on', `${d.dsh?.enabled ? '已开启' : '已关闭'} · 运行中 ${running} 个`);
  set('lk-dsh-kw', esc(d.dsh?.keywords || '—'));
  const cmd = $('#lk-dsh-cmd');
  if (cmd) {
    const text = d.dsh?.command || '—';
    if (cmd.textContent !== text) {
      cmd.textContent = text;
      cmd.title = text;
    }
  }
  set('lk-dsh-cwd', esc(d.dsh?.cwd || '—'));
  set('lk-dsh-timeout', `${esc(d.dsh?.timeout_min ?? '—')} 分钟`);
  set(
    'lk-pro',
    d.proactive?.enabled
      ? `每 ${d.proactive.min}–${d.proactive.max} 分钟 · 安静 ${esc(d.proactive.quiet || '')}`
      : '关闭'
  );
  set(
    'lk-follow',
    d.proactive?.followup
      ? `${d.proactive.followup_minutes} 分钟后 · 最多 ${d.proactive.followup_max} 次`
      : '关闭'
  );

  const jobsBadge = $('#lk-jobs-badge');
  if (jobsBadge) {
    const label = `${jobs.length} 条 · ${running} 运行中`;
    if (jobsBadge.textContent !== label) jobsBadge.textContent = label;
    const cls = `badge ${running ? 'accent' : ''}`;
    if (jobsBadge.className !== cls) jobsBadge.className = cls;
  }
  paintJobs(jobs);
}

function stopLinkTimer() {
  if (state.linkTimer) {
    clearInterval(state.linkTimer);
    state.linkTimer = 0;
  }
}

async function refreshLink(first) {
  try {
    const data = await api('/link');
    state.linkData = data;
    paintLink(data);
    const hint = $('#lk-hint');
    if (hint) hint.textContent = '';
  } catch (e) {
    if (first && !state.linkData) {
      const host = $('#view');
      host.innerHTML = `<div class="card"><h3>读取失败</h3><p class="muted">${esc(e.message)}</p></div>`;
      return;
    }
    const hint = $('#lk-hint');
    if (hint) hint.textContent = `更新失败（${e.message}），页面停留在上一次数据。`;
  }
}

async function renderLink() {
  const host = $('#view');
  host.className = 'view';
  host.innerHTML = LINK_SKELETON;
  stopLinkTimer();
  await refreshLink(true);
  if (state.route !== 'link' || !$('#lk-jobs')) return;
  state.linkTimer = setInterval(() => {
    if (state.route !== 'link' || document.hidden || !$('#lk-jobs')) return;
    refreshLink(false);
  }, 3000);
}

function routeName() {
  const name = (location.hash.replace(/^#\/?/, '').split('?')[0] || 'main').trim();
  return RENDERERS[name] ? name : 'main';
}

async function navigate(name) {
  const route = name || routeName();
  if (state.linkTimer) {
    clearInterval(state.linkTimer);
    state.linkTimer = 0;
  }
  state.route = route;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === route));
  const page = PAGES[route];
  $('#page-title').textContent = page.title;
  $('#page-sub').textContent = page.sub;
  $('#topbar-right').innerHTML = `
    <span class="badge ${state.status?.onebot?.connected ? 'ok' : 'err'}">${
      state.status?.onebot?.connected ? '在线' : '离线'
    }</span>
    <button class="btn sm" id="btn-refresh">刷新</button>`;
  $('#btn-refresh').onclick = () => navigate(route);
  await refreshStatus();
  await RENDERERS[route]();
}

/* ————————————————— 概览 ————————————————— */

async function renderDashboard() {
  const [statusRes, logsRes, convRes] = await Promise.allSettled([
    api('/status'),
    api('/logs?limit=40'),
    api('/conversations'),
  ]);
  if (statusRes.status === 'fulfilled') state.status = statusRes.value;
  const st = state.status;
  const logs = logsRes.status === 'fulfilled' ? logsRes.value.logs : [];
  const convs = convRes.status === 'fulfilled' ? convRes.value.conversations : [];
  connPill();

  const apiWarn =
    st && !st.llm.ready
      ? `<div class="card" style="border-color:rgba(240,180,92,.35);margin-bottom:16px;display:flex;gap:14px;align-items:center">
           <div style="font-size:22px">⚠️</div>
           <div><strong>还没有配置模型 API</strong>
           <div class="muted" style="font-size:12.5px;margin-top:3px">填写 API Key 后机器人才能回复消息。</div></div>
           <div class="spacer"></div>
           <a class="btn primary sm" href="#/settings">去配置</a>
         </div>`
      : '';

  const onebotHint = st?.onebot?.connected
    ? `<span class="badge ok">已连接</span>`
    : `<span class="badge err">未连接</span>`;

  view().innerHTML = `
    ${apiWarn}
    <div class="hero">
      <div class="avatar avatar-lg">${esc(state.personas?.[0]?.emoji || '🫧')}</div>
      <div style="min-width:0">
        <h2>${st?.onebot?.connected ? esc(st.onebot.nickname || '机器人') : '等待 OneBot 接入'}</h2>
        <p>${st?.onebot?.connected ? `QQ ${esc(st.onebot.self_id)} · ${esc(st.onebot.mode)} 连接` : '双击 start-snowcat.cmd 启动 QQ 后即可上线'}</p>
      </div>
      <div class="spacer"></div>
      <div class="row wrap" id="dash-badges">${statusBadges()}</div>
      <button class="btn sm" id="btn-copy">复制接入地址</button>
    </div>

    <div class="grid cols-4" style="margin-top:16px">
      <div class="stat"><div class="k">今日消息</div><div class="v">${st?.stats?.messages_today ?? 0}</div></div>
      <div class="stat"><div class="k">累计消息</div><div class="v">${st?.stats?.messages ?? 0}</div></div>
      <div class="stat"><div class="k">会话</div><div class="v">${st?.stats?.conversations ?? 0}</div></div>
      <div class="stat"><div class="k">人格</div><div class="v">${state.personas?.length ?? st?.stats?.personas ?? 0}</div></div>
    </div>

    <div class="grid" style="grid-template-columns:1.25fr .9fr;margin-top:16px">
      <div class="card">
        <div class="card-head">
          <div><h3>最近对话</h3><div class="sub">点进去看完整记录</div></div>
          <a class="btn sm ghost" href="#/chats">全部 →</a>
        </div>
        <div id="recent-convs">
          ${
            convs.length
              ? convs
                  .slice(0, 6)
                  .map(
                    (c) => `
            <div class="conv-item" data-goto="${c.id}">
              <div class="avatar ${c.kind === 'group' ? 'group' : ''}">${c.kind === 'group' ? '👥' : esc(c.persona_emoji || '💬')}</div>
              <div class="meta">
                <div class="line1"><span class="name">${esc(c.title || c.peer_id)}</span><span class="time">${relTime(c.last_message_at)}</span></div>
                <div class="line2">${esc(String(c.last_content || '还没有消息').slice(0, 40))}</div>
              </div>
            </div>`
                  )
                  .join('')
              : `<div class="empty"><div class="big">🫥</div><p>还没有会话。等第一条消息进来吧。</p></div>`
          }
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>系统日志</h3><div class="sub">最近 40 条</div></div><a class="btn sm ghost" href="#/settings">详情 →</a></div>
        <div style="max-height:330px;overflow:auto">
          ${
            logs.length
              ? logs
                  .slice(-40)
                  .map(
                    (l) => `<div class="log-line">
                      <span class="t">${fmtTime(l.created_at)}</span>
                      <span class="lv ${esc(l.level)}">${esc(l.level)}</span>
                      <span class="m">${l.scope ? `<span class="scope">${esc(l.scope)}</span> · ` : ''}${esc(l.message)}</span>
                    </div>`
                  )
                  .join('')
              : `<div class="empty"><p>暂无日志</p></div>`
          }
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div><h3>接入信息</h3><div class="sub">SnowCat（NapCat 内核）已预配「反向 WebSocket」，登录即连</div></div>${onebotHint}</div>
      <div class="kv"><span class="k">WebSocket 地址</span><span class="v">ws://${esc(location.hostname)}:${esc(String(state.settings?.onebot_ws_port || 7801))}/onebot</span></div>
      <div class="kv"><span class="k">Token</span><span class="v">${state.settings?.onebot_token ? esc(state.settings.onebot_token) : '（未设置）'}</span></div>
      <div class="kv"><span class="k">当前模式</span><span class="v">${st?.onebot?.connected ? esc(st.onebot.mode) : '等待连接'}</span></div>
      <div class="kv"><span class="k">运行时长</span><span class="v">${Math.floor((st?.uptime || 0) / 60)} 分钟</span></div>
    </div>`;

  $('#btn-copy')?.addEventListener('click', () =>
    copyText(`ws://${location.hostname}:${state.settings?.onebot_ws_port || 7801}/onebot`)
  );
  $$('#recent-convs .conv-item').forEach((node) => {
    node.onclick = () => {
      location.hash = `#/chats?c=${node.dataset.goto}`;
    };
  });
}

/* ————————————————— 人格 ————————————————— */

async function renderPersonas() {
  const { personas } = await api('/personas');
  state.personas = personas;
  const s = state.settings;

  view().innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <p class="muted" style="margin:0;font-size:12.5px">人格决定「它是谁」：说话方式、性格、对什么事有反应。会话可以临时指定人格。</p>
      <div class="spacer"></div>
      <button class="btn primary" id="btn-new-persona">＋ 新建人格</button>
    </div>
    <div class="persona-grid">
      ${
        personas.length
          ? personas
              .map(
                (p) => `
        <div class="persona-card ${Number(s?.default_persona_id) === p.id ? 'default' : ''} ${p.enabled ? '' : 'disabled'}">
          <div class="top">
            <div class="emoji">${esc(p.emoji)}</div>
            <div style="min-width:0">
              <h4>${esc(p.name)}</h4>
              <div class="row" style="gap:6px;margin-top:3px">
                ${Number(s?.default_persona_id) === p.id ? '<span class="badge accent">默认</span>' : ''}
                ${p.enabled ? '' : '<span class="badge">已停用</span>'}
                <span class="badge">温度 ${p.temperature == null ? '跟随全局' : p.temperature}</span>
              </div>
            </div>
          </div>
          <div class="desc">${esc(p.description || '（没有写简介）')}</div>
          <div class="prompt-preview">${esc(p.system_prompt || '（没有人格设定）')}</div>
          <div class="actions">
            <button class="btn sm" data-edit="${p.id}">编辑</button>
            <button class="btn sm ghost" data-toggle="${p.id}">${p.enabled ? '停用' : '启用'}</button>
            <button class="btn sm ghost" data-default="${p.id}">设为默认</button>
            <div class="spacer"></div>
            <button class="btn sm ghost" data-del="${p.id}" style="color:var(--err)">删除</button>
          </div>
        </div>`
              )
              .join('')
          : `<div class="empty" style="grid-column:1/-1"><div class="big">🎭</div><p>还没有人格，点右上角新建一个。</p></div>`
      }
    </div>`;

  $('#btn-new-persona').onclick = () => openPersonaEditor(null);
  $$('[data-edit]').forEach((b) => (b.onclick = () => openPersonaEditor(Number(b.dataset.edit))));
  $$('[data-toggle]').forEach(
    (b) =>
      (b.onclick = async () => {
        const p = state.personas.find((x) => x.id === Number(b.dataset.toggle));
        await api(`/personas/${p.id}`, { method: 'PATCH', body: { enabled: !p.enabled } });
        toast(p.enabled ? '已停用' : '已启用', 'ok');
        renderPersonas();
      })
  );
  $$('[data-default]').forEach(
    (b) =>
      (b.onclick = async () => {
        await api(`/personas/${b.dataset.default}/default`, { method: 'POST' });
        state.settings = (await api('/settings')).settings;
        toast('已设为默认人格', 'ok');
        renderPersonas();
      })
  );
  $$('[data-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        const p = state.personas.find((x) => x.id === Number(b.dataset.del));
        if (!(await confirmDialog('删除人格', `确定删除「${esc(p.name)}」吗？绑定它的会话会回退到默认人格。`, '删除'))) return;
        await api(`/personas/${p.id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        renderPersonas();
      })
  );
}

function openPersonaEditor(id) {
  const p = id ? state.personas.find((x) => x.id === id) : null;
  const emojis = ['🫧', '🧂', '🌙', '🐈', '🌿', '🎧', '🍊', '🦊', '☕️', '🪐'];
  const body = `
    <div class="form-grid">
      <div class="field">
        <label class="label">人格名称</label>
        <input class="input" id="pf-name" value="${esc(p?.name || '')}" placeholder="小深" maxlength="20" />
      </div>
      <div class="field">
        <label class="label">头像表情</label>
        <div class="row">
          <input class="input" id="pf-emoji" value="${esc(p?.emoji || '🤖')}" style="width:74px;text-align:center;font-size:18px" maxlength="4" />
          <div class="row wrap" style="gap:4px">${emojis
            .map((e) => `<button class="btn sm ghost" data-emoji="${e}" style="padding:4px 7px;font-size:16px">${e}</button>`)
            .join('')}</div>
        </div>
      </div>
      <div class="field full">
        <label class="label">一句话简介</label>
        <input class="input" id="pf-desc" value="${esc(p?.description || '')}" placeholder="温柔耐心的聊天搭子，会记住你说过的事" />
      </div>
      <div class="field full">
        <label class="label">人格设定（提示词主体）</label>
        <textarea class="textarea" id="pf-prompt" style="min-height:190px" placeholder="描述它是谁、什么性格、怎么说话、有什么底线…">${esc(p?.system_prompt || '')}</textarea>
        <div class="hintline">这里写「它是谁」。系统会自动补上聊天守则、对方昵称、时间和记忆，不需要你重复。</div>
      </div>
      <div class="field full">
        <label class="label">开场白（第一次聊天时先发这一句）</label>
        <input class="input" id="pf-greeting" value="${esc(p?.greeting || '')}" placeholder="在的，怎么啦～" />
      </div>
      <div class="field full">
        <label class="label">补充知识 / 口癖（可选）</label>
        <textarea class="textarea" id="pf-knowledge" style="min-height:110px" placeholder="这个人的专属知识：常去的地方、爱好、口头禅、和对方之间的梗…">${esc(p?.knowledge || '')}</textarea>
        <div class="hintline">只对这个人生效，会拼在人格设定后面。QQ 玩法、表情包、网络用语由系统统一注入，不用写在这里。</div>
      </div>
      <div class="field">
        <label class="label">温度（留空跟随全局 ${
          esc(String(state.settings?.temperature ?? 1))
        }）</label>
        <input class="input" id="pf-temp" value="${p?.temperature == null ? '' : esc(p.temperature)}" placeholder="0.9" inputmode="decimal" />
      </div>
      <div class="field">
        <label class="label">覆盖模型（留空使用全局）</label>
        <input class="input" id="pf-model" value="${esc(p?.model || '')}" placeholder="${esc(state.settings?.model || 'deepseek-chat')}" />
      </div>
      <div class="field full">
        <label class="switch"><input type="checkbox" id="pf-enabled" ${!p || p.enabled ? 'checked' : ''} /><span class="track"></span><span>启用这个人格</span></label>
      </div>
    </div>`;

  openModal({
    title: p ? '编辑人格' : '新建人格',
    body,
    footer: `<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>`,
    width: 720,
    onMount: ({ root, close }) => {
      $$('[data-emoji]', root).forEach(
        (b) =>
          (b.onclick = () => {
            $('#pf-emoji', root).value = b.dataset.emoji;
          })
      );
      $('[data-cancel]', root).onclick = close;
      $('[data-save]', root).onclick = async () => {
        const payload = {
          name: $('#pf-name', root).value.trim(),
          emoji: $('#pf-emoji', root).value.trim() || '🤖',
          description: $('#pf-desc', root).value.trim(),
          system_prompt: $('#pf-prompt', root).value,
          greeting: $('#pf-greeting', root).value.trim(),
          knowledge: $('#pf-knowledge', root).value,
          temperature: $('#pf-temp', root).value.trim(),
          model: $('#pf-model', root).value.trim(),
          enabled: $('#pf-enabled', root).checked,
        };
        if (!payload.name) return toast('请填写人格名称', 'err');
        if (!payload.system_prompt.trim()) return toast('人格设定不能为空', 'err');
        try {
          if (p) await api(`/personas/${p.id}`, { method: 'PATCH', body: payload });
          else await api('/personas', { method: 'POST', body: payload });
          close();
          toast('已保存', 'ok');
          renderPersonas();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    },
  });
}

/* ————————————————— 对话记录 ————————————————— */

function convQuery() {
  const params = new URLSearchParams();
  if (state.search) params.set('q', state.search);
  if (state.convFilter !== 'all') params.set('kind', state.convFilter);
  const qs = params.toString();
  return `/conversations${qs ? `?${qs}` : ''}`;
}

async function renderMain() {
  if (!state.status) await refreshStatus();
  if (!state.personas?.length) {
    try {
      state.personas = (await api('/personas')).personas || [];
    } catch {
      state.personas = [];
    }
  }
  let convs = [];
  try {
    convs = (await api('/conversations')).conversations || [];
  } catch (err) {
    toast(err.message, 'err');
  }
  state.conversations = convs;

  if (!convs.length) {
    view().className = 'view main-view';
    view().innerHTML = `<div class="empty" style="margin-top:12vh">
      <div class="big">🫧</div>
      <p>还没有任何对话<br />在 QQ 里给她发第一条消息，这里就会成为你们的主对话</p>
    </div>`;
    return;
  }

  const main = convs.find((c) => c.is_main);
  if (!main) {
    view().className = 'view main-view';
    view().innerHTML = `
      <div class="pick-hero">
        <div class="pick-hero-head">
          <div class="big-badge">⭐</div>
          <div>
            <h2>先挑一个主对话</h2>
            <p class="muted">主对话不限制上下文长度，也是她会主动找你、接着话头继续聊的地方。<br />其他会话只是附带，长期关系都留在这里。</p>
          </div>
        </div>
        <div class="pick-list">
          ${convs
            .map(
              (c) => `<button class="pick-row" data-pick="${c.id}">
                <span class="avatar ${c.kind === 'group' ? 'group' : ''}">${
                  c.kind === 'group' ? '👥' : esc(c.persona_emoji || '💬')
                }</span>
                <span class="pick-meta">
                  <span class="pick-name">${esc(c.title || c.peer_id)}</span>
                  <span class="pick-sub">${c.kind === 'group' ? '群' : '私聊'} ${esc(c.peer_id)} · ${
                    c.message_count || 0
                  } 条 · ${esc(c.persona_name || '')}</span>
                </span>
                <span class="pick-go">设为主对话 →</span>
              </button>`
            )
            .join('')}
        </div>
      </div>`;
    $$('.pick-row').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/conversations/${b.dataset.pick}/main`, { method: 'POST' });
          toast('已设为主对话', 'ok');
          await renderMain();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    });
    return;
  }

  state.activeConvId = main.id;
  view().className = 'view no-pad main-view';
  view().innerHTML = `<div class="chat-layout single"><div class="chat-pane" id="chat-pane"></div></div>`;
  await selectConversation(main.id, { skipList: true });
}

async function loadConversations() {
  try {
    const { conversations } = await api(convQuery());
    state.conversations = conversations;
    renderConvList();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderConvList() {
  const box = $('#conv-items');
  if (!box) return;
  if (!state.conversations.length) {
    box.innerHTML = `<div class="empty"><div class="big">💬</div><p>还没有会话<br />机器人收到消息后会出现在这里</p></div>`;
    return;
  }
  box.innerHTML = state.conversations
    .map(
      (c) => `
    <div class="conv-item ${c.id === state.activeConvId ? 'active' : ''}" data-conv="${c.id}">
      <div class="avatar ${c.kind === 'group' ? 'group' : ''}">${c.kind === 'group' ? '👥' : esc(c.persona_emoji || '💬')}</div>
      <div class="meta">
        <div class="line1">
          ${c.is_main ? '<span class="pin" title="主对话">⭐</span>' : ''}
          ${c.pinned ? '<span class="pin">📌</span>' : ''}
          <span class="name">${esc(c.title || c.peer_id)}</span>
          <span class="time">${relTime(c.last_message_at)}</span>
        </div>
        <div class="line2">${c.last_role === 'assistant' ? '我：' : ''}${esc(String(c.last_content || '还没有消息').slice(0, 34))}</div>
      </div>
    </div>`
    )
    .join('');
  $$('#conv-items .conv-item').forEach((node) => {
    node.onclick = () => selectConversation(Number(node.dataset.conv));
  });
}

async function renderChats() {
  if (!state.conversations.length) await loadConversations();
  const param = new URLSearchParams(location.hash.split('?')[1] || '');
  const wanted = Number(param.get('c') || 0);
  if (wanted) state.activeConvId = wanted;
  if (!state.activeConvId || !state.conversations.some((c) => c.id === state.activeConvId)) {
    state.activeConvId = state.conversations[0]?.id ?? null;
  }

  view().className = 'view no-pad';
  view().innerHTML = `
    <div class="chat-layout">
      <div class="chat-list">
        <div class="chat-list-head">
          <div class="row">
            <input class="input" id="conv-search" placeholder="搜索昵称 / QQ / 群号" value="${esc(state.search)}" style="padding:7px 10px;font-size:12.5px" />
          </div>
          <div class="chat-tabs" id="conv-tabs">
            <button data-tab="all" class="${state.convFilter === 'all' ? 'active' : ''}">全部</button>
            <button data-tab="private" class="${state.convFilter === 'private' ? 'active' : ''}">私聊</button>
            <button data-tab="group" class="${state.convFilter === 'group' ? 'active' : ''}">群聊</button>
          </div>
        </div>
        <div class="conv-items" id="conv-items"></div>
      </div>
      <div class="chat-pane" id="chat-pane">
        <div class="empty" style="margin:auto"><div class="big">🫧</div><p>选择左侧的会话开始查看</p></div>
      </div>
    </div>`;

  renderConvList();
  let st = null;
  $('#conv-search').oninput = (e) => {
    state.search = e.target.value;
    clearTimeout(st);
    st = setTimeout(loadConversations, 260);
  };
  $$('#conv-tabs button').forEach(
    (b) =>
      (b.onclick = () => {
        state.convFilter = b.dataset.tab;
        $$('#conv-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        loadConversations();
      })
  );

  if (state.activeConvId) await selectConversation(state.activeConvId, { skipList: true });
  else {
    $('#chat-pane').innerHTML = `<div class="empty" style="margin:auto"><div class="big">🫧</div><p>还没有任何对话<br />机器人收到第一条消息后就会出现在这里</p></div>`;
  }
}

async function selectConversation(id, { skipList = false } = {}) {
  state.activeConvId = id;
  state.typing = false;
  if (!skipList) renderConvList();
  const pane = $('#chat-pane');
  if (!pane) return;
  state.loadingChat = true;
  try {
    const [{ conversation }, { messages }] = await Promise.all([
      api(`/conversations/${id}`),
      api(`/conversations/${id}/messages?limit=80`),
    ]);
    state.conv = conversation;
    state.messages = messages;
    renderChatPane();
    if (conversation.is_main) loadMood(conversation.id);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    state.loadingChat = false;
  }
}

function personaOptionsHtml(conv) {
  const current = Number(conv.persona_id) || 0;
  const opts = [
    `<option value="" ${current ? '' : 'selected'}>跟随默认（${esc(conv.persona_name || '自动')}）</option>`,
    ...state.personas.map(
      (p) =>
        `<option value="${p.id}" ${p.id === current ? 'selected' : ''}>${esc(p.emoji || '')} ${esc(p.name)}${
          p.enabled ? '' : '（已停用）'
        }</option>`
    ),
  ];
  return opts.join('');
}

function chatHeaderHtml(conv) {
  return `
    <div class="avatar ${conv.kind === 'group' ? 'group' : ''}">${conv.kind === 'group' ? '👥' : esc(conv.persona_emoji || '💬')}</div>
    <div>
      <div class="name">${esc(conv.title || conv.peer_id)}</div>
      <div class="sub">${conv.kind === 'group' ? '群' : 'QQ'} ${esc(conv.peer_id)} · ${conv.message_count} 条消息${
        conv.persona_inherited ? '' : ` · 已单独指定人格`
      }</div>
    </div>
    <div class="spacer"></div>
    <label class="persona-pick" title="这个会话用哪个人格回复">
      人格
      <select class="mini-select" id="conv-persona">${personaOptionsHtml(conv)}</select>
    </label>
    <button class="btn sm ghost" id="btn-main" title="${conv.is_main ? '取消主对话' : '设为主对话：记忆不设上限，空闲时会主动找你聊天'}">${
      conv.is_main ? '⭐ 主对话' : '☆ 主对话'
    }</button>
    ${
      conv.is_main
        ? `<div class="mood" id="mood-mini" title="情绪条：只在面板里看得到，会随聊天上下浮动">
             <span class="mood-label">心情</span><span class="mood-bar"><i id="mood-v"></i></span>
             <span class="mood-label">起伏</span><span class="mood-bar"><i id="mood-a"></i></span>
           </div>`
        : ''
    }
    <button class="btn sm ghost" id="btn-memory" title="长期记忆">🧠 记忆</button>
    <a class="btn sm ghost" href="/api/conversations/${conv.id}/export" title="导出 txt">导出</a>
    <button class="btn sm ghost" id="btn-clear" title="清空消息">清空</button>
    <button class="btn sm ghost" id="btn-del-conv" style="color:var(--err)" title="删除会话">删除</button>`;
}

let moodSeq = 0;
/** 面板上的情绪条：只显示，不发给 QQ */
async function loadMood(convId) {
  const v = document.getElementById('mood-v');
  const a = document.getElementById('mood-a');
  if (!v || !a) return;
  const seq = ++moodSeq;
  try {
    const res = await api(`/api/mood/${convId}`);
    if (seq !== moodSeq) return;
    const m = res.mood || {};
    const val = Math.round(m.valence ?? 50);
    const aro = Math.round(m.arousal ?? 35);
    v.style.width = `${val}%`;
    v.style.background = val >= 55 ? '#2f9e6f' : val >= 40 ? '#9a9aa2' : '#c0392b';
    a.style.width = `${aro}%`;
    a.style.background = aro >= 70 ? '#d97706' : aro >= 50 ? '#b0894a' : '#b9b9c0';
    const box = document.getElementById('mood-mini');
    if (box) box.title = `心情 ${val}/100 · 起伏 ${aro}/100（只在面板里看得到）`;
  } catch {
    /* 心情条读不到就算了，不影响聊天 */
  }
}

/** 直接改这个会话的人格，立刻写入后端并刷新列表 */
async function saveConvPersona(conv, value) {
  const personaId = value ? Number(value) : null;
  try {
    const { conversation } = await api(`/conversations/${conv.id}`, {
      method: 'PATCH',
      body: { persona_id: personaId },
    });
    Object.assign(conv, conversation);
    const row = state.conversations.find((c) => c.id === conv.id);
    if (row) Object.assign(row, conversation);
    renderConvList();
    if (state.conv?.id === conv.id) {
      const head = $('#chat-head');
      if (head) {
        head.innerHTML = chatHeaderHtml(state.conv);
        rebindHeader();
      }
    }
    toast(personaId ? `已切换为「${conversation.persona_name || ''}」` : '已改为跟随默认人格', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** 设为/取消主对话 */
async function saveMainConv(conv, on) {
  try {
    if (on) await api(`/conversations/${conv.id}/main`, { method: 'POST' });
    else await api(`/conversations/${conv.id}/main`, { method: 'DELETE' });
    await loadConversations();
    const fresh = state.conversations.find((c) => c.id === conv.id);
    if (fresh) Object.assign(state.conv, fresh);
    const head = $('#chat-head');
    if (head) {
      head.innerHTML = chatHeaderHtml(state.conv);
      rebindHeader();
    }
    renderConvList();
    toast(on ? '已设为主对话：上下文不设上限，空闲时会主动找你' : '已取消主对话', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function bindMainConv(conv) {
  const btn = $('#btn-main');
  if (!btn) return;
  btn.onclick = () => saveMainConv(conv, !conv.is_main);
}

function bindConvPersona(conv) {
  const sel = $('#conv-persona');
  if (!sel) return;
  sel.onchange = () => saveConvPersona(conv, sel.value);
  sel.onclick = (e) => e.stopPropagation();
}

function renderChatPane() {
  const conv = state.conv;
  const pane = $('#chat-pane');
  if (!pane || !conv) return;
  pane.innerHTML = `
    <div class="chat-head" id="chat-head">${chatHeaderHtml(conv)}</div>
    <div class="chat-body" id="chat-body"></div>
    <div class="composer">
      <div class="box">
        <textarea class="textarea" id="composer-input" placeholder="以机器人身份发一条消息…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button class="btn primary" id="btn-send">发送</button>
      </div>
      <div class="foot" id="composer-foot">
        ${
          state.status?.onebot?.connected
            ? '消息会通过 OneBot 直接发到对方 QQ'
            : 'OneBot 未连接，暂时无法发送'
        }
      </div>
    </div>`;

  const body = $('#chat-body');
  body.innerHTML = state.messages.map((m, i) => bubbleHtml(m, state.messages[i - 1])).join('');
  if (!state.messages.length) {
    body.innerHTML = `<div class="empty" style="margin:auto"><div class="big">🕳️</div><p>这里还没有消息</p></div>`;
  }
  scrollChatBottom(false);

  $('#btn-send').onclick = sendFromComposer;
  $('#composer-input').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendFromComposer();
    }
  };
  $('#composer-input').oninput = (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(140, e.target.scrollHeight) + 'px';
  };
  $('#btn-memory').onclick = () => openMemoryDrawer(conv);
  bindMainConv(conv);
  bindConvPersona(conv);
  $('#btn-clear').onclick = async () => {
    if (!(await confirmDialog('清空消息', '会删除这个会话里的全部聊天记录，但保留会话和记忆备注。', '清空'))) return;
    await api(`/conversations/${conv.id}/clear`, { method: 'POST' });
    toast('已清空', 'ok');
    selectConversation(conv.id);
  };
  $('#btn-del-conv').onclick = async () => {
    if (!(await confirmDialog('删除会话', '会话和其中的全部消息都会被永久删除。', '删除'))) return;
    await api(`/conversations/${conv.id}`, { method: 'DELETE' });
    state.activeConvId = null;
    state.conversations = state.conversations.filter((c) => c.id !== conv.id);
    if (state.route === 'main') renderMain();
    else renderChats();
  };
  $('#btn-send').disabled = !state.status?.onebot?.connected;
}

function bubbleHtml(m, prev) {
  const out = m.role === 'assistant';
  const needDay = !prev || fmtDate(prev.created_at) !== fmtDate(m.created_at);
  const day = needDay ? `<div class="chat-day">${fmtDate(m.created_at)}</div>` : '';
  const who =
    !out && state.conv?.kind === 'group'
      ? `<div class="who">${esc(m.sender || '群友')}</div>`
      : '';
  const rawContent = String(m.content || '').trim();
  const shot = !out ? /^\[图片\]#([A-Za-z0-9._-]+)$/.exec(rawContent) : null;
  const img = !out ? /^\[图片[:：]\s*([\s\S]*?)\]$/.exec(rawContent) : null;
  const bubble = shot
    ? `<div class="bubble shot"><img class="shot-img" src="/api/images/${esc(shot[1])}" alt="图片" loading="lazy" onclick="window.open(this.src)" /></div>`
    : img
      ? `<div class="bubble media"><span class="media-tag">🖼 图片</span><span class="media-cap">${esc(
          img[1] || '对方发来一张图片'
        )}</span></div>`
      : `<div class="bubble">${esc(m.content)}</div>`;
  return `${day}
    <div class="msg ${out ? 'out' : 'in'}">
      <div>
        ${who}
        ${bubble}
      </div>
      <div class="stamp">${fmtTime(m.created_at)}</div>
    </div>`;
}

function appendBubble(m) {
  const body = $('#chat-body');
  if (!body) return;
  const prev = state.messages[state.messages.length - 1];
  const wrap = document.createElement('div');
  wrap.innerHTML = bubbleHtml(m, prev);
  while (wrap.firstChild) body.appendChild(wrap.firstChild);
  state.messages.push(m);
  scrollChatBottom(true);
  const head = $('#chat-head');
  if (head && state.conv) {
    state.conv.message_count = (state.conv.message_count || 0) + 1;
    head.innerHTML = chatHeaderHtml(state.conv);
    rebindHeader();
  }
}

function rebindHeader() {
  const conv = state.conv;
  if (!conv) return;
  $('#btn-memory').onclick = () => openMemoryDrawer(conv);
  bindMainConv(conv);
  bindConvPersona(conv);
  $('#btn-clear').onclick = async () => {
    if (!(await confirmDialog('清空消息', '会删除这个会话里的全部聊天记录，但保留会话和记忆备注。', '清空'))) return;
    await api(`/conversations/${conv.id}/clear`, { method: 'POST' });
    toast('已清空', 'ok');
    selectConversation(conv.id);
  };
  $('#btn-del-conv').onclick = async () => {
    if (!(await confirmDialog('删除会话', '会话和其中的全部消息都会被永久删除。', '删除'))) return;
    await api(`/conversations/${conv.id}`, { method: 'DELETE' });
    state.activeConvId = null;
    state.conversations = state.conversations.filter((c) => c.id !== conv.id);
    renderChats();
  };
}

function scrollChatBottom(smooth) {
  const body = $('#chat-body');
  if (!body) return;
  body.scrollTo({ top: body.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function setTyping(on) {
  state.typing = on;
  const body = $('#chat-body');
  if (!body) return;
  let node = $('#typing-node');
  if (on && !node) {
    node = document.createElement('div');
    node.id = 'typing-node';
    node.className = 'msg in';
    node.innerHTML = `<div class="typing"><i></i><i></i><i></i></div>`;
    body.appendChild(node);
    scrollChatBottom(true);
  } else if (!on && node) {
    node.remove();
  }
}

async function sendFromComposer() {
  const input = $('#composer-input');
  const text = input.value.trim();
  if (!text || !state.conv) return;
  const btn = $('#btn-send');
  btn.disabled = true;
  try {
    await api('/send', {
      method: 'POST',
      body: { kind: state.conv.kind, peer_id: state.conv.peer_id, text },
    });
    input.value = '';
    input.style.height = 'auto';
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = !state.status?.onebot?.connected;
  }
}

async function openMemoryDrawer(conv) {
  const personaOptions = [
    `<option value="" ${conv.persona_id ? '' : 'selected'}>跟随默认（${esc(conv.persona_name || state.personas.find((p) => p.id === Number(state.settings?.default_persona_id))?.name || '默认')}）</option>`,
    ...state.personas.map(
      (p) => `<option value="${p.id}" ${Number(conv.persona_id || 0) === p.id ? 'selected' : ''}>${esc(p.emoji)} ${esc(p.name)}</option>`
    ),
  ].join('');

  let userNotes = '';
  let userName = '';
  if (conv.kind === 'private') {
    try {
      const { users } = await api('/users');
      const u = users.find((x) => x.id === conv.peer_id);
      userNotes = u?.notes || '';
      userName = u?.nickname || '';
    } catch {
      /* ignore */
    }
  }

  openDrawer({
    title: '记忆 · ' + (conv.title || conv.peer_id),
    body: `
      <div class="field">
        <label class="label">会话使用的人格</label>
        <select class="select" id="mem-persona">${personaOptions}</select>
      </div>
      <div class="field">
        <label class="label">你们之间的记忆</label>
        <textarea class="textarea" id="mem-notes" style="min-height:140px" placeholder="例如：他最近在准备考研，压力很大；不喜欢被叫全名；养了一只叫豆豆的猫。">${esc(conv.notes || '')}</textarea>
        <div class="hintline">每次回复都会带上这段内容，用来做长期记忆。写得越具体，它越像真的记得。</div>
      </div>
      ${
        conv.kind === 'private'
          ? `<div class="field">
               <label class="label">关于对方${userName ? `（${esc(userName)}）` : ''}</label>
               <textarea class="textarea" id="mem-user" style="min-height:110px" placeholder="这个人自己的档案：称呼、喜好、雷点…">${esc(userNotes)}</textarea>
             </div>`
          : ''
      }
      <div class="field">
        <label class="switch"><input type="checkbox" id="mem-pin" ${conv.pinned ? 'checked' : ''} /><span class="track"></span><span>在列表里置顶</span></label>
      </div>
      <button class="btn primary" id="mem-save" style="width:100%">保存记忆</button>`,
    onMount: ({ root, close }) => {
      $('#mem-save', root).onclick = async () => {
        try {
          const patch = {
            notes: $('#mem-notes', root).value,
            persona_id: $('#mem-persona', root).value ? Number($('#mem-persona', root).value) : null,
            pinned: $('#mem-pin', root).checked ? 1 : 0,
          };
          const { conversation } = await api(`/conversations/${conv.id}`, { method: 'PATCH', body: patch });
          if (conv.kind === 'private' && $('#mem-user', root)) {
            await api(`/users/${conv.peer_id}`, { method: 'PATCH', body: { notes: $('#mem-user', root).value } });
          }
          state.conv = conversation;
          const head = $('#chat-head');
          if (head) head.innerHTML = chatHeaderHtml(conversation);
          close();
          toast('记忆已保存', 'ok');
          loadConversations();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    },
  });
}

/* ————————————————— 触发规则 ————————————————— */

function switchRow(id, label, desc, checked) {
  return `
    <div class="field" style="display:flex;align-items:flex-start;gap:12px">
      <label class="switch" style="margin-top:2px"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} /><span class="track"></span></label>
      <div>
        <div style="font-size:13.5px">${label}</div>
        <div class="hintline" style="margin-top:2px">${desc}</div>
      </div>
    </div>`;
}

async function renderRules() {
  const [{ settings: s }, convList, stickerPack] = await Promise.all([
    api('/settings'),
    api('/conversations'),
    api('/stickers').catch(() => ({ stickers: [], total: 0, enabled: 0 })),
  ]);
  state.settings = s;
  state.stickers = stickerPack.stickers || [];
  if (convList?.conversations) state.conversations = convList.conversations;
  const mainConv = state.conversations.find((c) => c.is_main) || null;
  view().innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><div><h3>回复范围</h3><div class="sub">什么场景下它会开口</div></div></div>
        ${switchRow('st-private', '私聊自动回复', '好友发来的私聊消息全部回复', s.trigger_private)}
        ${switchRow('st-group', '群聊自动回复', '允许在群里说话', s.trigger_group)}
        ${switchRow('st-needat', '群聊必须 @ 或唤醒词', '关闭后群里每条消息都会回复（慎用）', s.group_need_at)}
      </div>

      <div class="card">
        <div class="card-head"><div><h3>唤醒与打扰</h3><div class="sub">谁可以叫它、多容易被叫到</div></div></div>
        <div class="field">
          <label class="label">唤醒词（逗号分隔）</label>
          <input class="input" id="st-wake" value="${esc(s.wake_words)}" placeholder="小深, 机器人, 出来" />
          <div class="hintline">群聊里消息包含任意一个词就会回复</div>
        </div>
        <div class="field">
          <label class="label">随机插话概率 <span id="st-chance-label" class="badge">${s.random_chance}%</span></label>
          <input type="range" min="0" max="100" step="1" value="${s.random_chance}" id="st-chance" class="slider" />
          <div class="hintline">群聊未 @ 时，有该概率主动接话。0 表示从不</div>
        </div>
        <div class="field">
          <label class="label">回复冷却（毫秒）</label>
          <input class="input" id="st-cooldown" value="${s.cooldown_ms}" inputmode="numeric" />
          <div class="hintline">同一会话两次回复之间的最小间隔，防止刷屏</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>主对话与主动消息</h3><div class="sub">挑一个会话当「主对话」：记忆不设上限，闲下来会主动找你</div></div></div>
        <div class="field">
          <label class="label">当前主对话</label>
          <div class="row">
            <span class="badge ${mainConv ? 'ok' : ''}">${mainConv ? `⭐ ${esc(mainConv.title || mainConv.peer_id)}` : '未设置'}</span>
            <div class="spacer"></div>
            <a class="btn sm ghost" href="#/chats${mainConv ? `?c=${mainConv.id}` : ''}">去对话框选</a>
          </div>
          <div class="hintline">在「对话记录」里选中会话，点右上角 ☆ 主对话 即可切换；一次只有一个主对话</div>
        </div>
        <div class="field">
          <label class="label">上下文</label>
          <label class="switch"><input type="checkbox" id="st-mainall" ${s.main_unlimited_history ? 'checked' : ''} /><span class="track"></span><span>主对话不受「携带最近多少条」限制（按 ${s.main_history_char_budget} 字符预算装满）</span></label>
          <div class="hintline" style="margin-top:6px">预算按字符算，够放几十上百轮对话；超出的旧消息不会进提示词，但记录一直在库里</div>
        </div>
        <div class="field">
          <label class="label">定时主动发消息</label>
          <label class="switch"><input type="checkbox" id="st-proon" ${s.proactive_enabled ? 'checked' : ''} /><span class="track"></span><span>不开也不会打扰你，只是不主动开口</span></label>
          <div class="hintline">到点了会先看上一轮：像在等你回 → 轻轻催一句；已经聊完了（道晚安、只回了个「嗯」）→ 起个新话题，不硬接旧话。</div>
        </div>
        <div class="field">
          <label class="label">间隔（分钟）</label>
          <div class="row">
            <input class="input" id="st-pmin" value="${s.proactive_min_minutes}" inputmode="numeric" placeholder="最短" />
            <span class="muted">~</span>
            <input class="input" id="st-pmax" value="${s.proactive_max_minutes}" inputmode="numeric" placeholder="最长" />
          </div>
          <div class="hintline">每次在这个区间里随机取一个时间点，不定时才有真人感</div>
        </div>
        <div class="field">
          <label class="label">安静时段</label>
          <div class="row">
            <input class="input" type="time" id="st-pqs" value="${esc(s.proactive_quiet_start)}" />
            <span class="muted">到</span>
            <input class="input" type="time" id="st-pqe" value="${esc(s.proactive_quiet_end)}" />
          </div>
          <div class="hintline">这段时间不会主动发消息，可以跨零点</div>
        </div>
        <div class="field">
          <label class="label">空闲多久才主动（分钟）</label>
          <input class="input" id="st-pidle" value="${s.proactive_idle_minutes}" inputmode="numeric" />
          <div class="hintline">你们刚聊完不会插话，隔一会儿才找你</div>
        </div>
        <div class="field">
          <label class="label">每天最多 <span class="badge">${s.proactive_daily_cap} 条</span></label>
          <input class="input" id="st-pcap" value="${s.proactive_daily_cap}" inputmode="numeric" />
          <div class="hintline">主动聊天 + 追问都算在内</div>
        </div>
        <div class="field">
          <label class="label">没回你就追问</label>
          <label class="switch"><input type="checkbox" id="st-follow" ${s.followup_enabled ? 'checked' : ''} /><span class="track"></span><span>发出去的消息没人接，过一会儿再问一句</span></label>
        </div>
        <div class="form-grid">
          <div class="field">
            <label class="label">等多久没回就追问（分钟）</label>
            <input class="input" id="st-fmin" value="${s.followup_minutes}" inputmode="numeric" />
          </div>
          <div class="field">
            <label class="label">同一条消息最多追问 <span class="badge">${s.followup_max} 次</span></label>
            <input class="input" id="st-fmax" value="${s.followup_max}" inputmode="numeric" />
          </div>
        </div>
        <div class="hintline" style="margin-top:-6px;margin-bottom:12px">追问会半开玩笑地来一句「怎么不理我」「人呢」；连问超过次数就停下来，不刷屏</div>
        <div class="field" style="margin-bottom:0">
          <div class="row">
            <button class="btn sm ghost" id="btn-pnow">现在试一条</button>
            <span class="muted" id="st-pnow-hint" style="font-size:12px"></span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>白名单 / 黑名单</h3><div class="sub">一行一个 QQ 号或群号，也可用逗号分隔</div></div></div>
        <div class="field">
          <label class="label">白名单（留空表示不限制）</label>
          <textarea class="textarea" id="st-white" style="min-height:80px" placeholder="123456789">${esc(s.whitelist)}</textarea>
        </div>
        <div class="field">
          <label class="label">黑名单（永不回复）</label>
          <textarea class="textarea" id="st-black" style="min-height:80px" placeholder="987654321">${esc(s.blacklist)}</textarea>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>说话方式</h3><div class="sub">像不像真人，很大程度靠这里</div></div></div>
        <div class="field">
          <label class="label">携带最近多少条上下文</label>
          <input class="input" id="st-history" value="${s.history_turns}" inputmode="numeric" />
        </div>
        <div class="field">
          <label class="label">长回复拆成多条气泡</label>
          <label class="switch"><input type="checkbox" id="st-split" ${s.split_reply ? 'checked' : ''} /><span class="track"></span><span>开启后更像在打字</span></label>
        </div>
        <div class="field">
          <label class="label">一次最多几条气泡</label>
          <div class="row">
            <input class="input" id="st-maxparts" value="${s.reply_max_parts}" inputmode="numeric" placeholder="1 ~ 5" />
            <span class="muted">条</span>
          </div>
          <div class="hintline">一条完整回复可以先接上文、再说自己的想法；情绪上头时实际条数会再放宽一点。</div>
        </div>
        <div class="field">
          <label class="label">气泡间隔（毫秒）</label>
          <div class="row">
            <input class="input" id="st-dmin" value="${s.segment_delay_min}" inputmode="numeric" placeholder="最小" />
            <span class="muted">~</span>
            <input class="input" id="st-dmax" value="${s.segment_delay_max}" inputmode="numeric" placeholder="最大" />
          </div>
        </div>
        <div class="field" style="margin-bottom:0">
          <label class="label">清除 Markdown 排版</label>
          <label class="switch"><input type="checkbox" id="st-plain" ${s.plain_text ? 'checked' : ''} /><span class="track"></span><span>把 **加粗**、标题、列表转成 QQ 友好纯文本</span></label>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><h3>表情包库</h3><div class="sub">把号码里收藏的表情包拉到本地，让它自己挑着发</div></div>
          <button class="btn sm ghost" id="btn-sync-stickers">从 QQ 收藏同步</button>
        </div>
        <div class="field">
          <label class="label">库里共 <span class="badge">${stickerPack.total || 0}</span> 个，启用 <span class="badge">${stickerPack.enabled || 0}</span> 个</label>
          <div class="sticker-grid" id="sticker-grid">
            ${
              (stickerPack.stickers || []).length
                ? stickerPack.stickers
                    .map(
                      (st) => `<button class="sticker ${st.enabled ? '' : 'off'}" data-sticker="${st.id}" title="${esc(st.descr || '还没识别')}｜用过 ${st.used_count} 次，点一下切换启用">
                        <img src="/api/stickers/${st.id}/file" alt="" loading="lazy" />
                      </button>`
                    )
                    .join('')
                : '<div class="hintline">还没有表情包。点右上角「从 QQ 收藏同步」，会把账号收藏夹里的表情抓到本地。</div>'
            }
          </div>
          <div class="hintline">点表情可以停用/启用；停用的不会被抽到。表情文件存在 data/stickers/，不联网也能用</div>
          <div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
            <button class="btn sm ghost" id="btn-desc-stickers">识别含义</button>
            <input class="input" id="st-find" placeholder="让它自己去网上找，比如：委屈 猫猫" style="max-width:220px" />
            <button class="btn sm ghost" id="btn-find-stickers">网上找几张</button>
            <span class="muted" id="sticker-msg" style="font-size:12px"></span>
          </div>
        </div>
        <div class="field">
          <label class="label">允许发表情包</label>
          <label class="switch"><input type="checkbox" id="st-stickon" ${s.sticker_enabled ? 'checked' : ''} /><span class="track"></span><span>它想发的时候会发（提示词里教了用 [[sticker]] 标记）</span></label>
        </div>
        <div class="field" style="margin-bottom:0">
          <div class="divider" style="margin:14px 0 10px"></div>
          ${switchRow('st-continue', '自己说完接着聊', '说完了也别停，过一会儿主动再补一句把话题推下去', s.continue_enabled)}
          <div class="row" style="margin-top:10px">
            <div class="field grow">
              <label class="label">隔多久再补（秒）</label>
              <input id="st-cdelay" class="input" type="number" min="5" max="600" step="5" value="${Math.round((Number(s.continue_delay_ms) || 45000) / 1000)}" />
            </div>
            <div class="field grow">
              <label class="label">概率 <span id="st-cchance-label" class="badge">${s.continue_chance}%</span></label>
              <input type="range" min="0" max="100" step="5" value="${s.continue_chance}" id="st-cchance" class="slider" />
            </div>
          </div>
          <label class="label">额外随缘配图概率 <span id="st-stickchance-label" class="badge">${s.sticker_chance}%</span></label>
          <input type="range" min="0" max="100" step="5" value="${s.sticker_chance}" id="st-stickchance" class="slider" />
          <div class="hintline">即使它没主动标记，也有这个概率顺手配一张。0 = 只在它明确想发时才发</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>QQ 玩法与网络用语</h3><div class="sub">教它怎么在这款软件里当个正常人</div></div></div>
        <div class="field">
          <label class="label">注入 QQ 常识</label>
          <label class="switch"><input type="checkbox" id="st-knowledge" ${s.qq_knowledge ? 'checked' : ''} /><span class="track"></span><span>私聊/群聊/@/引用/戳一戳/表情包/撤回等玩法，按场景自动裁剪</span></label>
        </div>
        <div class="field" style="margin-bottom:0">
          <label class="label">网络用语词条数 <span class="badge">${s.slang_limit}</span></label>
          <input class="input" id="st-slang" value="${s.slang_limit}" inputmode="numeric" placeholder="16" />
          <div class="hintline">注入多少条当前流行语（0 = 不注入，最多 25 条）。词条越少越省 token</div>
        </div>
      </div>
    </div>

    <div class="row" style="margin-top:18px">
      <span class="muted" style="font-size:12px">规则会立刻生效，无需重启</span>
      <div class="spacer"></div>
      <button class="btn primary" id="btn-save-rules">保存规则</button>
    </div>`;

  $('#st-chance').oninput = (e) => ($('#st-chance-label').textContent = `${e.target.value}%`);
  $('#st-stickchance').oninput = (e) => ($('#st-stickchance-label').textContent = `${e.target.value}%`);
  const stickerMsg = (txt) => {
    const el = $('#sticker-msg');
    if (el) el.textContent = txt;
  };
  $('#btn-desc-stickers').onclick = async () => {
    stickerMsg('识别中…（一次 8 张，可多点几次）');
    const r = await api('/api/stickers/describe', { method: 'POST', body: { limit: 8 } });
    if (!r.ok) return stickerMsg(r.data?.error || '识别失败');
    stickerMsg(`已识别 ${r.data.described} 个，还剩 ${r.data.remaining} 个没描述`);
    RENDERERS.rules();
  };
  $('#btn-find-stickers').onclick = async () => {
    const q = ($('#st-find').value || '').trim();
    if (!q) return stickerMsg('先写个搜索词');
    stickerMsg('上网找…');
    const r = await api('/api/stickers/search', { method: 'POST', body: { q, count: 6 } });
    if (!r.ok) return stickerMsg(r.data?.error || '没找到');
    stickerMsg(`新增 ${r.data.saved} 张（带描述 ${r.data.described}）`);
    RENDERERS.rules();
  };

  $('#btn-sync-stickers').onclick = async () => {
    const btn = $('#btn-sync-stickers');
    btn.disabled = true;
    btn.textContent = '同步中…';
    try {
      const res = await api('/stickers', { method: 'POST', body: { count: 150 } });
      if (!res.ok) throw new Error(res.error || '同步失败');
      toast(res.fetched ? `拿到 ${res.fetched} 个，新增 ${res.saved} 个` : res.hint || '账号里没有表情包', res.fetched ? 'ok' : 'warn');
      renderRules();
      return;
    } catch (err) {
      toast(err.message, 'err');
    }
    btn.disabled = false;
    btn.textContent = '从 QQ 收藏同步';
  };
  $$('#sticker-grid .sticker').forEach((node) => {
    node.onclick = async () => {
      const on = node.classList.contains('off');
      try {
        await api(`/stickers/${node.dataset.sticker}`, { method: 'PATCH', body: { enabled: on } });
        node.classList.toggle('off', !on);
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });
  $('#btn-pnow').onclick = async () => {
    const hint = $('#st-pnow-hint');
    hint.textContent = '生成中…';
    try {
      const res = await api('/proactive/now', { method: 'POST' });
      if (res.ok) hint.textContent = `已发出：${res.text}`;
      else hint.textContent = `没发出去：${res.error || res.skipped || '未知原因'}`;
    } catch (err) {
      hint.textContent = err.message;
    }
  };
  $('#btn-save-rules').onclick = async () => {
    const body = {
      trigger_private: $('#st-private').checked,
      trigger_group: $('#st-group').checked,
      group_need_at: $('#st-needat').checked,
      wake_words: $('#st-wake').value,
      random_chance: Number($('#st-chance').value),
      cooldown_ms: Number($('#st-cooldown').value) || 0,
      whitelist: $('#st-white').value,
      blacklist: $('#st-black').value,
      history_turns: Number($('#st-history').value) || 12,
      split_reply: $('#st-split').checked,
      reply_max_parts: Math.max(1, Math.min(5, Number($('#st-maxparts').value) || 1)),
      segment_delay_min: Number($('#st-dmin').value) || 0,
      segment_delay_max: Number($('#st-dmax').value) || 0,
      plain_text: $('#st-plain').checked,
      sticker_enabled: $('#st-stickon').checked,
      sticker_chance: Number($('#st-stickchance').value) || 0,
      continue_enabled: $('#st-continue').checked,
      continue_chance: Number($('#st-cchance').value) || 0,
      continue_delay_ms: Math.round((Number($('#st-cdelay').value) || 45) * 1000),
      main_unlimited_history: $('#st-mainall').checked,
      proactive_enabled: $('#st-proon').checked,
      proactive_min_minutes: Number($('#st-pmin').value) || 90,
      proactive_max_minutes: Number($('#st-pmax').value) || 240,
      proactive_quiet_start: $('#st-pqs').value || '00:30',
      proactive_quiet_end: $('#st-pqe').value || '08:30',
      proactive_idle_minutes: Number($('#st-pidle').value) || 45,
      proactive_daily_cap: Number($('#st-pcap').value) || 8,
      followup_enabled: $('#st-follow').checked,
      followup_minutes: Number($('#st-fmin').value) || 12,
      followup_max: Number($('#st-fmax').value) || 0,
      qq_knowledge: $('#st-knowledge').checked,
      slang_limit: Math.max(0, Math.min(25, Number($('#st-slang').value) || 0)),
    };
    try {
      const res = await api('/settings', { method: 'PUT', body });
      state.settings = res.settings;
      toast('规则已保存', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

/* ————————————————— 设置 ————————————————— */

async function renderSettings() {
  const [{ settings: s }, logsRes] = await Promise.all([api('/settings'), api('/logs?limit=150')]);
  state.settings = s;
  const logs = logsRes?.logs || [];

  view().innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><div><h3>模型 API</h3><div class="sub">任何 OpenAI 兼容接口都行（DeepSeek、中转站、本地 vLLM）</div></div></div>
        <div class="field">
          <label class="label">Base URL</label>
          <input class="input" id="cfg-base" value="${esc(s.api_base)}" placeholder="https://api.deepseek.com" />
        </div>
        <div class="field">
          <label class="label">API Key</label>
          <div class="row">
            <input class="input" id="cfg-key" type="password" value="${esc(s.api_key)}" placeholder="sk-..." />
            <button class="btn sm" id="btn-eye" type="button">显示</button>
          </div>
          <div class="hintline">只保存在本地 data/bot.db，不会上传</div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label class="label">模型</label>
            <input class="input" id="cfg-model" value="${esc(s.model)}" placeholder="deepseek-chat" />
          </div>
          <div class="field">
            <label class="label">温度</label>
            <input class="input" id="cfg-temp" value="${esc(s.temperature)}" />
          </div>
          <div class="field">
            <label class="label">最大回复 tokens</label>
            <input class="input" id="cfg-max" value="${esc(s.max_tokens)}" />
          </div>
          <div class="field">
            <label class="label">超时（毫秒）</label>
            <input class="input" id="cfg-timeout" value="${esc(s.request_timeout_ms)}" />
          </div>
        </div>
        <div class="row">
          <button class="btn" id="btn-test">测试连接</button>
          <span class="muted" id="test-result" style="font-size:12px"></span>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>OneBot 连接</h3><div class="sub">SnowCat（NapCat 内核 + QQ 9.9.37 便携运行时）已随项目附带；其他 OneBot v11 实现也可接入</div></div></div>
        <div class="field">
          <label class="label">反向 WebSocket 端口</label>
          <input class="input" id="cfg-wsport" value="${esc(s.onebot_ws_port)}" />
          <div class="hintline">保存后立即生效（端口被占用会监听失败，见页面底部运行日志）。当前地址：ws://${esc(location.hostname)}:${esc(String(s.onebot_ws_port))}/onebot</div>
        </div>
        <div class="field">
          <label class="label">接入 Token（可选）</label>
          <input class="input" id="cfg-token" value="${esc(s.onebot_token)}" placeholder="留空表示不校验" />
        </div>
        <div class="field">
          <label class="label">正向 WebSocket（可选，留空则不连）</label>
          <input class="input" id="cfg-fwd" value="${esc(s.forward_ws_url)}" placeholder="ws://127.0.0.1:3001" />
        </div>
        <div class="field">
          <label class="label">正向连接 Token</label>
          <input class="input" id="cfg-fwdtoken" value="${esc(s.forward_ws_token)}" />
        </div>
        <div class="field" style="margin-bottom:0">
          <label class="switch"><input type="checkbox" id="cfg-onebot-enabled" ${s.onebot_enabled ? 'checked' : ''} /><span class="track"></span><span>允许 OneBot 连接</span></label>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>识图（可选）</h3><div class="sub">需要一个支持图片输入的模型；配好后对方发图，它会先"看一眼"再回</div></div></div>
        <div class="field">
          <label class="switch"><input type="checkbox" id="cfg-vision-on" ${s.vision_enabled ? 'checked' : ''} /><span class="track"></span><span>开启识图</span></label>
          <div class="hintline">默认走主模型之外的视觉模型；不开也能用，只是看不到图片内容</div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label class="label">识图模型</label>
            <input class="input" id="cfg-vmodel" value="${esc(s.vision_model)}" placeholder="qwen-vl-max / glm-4v / gpt-4o" />
          </div>
          <div class="field">
            <label class="label">识图 Base URL（留空=跟随主模型）</label>
            <input class="input" id="cfg-vbase" value="${esc(s.vision_api_base)}" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" title="例如 https://dashscope.aliyuncs.com/compatible-mode/v1" />
          </div>
        </div>
        <div class="field">
          <label class="label">识图 API Key（留空=跟随主模型）</label>
          <input class="input" id="cfg-vkey" type="password" value="${esc(s.vision_api_key)}" placeholder="sk-..." />
        </div>
        <div class="row">
          <button class="btn sm ghost" id="btn-vision-test">测试识图</button>
          <span class="muted" id="vision-result" style="font-size:12px">${state.status?.vision?.ready ? '识图模型已就绪' : '未配置'}</span>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>DSH 转交</h3><div class="sub">主对话里出现这些关键词时，把你的话原样交给 dsh 命令跑，跑完把完整输出截图发回 QQ</div></div><span class="badge ${state.status?.dsh?.configured ? 'ok' : ''}">${state.status?.dsh?.configured ? '已配置' : '未配置命令'}</span></div>
        <div class="field">
          <label class="switch"><input type="checkbox" id="cfg-dsh-on" ${s.dsh_enabled ? 'checked' : ''} /><span class="track"></span><span>开启转交</span></label>
          <div class="hintline">只对「主对话」生效，其他会话不受影响</div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label class="label">触发关键词（逗号分隔）</label>
            <input class="input" id="cfg-dsh-kw" value="${esc(s.dsh_keywords)}" placeholder="dsh,harness" />
          </div>
          <div class="field">
            <label class="label">超时（毫秒）</label>
            <input class="input" id="cfg-dsh-timeout" value="${esc(s.dsh_timeout_ms)}" placeholder="600000" />
          </div>
        </div>
        <div class="field">
          <label class="label">dsh 命令</label>
          <input class="input" id="cfg-dsh-cmd" value="${esc(s.dsh_command)}" placeholder="例如：dsh exec --print &quot;{prompt}&quot;" />
          <div class="hintline">可用占位符 <code>{prompt}</code>（原话）与 <code>{prompt_file}</code>（写好的文本文件路径）；都不写就把文件路径追加到命令后面。</div>
        </div>
        <div class="field" style="margin-bottom:0">
          <label class="label">工作目录（可选）</label>
          <input class="input" id="cfg-dsh-cwd" value="${esc(s.dsh_cwd)}" placeholder="C:\path	o\project" />
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><h3>接入步骤</h3><div class="sub">SnowCat（NapCat 内核）已随项目附带，不需要另装协议端</div></div>
          <button class="btn sm ghost" id="btn-copy-lagrange">复制接入地址</button>
        </div>
        <ol style="margin:0;padding-left:18px;line-height:1.9;font-size:12.5px;color:var(--text-2)">
          <li>双击项目根目录的 <code class="mono">start-snowcat.cmd</code>：先拉起面板，再启动内置的 QQ（SnowCat 便携运行时）</li>
          <li>首次登录：在雪猫后台 <a href="http://127.0.0.1:6099/webui/" target="_blank" rel="noreferrer" style="color:var(--accent)">127.0.0.1:6099/webui</a> 用手机 QQ 扫码（建议小号）；登录过后再启动会自动恢复</li>
          <li>登录成功后，内置的 OneBot 11 会自动连到本面板的 <code class="mono">ws://127.0.0.1:7801/onebot</code>，左上角变「在线」即可聊天</li>
          <li>改过端口或 Token 时，点「复制接入地址」拿到新地址，填进雪猫后台的网络配置（或 <code class="mono">config\\onebot11_&lt;QQ号&gt;.json</code>）</li>
        </ol>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>数据</h3><div class="sub">全部记录存在本地 SQLite</div></div></div>
        <div class="kv"><span class="k">会话</span><span class="v">${state.status?.stats?.conversations ?? '-'}</span></div>
        <div class="kv"><span class="k">消息</span><span class="v">${state.status?.stats?.messages ?? '-'}</span></div>
        <div class="kv"><span class="k">人格</span><span class="v">${state.personas.length || '-'}</span></div>
        <div class="row" style="margin-top:14px">
          <button class="btn sm" id="btn-clear-logs">清空日志</button>
        </div>
      </div>
    </div>

    <div class="row" style="margin-top:18px">
      <span class="muted" style="font-size:12px">改完记得保存</span>
      <div class="spacer"></div>
      <button class="btn primary" id="btn-save-settings">保存设置</button>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div><h3>运行日志</h3><div class="sub">最近 150 条</div></div><button class="btn sm ghost" id="btn-reload-logs">刷新</button></div>
      <div style="max-height:360px;overflow:auto" id="log-box">
        ${
          logs.length
            ? logs
                .map(
                  (l) => `<div class="log-line">
                    <span class="t">${fmtTime(l.created_at)}</span>
                    <span class="lv ${esc(l.level)}">${esc(l.level)}</span>
                    <span class="m">${l.scope ? `<span class="scope">${esc(l.scope)}</span> · ` : ''}${esc(l.message)}</span>
                  </div>`
                )
                .join('')
            : `<div class="empty"><p>暂无日志</p></div>`
        }
      </div>
    </div>`;

  $('#btn-eye').onclick = () => {
    const input = $('#cfg-key');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#btn-eye').textContent = show ? '隐藏' : '显示';
  };

  $('#btn-vision-test').onclick = async () => {
    const out = $('#vision-result');
    out.textContent = '保存并测试中…';
    try {
      // 先按当前表单保存，避免「填了但没保存就测试」被当成未配置
      await saveSettings();
      const res = await api('/vision/test', { method: 'POST' });
      out.textContent = res.ok ? `可用：${res.sample}` : `不可用：${res.error}`;
      out.style.color = res.ok ? 'var(--ok)' : 'var(--err)';
    } catch (err) {
      out.textContent = `不可用：${err.message}`;
      out.style.color = 'var(--err)';
    }
  };
  $('#btn-test').onclick = async () => {
    const btn = $('#btn-test');
    btn.disabled = true;
    $('#test-result').textContent = '请求中…';
    try {
      await saveSettings();
      const res = await api('/llm/test', { method: 'POST' });
      $('#test-result').innerHTML = `<span style="color:var(--ok)">✓ ${esc(res.reply)} · ${res.ms}ms</span>`;
    } catch (err) {
      $('#test-result').innerHTML = `<span style="color:var(--err)">✗ ${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  };

  $('#btn-save-settings').onclick = async () => {
    try {
      await saveSettings();
      toast('设置已保存', 'ok');
      toast('Key / 模型立即生效；端口保存后会马上重新监听', '');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  $('#btn-copy-lagrange').onclick = async () => {
    const port = Number($('#cfg-wsport')?.value) || 7801;
    const token = $('#cfg-token')?.value.trim() || '';
    const url = `ws://127.0.0.1:${port}/onebot${token ? `?access_token=${encodeURIComponent(token)}` : ''}`;
    await copyText(url);
  };

  $('#btn-clear-logs').onclick = async () => {
    await api('/logs', { method: 'DELETE' });
    toast('日志已清空', 'ok');
    renderSettings();
  };
  $('#btn-reload-logs').onclick = () => renderSettings();

  async function saveSettings() {
    const body = {
      api_base: $('#cfg-base').value.trim(),
      api_key: $('#cfg-key').value.trim(),
      vision_enabled: $('#cfg-vision-on').checked,
      dsh_enabled: $('#cfg-dsh-on').checked,
      dsh_keywords: $('#cfg-dsh-kw').value.trim(),
      dsh_command: $('#cfg-dsh-cmd').value.trim(),
      dsh_timeout_ms: $('#cfg-dsh-timeout').value.trim(),
      dsh_cwd: $('#cfg-dsh-cwd').value.trim(),
      vision_model: $('#cfg-vmodel').value.trim(),
      vision_api_base: $('#cfg-vbase').value.trim(),
      vision_api_key: $('#cfg-vkey').value.trim(),
      model: $('#cfg-model').value.trim(),
      temperature: Number($('#cfg-temp').value) || 0,
      max_tokens: Number($('#cfg-max').value) || 800,
      request_timeout_ms: Number($('#cfg-timeout').value) || 60000,
      onebot_ws_port: Number($('#cfg-wsport').value) || 7801,
      onebot_token: $('#cfg-token').value.trim(),
      forward_ws_url: $('#cfg-fwd').value.trim(),
      forward_ws_token: $('#cfg-fwdtoken').value.trim(),
      onebot_enabled: $('#cfg-onebot-enabled').checked,
    };
    const res = await api('/settings', { method: 'PUT', body });
    state.settings = res.settings;
    return res.settings;
  }
}

/* ————————————————— 启动 ————————————————— */

async function boot() {
  const { settings } = await api('/settings').catch(() => ({ settings: null }));
  state.settings = settings;
  const { personas } = await api('/personas').catch(() => ({ personas: [] }));
  state.personas = personas;

  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      location.hash = `#/${btn.dataset.route}`;
    });
  });

  window.addEventListener('hashchange', () => {
    view().className = 'view';
    navigate(routeName());
  });

  await refreshStatus();
  connectWs();
  await navigate(routeName());
  setInterval(() => {
    if (state.route === 'dashboard') refreshStatus();
  }, 15000);
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="toast show err" style="bottom:auto;top:20px">初始化失败：${esc(err.message)}</div>`
  );
});
