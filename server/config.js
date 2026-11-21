import { all, run } from './db.js';
import { log } from './db.js';

/**
 * 全量默认配置。写入 settings 表时统一 JSON 编码，读出时按默认值类型解码。
 */
export const DEFAULT_SETTINGS = {
  // —— 模型 ——
  api_base: 'https://api.deepseek.com',
  api_key: '',
  model: 'deepseek-chat',
  temperature: 1.0,
  max_tokens: 800,
  request_timeout_ms: 60000,

  // —— 人格 ——
  bot_name: '小深',
  default_persona_id: 0,
  qq_knowledge: true, // 注入 QQ 常识 / 群聊私聊玩法 / 表情包 / 网络用语
  slang_limit: 16, // 注入多少条网络用语（0 = 不注入）

  // —— 对话 ——
  history_turns: 12, // 携带最近多少条历史消息
  split_reply: true,
  reply_max_parts: 3,
  mood_enabled: true, // 情绪条：影响说话长短和连发节奏 // 每条回复最多几条气泡（1 = 只回一条）
  segment_delay_min: 500,
  segment_delay_max: 1400,
  plain_text: true, // Markdown 转纯文本
  cooldown_ms: 1200, // 同一会话两次回复的最小间隔
  max_concurrency: 3,

  // —— 触发规则 ——
  trigger_private: true,
  trigger_group: true,
  group_need_at: true,
  wake_words: '',
  whitelist: '',
  blacklist: '',
  random_chance: 0, // 群聊随机插话概率 %

  // —— 表情包 ——
  sticker_enabled: true, // 允许它发表情包（库里的收藏表情）
  sticker_chance: 20,
  sticker_desc_limit: 24,
  sticker_web_enabled: true,
  sticker_search_url: 'https://www.bing.com/images/async?q={q}&first=1&count=35&mkt=zh-CN&adlt=strict',
  reply_settle_ms: 2500,
  continue_enabled: true, // 自己说完一句后，主动再补一句把话题往前推
  continue_chance: 45, // 概率 %
  continue_delay_ms: 45000, // 隔多久再补 // 没有明确标记时，额外随机配一张的概率 %

  // —— 主对话 / 主动消息 ——
  main_conversation_id: 0, // 主对话会话 id（0 = 未设定）
  main_unlimited_history: true, // 主对话携带尽量多的历史（按字符预算）
  main_history_char_budget: 24000, // 主对话历史注入的字符上限
  proactive_enabled: true, // 定时主动开口
  proactive_min_minutes: 20, // 两次主动消息的最小间隔
  proactive_max_minutes: 60, // 最大间隔
  proactive_quiet_start: '00:30', // 安静时段（不主动打扰）
  proactive_quiet_end: '08:30',
  proactive_idle_minutes: 15, // 对方多久没说话才主动
  proactive_daily_cap: 8, // 每天最多主动几次（含追问）
  followup_enabled: true, // 发了消息没人回时追问
  followup_minutes: 12, // 等多久没回就追问
  followup_max: 2, // 同一条消息最多追问几次

  // —— 识图（可选，需要支持图片输入的模型）——
  vision_enabled: false,
  vision_api_base: '', // 留空则复用主模型 Base URL
  vision_api_key: '', // 留空则复用主模型 Key
  vision_model: '',
  dsh_enabled: true,
  dsh_keywords: 'dsh,harness,小D',
  dsh_command: '',
  dsh_timeout_ms: 600000,
  dsh_cwd: '',
  dsh_send_mode: 'images', // images = 优先发任务产出的图片；transcript = 发终端截图；both = 两者 // 例如 qwen-vl-max / glm-4.6v / gpt-4o-mini

  // —— OneBot ——
  onebot_enabled: true,
  onebot_ws_port: 7801,
  onebot_token: '',
  forward_ws_url: '',
  forward_ws_token: '',
};

let cache = null;

export function loadSettings() {
  const rows = all('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (!(row.key in DEFAULT_SETTINGS)) continue;
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      /* ignore corrupt value */
    }
  }
  cache = out;
  return cache;
}

export function getSettings() {
  if (!cache) loadSettings();
  return cache;
}

export function updateSettings(patch) {
  const current = getSettings();
  const changed = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[key];
    let next = value;
    if (typeof def === 'number') {
      next = Number(value);
      if (!Number.isFinite(next)) next = def;
    } else if (typeof def === 'boolean') {
      next = Boolean(value);
    } else {
      next = value == null ? '' : String(value);
    }
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, JSON.stringify(next));
    changed[key] = next;
  }
  const next = { ...current, ...changed };
  cache = next;
  if (Object.keys(changed).length) {
    const keys = Object.keys(changed).map((k) => (k === 'api_key' ? 'api_key(已更新)' : k));
    log('info', 'settings', `更新配置：${keys.join(', ')}`);
  }
  return next;
}

/** 逗号 / 空格 / 换行分隔的列表 */
export function parseList(raw) {
  return String(raw || '')
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
