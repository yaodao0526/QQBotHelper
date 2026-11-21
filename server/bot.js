import { getSettings, parseList } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './db.js';
import { chat, llmReady } from './llm.js';
import {
  getOrCreateConversation,
  getOrCreateUser,
  getConversation,
  addMessage,
  updateConversation,
  lastMessage,
} from './store.js';
import { resolvePersona, buildMessages } from './personas.js';
import { pickSticker, pickStickerById, stickerPath, countStickers } from './stickers.js';
import { visionReady, resolveImageBytes, captionImage } from './vision.js';
import { dshTriggered } from './dsh.js';
import { getMood, afterUserMessage, afterAssistantMessage, burstPolicy } from './mood.js';
import {
  cqToSegments,
  segmentsToText,
  stripMarkdown,
  stripSpeakerPrefix,
  splitReply,
  randomBetween,
  sleep,
} from './text.js';

/**
 * 对话引擎：收到 OneBot 事件 → 过滤/触发判断 → 组装人格提示词 → 调模型 → 分段发出。
 */
function maxPartsFor(s) {
  const n = Number(s.reply_max_parts);
  return Number.isFinite(n) && n > 0 ? Math.min(5, Math.trunc(n)) : 1;
}

export class Bot {
  constructor(onebot, { broadcast = () => {} } = {}) {
    this.dsh = null;
    this.ob = onebot;
    this.broadcast = broadcast;
    this.buffers = new Map(); // 每个会话的合并缓冲
    this.chains = new Map(); // 每个会话的串行队列
    this.lastReplyAt = new Map();
    this.pendingImages = new Map();
    this.active = 0;
  }

  // —————————————————————————— 事件入口 ——————————————————————————

  async handleEvent(ev) {
    try {
      if (!ev || ev.post_type !== 'message') return;
      if (ev.message_type !== 'private' && ev.message_type !== 'group') return;

      const selfId = String(this.ob.selfId || '');
      if (selfId && String(ev.user_id) === selfId) return;

      const s = getSettings();
      const isGroup = ev.message_type === 'group';
      const kind = isGroup ? 'group' : 'private';
      const peerId = String(isGroup ? ev.group_id : ev.user_id);
      const userId = String(ev.user_id || '');
      if (!peerId || peerId === 'undefined') return;

      const segments = Array.isArray(ev.message)
        ? ev.message
        : typeof ev.message === 'string'
          ? cqToSegments(ev.message)
          : [];
      const { text, atMe } = segmentsToText(segments, { selfId });
      if (!text) return;

      const blacklist = parseList(s.blacklist);
      if (blacklist.includes(userId) || blacklist.includes(peerId)) return;
      const whitelist = parseList(s.whitelist);
      if (whitelist.length && !whitelist.includes(userId) && !whitelist.includes(peerId)) {
        return;
      }

      const user = getOrCreateUser(userId, ev.sender?.card || ev.sender?.nickname || '');
      if (user.blocked) return;

      if (!isGroup && !s.trigger_private) return;
      if (!llmReady()) {
        log('warn', 'bot', '收到消息，但模型 API 尚未配置，已跳过');
        return;
      }

      if (isGroup) {
        if (!s.trigger_group) return;
        const wake = parseList(s.wake_words);
        const hitWake = wake.some((w) => text.includes(w));
        const roll = Math.random() * 100 < Number(s.random_chance || 0);
        if (!atMe && !hitWake && !roll) {
          if (s.group_need_at) return;
        }
      }

      const senderName = isGroup ? ev.sender?.card || ev.sender?.nickname || userId : ev.sender?.nickname || userId;
      const title = isGroup
        ? ev.group_name || `群 ${peerId}`
        : ev.sender?.card || ev.sender?.nickname || `QQ ${peerId}`;

      const conv = getOrCreateConversation(kind, peerId, { title });
      if (!isGroup && conv.title !== title) updateConversation(conv.id, { title });

      // 有图片且配了识图模型时，把 [图片] 换成「[图片：一只橘猫趴在键盘上]」
      const shots = await this.#grabImages(segments, ev.message_id);
      if (shots.length) this.pendingImages.set(conv.id, shots);
      const hasImage = segments.some((seg) => seg && seg.type === 'image');
      // 有图且取到了字节：落盘一份，面板直接显示缩略图；模型那边用 image_url 真图
      let imageName = '';
      if (shots.length && this.imagesDir) {
        try {
          imageName = `${conv.id}-${Date.now()}.jpg`;
          const first = shots[0];
          const buf =
            typeof first === 'string'
              ? Buffer.from(String(first).replace(/^data:[^;]+;base64,/, ''), 'base64')
              : Buffer.from(first);
          fs.writeFileSync(path.join(this.imagesDir, imageName), buf);
        } catch (e) {
          log('warn', 'bot', `图片落盘失败：${e.message}`);
          imageName = '';
        }
      }
      // 有图但没取到字节：明确标出来，避免模型凭空描述一张它没看到过的图
      const finalText = imageName
        ? `[图片]#${imageName}`
        : hasImage && !shots.length
          ? `${text}（这条图我没能读到内容，别猜它是什么）`.trim()
          : text;
      const stored = addMessage(conv.id, 'user', finalText, senderName);
      afterUserMessage(conv.id, finalText);
      this.broadcast({
        type: 'message',
        conversation_id: conv.id,
        kind,
        peer_id: peerId,
        title,
        role: 'user',
        sender: senderName,
        content: finalText,
        id: stored.id,
        created_at: stored.created_at,
      });

      // 主对话里带 dsh 关键词：把话转给 DSH，跑完把输出截图发回来
      const mainId = Number(getSettings().main_conversation_id) || 0;
      if (this.dsh && mainId && Number(conv.id) === mainId && dshTriggered(finalText)) {
        this.#enqueue(`${kind}:${peerId}`, async () => {
          const res = await this.dsh.run({ ...conv, kind, peer_id: peerId, title }, finalText).catch((e) => {
            log('error', 'dsh', String(e && e.message));
            return { ok: false, reason: 'error' };
          });
          if (res && res.reason === 'no-command') {
            await this.saySafely({ ...conv, kind, peer_id: peerId, title }, 'DSH 还没配置命令：面板「设置 → DSH 转交」里填一下再试。').catch(() => {});
          }
        });
        return;
      }

