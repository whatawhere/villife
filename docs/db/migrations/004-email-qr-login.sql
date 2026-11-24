CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS qr_sessions (
  id TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  token TEXT,
  created_at INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
