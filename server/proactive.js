import { getSettings } from './config.js';
import {
  getConversation,
  lastMessage,
  lastMessages,
  countMessagesSince,
  trailingProactiveCount,
} from './store.js';
import { llmReady } from './llm.js';
import { log } from './db.js';
import { randomBetween } from './text.js';

/** "HH:MM" → 分钟数 */
function hhmm(raw, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return fallback;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

/** 安静时段判断（支持跨零点，如 23:30–08:00） */
export function inQuietHours(start, end, date = new Date()) {
  const a = hhmm(start, 30);
  const b = hhmm(end, 510);
  if (a === b) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** 这句话是不是在等对方接话（问句 / 「…吗」「…呢」这类） */
export function expectsAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const tail = t.slice(-20);
  if (/[？?]/.test(tail)) return true;
  return /(吗|呢|么|嘛|好不好|行不行|是不是|对不对)[\s。！!~～…]*$/.test(tail);
}

/** 有收尾感：道晚安、说要走，或者对面只回了个「嗯/好/哦/行」 */
export function feelsClosed(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/(晚安|睡了|先睡|拜拜|再见|先这样|回头聊|下次聊|不聊了|去忙了|先走了|下班了)/.test(t)) return true;
  return /^(嗯+|哦+|好|好的|行|可以|知道|知道了|ok|OK|哈哈+|呵+|收到|明白|是啊|對啊|对啊)[。！!~～…\s]*$/.test(t);
}

/**
 * 主对话的"主动开口"调度器：每隔 random(min,max) 分钟检查一次，
 * 先判断上一轮是不是"等对方回"（→ 催一句），还是"已经聊完了"（→ 起新话题）。
 */
export class Proactive {
  constructor(bot) {
    this.bot = bot;
    this.timer = null;
    this.running = false;
    this.lastReason = '';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#schedule();
    log('info', 'proactive', '主动消息调度已启动');
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 设置变更后重排下一次检查（间隔可能被改过） */
  reschedule() {
    if (this.running) this.#schedule();
  }

  #delayMs() {
    const s = getSettings();
    const min = Math.max(1, Number(s.proactive_min_minutes) || 20);
    const max = Math.max(min, Number(s.proactive_max_minutes) || 60);
    const base = randomBetween(min, max) * 60000;
    // 追问要更快：已经待到该催的时候，就早一点来看一眼
    if (s.followup_enabled) {
      const f = Math.max(0.005, Number(s.followup_minutes) || 12) * 60000;
      const quick = Math.min(base, Math.max(45000, f * 0.9));
      return Math.round(quick * (0.9 + Math.random() * 0.2));
    }
    return Math.round(base * (0.9 + Math.random() * 0.2));
  }

  /**
   * 判断此刻该干什么：
   *   followup —— 上一条是我说的，而且像在等回复（有问号/「吗」「呢」），或者对方明显没接话
   *   newtopic —— 那一轮已经聊完了（道别/只回了「嗯」），或者追问次数已经用完
   *   null     —— 还不到时候 / 追问关着
   */
  describe(conv, s = getSettings()) {
    const msgs = lastMessages(conv.id, 8);
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'assistant') {
      return { mode: null, reason: 'not-waiting', asked: 0, gapMin: 0 };
    }

    const gapMin = (Date.now() - Number(last.created_at || 0)) / 60000;
    const asked = trailingProactiveCount(conv.id);
    const max = Math.max(0, Number(s.followup_max) || 0);
    const wait = Math.max(0.005, Number(s.followup_minutes) || 12);

    if (asked >= max) return { mode: 'newtopic', reason: 'asked-out', asked, gapMin };
    if (gapMin < wait) return { mode: null, reason: 'too-soon', asked, gapMin };
    if (!s.followup_enabled) return { mode: null, reason: 'followup-off', asked, gapMin };

    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (expectsAnswer(last.content)) return { mode: 'followup', reason: 'waiting', asked, gapMin };
    if (feelsClosed(last.content) || feelsClosed(lastUser?.content)) {
      return { mode: 'newtopic', reason: 'topic-closed', asked, gapMin };
    }
    return { mode: 'followup', reason: 'silent', asked, gapMin };
  }

  #schedule(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    const wait = delayMs ?? this.#delayMs();
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => log('error', 'proactive', err?.stack || String(err)))
        .finally(() => this.#schedule());
    }, wait);
    if (this.timer.unref) this.timer.unref();
  }

  /** 面板上的"现在试一条"走 force=true，跳过时段/空闲/上限检查 */
  async tick({ force = false } = {}) {
    const s = getSettings();
    const id = Number(s.main_conversation_id) || 0;
    if (!id) return { ok: false, skipped: 'no-main' };
    if (!force) {
      if (!s.proactive_enabled) return { ok: false, skipped: 'disabled' };
      if (!llmReady()) return { ok: false, skipped: 'no-llm' };
      if (inQuietHours(s.proactive_quiet_start, s.proactive_quiet_end)) return { ok: false, skipped: 'quiet' };
    }
    const conv = getConversation(id);
    if (!conv) return { ok: false, skipped: 'missing' };

    const state = this.describe(conv, s);
    this.lastReason = state.reason;
    const cap = Math.max(0, Number(s.proactive_daily_cap) || 0);
    const used = countMessagesSince(conv.id, Date.now() - 24 * 3600 * 1000, '主动');

    // 还没到时候：不催也不换话题（手动「现在试一条」除外）
    if (!force && state.mode === null) return { ok: false, skipped: state.reason };
    if (!force && used >= cap) return { ok: false, skipped: 'cap' };

    if (state.mode === 'followup') {
      const res = await this.bot.followupSay(conv.id, { attempt: state.asked + 1 });
      if (res.ok) {
        log('info', 'proactive', `对方 ${Math.round(state.gapMin)} 分钟没接话，第 ${state.asked + 1} 次问了一句（${state.reason}）`);
        return { ok: true, followup: true, reason: state.reason, text: res.text };
      }
      if (res.error) log('warn', 'proactive', `追问没发出去：${res.error}`);
    }

    const idleMs = Math.max(1, Number(s.proactive_idle_minutes) || 45) * 60000;
    if (!force && state.mode === 'newtopic') {
      const last = lastMessage(conv.id);
      if (last && last.created_at && Date.now() - last.created_at < idleMs) {
        return { ok: false, skipped: 'busy' };
      }
    }

    const res = await this.bot.proactiveSay(conv.id, { force, mode: state.mode === 'newtopic' ? 'newtopic' : 'topic' });
    if (res.ok) {
      log(
        'info',
        'proactive',
        `主动给「${conv.title || conv.peer_id}」发了一条（${state.mode || 'topic'}${state.reason ? `/${state.reason}` : ''}）：${String(res.text || '').slice(0, 40)}`
      );
    } else if (res.error) {
      log('warn', 'proactive', `主动消息没发出去：${res.error}`);
    }
    return res;
  }
}
