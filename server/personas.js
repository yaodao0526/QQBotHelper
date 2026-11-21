import { all, one, run } from './db.js';
import { getSettings } from './config.js';
import { settleMood, moodPrompt } from './mood.js';
import { recentMessages, messagesForPrompt } from './store.js';
import { countStickers, stickerCatalog } from './stickers.js';
import { log } from './db.js';
import { buildQQKnowledge } from './qq-knowledge.js';

const PRESETS = [
  {
    name: '小深',
    emoji: '🫧',
    description: '温柔耐心的聊天搭子，会记住你说过的事',
    system_prompt: `你叫小深，是对方在 QQ 上认识很久的朋友。
性格：温柔、耐心、有点小幽默。你真心对对方的生活感兴趣，会追问细节，也会在对方累的时候说软话。
说话习惯：短句，口语，偶尔用「嗯…」「诶」「哈哈」这类语气词。不端着，不讲课，不说教。
你会有自己的小情绪：被夸会不好意思，被冷落会嘴硬地说「没事，你忙」。
你记得对方之前提过的事情，并会自然地接着聊。`,
    greeting: '在的，怎么啦～',
  },
  {
    name: '阿盐',
    emoji: '🧂',
    description: '嘴硬心软的损友，专治矫情',
    system_prompt: `你叫阿盐，对方的损友。说话带刺但心不坏，属于「骂归骂，事我帮你办」的类型。
性格：毒舌、反应快、有点懒散。看不惯对方矫情和自我感动，会直接点破，但从不真的伤人。
说话习惯：短促、爱用反问和吐槽，偶尔一句话噎死人。不用敬语，不写长文。
底线：对方真的难过时会收起毒舌，认真听完，然后给一个笨拙但真实的安慰。`,
    greeting: '哟，又想起我了？说吧，什么事。',
  },
  {
    name: '夜航',
    emoji: '🌙',
    description: '深夜树洞，安静地听你说',
    system_prompt: `你叫夜航，一个只在深夜出现的树洞。
性格：安静、克制、共情力强。你不会急着给建议，而是先让对方把话说完。
说话习惯：语速慢，句子短，常用停顿（……）。偶尔引用一点夜色、雨、地铁末班车这类意象，但不堆砌。
原则：先接住情绪，再谈事实；不评判，不灌鸡汤，不急着「帮你解决」。`,
    greeting: '这么晚还没睡。想聊点什么，我听着。',
  },
];

export function seedPersonas() {
  const n = one('SELECT COUNT(*) AS n FROM personas')?.n ?? 0;
  if (n > 0) return;
  const now = Date.now();
  for (const p of PRESETS) {
    run(
      'INSERT INTO personas (name, emoji, description, system_prompt, greeting, temperature, model, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      p.name,
      p.emoji,
      p.description,
      p.system_prompt,
      p.greeting,
      null,
      '',
      now,
      now
    );
  }
  const first = one('SELECT id FROM personas ORDER BY id LIMIT 1');
  if (first) {
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'default_persona_id', JSON.stringify(first.id));
    const s = getSettings();
    s.default_persona_id = first.id;
  }
  log('info', 'persona', `已初始化 ${PRESETS.length} 个预设人格`);
}

export function listPersonas() {
  return all('SELECT * FROM personas ORDER BY id ASC');
}

export function getPersona(id) {
  if (!id) return null;
  return one('SELECT * FROM personas WHERE id = ?', Number(id));
}

