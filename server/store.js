import { all, one, run } from './db.js';
import { getSettings } from './config.js';

export function getOrCreateConversation(kind, peerId, patch = {}) {
  const pid = String(peerId);
  let conv = one('SELECT * FROM conversations WHERE kind = ? AND peer_id = ?', kind, pid);
  if (!conv) {
    run(
      'INSERT INTO conversations (kind, peer_id, title, persona_id, created_at) VALUES (?, ?, ?, ?, ?)',
      kind,
      pid,
      patch.title || '',
      patch.personaId ?? null,
      Date.now()
    );
    conv = one('SELECT * FROM conversations WHERE kind = ? AND peer_id = ?', kind, pid);
  } else if (patch.title && patch.title !== conv.title) {
    run('UPDATE conversations SET title = ? WHERE id = ?', patch.title, conv.id);
    conv.title = patch.title;
  }
  return conv;
}

export function addMessage(conversationId, role, content, sender = '') {
  const now = Date.now();
  const r = run(
    'INSERT INTO messages (conversation_id, role, sender, content, created_at) VALUES (?, ?, ?, ?, ?)',
    conversationId,
    role,
    sender,
    String(content),
    now
  );
  run(
    'UPDATE conversations SET message_count = message_count + 1, last_message_at = ? WHERE id = ?',
    now,
    conversationId
  );
  return { id: Number(r.lastInsertRowid), created_at: now };
}

export function recentMessages(conversationId, limit = 20) {
  const rows = all(
    'SELECT id, role, sender, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
    conversationId,
    Math.max(1, Math.min(200, limit))
  );
  return rows.reverse();
}

/** 主对话：取尽可能多的历史，直到字符预算用完（从最新往前装，再翻回时间正序） */
export function messagesForPrompt(conversationId, { charBudget = 24000, maxRows = 600 } = {}) {
  const rows = all(
    'SELECT id, role, sender, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
    conversationId,
    Math.max(1, Math.min(2000, Number(maxRows) || 600))
  );
  const picked = [];
  let used = 0;
  for (const row of rows) {
    const cost = String(row.content || '').length + 8;
    if (picked.length && used + cost > charBudget) break;
    used += cost;
    picked.push(row);
  }
  return picked.reverse();
}

export function lastMessage(conversationId) {
  return (
    one(
      'SELECT id, role, sender, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
      Number(conversationId)
    ) || null
  );
}

/** 末尾连续由机器人主动发出的条数（sender='主动'，含追问），用来限制追问次数 */
export function lastMessages(conversationId, n = 6) {
  const rows = all(
    'SELECT id, role, sender, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
    Number(conversationId),
    Math.max(1, Number(n) || 6)
  );
  return rows.reverse();
}

export function trailingProactiveCount(conversationId) {
  const rows = all(
    "SELECT role, sender FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 12",
    Number(conversationId)
  );
  let n = 0;
  for (const r of rows) {
    if (r.role === 'assistant' && r.sender === '主动') n += 1;
    else break;
  }
  return n;
}

/** 最后一条用户消息之后，机器人连续发了几条（用来判断「没人回」） */
export function trailingAssistantCount(conversationId) {
  const rows = all(
    'SELECT role FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 12',
    Number(conversationId)
  );
  let n = 0;
  for (const r of rows) {
    if (r.role === 'assistant') n += 1;
    else break;
  }
  return n;
}

export function countMessagesSince(conversationId, since, sender = '') {
  const row = sender
    ? one(
        'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND created_at >= ? AND sender = ?',
        Number(conversationId),
        Number(since),
        sender
      )
    : one('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND created_at >= ?', Number(conversationId), Number(since));
  return Number(row?.n || 0);
}

/** 会话没有单独指定人格时，真正生效的是「全局默认人格」——用于列表/详情展示 */
function effectivePersonaId() {
  const row = one("SELECT value FROM settings WHERE key = 'default_persona_id'");
  let id = 0;
  try {
    id = Number(JSON.parse(row?.value ?? '0')) || 0;
  } catch {
    /* ignore */
  }
  if (id && one('SELECT id FROM personas WHERE id = ? AND enabled = 1', id)) return id;
  return one('SELECT id FROM personas WHERE enabled = 1 ORDER BY id LIMIT 1')?.id || 0;
}

