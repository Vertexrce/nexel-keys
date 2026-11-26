const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'nexel.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  username   TEXT,
  avatar     TEXT,
  hwid       TEXT,
  tier       TEXT,
  expires_at INTEGER,
  license_key TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
  key         TEXT PRIMARY KEY,
  tier        TEXT NOT NULL,
  duration_ms INTEGER,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  redeemed_by TEXT,
  redeemed_at INTEGER,
  expires_at  INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  paused      INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_keys_redeemed ON keys(redeemed_by);
`);

// Upgrade older Nexel databases without losing existing keys.
const keyColumns = db.prepare('PRAGMA table_info(keys)').all();
if (!keyColumns.some(column => column.name === 'paused')) {
  db.exec('ALTER TABLE keys ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
}
if (!keyColumns.some(column => column.name === 'deleted')) {
  db.exec('ALTER TABLE keys ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
}

module.exports = db;