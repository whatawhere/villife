CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bio TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  label_id TEXT REFERENCES labels(id),
  title TEXT NOT NULL,
  artwork_url TEXT,
  release_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  album_id TEXT REFERENCES albums(id),
  artist_id TEXT NOT NULL REFERENCES artists(id),
  title TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  audio_key TEXT,
  artwork_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  album_id TEXT REFERENCES albums(id),
  track_id TEXT REFERENCES tracks(id),
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  territory TEXT,
  valid_from TEXT,
  valid_until TEXT,
  license_type TEXT,
  evidence_url TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credits (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  person TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lyrics (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  language TEXT NOT NULL DEFAULT 'en',
  source TEXT,
  permission_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rights (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id),
  holder TEXT NOT NULL,
  right_type TEXT NOT NULL,
  territory TEXT,
  valid_from TEXT,
  valid_until TEXT,
  evidence_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id TEXT NOT NULL REFERENCES playlists(id),
  track_id TEXT NOT NULL REFERENCES tracks(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);

CREATE TABLE IF NOT EXISTS listening_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  track_id TEXT NOT NULL REFERENCES tracks(id),
  played_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
CREATE INDEX IF NOT EXISTS idx_albums_title ON albums(title);
CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);
CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
CREATE INDEX IF NOT EXISTS idx_lyrics_status ON lyrics(status);
CREATE INDEX IF NOT EXISTS idx_history_user ON listening_history(user_id, played_at);
