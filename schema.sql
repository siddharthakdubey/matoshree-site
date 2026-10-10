CREATE TABLE IF NOT EXISTS leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  city       TEXT,
  bill       INTEGER,
  lang       TEXT,
  status     TEXT NOT NULL DEFAULT 'new',
  note       TEXT,
  ip_hash    TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_phone   ON leads(phone);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('orders_completed', '92');

-- Installation gallery (photos are stored compressed in D1, so no paid storage is needed)
CREATE TABLE IF NOT EXISTS photos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  data       TEXT NOT NULL            -- base64 JPEG
);
CREATE TABLE IF NOT EXISTS installations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  title      TEXT NOT NULL,
  city       TEXT,
  kw         REAL,
  photo_id   INTEGER,
  visible    INTEGER NOT NULL DEFAULT 1
);