      this.#schedule(kind, peerId, { userId, senderName });
    } catch (err) {
      log('error', 'bot', `处理消息出错：${err?.stack || err?.message || err}`);
    }
  }

  /** 短时间内的多条消息合并成一次回复 */
  #schedule(kind, peerId, meta) {
    const key = `${kind}:${peerId}`;
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = { timer: null, meta };
      this.buffers.set(key, buf);
    } else {
      buf.meta = meta;
    }
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      this.buffers.delete(key);
      this.#enqueue(key, () => this.respond(kind, peerId, buf.meta));
    }, Math.max(300, Number(getSettings().reply_settle_ms) || 2500));
  }

  #enqueue(key, fn) {
    const prev = this.chains.get(key) || Promise.resolve();
    const next = prev.then(fn, fn).catch((err) => {
      log('error', 'bot', `回复任务失败：${err?.stack || err?.message || err}`);
    });
    this.chains.set(key, next);
    next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  // —————————————————————————— 回复 ——————————————————————————

  async respond(kind, peerId, { userId = '', senderName = '' } = {}) {
    const s = getSettings();
    const conv = getConversation(
      getOrCreateConversation(kind, peerId).id
    );
    if (!conv) return;

    const isGroup = kind === 'group';
    const user = isGroup ? null : getOrCreateUser(peerId, senderName);
    const persona = resolvePersona(conv, user);
    if (!persona) {
      log('warn', 'bot', '没有可用人格（全部被停用），已跳过回复');
      return;
    }

    // 第一次对话时先递一句招呼，像真人那样
    if (persona.greeting && Number(conv.message_count) <= 1) {
      try {
        await this.#send(kind, peerId, persona.greeting);
        const rec = addMessage(conv.id, 'assistant', persona.greeting, '');
        this.#emitOut(conv, persona.greeting, rec);
      } catch (err) {
        log('warn', 'bot', `发送开场白失败：${err.message}`);
      }
    }

    const wait = Number(s.cooldown_ms) - (Date.now() - (this.lastReplyAt.get(`${kind}:${peerId}`) || 0));
    if (wait > 0) await sleep(wait);

    const pending = this.pendingImages.get(conv.id) || [];
    this.pendingImages.delete(conv.id);
    const messages = buildMessages(persona, { conv, user, images: pending });
    this.broadcast({ type: 'typing', conversation_id: conv.id, on: true });

    let out;
    try {
      out = await this.#withSlot(() =>
        chat(messages, {
          temperature: persona.temperature == null ? s.temperature : persona.temperature,
          model: pending.length ? undefined : persona.model || undefined,
          vision: pending.length > 0,
        })
      );
    } catch (err) {
      this.broadcast({ type: 'typing', conversation_id: conv.id, on: false });
      log('error', 'llm', err.message);
      return;
    }
    this.broadcast({ type: 'typing', conversation_id: conv.id, on: false });

    let text = s.plain_text ? stripMarkdown(out.content) : String(out.content).trim();
    text = stripSpeakerPrefix(text, [persona.name, s.bot_name]);
    const wantSticker = this.#stripStickerMarker(text);
    text = wantSticker.text;
    if (!text && !wantSticker.wanted) return;

    if (text) await this.#deliver(persona, conv, text);
    if (s.sticker_enabled) {
      const chance = Math.max(0, Math.min(100, Number(s.sticker_chance) || 0));
      if (wantSticker.wanted || Math.random() * 100 < chance) await this.#sendSticker(conv, wantSticker.id);
    }
    if (out.usage) {
      log('info', 'llm', `tokens in=${out.usage.prompt_tokens ?? '?'} out=${out.usage.completion_tokens ?? '?'}`);
    }
  }

  /** 自己说完一句后，隔一会儿主动再补一句（只在主对话里，按概率） */
  #maybeContinue(conv) {
    const s = getSettings();
    if (!s.continue_enabled) return;
    const mainId = Number(s.main_conversation_id) || 0;
    if (!mainId || Number(conv.id) !== mainId) return;
    const chance = Math.max(0, Math.min(100, Number(s.continue_chance) || 0));
    if (Math.random() * 100 >= chance) return;
    const delay = Math.max(5000, Math.min(600000, Number(s.continue_delay_ms) || 45000));
    const timer = setTimeout(() => {
      this.#enqueue(conv.id, async () => {
        try {
          const persona = resolvePersona(conv, conv.user || null);
          if (!persona) return;
          const out = await chat(buildMessages(persona, { conv, user: conv.user || null, mode: 'continue' }), { temperature: persona.temperature ?? undefined });
          let text = s.plain_text ? stripMarkdown(out.content) : String(out.content).trim();
          text = stripSpeakerPrefix(text, [persona.name, s.bot_name]);
          const want = this.#stripStickerMarker(text);
          text = want.text;
          if (!text) return;
          await this.#deliver(persona, conv, text, '主动');
          if (want.wanted && s.sticker_enabled) await this.#sendSticker(conv, want.id);
          log('info', 'continue', `主动续话 -> ${conv.id}`);
        } catch (err) {
          log('warn', 'continue', '续话失败: ' + (err && err.message));
        }
      });
    }, delay);
    if (timer.unref) timer.unref();
  }

  /** 取消息里的图片，转成 data URI 交给多模态模型直接看 */
  async #grabImages(segments, messageId = 0) {
    if (!visionReady()) return [];
    const images = (segments || []).filter((x) => x.type === 'image').slice(0, 3);
    if (!images.length) return [];
    const out = [];
    for (const seg of images) {
      try {
        const buf = await resolveImageBytes(this.ob, seg, 15000, messageId);
        if (!buf || !buf.length) continue;
        const mime = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png';
        out.push(`data:${mime};base64,${buf.toString('base64')}`);
      } catch (err) {
        log('warn', 'vision', `图片读取失败：${err.message}`);
      }
    }
    return out;
  }

  /** 给消息里的图片补中文描述；没配识图或失败就原样返回 */
  async #withImageCaptions(segments, text) {
    if (!visionReady()) return text;
    const images = (segments || []).filter((x) => x.type === 'image');
    if (!images.length || !String(text).includes('[图片]')) return text;

    const captions = [];
    for (const seg of images.slice(0, 3)) {
      try {
        const buf = await resolveImageBytes(this.ob, seg);
        const desc = await captionImage(buf);
        if (desc) captions.push(desc);
      } catch (err) {
        log('warn', 'vision', `图片识别失败：${err.message}`);
      }
    }
    if (!captions.length) return text;

    let i = 0;
    return String(text).replace(/\[图片\]/g, () => {
      const desc = captions[i++];
      return desc ? `[图片：${desc}]` : '[图片]';
    });
  }

  /** 追问：等了一会儿没人回，催一句 */
  async followupSay(convId, { attempt = 1 } = {}) {
    const s = getSettings();
    const conv = getConversation(convId);
    if (!conv) return { ok: false, error: '会话不存在' };
    if (!llmReady()) return { ok: false, error: '模型未配置' };

    const user = conv.kind === 'private' ? getOrCreateUser(conv.peer_id, '') : null;
    const persona = resolvePersona(conv, user);
    if (!persona) return { ok: false, error: '没有可用人格' };

    let out;
    try {
      out = await this.#withSlot(() =>
        chat(buildMessages(persona, { conv, user, mode: Number(attempt) >= 2 ? 'followup2' : 'followup' }), {
          temperature: persona.temperature ?? s.temperature,
        })
      );
    } catch (err) {
      log('error', 'proactive', `追问失败：${err.message}`);
      return { ok: false, error: err.message };
    }

    let text = s.plain_text ? stripMarkdown(out.content) : String(out.content || '').trim();
    text = stripSpeakerPrefix(text, [persona.name, s.bot_name]);
    const wantSticker = this.#stripStickerMarker(text);
    text = wantSticker.text;
    if (!text) return { ok: false, error: '模型返回了空内容' };

    const sent = await this.#deliver(persona, conv, text, '主动');
    if (wantSticker.wanted && s.sticker_enabled) await this.#sendSticker(conv, wantSticker.id);
    return { ok: true, parts: sent, text };
  }

  /** 去掉 [[sticker]] / [[sticker:12]] 标记，返回是否需要发表情、以及指定编号 */
  #stripStickerMarker(text) {
    let wanted = false;
    let id = 0;
    const cleaned = String(text || '')
      .replace(/\[\[\s*(?:sticker|表情包?|表情)\s*(?:[:：]\s*(\d{1,6}))?\s*\]\]/gi, (_m, n) => {
        wanted = true;
        if (n) id = Number(n);
        return '';
      })
      // 模型有时直接照抄占位符写 [表情包]/【表情】，也当成要发表情
      .replace(/[\[【]\s*(?:表情包?|sticker)\s*[\]】]/gi, () => {
        wanted = true;
        return '';
      })
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: cleaned, wanted, id };
  }

  /** 从库里挑一张发出去（OneBot image，base64 避免路径转义问题） */
  async #sendSticker(conv, preferredId = 0) {
    if (!countStickers({ enabledOnly: true })) return null;
    const row = preferredId ? pickStickerById(preferredId) : pickSticker();
    if (!row) return null;
    let buf;
    try {
      buf = fs.readFileSync(stickerPath(row));
    } catch {
      log('warn', 'stickers', `表情文件丢了：${row.file}`);
      return null;
    }
    const segment = [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }];
    try {
      if (conv.kind === 'group') await this.ob.sendGroup(conv.peer_id, segment);
      else await this.ob.sendPrivate(conv.peer_id, segment);
    } catch (err) {
      log('error', 'stickers', `表情包发送失败：${err.message}`);
      return null;
    }
    const rec = addMessage(conv.id, 'assistant', '[表情包]', '');
    this.#emitOut(conv, '[表情包]', rec);
    log('info', 'stickers', `发了一张表情包 → ${conv.title || conv.peer_id}`);
    return row;
  }

  /** 分段发送 + 落库 + 推送面板；senderTag 用来标记「主动」消息 */
  async #deliver(persona, conv, text, senderTag = '') {
    const s = getSettings();
    const burst = burstPolicy(getMood(conv.id), s);
    const parts = s.split_reply ? splitReply(text, { maxLen: 70, maxParts: burst.maxParts }) : [text];
    const sent = [];
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await sleep(randomBetween(burst.delayMin, burst.delayMax));
      try {
        await this.#send(conv.kind, conv.peer_id, parts[i]);
      } catch (err) {
        log('error', 'bot', `发送失败：${err.message}`);
        break;
      }
      const rec = addMessage(conv.id, 'assistant', parts[i], senderTag);
      this.#emitOut(conv, parts[i], rec);
      sent.push(parts[i]);
    }
    if (sent.length) {
      this.lastReplyAt.set(`${conv.kind}:${conv.peer_id}`, Date.now());
      afterAssistantMessage(conv.id, sent.length);
    }
    return sent;
  }

  /**
   * 主对话的「主动开口」：拿当前人格 + 全部（预算内）历史，生成一条不靠对方的话。
   * force=true 时忽略「上一条已经是主动消息」的保护（面板上的「现在试一条」）。
   */
  async proactiveSay(convId, { force = false, mode = 'topic' } = {}) {
    const s = getSettings();
    const conv = getConversation(convId);
    if (!conv) return { ok: false, error: '会话不存在' };
    if (!llmReady()) return { ok: false, error: '模型 API 还没配置' };
    const user = conv.kind === 'private' ? getOrCreateUser(conv.peer_id, conv.title) : null;
    const persona = resolvePersona(conv, user);
    if (!persona) return { ok: false, error: '没有可用人格' };

    const last = lastMessage(conv.id);
    const idleMs = Math.max(1, Number(s.proactive_idle_minutes) || 45) * 60000;
    if (!force && last && last.sender === '主动' && Date.now() - last.created_at < idleMs) {
      return { ok: false, error: '刚发过一条主动消息，先等等' };
    }

    const messages = buildMessages(persona, { conv, user, mode: mode === 'newtopic' ? 'newtopic' : 'proactive' });
    this.broadcast({ type: 'typing', conversation_id: conv.id, on: true });
    let out;
    try {
      out = await this.#withSlot(() =>
        chat(messages, {
          temperature: persona.temperature == null ? s.temperature : persona.temperature,
          model: persona.model || undefined,
        })
      );
    } catch (err) {
      this.broadcast({ type: 'typing', conversation_id: conv.id, on: false });
      log('error', 'llm', err.message);
      return { ok: false, error: err.message };
    }
    this.broadcast({ type: 'typing', conversation_id: conv.id, on: false });

    let text = s.plain_text ? stripMarkdown(out.content) : String(out.content || '').trim();
    text = stripSpeakerPrefix(text, [persona.name, s.bot_name]);
    const wantSticker = this.#stripStickerMarker(text);
    text = wantSticker.text;
    if (!text && !wantSticker.wanted) return { ok: false, error: '模型返回了空内容' };
    const sent = text ? await this.#deliver(persona, conv, text, '主动') : [];
    if (wantSticker.wanted && s.sticker_enabled) await this.#sendSticker(conv, wantSticker.id);
    if (out.usage) log('info', 'llm', `tokens in=${out.usage.prompt_tokens ?? '?'} out=${out.usage.completion_tokens ?? '?'}（主动消息）`);
    return { ok: sent.length > 0, text: sent.join(''), parts: sent, persona: persona.name };
  }

  #emitOut(conv, content, rec) {
    this.broadcast({
      type: 'message',
      conversation_id: conv.id,
      kind: conv.kind,
      peer_id: conv.peer_id,
      title: conv.title,
      role: 'assistant',
      sender: rec.sender || '',
      content,
      id: rec.id,
      created_at: rec.created_at,
    });
  }

  async #send(kind, peerId, text) {
    const message = [{ type: 'text', data: { text } }];
    if (kind === 'group') return this.ob.sendGroup(peerId, message);
    return this.ob.sendPrivate(peerId, message);
  }

  async #withSlot(fn) {
    const max = Math.max(1, Number(getSettings().max_concurrency) || 3);
    while (this.active >= max) await sleep(60);
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }

  // —————————————————————————— 面板手动发送 ——————————————————————————

  /** 直接说一句话（不经过模型），用于转交提示与结果 */
  async saySafely(conv, text) {
    const s = getSettings();
    const body = s.plain_text ? stripMarkdown(String(text)) : String(text);
    const parts = splitReply(body, { maxLen: 300, maxParts: 3 });
    const sent = [];
    for (const part of parts) {
      if (!part.trim()) continue;
      await this.#send(conv.kind, conv.peer_id, part);
      const rec = addMessage(conv.id, 'assistant', part, '');
      this.#emitOut(conv, part, rec);
      sent.push(part);
    }
    return sent;
  }

  /** 发一张图（base64 内联），用于 DSH 输出截图 */
  async sendImage(conv, buf) {
    const segment = [{ type: 'image', data: { file: `base64://${Buffer.from(buf).toString('base64')}` } }];
    if (conv.kind === 'group') await this.ob.sendGroup(conv.peer_id, segment);
    else await this.ob.sendPrivate(conv.peer_id, segment);
    const rec = addMessage(conv.id, 'assistant', '[DSH 输出截图]', '');
    this.#emitOut(conv, '[DSH 输出截图]', rec);
    return rec;
  }

  async sendManual(kind, peerId, text) {
    const s = getSettings();
    const conv = getOrCreateConversation(kind, String(peerId), {});
    const parts = s.split_reply ? splitReply(stripMarkdown(text), { maxLen: 70, maxParts: maxPartsFor(s) }) : [String(text)];
    const sent = [];
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await sleep(randomBetween(s.segment_delay_min, s.segment_delay_max));
      await this.#send(kind, String(peerId), parts[i]);
      const rec = addMessage(conv.id, 'assistant', parts[i], '');
      this.#emitOut(conv, parts[i], rec);
      sent.push(parts[i]);
    }
    return sent;
  }
}
