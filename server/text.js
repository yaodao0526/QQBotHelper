/** QQ 文本处理：CQ 码解析、Markdown 净化、分段发送 */

const CQ_RE = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;

function parseCQParams(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of raw.replace(/^,/, '').split(',')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = pair.slice(0, i);
    let v = pair.slice(i + 1);
    v = v
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&#44;/g, ',')
      .replace(/&amp;/g, '&');
    out[k] = v;
  }
  return out;
}

/** 把 [CQ:xxx] 字符串转成 OneBot 的 message 数组 */
export function cqToSegments(str) {
  const segments = [];
  let last = 0;
  const text = String(str ?? '');
  for (const m of text.matchAll(CQ_RE)) {
    if (m.index > last) segments.push({ type: 'text', data: { text: text.slice(last, m.index) } });
    segments.push({ type: m[1], data: parseCQParams(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', data: { text: text.slice(last) } });
  return segments.filter((s) => s.type !== 'text' || s.data.text !== '');
}

/** 把消息段转成人可读文本，同时判断是否 @ 了机器人 */
export function segmentsToText(segments, { selfId = '' } = {}) {
  const parts = [];
  let atMe = false;
  let hasImage = false;
  for (const seg of segments || []) {
    const type = seg?.type;
    const data = seg?.data || {};
    switch (type) {
      case 'text':
        parts.push(data.text || '');
        break;
      case 'at': {
        const qq = String(data.qq ?? '');
        if (selfId && qq === String(selfId)) atMe = true;
        else if (qq === 'all') parts.push('@全体成员');
        else parts.push(`@${data.name || qq}`);
        break;
      }
      case 'image':
        hasImage = true;
        parts.push('[图片]');
        break;
      case 'face':
        parts.push('[表情]');
        break;
      case 'mface':
      case 'marketface':
        parts.push('[表情包]');
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'file':
        parts.push('[文件]');
        break;
      case 'reply':
        break;
      case 'json':
      case 'xml':
        parts.push('[卡片消息]');
        break;
      case 'forward':
        parts.push('[聊天记录]');
        break;
      default:
        break;
    }
  }
  const text = parts.join('').replace(/\s+\n/g, '\n').trim();
  return { text, atMe, hasImage };
}

const MD_RULES = [
  [/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim()],
  [/`([^`]+)`/g, '$1'],
  [/^\s{0,3}#{1,6}\s+/gm, ''],
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/__([^_]+)__/g, '$1'],
  [/\*([^*\n]+)\*/g, '$1'],
  [/~~([^~]+)~~/g, '$1'],
  [/!\[[^\]]*\]\([^)]*\)/g, '[图片]'],
  [/\[([^\]]+)\]\(([^)]+)\)/g, '$1'],
  [/^\s*[-*+]\s+/gm, '· '],
  [/^\s*>\s?/gm, ''],
  [/^\s*[-—]{3,}\s*$/gm, ''],
];

/** 模型回复 → 适合 QQ 气泡的纯文本 */
export function stripMarkdown(input) {
  let s = String(input ?? '').replace(/\r\n/g, '\n');
  for (const [re, rep] of MD_RULES) s = s.replace(re, rep);
  s = s
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

/** 去掉模型偶尔加上的「名字：」前缀和包裹引号 */
export function stripSpeakerPrefix(input, names = []) {
  let s = input.trim();
  for (const name of names.filter(Boolean)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`^${esc}\\s*[:：]\\s*`), '');
  }
  if (/^["“「].*["”」]$/s.test(s) && s.length < 200) s = s.slice(1, -1).trim();
  return s;
}

/**
 * 把一段回复切成 1~3 条气泡，模拟真人打字节奏。
 */
export function splitReply(input, { maxLen = 70, maxParts = 3 } = {}) {
  const text = String(input ?? '').replace(/\r/g, '').trim();
  if (!text) return [];

  // 模型自己换行（包括空行）= 想分成几条发，这些硬边界不合并
  const blocks = text
    .split(/\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const splitLong = (block, limit) => {
    const sentences = block
      .split(/(?<=[。！？!?…~～])/)
      .map((x) => x.trim())
      .filter(Boolean);
    const out = [];
    let buf = '';
    for (const sen of sentences) {
      if (buf && buf.length + sen.length > limit) {
        out.push(buf);
        buf = '';
      }
      buf += sen;
    }
    if (buf) out.push(buf);
    return out.length ? out : [block];
  };

  let parts = [];
  for (const block of blocks) {
    if (block.length <= maxLen) {
      parts.push(block);
      continue;
    }
    parts.push(...splitLong(block, maxLen));
  }

  // 只有一段、但句子不少：拆成两三条发，别糊成一大坨
  if (blocks.length === 1 && maxParts >= 2 && maxLen <= 80 && parts.length === 1 && parts[0].length > 45) {
    const chunks = splitLong(parts[0], Math.min(maxLen, 42));
    if (chunks.length > 1) parts = chunks.slice(0, maxParts);
  }

  if (parts.length <= maxParts) return parts;

  // 太多段就合并尾部，保持气泡数量可控
  const head = parts.slice(0, maxParts - 1);
  const tail = parts.slice(maxParts - 1).join('');
  return [...head, tail];
}

export function randomBetween(min, max) {
  const a = Number.isFinite(min) ? min : 500;
  const b = Number.isFinite(max) ? max : 1400;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.round(lo + Math.random() * (hi - lo));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
