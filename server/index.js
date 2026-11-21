import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { openDb, log, pruneLogs } from './db.js';
import { loadSettings, getSettings } from './config.js';
import { seedPersonas } from './personas.js';
import { OneBot } from './onebot.js';
import { Bot } from './bot.js';
import { createApi } from './api.js';
import { Proactive } from './proactive.js';
import { DshRelay } from './dsh.js';
import { initStickers } from './stickers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : path.join(ROOT, 'data');
const HOST = process.env.BOT_HOST || '127.0.0.1';
const PORT = Number(process.env.BOT_PORT || 7800);
const ONEBOT_PORT = Number(process.env.BOT_ONEBOT_PORT || 0);
// 双击 start.cmd 时置 1：服务起来后自动打开默认浏览器，省掉手动点链接
const OPEN_BROWSER = /^(1|true|yes|on)$/i.test(String(process.env.BOT_OPEN || ''));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

openDb(DATA_DIR);
loadSettings();
seedPersonas();

// 环境变量可覆盖 OneBot 端口（方便测试）
if (ONEBOT_PORT) {
  const s = getSettings();
  s.onebot_ws_port = ONEBOT_PORT;
}

// ——————————————— 面板实时广播 ———————————————
const panelWss = new WebSocketServer({ noServer: true });
const panelClients = new Set();

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of panelClients) {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }
}

panelWss.on('connection', (ws) => {
  panelClients.add(ws);
  ws.on('close', () => panelClients.delete(ws));
  ws.on('error', () => panelClients.delete(ws));
  try {
    ws.send(JSON.stringify({ type: 'hello', at: Date.now() }));
  } catch {
    /* ignore */
  }
});

// ——————————————— 核心对象 ———————————————
const ob = new OneBot({ host: HOST });
initStickers(DATA_DIR);
const imagesDir = path.join(DATA_DIR, 'images');
fs.mkdirSync(imagesDir, { recursive: true });
const bot = new Bot(ob, { broadcast });
bot.imagesDir = imagesDir;
const proactive = new Proactive(bot);
const dsh = new DshRelay(bot, { dataDir: DATA_DIR });
bot.dsh = dsh;
const api = createApi({ bot, ob, broadcast, proactive, dsh });

ob.on('event', (ev) => bot.handleEvent(ev));
ob.on('status', (status) => {
  broadcast({ type: 'status' });
  if (status.connected && status.nickname) {
    log('info', 'onebot', `账号已就绪：${status.nickname}（${status.self_id}）`);
  }
});
ob.start();

// ——————————————— 静态文件 ———————————————
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

// ——————————————— HTTP 服务 ———————————————
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname.startsWith('/api/images/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/images/'.length));
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('bad name');
      return;
    }
    const file = path.join(imagesDir, name);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': buf.length,
      });
      res.end(buf);
    });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    await api(req, res, url);
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ ok: true, onebot: ob.getStatus() })
    );
    return;
  }
  serveStatic(req, res, url);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/panel') {
    panelWss.handleUpgrade(req, socket, head, (ws) => panelWss.emit('connection', ws, req));
    return;
  }
  if (url.pathname === '/onebot') {
    // 兼容：也允许直接连到面板端口
    ob.handleUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。设置 BOT_PORT 环境变量换一个端口后再启动。`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

/** 浏览器里能直接点开的地址（0.0.0.0 / :: 这类监听地址换成回环） */
function panelUrl() {
  let host = HOST;
  if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
  else if (host.includes(':')) host = `[${host}]`;
  return `http://${host}:${PORT}`;
}

/** 用系统默认浏览器打开面板；失败只记日志，不影响服务 */
function openPanel() {
  const url = panelUrl();
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const opts = { detached: true, stdio: 'ignore' };
  if (process.platform === 'win32') opts.windowsVerbatimArguments = true;
  try {
    spawn(cmd, args, opts).unref();
    log('info', 'server', `已在默认浏览器打开：${url}`);
  } catch (err) {
    log('warn', 'server', `自动打开浏览器失败（${err?.message || err}），请手动访问 ${url}`);
  }
}

server.listen(PORT, HOST, () => {
  const s = getSettings();
  log('info', 'server', `面板已启动：${panelUrl()}`);
  if (s.onebot_enabled) {
    log('info', 'server', `OneBot 反向 WS 地址：ws://${HOST}:${s.onebot_ws_port}/onebot`);
  } else {
    log('warn', 'server', 'OneBot 接入当前为关闭状态（可在面板「设置」中开启）');
  }
  log('info', 'server', `数据目录：${DATA_DIR}`);
  proactive.start();
  setTimeout(() => pruneLogs(2000), 5000);
  if (OPEN_BROWSER) setTimeout(openPanel, 250);
});

function shutdown(signal) {
  log('info', 'server', `收到 ${signal}，正在退出…`);
  proactive.stop();
  ob.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  log('error', 'server', `未捕获的 Promise 拒绝：${err?.stack || err}`);
});
