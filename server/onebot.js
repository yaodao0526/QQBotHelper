import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { getSettings } from './config.js';
import { log } from './db.js';

/**
 * OneBot v11 连接层。
 *  · 反向 WS（推荐）：NapCat / Lagrange 以「WebSocket 客户端」连到 ws://127.0.0.1:<port>/onebot
 *    本类自己监听 settings.onebot_ws_port（默认 7801），与面板端口（7800）分开。
 *  · 正向 WS：本服务主动连到 NapCat 的 ws://127.0.0.1:3001
 */
export class OneBot extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.obServer = null; // 反向 WS 独立 http server
    this.obServerPort = 0;
    this.wss = new WebSocketServer({ noServer: true });
    this.reverse = null; // 当前的反向连接
    this.forward = null; // 正向连接
    this.selfId = null;
    this.nickname = '';
    this.mode = 'none';
    this.pending = new Map();
    this.seq = 0;
    this.lastEventAt = 0;
    this.forwardTimer = null;
    this.stopped = true;
    this.wss.on('connection', (ws, req) => this.#onReverse(ws, req));
  }

  /** 由 http server 的 upgrade 事件调用 */
  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/onebot') return false;
    const s = getSettings();
    if (!s.onebot_enabled) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }
    const token = String(s.onebot_token || '').trim();
    if (token) {
      const given =
        (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim() ||
        url.searchParams.get('access_token') ||
        '';
      if (given !== token) {
        log('warn', 'onebot', '反向连接 token 校验失败，已拒绝');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return true;
      }
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    return true;
  }

  #onReverse(ws, req) {
    const role = String(req.headers['x-client-role'] || 'Universal');
    const selfId = req.headers['x-self-id'] ? String(req.headers['x-self-id']) : '';
    if (this.reverse && this.reverse.readyState === WebSocket.OPEN) {
      try { this.reverse.close(4000, 'replaced'); } catch { /* ignore */ }
    }
    this.reverse = ws;
    this.mode = 'reverse';
    this.selfId = selfId || this.selfId;
    log('info', 'onebot', `反向连接已建立（self_id=${selfId || '?'}，role=${role}）`);
    this.#emitStatus();

    ws.on('message', (buf) => this.#onData(buf));
    ws.on('close', () => {
      if (this.reverse === ws) {
        this.reverse = null;
        this.mode = 'none';
        log('warn', 'onebot', '反向连接已断开');
        this.#emitStatus();
      }
    });
    ws.on('error', (err) => log('warn', 'onebot', `反向连接错误：${err.message}`));

    this.sendAction('get_login_info')
      .then((info) => {
        this.nickname = info?.nickname || '';
        this.selfId = String(info?.user_id || this.selfId || '');
        this.#emitStatus();
      })
      .catch(() => {});
  }

  #onData(buf) {
    let data;
    try {
      data = JSON.parse(String(buf));
    } catch {
      log('warn', 'onebot', '收到非 JSON 数据，已忽略');
      return;
    }
    if (data && data.echo != null && this.pending.has(String(data.echo))) {
      const p = this.pending.get(String(data.echo));
      this.pending.delete(String(data.echo));
      clearTimeout(p.timer);
      if (data.status === 'failed' || (data.retcode != null && data.retcode !== 0)) {
        p.reject(new Error(`OneBot ${data.status || 'failed'} retcode=${data.retcode} ${data.wording || data.message || ''}`.trim()));
      } else {
        p.resolve(data.data ?? {});
      }
      return;
    }
    this.lastEventAt = Date.now();
    if (data?.post_type) this.emit('event', data);
  }

  #emitStatus() {
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return {
      connected: Boolean(this.reverse || this.forward),
      mode: this.mode,
      self_id: this.selfId || '',
      nickname: this.nickname,
      last_event_at: this.lastEventAt,
      listen_port: this.obServerPort || 0,
    };
  }

  sendAction(action, params = {}, timeout = 15000) {
    const ws =
      this.reverse && this.reverse.readyState === WebSocket.OPEN
        ? this.reverse
        : this.forward && this.forward.readyState === WebSocket.OPEN
          ? this.forward
          : null;
    if (!ws) return Promise.reject(new Error('OneBot 未连接'));
    const echo = `e${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 调用超时：${action}`));
      }, timeout);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(err);
      }
    });
  }

  // —— 便捷方法 ——
  sendPrivate(userId, message) {
    return this.sendAction('send_private_msg', { user_id: Number(userId), message });
  }

  sendGroup(groupId, message) {
    return this.sendAction('send_group_msg', { group_id: Number(groupId), message });
  }

  // —— 正向连接 ——
  #connectForward() {
    const s = getSettings();
    const url = String(s.forward_ws_url || '').trim();
    if (!url || this.stopped) return;
    const headers = { 'X-Client-Role': 'Universal', 'X-Self-ID': this.selfId || '' };
    const token = String(s.forward_ws_token || '').trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    let ws;
    try {
      ws = new WebSocket(url, { headers });
    } catch (err) {
      log('warn', 'onebot', `正向连接创建失败：${err.message}`);
      this.#scheduleReconnect();
      return;
    }
    this.forward = ws;
    ws.on('open', () => {
      this.mode = this.reverse ? 'reverse' : 'forward';
      log('info', 'onebot', `正向连接成功：${url}`);
      this.#emitStatus();
      this.sendAction('get_login_info')
        .then((info) => {
          this.nickname = info?.nickname || this.nickname;
          this.selfId = String(info?.user_id || this.selfId || '');
          this.#emitStatus();
        })
        .catch(() => {});
    });
    ws.on('message', (buf) => this.#onData(buf));
    ws.on('close', () => {
      if (this.forward === ws) {
        this.forward = null;
        if (this.mode === 'forward') this.mode = this.reverse ? 'reverse' : 'none';
        log('warn', 'onebot', '正向连接断开，5 秒后重试');
        this.#emitStatus();
        this.#scheduleReconnect();
      }
    });
    ws.on('error', (err) => log('warn', 'onebot', `正向连接错误：${err.message}`));
  }

  #scheduleReconnect() {
    if (this.stopped || this.forwardTimer) return;
    this.forwardTimer = setTimeout(() => {
      this.forwardTimer = null;
      this.#connectForward();
    }, 5000);
  }

  /**
   * 按配置同步「反向 WS 监听端口」：端口或开关变化时重建监听。
   * 监听失败的详细错误写日志，并在 status 里通过 listen_port=0 体现。
   */
  #syncReverseServer() {
    if (this.stopped) return;
    const s = getSettings();
    const port = Number(s.onebot_ws_port) || 0;
    if (!s.onebot_enabled || !port) {
      this.#closeReverseServer();
      return;
    }
    if (this.obServer && this.obServerPort === port) return;
    this.#closeReverseServer();

    const srv = http.createServer((req, res) => {
      res
        .writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('426 Upgrade Required — 这是 OneBot v11 反向 WebSocket 入口，请把 NapCat 的 WS 地址指向 /onebot');
    });
    srv.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/onebot' || !this.handleUpgrade(req, socket, head)) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
    });
    srv.on('error', (err) => {
      if (this.obServer === srv) {
        this.obServer = null;
        this.obServerPort = 0;
      }
      if (err.code === 'EADDRINUSE') {
        log('error', 'onebot', `反向 WS 端口 ${port} 已被占用，请在设置里换一个端口`);
      } else {
        log('error', 'onebot', `反向 WS 监听失败：${err.message}`);
      }
      this.#emitStatus();
    });
    srv.listen(port, this.host, () => {
      log('info', 'onebot', `OneBot 反向 WS 已监听：ws://${this.host}:${port}/onebot`);
      this.#emitStatus();
    });
    this.obServer = srv;
    this.obServerPort = port;
  }

  #closeReverseServer() {
    const srv = this.obServer;
    if (!srv) return;
    this.obServer = null;
    this.obServerPort = 0;
    try { srv.close(); } catch { /* ignore */ }
    if (this.reverse) {
      try { this.reverse.close(4001, 'listen port changed'); } catch { /* ignore */ }
    }
  }

  start() {
    this.stopped = false;
    this.reconfigure();
  }

  /** 配置变更后重新应用（反向监听端口 / 正向连接） */
  reconfigure() {
    const s = getSettings();
    this.#syncReverseServer();
    const shouldForward = Boolean(String(s.forward_ws_url || '').trim());
    if (shouldForward && !this.forward) this.#connectForward();
    if (!shouldForward && this.forward) {
      try { this.forward.close(); } catch { /* ignore */ }
      this.forward = null;
      if (this.mode === 'forward') this.mode = this.reverse ? 'reverse' : 'none';
      this.#emitStatus();
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.forwardTimer);
    try { this.reverse?.close(); } catch { /* ignore */ }
    try { this.forward?.close(); } catch { /* ignore */ }
    this.#closeReverseServer();
    this.wss.close();
  }
}
