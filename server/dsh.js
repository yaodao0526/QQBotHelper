// DSH 转交：把主对话里带关键词的消息，交给外部 dsh 命令处理，
// 处理完把完整输出渲染成一张图（模拟“输出窗口截图”）发回 QQ。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { getSettings } from './config.js';
import { log } from './db.js';

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const MAX_OUTPUT = 200000;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

export function dshKeywords(settings = getSettings()) {
  return String(settings.dsh_keywords || '')
    .split(/[,，;；\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function dshTriggered(text, settings = getSettings()) {
  if (!settings.dsh_enabled) return false;
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return false;
  return dshKeywords(settings).some((kw) => lower.includes(kw));
}

export function edgePath() {
  return EDGE_PATHS.find((p) => fs.existsSync(p)) || '';
}


/** 默认命令：本机装了 dsh CLI 就直接用，否则退回 npx（headless = 跑完一个任务就退出） */
export function resolveDshCommand(settings = {}) {
  const explicit = String(settings.dsh_command || '').trim();
  if (explicit) return explicit;

  const candidates = [
    process.env.DSH_CLI_PATH,
    path.join(os.homedir(), 'AppData', 'Local', 'dsh-cli', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(process.cwd(), 'tools', 'dsh-cli', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return 'node "' + c + '" headless {prompt}';
    } catch {}
  }
  return 'npx -y @deepseek-ai/dsh headless {prompt}';
}

export class DshRelay {
  constructor(bot, { dataDir }) {
    this.bot = bot;
    this.dir = path.resolve(dataDir, 'dsh');
    fs.mkdirSync(this.dir, { recursive: true });
    this.running = new Map();
    this.history = [];
  }

  list() {
    const live = [...this.running.values()].map((job) => ({ ...job, running: true, child: undefined }));
    const past = this.history.map((job) => ({ ...job, running: false }));
    return live.concat(past);
  }

  isBusy(conversationId) {
    return [...this.running.values()].some((j) => j.conversation_id === conversationId);
  }

  /**
   * 把一句话交给 dsh 命令跑，结束后把完整输出渲染成图片发回会话。
   * @returns {Promise<{ok: boolean, reason?: string, jobId?: string}>}
   */
  async run(conversation, prompt, { ack = true } = {}) {
    const settings = getSettings();
    if (this.isBusy(conversation.id)) return { ok: false, reason: 'busy' };

    const command = resolveDshCommand(settings);
    if (!command) return { ok: false, reason: 'no-command' };

    const id = `${conversation.id}-${Date.now()}`;
    const promptFile = path.join(this.dir, `inp-${stamp()}.txt`);
    const taskText = [
      '这条内容来自 QQ 聊天，可能是闲聊、提问，也可能是一件要做的小事。',
      '如果只是问候或询问，直接用一两句话回答，不要调用工具、不要写长篇。',
      '如果是明确的任务，就执行，最后用一句话给结论。',
      '不要为了「发截图」而创建图片、脚本或临时文件；需要图的话由发送方自己处理。',
      '',
      `原始消息：${prompt}`
    ].join(String.fromCharCode(10));
    fs.writeFileSync(promptFile, taskText, 'utf8');

    const job = {
      id,
      conversation_id: conversation.id,
      peer_id: String(conversation.peer_id),
      kind: conversation.kind,
      prompt,
      command,
      status: 'running',
      started_at: new Date().toISOString(),
      finished_at: '',
      output: '',
      image: '',
      images: [],
      error: ''
    };
    job.startedMs = Date.now();
    this.running.set(id, job);
    if (ack) await this.bot.saySafely(conversation, '收到，我转给 DSH 处理了，跑完把输出发给你。').catch(() => {});

    let full = command.replaceAll('{prompt_file}', promptFile).replaceAll('{prompt}', shellQuote(prompt));
    if (!/\{prompt(_file)?\}/.test(command)) full = `${command} "${promptFile}"`;

    log('info', 'dsh', `转交任务 #${id}：${full.slice(0, 200)}`);

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(full, {
          shell: true,
          cwd: workDirFor(settings),
          windowsHide: true,
          env: {
            ...process.env,
            DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || String(settings.api_key || ''),
            DSH_PROMPT: prompt,
            DSH_PROMPT_FILE: promptFile
          }
        });
      } catch (e) {
        job.status = 'failed';
        job.error = String(e && e.message);
        this.running.delete(id);
        resolve({ ok: false, reason: 'spawn-failed' });
        return;
      }

      let out = '';
      let err = '';
      const collect = (chunk, bucket) => {
        const text = chunk.toString('utf8');
        if (out.length + err.length > MAX_OUTPUT) return;
        if (bucket === 'out') out += text;
        else err += text;
      };
      child.stdout.on('data', (c) => collect(c, 'out'));
      child.stderr.on('data', (c) => collect(c, 'err'));

      const timeoutMs = Math.max(5000, Number(settings.dsh_timeout_ms) || 240000);
      let finished = false;

      const finish = async (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        job.output = (out + (err ? `\n[stderr]\n${err}` : '')).slice(-MAX_OUTPUT);
        job.exit_code = code;
        job.error = job.error || '';
        job.status = code === 0 && !job.error ? 'done' : 'failed';
        job.finished_at = new Date().toISOString();

        const workdir = workDirFor(settings);
        const mode = String(settings.dsh_send_mode || 'images');
        const seen = new Set();
        const produced = collectImages(workdir, job.startedMs || 0)
          .filter((f) => {
            try {
              const st = fs.statSync(f);
              const key = `${st.size}:${path.basename(f)}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            } catch {
              return false;
            }
          })
          .slice(0, 3);

        const panels = [];
        if (mode !== 'transcript' && !produced.length) {
          const codeFile = pickCodeFile(workdir, job.startedMs || 0);
          if (codeFile) {
            try {
              const src = fs.readFileSync(codeFile, 'utf8').split(/\r?\n/).slice(0, 60);
              panels.push(await this.renderPanel({ title: `代码 · ${path.basename(codeFile)}`, lines: src }));
            } catch (e) {
              log('warn', 'dsh', `代码截图失败：${e && e.message}`);
            }
          }
          try {
            const lines = String(job.output || '')
              .split('[stderr]')[0]
              .split(String.fromCharCode(10))
              .filter((l) => l.trim() && !l.trim().toLowerCase().startsWith('dsh:'));
            panels.push(await this.renderPanel({ title: '运行结果', lines: lines.slice(-30) }));
          } catch (e) {
            log('warn', 'dsh', `结果截图失败：${e && e.message}`);
          }
        }

        job.images = produced;
        if (mode === 'transcript' || (!produced.length && !panels.length)) {
          try {
            job.image = await this.render(job);
          } catch (e) {
            log('warn', 'dsh', `输出截图失败：${e && e.message}`);
          }
        }

        this.running.delete(id);
        fs.rmSync(promptFile, { force: true });
        this.history.unshift({
          id: job.id,
          conversation_id: job.conversation_id,
          peer_id: job.peer_id,
          kind: job.kind,
          prompt: job.prompt,
          status: job.status,
          started_at: job.started_at,
          finished_at: job.finished_at,
          exit_code: job.exit_code,
          images: job.images.concat(panels || []).slice(0, 3),
          image: job.image || '',
          error: job.error || '',
          secs: Math.max(1, Math.round((Date.now() - (job.startedMs || Date.now())) / 1000)),
        });
        if (this.history.length > 20) this.history.length = 20;

        let sent = 0;
        try {
          const conv = { id: job.conversation_id, kind: job.kind, peer_id: job.peer_id };
          for (const img of job.images.concat(panels)) {
            try {
              await this.bot.sendImage(conv, fs.readFileSync(img));
              sent += 1;
            } catch (e) {
              log('warn', 'dsh', `发送图片失败：${e && e.message}`);
            }
          }
          if (job.image) {
            try {
              await this.bot.sendImage(conv, fs.readFileSync(job.image));
              sent += 1;
            } catch (e) {
              log('warn', 'dsh', `发送截图失败：${e && e.message}`);
            }
          }
          const secs = Math.max(1, Math.round((Date.now() - (job.startedMs || Date.now())) / 1000));
          const head =
            job.status === 'done'
              ? `做完了（${secs}s${sent ? `，发你 ${sent} 张图` : ''}）。`
              : `没跑成（退出码 ${job.exit_code ?? '无'}，${secs}s）。`;
          await this.bot.saySafely(conv, head).catch(() => {});
          log(job.status === 'done' ? 'info' : 'warn', 'dsh', `任务 #${id} ${job.status}`);
        } catch (e) {
          log('warn', 'dsh', `把结果发回 QQ 失败：${e && e.message}`);
        }
        resolve({ ok: job.status === 'done', jobId: id, image: job.image, images: job.images, panels });
      };

      const timer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && child.pid) {
            spawn(`taskkill /PID ${child.pid} /T /F`, { shell: true, windowsHide: true });
          } else {
            child.kill('SIGKILL');
          }
        } catch {}
        setTimeout(() => finish(-1), 3000);
      }, timeoutMs);

      child.on('error', (e) => {
        job.error = String(e && e.message);
        finish(-1);
      });
      child.on('close', (code) => finish(code));
    });
  }

  async render(job) {
    const edge = edgePath();
    const htmlPath = path.join(this.dir, `out-${stamp()}.html`);
    const pngPath = htmlPath.replace(/\.html$/, '.png');
    const lines = (job.output || '(没有输出)').split('\n');
    const height = Math.min(6000, Math.max(420, 150 + lines.length * 21));
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
      * { box-sizing: border-box }
      body { margin: 0; background: #0b0e14; color: #d7dce8; font: 13px/21px "Cascadia Mono", Consolas, monospace }
      header { padding: 14px 20px; border-bottom: 1px solid #222a3a; display: flex; gap: 10px; align-items: center }
      .dot { width: 11px; height: 11px; border-radius: 50% }
      .title { color: #9fb0cd; font-family: "Microsoft YaHei", sans-serif; font-size: 13px }
      .meta { margin-left: auto; color: #6b7a93; font-family: "Microsoft YaHei", sans-serif; font-size: 12px }
      pre { margin: 0; padding: 16px 20px; white-space: pre-wrap; word-break: break-word }
      .prompt { color: #7c9cff }
    </style></head><body>
      <header>
        <span class="dot" style="background:#ff5f57"></span>
        <span class="dot" style="background:#febc2e"></span>
        <span class="dot" style="background:#28c840"></span>
        <span class="title">DSH · ${escapeHtml(job.status === 'done' ? '任务完成' : '任务结束')}</span>
        <span class="meta">退出码 ${escapeHtml(String(job.exit_code ?? '-'))} · ${escapeHtml(job.started_at.replace('T', ' ').slice(0, 19))}</span>
      </header>
      <pre><span class="prompt">$ ${escapeHtml(job.prompt.slice(0, 400))}</span>

${escapeHtml(job.output || '(没有输出)')}</pre>
    </body></html>`;
    fs.writeFileSync(htmlPath, html, 'utf8');
    if (!edge) throw new Error('找不到 Edge，无法截图');
    const profileDir = path.join(this.dir, `edge-profile-${Date.now()}`);
    fs.mkdirSync(profileDir, { recursive: true });
    await runEdge(edge, htmlPath, pngPath, height, profileDir);
    return pngPath;
  }

  async renderPanel({ title, lines }) {
    const edge = edgePath();
    const htmlPath = path.join(this.dir, `panel-${stamp()}.html`);
    const pngPath = htmlPath.replace(/\.html$/, '.png');
    const arr = (lines || []).length ? lines : ['(空)'];
    const height = Math.min(2400, Math.max(240, 92 + arr.length * 19));
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
      * { box-sizing: border-box }
      body { margin: 0; background: #0b0e14; color: #d7dce8; font: 13px/19px "Cascadia Mono", Consolas, monospace }
      header { padding: 12px 20px; border-bottom: 1px solid #222a3a; display: flex; align-items: center; gap: 10px }
      .dot { width: 11px; height: 11px; border-radius: 50% }
      .title { color: #9fb0cd; font-family: "Microsoft YaHei", sans-serif; font-size: 13px }
      pre { margin: 0; padding: 14px 20px; white-space: pre-wrap; word-break: break-word }
    </style></head><body>
      <header>
        <span class="dot" style="background:#ff5f57"></span>
        <span class="dot" style="background:#febc2e"></span>
        <span class="dot" style="background:#28c840"></span>
        <span class="title">DSH · ${escapeHtml(title || '结果')}</span>
      </header>
      <pre>${escapeHtml(arr.join(String.fromCharCode(10)))}</pre>
    </body></html>`;
    fs.writeFileSync(htmlPath, html, 'utf8');
    if (!edge) throw new Error('找不到 Edge，无法截图');
    const profileDir = path.join(this.dir, `edge-profile-${Date.now()}`);
    fs.mkdirSync(profileDir, { recursive: true });
    await runEdge(edge, htmlPath, pngPath, height, profileDir);
    return pngPath;
  }
}

function pickCodeFile(dir, sinceMs) {
  const ext = /\.(c|cc|cpp|h|hpp|cs|java|kt|py|js|mjs|ts|go|rs|lua|rb|php|sh|bat|ps1|sql|html|css|json|yml|yaml|md)$/i;
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 2) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (ext.test(entry.name)) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= sinceMs - 1500 && st.size > 8 && st.size < 400 * 1024) hits.push({ full, m: st.mtimeMs });
        } catch {}
      }
    }
  };
  walk(dir, 0);
  const langs = /\.(c|cc|cpp|cxx|h|hpp|cs|java|kt|py|js|mjs|ts|tsx|go|rs|lua|rb|php|sql)$/i;
  hits.sort((a, b) => {
    const pa = langs.test(a.full) ? 2 : 1;
    const pb = langs.test(b.full) ? 2 : 1;
    return pb - pa || b.m - a.m;
  });
  return hits.length ? hits[0].full : '';
}

