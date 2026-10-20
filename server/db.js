import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    ranges TEXT NOT NULL DEFAULT '[]',
    streak INTEGER NOT NULL DEFAULT 0,
    last_day TEXT,
    best_wpm REAL NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,
    start_pos INTEGER NOT NULL,
    end_pos INTEGER NOT NULL,
    wpm REAL NOT NULL,
    raw_wpm REAL NOT NULL,
    accuracy REAL NOT NULL,
    chars INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    xp INTEGER NOT NULL,
    committed INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS tests_user ON tests(user_id, created_at)',
  `CREATE TABLE IF NOT EXISTS badges (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge_id TEXT NOT NULL,
    earned_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, badge_id)
  )`,
];

// Thin async wrapper over a libSQL client (Turso in production, a local file or :memory: otherwise).
export function openDb({ url, authToken, upgrade }) {
  if (!url) throw new Error('Database URL missing: set TURSO_DATABASE_URL');
  if (url.startsWith('file:')) mkdirSync(dirname(url.slice(5)), { recursive: true });
  const client = createClient({ url, authToken });
  let ready;

  const db = {
    client,
    init: () => (ready ??= client.batch(SCHEMA, 'write')
      .then(() => upgrade?.(client))
      .catch((err) => { ready = null; throw err; })),
    async get(sql, ...args) {
      await db.init();
      return (await client.execute({ sql, args })).rows[0] ?? null;
    },
    async all(sql, ...args) {
      await db.init();
      return (await client.execute({ sql, args })).rows;
    },
    async run(sql, ...args) {
      await db.init();
      return client.execute({ sql, args });
    },
    // Runs statements atomically: [[sql, ...args], ...]
    async batch(statements) {
      await db.init();
      return client.batch(statements.map(([sql, ...args]) => ({ sql, args })), 'write');
    },
    close: () => client.close(),
  };
  return db;
}
