import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, one, run, log } from './db.js';
import { visionReady, captionImage } from './vision.js';

/**
 * 表情包库：把 QQ 账号「收藏的表情包」拉到本地（data/stickers），
 * 回复时由模型用 [[sticker]] 标记，我们从库里随机挑一张发出去。
 */

let dir = '';
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/apng': 'png',
};

export function initStickers(dataDir) {
  dir = path.join(dataDir, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function stickerDir() {
  return dir;
}

export function listStickers() {
  return all(
    'SELECT id, hash, file, url, enabled, used_count, descr, source, created_at FROM stickers ORDER BY used_count ASC, id ASC'
  );
}

/** 给模型看的表情包目录：#12 一个白发女孩在狂笑（只用有描述的） */
export function stickerCatalog(limit = 24) {
  const rows = all(
    "SELECT id, descr FROM stickers WHERE enabled = 1 AND descr != '' ORDER BY used_count ASC, RANDOM() LIMIT ?",
    Math.max(1, Math.min(60, Number(limit) || 24))
  );
  return rows;
}

/** 按编号挑：模型说了 [[sticker:12]] 就发 12 号；没这个编号就退回随机 */
export function pickStickerById(id) {
  const row = one('SELECT * FROM stickers WHERE id = ? AND enabled = 1', Number(id));
  if (row) {
    run('UPDATE stickers SET used_count = used_count + 1 WHERE id = ?', row.id);
    return row;
  }
  return pickSticker();
}

export function countStickers({ enabledOnly = false } = {}) {
  const row = enabledOnly
    ? one('SELECT COUNT(*) AS n FROM stickers WHERE enabled = 1')
    : one('SELECT COUNT(*) AS n FROM stickers');
  return Number(row?.n || 0);
}

export function stickerPath(row) {
  return row ? path.join(dir, row.file) : '';
}

export function readSticker(row) {
  try {
    return fs.readFileSync(stickerPath(row));
  } catch {
    return null;
  }
}

/** 随机挑一张（用得少的优先，避免老是同一张） */
export function pickSticker() {
  const rows = all('SELECT * FROM stickers WHERE enabled = 1 ORDER BY used_count ASC, RANDOM() LIMIT 12');
  if (!rows.length) return null;
  const row = rows[0];
  run('UPDATE stickers SET used_count = used_count + 1 WHERE id = ?', row.id);
  return row;
}

export function setStickerEnabled(id, enabled) {
  run('UPDATE stickers SET enabled = ? WHERE id = ?', enabled ? 1 : 0, Number(id));
  return one('SELECT id, enabled FROM stickers WHERE id = ?', Number(id)) || null;
}

export function deleteSticker(id) {
  const row = one('SELECT * FROM stickers WHERE id = ?', Number(id));
  if (!row) return false;
  run('DELETE FROM stickers WHERE id = ?', row.id);
  try {
    fs.rmSync(stickerPath(row), { force: true });
  } catch {
    /* ignore */
  }
  return true;
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('空文件');
    if (buf.length > 8 * 1024 * 1024) throw new Error('文件过大');
    const ext = MIME_EXT[type] || (url.match(/\.(png|jpe?g|gif|webp|bmp)(?:\?|$)/i)?.[1] || 'png').toLowerCase();
    return { buf, ext: ext === 'jpeg' ? 'jpg' : ext };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 OneBot 账号拉取收藏表情。count 由调用方决定（默认 48，最多 200）。
 * 返回 { ok, fetched, saved, skipped, total, error }
 */
export async function syncStickers(ob, { count = 120 } = {}) {
  if (!ob || !ob.getStatus().connected) {
    return { ok: false, error: 'OneBot 未连接，拉不到账号里的表情包' };
  }
  let urls = [];
  try {
    const res = await ob.sendAction('fetch_custom_face', { count: Math.max(1, Math.min(200, Number(count) || 120)) });
    const data = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
    urls = data.map((u) => (typeof u === 'string' ? u : u?.url)).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  } catch (err) {
    return { ok: false, error: `拉取失败：${err.message}` };
  }
  if (!urls.length) return { ok: true, fetched: 0, saved: 0, skipped: 0, total: countStickers(), hint: '账号收藏里没拿到表情包（可能没收藏，或协议端不支持该动作）' };

  let saved = 0;
  let skipped = 0;
  for (const url of urls) {
    try {
      const { buf, ext } = await download(url);
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      if (one('SELECT id FROM stickers WHERE hash = ?', hash)) {
        skipped++;
        continue;
      }
      const file = `${hash}.${ext}`;
      fs.writeFileSync(path.join(dir, file), buf);
      run(
        'INSERT INTO stickers (hash, file, url, enabled, used_count, created_at) VALUES (?, ?, ?, 1, 0, ?)',
        hash,
        file,
        url,
        Date.now()
      );
      saved++;
    } catch (err) {
      log('warn', 'stickers', `下载表情失败：${err.message}`);
      skipped++;
    }
  }
  log('info', 'stickers', `表情包同步：拿到 ${urls.length} 个，新增 ${saved}，跳过 ${skipped}，库里共 ${countStickers()}`);
  return { ok: true, fetched: urls.length, saved, skipped, total: countStickers() };
}

/** 给还没描述的表情包补一句话描述（用已配置的识图模型；没配就跳过） */
export async function describeStickers({ limit = 8, force = false } = {}) {
  if (!visionReady()) return { ok: false, error: '识图模型没配置，无法识别表情包含义', described: 0 };
  const rows = all(
    force
      ? 'SELECT * FROM stickers ORDER BY id DESC LIMIT ?'
      : "SELECT * FROM stickers WHERE descr = '' ORDER BY enabled DESC, id ASC LIMIT ?",
    Math.max(1, Math.min(30, Number(limit) || 8))
  );
  let ok = 0;
  for (const row of rows) {
    try {
      const buf = readSticker(row);
      if (!buf) continue;
      const desc = String(await captionImage(buf)).trim().replace(/\s+/g, ' ').slice(0, 90);
      if (!desc) continue;
      run('UPDATE stickers SET descr = ? WHERE id = ?', desc, row.id);
      ok++;
    } catch (err) {
      log('warn', 'stickers', `识别表情包 #${row.id} 失败：${err.message}`);
    }
  }
  if (ok) log('info', 'stickers', `已为 ${ok} 个表情包补上描述`);
  const left = Number(one("SELECT COUNT(*) AS n FROM stickers WHERE descr = ''")?.n || 0);
  return { ok: true, described: ok, remaining: left };
}

/** 把一张图片存进库（供全网搜索/手动导入复用） */
export function saveSticker(buf, { url = '', source = 'web', descr = '' } = {}) {
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  const existed = one('SELECT id, descr FROM stickers WHERE hash = ?', hash);
  if (existed) {
    if (descr && !existed.descr) run('UPDATE stickers SET descr = ? WHERE id = ?', descr, existed.id);
    return { saved: false, id: existed.id };
  }
  const ext = sniffExt(buf);
  const file = `${hash}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  run(
    'INSERT INTO stickers (hash, file, url, enabled, used_count, descr, source, created_at) VALUES (?, ?, ?, 1, 0, ?, ?, ?)',
    hash,
    file,
    url,
    descr,
    source,
    Date.now()
  );
  const row = one('SELECT id FROM stickers WHERE hash = ?', hash);
  return { saved: true, id: row?.id };
}

function sniffExt(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.subarray(0, 6).toString('ascii').startsWith('GIF')) return 'gif';
  if (buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return 'png';
}

/**
 * 去网上找表情包：抓搜索结果页里的图片直链，下载、识图、入库。
 * 搜索地址可配置（默认 Bing 图片异步接口），含 {q} 与 {count} 占位符。
 */
export async function searchStickers(query, { count = 6, endpoint = '' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '搜索词为空' };
  const url = String(endpoint || 'https://www.bing.com/images/async?q={q}&first=1&count=35&mkt=zh-CN&adlt=strict')
    .replaceAll('{q}', encodeURIComponent(q))
    .replaceAll('{count}', String(Math.max(6, Math.min(50, Number(count) * 4))));

  let html = '';
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return { ok: false, error: `搜索失败：HTTP ${res.status}` };
    html = await res.text();
  } catch (err) {
    return { ok: false, error: `搜索失败：${err.message}` };
  }

  const urls = [];
  for (const m of html.matchAll(/murl&quot;:&quot;(.*?)&quot;/g)) {
    const u = m[1].replace(/\u002f/g, '/').replace(/&amp;/g, '&');
    if (/^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u);
  }
  if (!urls.length) return { ok: false, error: '搜索结果里没解析到图片直链' };

  let saved = 0;
  let described = 0;
  for (const u of urls) {
    if (saved >= Number(count)) break;
    try {
      const { buf } = await download(u);
      if (buf.length < 4 * 1024) continue; // 太小的多半是缩略图/图标
      let desc = '';
      if (visionReady()) {
        try {
          desc = String(await captionImage(buf)).trim().replace(/\s+/g, ' ').slice(0, 90);
        } catch {
          desc = '';
        }
      }
      const r = saveSticker(buf, { url: u, source: 'web', descr: desc });
      if (r.saved) saved++;
      if (desc) described++;
    } catch (err) {
      log('warn', 'stickers', `下载网络表情失败：${err.message}`);
    }
  }
  log('info', 'stickers', `网络找表情「${q}」：新增 ${saved}，带描述 ${described}`);
  return { ok: saved > 0, saved, described, candidates: urls.length, total: countStickers() };
}
