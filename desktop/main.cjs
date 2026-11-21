'use strict';

/**
 * 桌面外壳：把面板装进一个独立窗口，常驻托盘，不再需要浏览器。
 *
 * 后台服务（server/index.js）仍用系统 Node 跑在子进程里：
 * Electron 自带的 Node 版本不一定带可用的 node:sqlite，交给 system node 最稳。
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell, powerSaveBlocker } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.BOT_PORT || 7800);
const PANEL_URL = `http://127.0.0.1:${PORT}`;
const ICON = path.join(__dirname, 'icon.png');

let win = null;
let tray = null;
let server = null; // 只记录「本程序自己拉起的」子进程
let quitting = false;
let trayHintShown = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 桌面壳自己的日志（Electron 崩在 ready 之前时，用户也能看到线索）
const DESKTOP_LOG = path.join(ROOT, 'data', 'desktop.log');
let powerSaveBlockerId = 0;

function dlog(message) {
  try {
    fs.mkdirSync(path.dirname(DESKTOP_LOG), { recursive: true });
    fs.appendFileSync(DESKTOP_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* ignore */
  }
}
dlog(`boot electron=${process.versions.electron} node=${process.versions.node}`);

// 本地小工具，不需要 GPU 加速；关掉能避开一部分驱动/黑屏问题
app.disableHardwareAcceleration();

/**
 * Chromium 自带的沙箱在某些目录（例如被安全软件/同步盘接管的工作目录、精简版
 * Windows 或 AppContainer 受限环境）里初始化会直接失败，表现为进程以
 * 0x80000003 / 139 秒退，窗口一个都不出来。这个程序只加载本机 127.0.0.1 的
 * 面板页面，不加载外部内容，所以默认关掉沙箱换启动稳定性；想保留沙箱可以设
 * 环境变量 BOT_SANDBOX=1。
 */
if (String(process.env.BOT_SANDBOX || '') !== '1') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

process.on('uncaughtException', (err) => {
  dlog(`uncaughtException: ${err && err.stack}`);
  dialog.showErrorBox('QQ 人格机器人出错', String((err && err.stack) || err));
});

