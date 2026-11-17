'use strict';
const fs = require('fs');
const Database = require('better-sqlite3');
const { config } = require('./config');

for (const d of [config.dataDir, config.uploadDir, config.resultDir]) fs.mkdirSync(d, { recursive: true, mode: 0o750 });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT,
  email         TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  input_type    TEXT NOT NULL,          -- docx | pdf | image | txt
  status        TEXT NOT NULL,          -- queued | processing | done | error
  progress      TEXT,
  error         TEXT,
  stats         TEXT,                   -- JSON: {byType:{...}, total, ocr, llm}
  model         TEXT,
  result_name   TEXT,
  result_path   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created_at);

-- Таблица соответствий токен -> исходное значение (значение зашифровано AES-256-GCM)
CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  group_id   TEXT NOT NULL,             -- общий ID для разных падежных форм одной сущности
  type       TEXT NOT NULL,
  value_enc  TEXT NOT NULL,
  source     TEXT NOT NULL,             -- regex | llm
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS entities_job ON entities(job_id);
CREATE INDEX IF NOT EXISTS entities_group ON entities(group_id);

-- Словарь известных сущностей: то, что LLM уже находила в прошлых документах.
-- Перед отправкой в LLM документ сначала проверяется по этому словарю.
CREATE TABLE IF NOT EXISTS known_entities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  value_hmac    TEXT NOT NULL UNIQUE,       -- HMAC(type|value) для поиска дублей без расшифровки
  type          TEXT NOT NULL,
  value_enc     TEXT NOT NULL,
  canonical_enc TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,  -- админ может отключить ложное срабатывание
  hits          INTEGER NOT NULL DEFAULT 1,  -- в скольких документах встретилось
  first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL DEFAULT (datetime('now')),
  user_id  INTEGER,
  username TEXT,
  action   TEXT NOT NULL,
  job_id   TEXT,
  ip       TEXT,
  details  TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

const stmts = {
  audit: db.prepare('INSERT INTO audit (user_id, username, action, job_id, ip, details) VALUES (?, ?, ?, ?, ?, ?)'),
};

function audit(req, action, jobId = null, details = null) {
  const u = req && req.session && req.session.user;
  stmts.audit.run(
    u ? u.id : null,
    u ? u.username : (details && details.username) || null,
    action,
    jobId,
    req ? req.ip : null,
    details ? JSON.stringify(details) : null,
  );
}

module.exports = { db, audit };
