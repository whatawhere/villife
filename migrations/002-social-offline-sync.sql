ALTER TABLE releases ADD COLUMN offline_allowed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, artist_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  owner_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
