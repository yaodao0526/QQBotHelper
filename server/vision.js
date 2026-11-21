/** 识图：把 QQ 里的图片交给一个支持图片输入的多模态模型，换回一句中文描述 */
import fs from 'node:fs';
import { getSettings } from './config.js';
import { log } from './db.js';

const MAX_BYTES = 6 * 1024 * 1024; // 单张 6MB 上限，避免把大图塞进请求

/** 识图是否可用（需要模型名 + Key） */
export function visionEndpointInfo() {
  const s = getSettings();
  return {
    base: String(s.vision_api_base || '').trim() || String(s.api_base || '').trim(),
    key: String(s.vision_api_key || '').trim() || String(s.api_key || '').trim(),
    model: String(s.vision_model || '').trim()
  };
}

export function visionReady() {
  const s = getSettings();
  const key = String(s.vision_api_key || s.api_key || '').trim();
  return Boolean(s.vision_enabled && String(s.vision_model || '').trim() && key);
}

/** 给面板展示用（不回显 Key） */
export function visionStatus() {
  const s = getSettings();
  return {
    ready: visionReady(),
    enabled: Boolean(s.vision_enabled),
    model: String(s.vision_model || ''),
    base: String(s.vision_api_base || s.api_base || ''),
    has_key: Boolean(String(s.vision_api_key || s.api_key || '').trim()),
    hints: visionReady() ? '' : '需要在「设置 → 识图」里填一个支持图片输入的模型（例如 qwen-vl-max、glm-4.6v、gpt-4o-mini）',
  };
}

function endpoint() {
  const s = getSettings();
  const base = String(s.vision_api_base || s.api_base || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  let url;
  if (/\/chat\/completions$/.test(base)) url = base;
  else if (/\/v\d+$/.test(base)) url = `${base}/chat/completions`;
  else url = `${base}/v1/chat/completions`;
  return { url, key: String(s.vision_api_key || s.api_key || '').trim(), model: String(s.vision_model || '').trim() };
}

function guessMime(buf, fallback = 'image/png') {
  if (!buf || buf.length < 12) return fallback;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return fallback;
}

const IMG_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  referer: 'https://qun.qq.com/',
  accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
};