async function panelUp() {
  try {
    const res = await fetch(`${PANEL_URL}/health`, { signal: AbortSignal.timeout(900) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 已有实例就复用，否则拉起 server/index.js 并等它可用 */
async function ensureServer() {
  if (await panelUp()) return true;

  const nodeBin = process.env.BOT_NODE || 'node';
  try {
    server = spawn(nodeBin, ['server/index.js'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, BOT_PORT: String(PORT), BOT_OPEN: '0' },
    });
  } catch (err) {
    showStartupError(err && err.message);
    return false;
  }

  server.on('error', (err) => {
    server = null;
    if (err && err.code === 'ENOENT') showStartupError('找不到 node 命令，请先安装 Node.js 22.5 或更高版本。');
    else showStartupError(`无法启动后台服务：${err && err.message}`);
  });

  for (let i = 0; i < 80; i += 1) {
    if (await panelUp()) return true;
    await sleep(250);
  }
  showStartupError('后台服务 20 秒内没有就绪。');
  return false;
}

function showStartupError(detail) {
  dialog.showErrorBox(
    'QQ 人格机器人启动失败',
    `${detail}\n\n面板地址：${PANEL_URL}\n\n排查建议：\n1. 打开命令行运行 node -v，确认是 22.5 以上\n2. 确认端口 ${PORT} 没有被别的程序占用\n3. 在项目目录运行 npm start，看后台服务的报错\n`,
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'QQ 人格机器人',
    backgroundColor: '#0b0e14',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 熄屏/最小化时别让渲染进程进入节流，否则定时消息会变慢
      backgroundThrottling: false,
    },
  });

  win.loadURL(PANEL_URL);
  win.once('ready-to-show', () => win.show());

  // 给启动脚本的「窗口真的出来了」回执：健康检查通过 ≠ 窗口可见，
  // 桌面壳可能在服务起来之后才崩掉，所以用一次成功的页面加载作为成功信号。
  const readyFile = process.env.BOT_READY_FILE;
  if (readyFile) {
    try {
      fs.rmSync(readyFile, { force: true });
    } catch {
      /* ignore */
    }
    win.webContents.once('did-finish-load', () => {
      try {
        fs.writeFileSync(readyFile, String(Date.now()));
      } catch (err) {
        dlog(`write ready file failed: ${err && err.message}`);
      }
    });
  }

  // 测试钩子：BOT_SHOT=<png 路径> 时截一张窗口内容并退出（用于自动化验证桌面壳）
  const shot = process.env.BOT_SHOT;
  if (shot) {
    win.webContents.once('did-finish-load', async () => {
      await sleep(1800);
      try {
        fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
        console.log(`screenshot saved: ${shot}`);
      } catch (err) {
        console.error('screenshot failed', err);
      }
      quitting = true;
      app.quit();
    });
  }

  // 关闭按钮 = 收进托盘；真正退出走托盘菜单
  win.on('close', (event) => {
    if (quitting) return;
    if (!tray) {
      quitting = true;
      return;
    }
    event.preventDefault();
    win.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      tray.displayBalloon({
        title: 'QQ 人格机器人还在运行',
        content: '窗口已收进托盘，机器人仍在回复消息。右键托盘图标可以退出。',
        iconType: 'info',
      });
    }
  });

  // 后台服务意外退出时别留个空窗口
  win.webContents.on('did-fail-load', () => {
    if (quitting) return;
    setTimeout(async () => {
      if (await panelUp()) win.loadURL(PANEL_URL);
    }, 1200);
  });

  // F5 / Ctrl+R 重新加载
  win.webContents.on('before-input-event', (event, input) => {
    const isReload = input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r');
    if (isReload && input.type === 'keyDown') {
      event.preventDefault();
      win.webContents.reload();
    }
  });
}

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  let image = nativeImage.createFromPath(ICON);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('QQ 人格机器人');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开面板', click: showWindow },
      { label: '重新加载', click: () => win && win.webContents.reload() },
      { type: 'separator' },
      { label: '接入说明', click: () => shell.openPath(path.join(ROOT, 'README.md')) },
      { label: '数据目录', click: () => shell.openPath(path.join(ROOT, 'data')) },
      { type: 'separator' },
      { label: '退出', click: quit },
    ]),
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function quit() {
  quitting = true;
  if (server) {
    try {
      server.kill();
    } catch {
      /* ignore */
    }
    server = null;
  }
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  // 已经有一个实例（可能缩在托盘里）：本次只是「再双击一次」的唤醒请求。
  // 给启动脚本一个成功回执，别让它以为窗口没起来而回退到浏览器。
  const readyFile = process.env.BOT_READY_FILE;
  if (readyFile) {
    try {
      fs.writeFileSync(readyFile, String(Date.now()));
    } catch {
      /* ignore */
    }
  }
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    // 只要不关机就一直在线：阻止系统进入睡眠/挂起
    try {
      if (typeof powerSaveBlocker !== 'undefined') {
        powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        dlog('powerSaveBlocker started: prevent-app-suspension #' + powerSaveBlockerId);
      }
    } catch (err) {
      dlog('powerSaveBlocker failed: ' + (err && err.message));
    }

    app.setAppUserModelId('local.qq-persona-bot');
    const ok = await ensureServer();
    if (!ok) {
      quitting = true;
      app.quit();
      return;
    }
    createWindow();
    try {
      createTray();
    } catch (err) {
      // 托盘建不起来也不影响使用，只是关闭窗口时直接退出
      console.error('tray failed', err);
    }
  });

  app.on('window-all-closed', () => {
    // 窗口只是隐藏到托盘，不在这里退出
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    if (server) {
      try {
        server.kill();
      } catch {
        /* ignore */
      }
    }
  });
}