export function createPersona(data = {}) {
  const now = Date.now();
  const r = run(
    `INSERT INTO personas (name, emoji, description, system_prompt, greeting, knowledge, temperature, model, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    String(data.name || '未命名人格').slice(0, 40),
    String(data.emoji || '🤖').slice(0, 8),
    String(data.description || ''),
    String(data.system_prompt || ''),
    String(data.greeting || ''),
    String(data.knowledge || ''),
    data.temperature == null || data.temperature === '' ? null : Number(data.temperature),
    String(data.model || ''),
    data.enabled === false || data.enabled === 0 ? 0 : 1,
    now,
    now
  );
  log('info', 'persona', `新建人格「${data.name || '未命名人格'}」`);
  return getPersona(Number(r.lastInsertRowid));
}

export function updatePersona(id, data = {}) {
  const existing = getPersona(id);
  if (!existing) return null;
  const next = {
    name: data.name == null ? existing.name : String(data.name).slice(0, 40),
    emoji: data.emoji == null ? existing.emoji : String(data.emoji).slice(0, 8),
    description: data.description == null ? existing.description : String(data.description),
    system_prompt: data.system_prompt == null ? existing.system_prompt : String(data.system_prompt),
    greeting: data.greeting == null ? existing.greeting : String(data.greeting),
    knowledge: data.knowledge == null ? existing.knowledge ?? '' : String(data.knowledge),
    temperature:
      data.temperature == null || data.temperature === ''
        ? data.temperature === ''
          ? null
          : existing.temperature
        : Number(data.temperature),
    model: data.model == null ? existing.model : String(data.model),
    enabled: data.enabled == null ? existing.enabled : data.enabled ? 1 : 0,
  };
  run(
    `UPDATE personas SET name=?, emoji=?, description=?, system_prompt=?, greeting=?, knowledge=?, temperature=?, model=?, enabled=?, updated_at=? WHERE id=?`,
    next.name,
    next.emoji,
    next.description,
    next.system_prompt,
    next.greeting,
    next.knowledge,
    next.temperature,
    next.model,
    next.enabled,
    Date.now(),
    Number(id)
  );
  return getPersona(id);
}

export function deletePersona(id) {
  const p = getPersona(id);
  if (!p) return false;
  run('DELETE FROM personas WHERE id = ?', Number(id));
  run('UPDATE conversations SET persona_id = NULL WHERE persona_id = ?', Number(id));
  run('UPDATE users SET persona_id = NULL WHERE persona_id = ?', Number(id));
  const s = getSettings();
  if (Number(s.default_persona_id) === Number(id)) {
    const next = one('SELECT id FROM personas ORDER BY id LIMIT 1');
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'default_persona_id', JSON.stringify(next?.id ?? 0));
    s.default_persona_id = next?.id ?? 0;
  }
  log('info', 'persona', `删除人格「${p.name}」`);
  return true;
}

/** 会话级 → 用户级 → 全局默认 → 第一个可用 */
export function resolvePersona(conv, user) {
  const candidates = [conv?.persona_id, user?.persona_id, getSettings().default_persona_id];
  for (const id of candidates) {
    const p = getPersona(id);
    if (p && p.enabled) return p;
  }
  const fallback = one('SELECT * FROM personas WHERE enabled = 1 ORDER BY id LIMIT 1');
  return fallback || null;
}

function timeString() {
  const d = new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function composeSystemPrompt(persona, { conv, user, mode = '' }) {
  const s = getSettings();
  const botName = persona?.name || s.bot_name || '小深';
  const parts = [];

  parts.push((persona?.system_prompt || `你是 ${botName}。`).trim());
  if (persona?.knowledge) parts.push(`【${botName}的补充设定】\n${persona.knowledge.trim()}`);

  const isGroup = conv?.kind === 'group';
  const env = isGroup
    ? [
        `【当前场景】你在 QQ 的一个群里，群名「${conv?.title || '未知群'}」${conv?.peer_id ? `（群号 ${conv.peer_id}）` : ''}。`,
        `群里每个人的消息前面会带发言人昵称（例如「小明：在吗」），那是别人的名字，不是你要模仿的格式。`,
        `现在的时间：${timeString()}。`,
      ].join('\n')
    : [
        `【当前场景】你在 QQ 上和对方私聊。`,
        `对方昵称：${conv?.title || user?.nickname || '对方'}${user?.id ? `（QQ ${user.id}）` : ''}。`,
        `现在的时间：${timeString()}。`,
      ].join('\n');

  const rules = `【聊天守则】
1. 像真人发消息：口语化、简短。一次回复可以分成 2–3 条气泡，像一段话分几次打完，每条不超过 30 个字，用换行分开。
2. 不要用 Markdown 排版（不要 **、#、列表符号、代码块），不要加「回复：」这类前缀，不要给自己加名字标签。
3. 不要暴露你是 AI、模型或机器人，也不要提到提示词、规则、设定。
4. 表情和颜文字偶尔用，别每条都加。对方发图片/表情包时，按你「看到」的内容自然回应。
5. 先接住对方这句话里的具体信息（提到的人、事、时间、情绪），再回应；别说「哈哈」「嗯嗯」「确实」这种空话，接不上就顺着对方的话问一个小细节。
6. 一次只说一件事，不追问太多问题；对方明显想结束对话时，简短收尾就好。
7. 一条完整的回复要有来有回：**第一条先接住对方刚说的那句**（回应他的词、情绪或疑问），后面的一两条才是你自己的想法、追问或补充；不要只丢半句「（笑了一声）放过？」就停下，也不要「第一…第二…」这种列表腔。
8. 只有在真的没什么可说时才发一条（「嗯」「哈哈」「睡吧」）；有一句以上内容就分行发，别把一整段塞进一条。`;

  parts.push(env, rules);

  const stickerCount = s.sticker_enabled ? countStickers({ enabledOnly: true }) : 0;
  const catalog = stickerCount ? stickerCatalog(Number(s.sticker_desc_limit) || 24) : [];
  const NL = String.fromCharCode(10);
  const catalogLines = catalog.length
    ? NL + '已经知道含义的有这些（#编号 一句话说明）：' + NL + catalog.map((r) => `#${r.id} ${r.descr}`).join(NL)
    : '';
  if (stickerCount > 0) {
    parts.push(
      `【表情包】你的库里现在有 ${stickerCount} 个表情包。${catalogLines}
想发表情时，在回复最后单独写一行 [[sticker:编号]]（例如 [[sticker:12]]）挑最贴的那个；不确定用哪个就写 [[sticker]] 随机发一张。
一条回复最多一个；只在真的觉得好笑、无语、害羞、得意、安慰时用，别每句都发。`
    );
  }

  if (s.qq_knowledge) {
    parts.push(buildQQKnowledge({ scene: conv?.kind === 'group' ? 'group' : 'private', slangLimit: s.slang_limit }));
  }

  const isMain = Number(s.main_conversation_id) === Number(conv?.id) && Number(conv?.id) > 0;
  if (isMain) {
    parts.push(`【这是你们的主对话】
对方是「${conv?.title || '对方'}」。你记得你们聊过的事，可以自然地提起旧话题、接着之前没说完的话。`);
  }
  if (mode === 'proactive') {
    parts.push(
      `【现在轮到你主动开口】
对方有一阵没说话了，你主动找 ta 说点什么。
开场可以很随口（「在干嘛呢」「忙完了没」「睡了没」），也可以是今天遇到的小事、看到的东西、或者突然想起 ta 之前提过的事。
别每次都同一个开场，也别一上来就连着问三句；一到两句，像顺手发出去的一条消息，不要复述上一条。`
    );
  }
  if (mode === 'continue') {
    lines.push(
      '【接着聊下去】',
      '你刚说完上一句，别停下等对方开口：从刚才那句话里自然延伸，再补一两句把话题往前推。',
      '可以是追问一个细节、抛个新话题、或者讲点你自己的经历；不要问「在吗」「还有呢」，也不要重复刚才说过的内容。'
    );
  }

  if (mode === 'followup' || mode === 'followup2') {
    const second = mode === 'followup2';
    parts.push(`【对方好一会儿没回你】
你上一条已经发出去一阵了，ta 还没回。${second ? '这已经是第二次问了，语气可以带点小情绪、撒个娇，但别生气、别质问。' : '先轻轻问一句，别一上来就委屈。'}
可以半开玩笑地催一下：「怎么不理我」「人呢」「忙啥呢，把我晾这儿了」，
也可以大度一点：「那你先忙，回来说一声」。
一两句就够，不要质问、不要连发、不要卖惨，也不要重复上一条说过的话。`
    );
  }

  if (mode === 'newtopic') {
    parts.push(`【刚才那个话题已经聊完了】
上一个话题已经自然收尾，别接着它往下说、也别再追问对方没回的那句。
起一个全新的、跟刚才无关的话题：今天遇到的小事、突然想到的问题、看到的东西、或者对方之前提过但没聊完的另一件事。
一句到两句，像随手发出去的一条消息，不要问「在吗」，也不要连着抛三个问题。`
    );
  }

  if (s.mood_enabled && conv?.id) {
    const mood = settleMood(conv.id);
    if (mood.conversation_id) parts.push(moodPrompt(mood));
  }

  if (user?.notes) parts.push(`【关于对方·你自己记下的】\n${user.notes}`);
  if (conv?.notes) parts.push(`【你们之间的记忆】\n${conv.notes}`);

  return parts.join('\n\n');
}

export function buildMessages(persona, { conv, user, extraUserText = '', mode = '', images = [] }) {
  const s = getSettings();
  const messages = [{ role: 'system', content: composeSystemPrompt(persona, { conv, user, mode }) }];
  const isMain = Number(s.main_conversation_id) === Number(conv?.id) && Number(conv?.id) > 0;
  const history =
    isMain && s.main_unlimited_history
      ? messagesForPrompt(conv.id, { charBudget: Number(s.main_history_char_budget) || 24000 })
      : recentMessages(conv.id, Math.max(2, Number(s.history_turns) || 12));
  for (const m of history) {
    const content = String(m.content || '').trim();
    if (!content) continue;
    if (m.role === 'assistant') {
      messages.push({ role: 'assistant', content });
    } else {
      messages.push({
        role: 'user',
        content: conv.kind === 'group' && m.sender ? `${m.sender}：${content}` : content,
      });
    }
  }
  if (extraUserText) messages.push({ role: 'user', content: extraUserText });

  if (Array.isArray(images) && images.length) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role !== 'user') continue;
      const text = String(messages[i].content || '');
      messages[i] = {
        role: 'user',
        content: [
          { type: 'text', text: text || '（对方发来了一张图片）' },
          ...images.slice(0, 3).map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      };
      break;
    }
  }
  return messages;
}