async function fetchBytes(url, timeoutMs) {
  const list = [url];
  if (url.startsWith('https://')) list.push(`http://${url.slice(8)}`);
  else if (url.startsWith('http://')) list.push(`https://${url.slice(7)}`);

  let lastErr = null;
  for (const u of list) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(u, { headers: IMG_HEADERS, signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('空响应');
      if (buf.length > MAX_BYTES) throw new Error('图片太大（>6MB）');
      return buf;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`图片下载失败 ${lastErr ? lastErr.message : ''}`.trim());
}


/** 协议端返回本地文件路径时直接读盘（QQ 通常已经把图缓存在本地） */
function bytesFromLocal(p) {
  const s = String(p || '').trim();
  if (s.length < 3 || s[1] !== ':') return null;
  try {
    const buf = fs.readFileSync(s);
    if (buf && buf.length) return buf;
  } catch (e) {
    log('warn', 'vision', `读本地缓存失败：${e.message}`);
  }
  return null;
}

/**
 * 从 OneBot 消息段拿到图片字节：
 *  - data.url 直接可下载
 *  - data.file 是 base64:// 开头就直接解
 *  - 否则调 get_image 拿 file/url/base64
 */
export async function resolveImageBytes(ob, seg, timeoutMs = 15000, messageId = 0) {
  const data = seg?.data || {};
  const file = String(data.file || '');
  const url = String(data.url || '');

  if (file.startsWith('base64://')) {
    return Buffer.from(file.slice('base64://'.length), 'base64');
  }

  // 消息段里直接给的就是本机缓存路径（get_msg 刷新后常见）
  const direct = bytesFromLocal(file);
  if (direct) return direct;

  // 先让协议端自己取：它手里有会话内的文件，不依赖有时效的外链
  const key = file || url;
  if (key) {
    const got = await ob.sendAction('get_image', { file: key }, timeoutMs).catch(() => null);
    const d = got?.data || got || {};
    const b64 = d.base64 || (String(d.file || '').startsWith('base64://') ? String(d.file).slice(9) : '');
    if (b64) return Buffer.from(String(b64).replace(/^base64:\/\//, ''), 'base64');
    for (const maybe of [d.file, d.path, d.file_path, d.filePath]) {
      const buf = bytesFromLocal(maybe);
      if (buf) return buf;
    }
    if (/^https?:\/\//.test(String(d.url || ''))) {
      try {
        return await fetchBytes(String(d.url), timeoutMs);
      } catch {}
    }
    log('info', 'vision', `get_image 返回不可直接用：${JSON.stringify(d).slice(0, 200)}`);
    const tmp = await ob.sendAction('temp_image_path', { file: key }, timeoutMs).catch(() => null);
    const tp = tmp?.data || {};
    for (const maybe of [tp.path, tp.file, tp.file_path]) {
      const buf = bytesFromLocal(maybe);
      if (buf) return buf;
    }
  }

  for (const cand of [url, file]) {
    if (/^https?:\/\//.test(String(cand || ''))) {
      try {
        return await fetchBytes(String(cand), timeoutMs);
      } catch (e) {
        log('warn', 'vision', `外链取图失败（${String(cand).slice(0, 120)}）：${e.message}`);
      }
    }
  }

  // 最后再试一次：拿 message_id 重新取这条消息，url 往往带着新的 rkey
  if (messageId) {
    const fresh = await refreshSegments(ob, messageId, timeoutMs).catch(() => []);
    for (const seg2 of fresh) {
      if (seg2.type !== 'image') continue;
      const d2 = seg2.data || {};
      const f2 = String(d2.file || '');
      if (f2.startsWith('base64://')) return Buffer.from(f2.slice(9), 'base64');
      if (/^https?:\/\//.test(String(d2.url || ''))) {
        try {
          return await fetchBytes(String(d2.url), timeoutMs);
        } catch (e) {
          log('warn', 'vision', `刷新后的链接仍失败：${e.message}`);
        }
      }
    }
  }

  throw new Error('拿不到图片内容（get_image / 直链 / get_msg 刷新都没成功）');
}

/** 用 message_id 重新拉这条消息的消息段（url 里的 rkey 会刷新） */
export async function refreshSegments(ob, messageId, timeoutMs = 15000) {
  const got = await ob.sendAction('get_msg', { message_id: messageId }, timeoutMs);
  const d = got?.data || got || {};
  const raw = d.message ?? d.segments ?? [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const arr = [];
    const re = /\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g;
    let m;
    while ((m = re.exec(raw))) {
      const data = {};
      for (const pair of (m[2] || '').split(',').slice(1)) {
        const i = pair.indexOf('=');
        if (i > 0) data[pair.slice(0, i)] = pair.slice(i + 1);
      }
      arr.push({ type: m[1], data });
    }
    return arr;
  }
  return [];
}

/** 让多模态模型描述一张图，返回一句简短中文 */
export async function captionImage(buf, timeoutMs = 30000) {
  if (!visionReady()) throw new Error('识图模型未配置');
  if (!buf?.length) throw new Error('图片内容为空');
  if (buf.length > MAX_BYTES) throw new Error('图片太大（>6MB）');

  const s = getSettings();
  const ep = endpoint();
  const mime = guessMime(buf);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(5000, Number(timeoutMs) || 30000));
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
      body: JSON.stringify({
        model: ep.model,
        temperature: 0.2,
        max_tokens: 160,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  '用中文客观描述这张聊天图片，供看不到图的人理解：画面里有什么（人/角色/界面/截图内容）、在做什么、图上的文字写了什么、整体属于搞笑/可爱/吐槽/表情包/资料截图哪种。' +
                  '如果是代码或报错截图，把关键文字（文件名、错误信息、关键行）照抄出来。' +
                  '不要寒暄、不要分点、不要评价好不好看，控制在 80 字以内。',
              },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
            ],
          },
        ],
      }),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`识图接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`);
    }
    if (!res.ok) {
      const detail = data?.error?.message || data?.message || text.slice(0, 160);
      const err = new Error(`识图失败（HTTP ${res.status}）：${detail}`);
      err.status = res.status;
      throw err;
    }
    const content = data?.choices?.[0]?.message?.content;
    const out = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text || '').join('') : '';
    return String(out).replace(/\s+/g, ' ').trim().slice(0, 120);
  } finally {
    clearTimeout(timer);
  }
}

/** 测试用：用一张 1x1 PNG 探一下接口是否可用 */
export async function testVision() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  try {
    const text = await captionImage(png, 20000);
    return { ok: true, sample: text || '（模型没有返回内容，但接口通了）' };
  } catch (err) {
    log('warn', 'vision', `识图测试失败：${err.message}`);
    return { ok: false, error: err.message };
  }
}