function workDirFor(settings) {
  const configured = String((settings && settings.dsh_cwd) || '').trim();
  if (configured) return configured;
  const dir = path.join(os.homedir(), 'AppData', 'Local', 'QQ人格机', 'dsh-work');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function collectImages(dir, sinceMs) {
  try {
    const out = [];
    const walk = (d, depth) => {
      if (depth > 2) return;
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) {
          const st = fs.statSync(full);
          if (st.mtimeMs >= sinceMs - 1500 && st.size > 2000) out.push({ full, m: st.mtimeMs });
        }
      }
    };
    walk(dir, 0);
    return out.sort((a, b) => a.m - b.m).map((x) => x.full);
  } catch {
    return [];
  }
}

function cleanOutput(text, maxLines = 3) {
  const noisy = [/^dsh:\s*reason/i, /^files:/i, /^do i need/i, /^-{3,}$/, /^`{3,}$/, /^\s*$/];
  const cjk = /[\u4e00-\u9fff]/;
  const all = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[>*\-\s]+/, '').trim())
    .filter((l) => l && !noisy.some((re) => re.test(l)));
  const zh = all.filter((l) => cjk.test(l) && l.length >= 4);
  const pick = (zh.length ? zh : all).slice(-maxLines);
  return pick.map((l) => (l.length > 80 ? l.slice(0, 80) + '…' : l)).join(String.fromCharCode(10));
}

function runEdge(edge, htmlPath, pngPath, height, profileDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      `--window-size=1280,${height}`,
      '--virtual-time-budget=1500',
      `--screenshot=${pngPath}`,
      pathToFileURL(htmlPath).href
    ];
    let edgeErr = '';
    const child = spawn(edge, args, { windowsHide: true });
    if (child.stderr) child.stderr.on('data', (c) => { edgeErr += c.toString(); if (edgeErr.length > 4000) edgeErr = edgeErr.slice(-4000); });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error('截图超时'));
    }, 30000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (fs.existsSync(pngPath)) resolve(pngPath);
      else reject(new Error('截图没生成: ' + (args.slice(-1)[0] || '') + ' | ' + edgeErr.split(String.fromCharCode(10)).slice(-2).join(' ').slice(0, 300)));
    });
  });
}

function shellQuote(str) {
  return `"${String(str).replace(/"/g, '\\"')}"`;
}

function lastLines(text, n) {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.slice(-n).join('\n').slice(0, 600);
}
