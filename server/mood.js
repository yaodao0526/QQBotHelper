import { one, run } from './db.js';
import { getSettings } from './config.js';

const BASE = { valence: 50, arousal: 35, energy: 55 };
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export function getMood(conversationId) {
  const id = Number(conversationId) || 0;
  if (!id) return { ...BASE, conversation_id: 0, updated_at: Date.now() };
  const row = one('SELECT conversation_id, valence, arousal, energy, updated_at FROM moods WHERE conversation_id = ?', id);
  if (!row) return { conversation_id: id, ...BASE, updated_at: 0 };
  return {
    conversation_id: id,
    valence: clamp(row.valence),
    arousal: clamp(row.arousal),
    energy: clamp(row.energy),
    updated_at: Number(row.updated_at) || 0,
  };
}

function saveMood(id, mood) {
  const now = Date.now();
  run(
    `INSERT INTO moods (conversation_id, valence, arousal, energy, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET valence = excluded.valence, arousal = excluded.arousal, energy = excluded.energy, updated_at = excluded.updated_at`,
    id,
    clamp(mood.valence),
    clamp(mood.arousal),
    clamp(mood.energy),
    now
  );
  return { ...mood, conversation_id: id, updated_at: now };
}

export function setMood(conversationId, patch = {}) {
  const id = Number(conversationId) || 0;
  if (!id) return getMood(0);
  const cur = getMood(id);
  const next = {
    valence: patch.valence == null ? cur.valence : clamp(patch.valence),
    arousal: patch.arousal == null ? cur.arousal : clamp(patch.arousal),
    energy: patch.energy == null ? cur.energy : clamp(patch.energy),
  };
  return saveMood(id, next);
}

/** 时间过去了会回落到基线：别一直记仇，也别一直亢奋 */
export function settleMood(conversationId) {
  const cur = getMood(conversationId);
  if (!cur.conversation_id || !cur.updated_at) return cur;
  const mins = (Date.now() - cur.updated_at) / 60000;
  if (mins < 3) return cur;
  // 每 10 分钟往基线靠 12%，最多靠 60%
  const k = Math.min(0.6, (mins / 10) * 0.12);
  const next = {
    valence: cur.valence + (BASE.valence - cur.valence) * k,
    arousal: cur.arousal + (BASE.arousal - cur.arousal) * k,
    energy: cur.energy + (BASE.energy - cur.energy) * k,
  };
  return saveMood(cur.conversation_id, next);
}

const PRAISE = /(喜欢你|爱你|想你|姐姐|抱抱|抱一下|亲亲|贴贴|好棒|厉害|可爱|想你啦|乖)/;
const SORRY = /(对不起|抱歉|我错了|是我不好|别生气)/;
const COLD = /^(嗯+|哦+|好|好的|行|可以|随便|不知道|没事|呵呵|睡了|困了)[。！!~～…\s]*$/;
const HOSTILE = /(烦死了|别管我|闭嘴|讨厌你|走开|滚)/;

/** 收到一条用户消息后，心情怎么动 */
export function afterUserMessage(conversationId, text) {
  const s = getSettings();
  if (!s.mood_enabled) return getMood(conversationId);
  const cur = getMood(conversationId);
  const t = String(text || '');
  let { valence, arousal, energy } = cur;

  if (PRAISE.test(t)) {
    valence += 7;
    arousal += 8;
    energy += 4;
  }
  if (SORRY.test(t)) {
    valence += 5;
    arousal -= 6;
  }
  if (HOSTILE.test(t)) {
    valence -= 14;
    arousal += 14;
    energy -= 4;
  }
  if (COLD.test(t.trim())) {
    valence -= 8;
    arousal += 3;
    energy -= 3;
  }
  if (t.length >= 40) {
    valence += 3;
    arousal += 2;
  } else if (t.length <= 3 && !COLD.test(t.trim())) {
    arousal += 2;
  }

  return saveMood(conversationId, {
    valence: clamp(valence),
    arousal: clamp(arousal),
    energy: clamp(energy),
  });
}

/** 自己说完之后：情绪被释放一点 */
export function afterAssistantMessage(conversationId, parts = 1) {
  const s = getSettings();
  if (!s.mood_enabled) return getMood(conversationId);
  const cur = getMood(conversationId);
  const n = Math.max(1, Number(parts) || 1);
  return saveMood(conversationId, {
    valence: clamp(cur.valence + (n >= 2 ? 3 : 0)),
    arousal: clamp(cur.arousal - Math.min(18, 5 * n)),
    energy: clamp(cur.energy - 2 * n),
  });
}

/** 给模型看的一段心情描述（也是"活人感"的来源） */
export function moodPrompt(mood) {
  const { valence, arousal, energy } = mood;
  const v =
    valence >= 75
      ? '心情很好，愿意多说两句，语气轻快'
      : valence >= 58
        ? '心情不错，松松散散的'
        : valence >= 42
          ? '心情平平，不冷不热'
          : valence >= 26
            ? '有点低落，话会变少，句子偏短'
            : '情绪很低，有点蔫，不太想多说';
  const a =
    arousal >= 78
      ? '情绪上头，标点会更用力，可以连着发两三条短消息'
      : arousal >= 58
        ? '心里有点起伏，可以拆成两条说'
        : arousal >= 36
          ? '情绪平稳，一次说一条就够'
          : '很平静，慢条斯理，一次只说一句';
  const e = energy >= 70 ? '这会儿精力很足' : energy >= 45 ? '精力一般' : '有点累，懒得说长句';

  return `【你现在的心情】
心情 ${Math.round(valence)}/100：${v}。
情绪强度 ${Math.round(arousal)}/100：${a}。
${e}。
这个状态只影响你自己怎么说话，不要向对方解释心情数值，也不要提「情绪条」这种东西。`;
}

/**
 * 根据当前情绪决定这次回复可以拆成几条、每条之间隔多久。
 * 情绪越上头，越容易"噼里啪啦连发几条"。
 */
export function burstPolicy(mood, settings) {
  const s = settings || getSettings();
  const baseParts = Math.max(1, Math.min(5, Number(s.reply_max_parts) || 1));
  if (!s.mood_enabled) {
    return {
      maxParts: baseParts,
      delayMin: Number(s.segment_delay_min) || 500,
      delayMax: Number(s.segment_delay_max) || 1400,
      hot: false,
    };
  }
  const a = Number(mood.arousal) || 0;
  if (a >= 78) return { maxParts: Math.max(baseParts, 4), delayMin: 220, delayMax: 620, hot: true };
  if (a >= 58) return { maxParts: Math.max(baseParts, 2), delayMin: 380, delayMax: 900, hot: true };
  return {
    maxParts: baseParts,
    delayMin: Number(s.segment_delay_min) || 500,
    delayMax: Number(s.segment_delay_max) || 1400,
    hot: false,
  };
}
