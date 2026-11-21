import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  emoji         TEXT NOT NULL DEFAULT '🤖',
  description   TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  greeting      TEXT NOT NULL DEFAULT '',
  knowledge     TEXT NOT NULL DEFAULT '',
  temperature   REAL,
  model         TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,              -- private | group
  peer_id         TEXT NOT NULL,              -- QQ 号 或 群号
  title           TEXT NOT NULL DEFAULT '',   -- 昵称 / 群名
  persona_id      INTEGER,
  notes           TEXT NOT NULL DEFAULT '',   -- 长期记忆，注入提示词
  pinned          INTEGER NOT NULL DEFAULT 0,
  message_count   INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (kind, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role            TEXT NOT NULL,              -- user | assistant | system
  sender          TEXT NOT NULL DEFAULT '',   -- 发言人昵称（群聊用）
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id DESC);

CREATE TABLE IF NOT EXISTS stickers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hash       TEXT NOT NULL UNIQUE,           -- 文件内容 sha1，用来去重
  file       TEXT NOT NULL,                  -- data/stickers 下的文件名
  url        TEXT NOT NULL DEFAULT '',       -- 来自 QQ 收藏的原始地址
  enabled    INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  descr      TEXT NOT NULL DEFAULT '',        -- 一句话描述（识图模型生成）
  source     TEXT NOT NULL DEFAULT 'qq',      -- qq | web
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sticker_enabled ON stickers(enabled, used_count);

CREATE TABLE IF NOT EXISTS moods (
  conversation_id INTEGER PRIMARY KEY,
  valence   REAL NOT NULL DEFAULT 50,        -- 心情：0 低落 … 100 高兴
  arousal   REAL NOT NULL DEFAULT 35,        -- 情绪强度：0 平静 … 100 上头
  energy    REAL NOT NULL DEFAULT 55,        -- 精力：0 蔫 … 100 有劲
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id        TEXT PRIMARY KEY,                 -- QQ 号
  nickname  TEXT NOT NULL DEFAULT '',
  notes     TEXT NOT NULL DEFAULT '',
  persona_id INTEGER,
  blocked   INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL DEFAULT 'info',
  scope      TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_time ON logs(id DESC);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'bot.db'));
  db.exec(SCHEMA);
  // 增量迁移：给已存在的旧库补列
  const personaCols = db.prepare('PRAGMA table_info(personas)').all().map((c) => c.name);
  if (!personaCols.includes('knowledge')) {
    db.exec("ALTER TABLE personas ADD COLUMN knowledge TEXT NOT NULL DEFAULT ''");
  }
  const stickerCols = db.prepare('PRAGMA table_info(stickers)').all().map((c) => c.name);
  if (!stickerCols.includes('descr')) db.exec("ALTER TABLE stickers ADD COLUMN descr TEXT NOT NULL DEFAULT ''");
  if (!stickerCols.includes('source')) db.exec("ALTER TABLE stickers ADD COLUMN source TEXT NOT NULL DEFAULT 'qq'");
  return db;
}

export function getDb() {
  if (!db) throw new Error('database not opened');
  return db;
}

export const all = (sql, ...args) => getDb().prepare(sql).all(...args);
export const one = (sql, ...args) => getDb().prepare(sql).get(...args) ?? null;
export const run = (sql, ...args) => getDb().prepare(sql).run(...args);
export const exec = (sql) => getDb().exec(sql);

export function log(level, scope, message) {
  const line = String(message).slice(0, 4000);
  try {
    run(
      'INSERT INTO logs (level, scope, message, created_at) VALUES (?, ?, ?, ?)',
      level,
      scope,
      line,
      Date.now()
    );
  } catch {
    /* logging must never throw */
  }
  const tag = level.toUpperCase().padEnd(5);
  console.log(`[${new Date().toISOString()}] ${tag} ${scope ? scope + ' · ' : ''}${line}`);
}

export function pruneLogs(keep = 2000) {
  run('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)', keep);
}