function withEffectivePersona(row) {
  if (!row) return row;
  const explicitId = Number(row.persona_id) || 0;
  const id = explicitId || effectivePersonaId();
  if (!id) return row;
  const p = one('SELECT id, name, emoji FROM personas WHERE id = ?', id);
  if (!p) return row;
  // persona_id 保持原样（null = 跟随默认），另给出生效中的人格名，面板据此区分「显式指定」和「继承」
  return {
    ...row,
    persona_name: p.name,
    persona_emoji: p.emoji,
    persona_inherited: !explicitId,
    is_main: Number(getSettings().main_conversation_id) === Number(row.id),
  };
}

export function listConversations({ query = '', kind = '' } = {}) {
  const where = [];
  const args = [];
  if (kind === 'private' || kind === 'group') {
    where.push('c.kind = ?');
    args.push(kind);
  }
  if (query) {
    where.push('(c.title LIKE ? OR c.peer_id LIKE ?)');
    args.push(`%${query}%`, `%${query}%`);
  }
  const sql = `
    SELECT c.*, p.name AS persona_name, p.emoji AS persona_emoji,
      (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_content,
      (SELECT role FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_role
    FROM conversations c
    LEFT JOIN personas p ON p.id = c.persona_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.pinned DESC, COALESCE(c.last_message_at, c.created_at) DESC
    LIMIT 300`;
  return all(sql, ...args).map(withEffectivePersona);
}

export function getConversation(id) {
  return withEffectivePersona(
    one(
      `SELECT c.*, p.name AS persona_name, p.emoji AS persona_emoji
       FROM conversations c LEFT JOIN personas p ON p.id = c.persona_id WHERE c.id = ?`,
      Number(id)
    )
  );
}

export function updateConversation(id, patch) {
  const fields = [];
  const args = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!['title', 'notes', 'pinned', 'persona_id'].includes(key)) continue;
    fields.push(`${key} = ?`);
    args.push(value);
  }
  if (!fields.length) return getConversation(id);
  run(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`, ...args, Number(id));
  return getConversation(id);
}

export function deleteConversation(id) {
  run('DELETE FROM messages WHERE conversation_id = ?', Number(id));
  run('DELETE FROM conversations WHERE id = ?', Number(id));
}

export function clearConversation(id) {
  run('DELETE FROM messages WHERE conversation_id = ?', Number(id));
  run('UPDATE conversations SET message_count = 0, last_message_at = NULL WHERE id = ?', Number(id));
}

export function listMessages(conversationId, { before = 0, limit = 50 } = {}) {
  const rows = before
    ? all(
        'SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        Number(conversationId),
        Number(before),
        Number(limit)
      )
    : all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?', Number(conversationId), Number(limit));
  return rows.reverse();
}

export function getOrCreateUser(id, nickname = '') {
  let user = one('SELECT * FROM users WHERE id = ?', String(id));
  if (!user) {
    run('INSERT INTO users (id, nickname, last_seen) VALUES (?, ?, ?)', String(id), nickname, Date.now());
    user = one('SELECT * FROM users WHERE id = ?', String(id));
  } else if (nickname && nickname !== user.nickname) {
    run('UPDATE users SET nickname = ?, last_seen = ? WHERE id = ?', nickname, Date.now(), String(id));
    user = one('SELECT * FROM users WHERE id = ?', String(id));
  } else {
    run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now(), String(id));
  }
  return user;
}

export function listUsers() {
  return all('SELECT * FROM users ORDER BY COALESCE(last_seen, 0) DESC LIMIT 500');
}

export function updateUser(id, patch) {
  const fields = [];
  const args = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!['notes', 'blocked', 'persona_id', 'nickname'].includes(key)) continue;
    fields.push(`${key} = ?`);
    args.push(value);
  }
  if (!fields.length) return one('SELECT * FROM users WHERE id = ?', String(id));
  run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...args, String(id));
  return one('SELECT * FROM users WHERE id = ?', String(id));
}

export function stats() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const today = startOfDay.getTime();
  return {
    conversations: one('SELECT COUNT(*) AS n FROM conversations')?.n ?? 0,
    messages: one('SELECT COUNT(*) AS n FROM messages')?.n ?? 0,
    messages_today: one('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?', today)?.n ?? 0,
    users: one('SELECT COUNT(*) AS n FROM users')?.n ?? 0,
    personas: one('SELECT COUNT(*) AS n FROM personas')?.n ?? 0,
  };
}
