CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL,
  idx INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','producing','ready','failed','done')),
  tier TEXT,
  master_json TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (local_date, idx)
);
CREATE TABLE renders (
  slot_id TEXT NOT NULL REFERENCES slots(id),
  platform TEXT NOT NULL,
  file_path TEXT NOT NULL,
  sha256 TEXT,
  qa_pass INTEGER NOT NULL DEFAULT 0,
  qa_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (slot_id, platform)
);
CREATE TABLE publications (
  slot_id TEXT NOT NULL REFERENCES slots(id),
  platform TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','uploading','published','skipped','needs_attention')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  claimed_at TEXT,
  handle_json TEXT,
  post_id TEXT,
  post_url TEXT,
  published_at TEXT,
  error TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slot_id, platform)
);
CREATE INDEX publications_due ON publications (state, scheduled_at);
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  message TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX events_kind_key ON events (kind, key, ts);
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
