ALTER TABLE slots ADD COLUMN kind TEXT NOT NULL DEFAULT 'planned' CHECK (kind IN ('planned','manual'));
ALTER TABLE slots ADD COLUMN video_model TEXT;            -- NULL = the effective tiers.t2; else a t2Presets key or 'custom:<id>'
ALTER TABLE slots ADD COLUMN hold TEXT CHECK (hold IN ('waiting','approved','discarded','expired'));
ALTER TABLE slots ADD COLUMN held_at TEXT;
ALTER TABLE spend ADD COLUMN credits REAL;                 -- the exact live quote the paid call was sent with
CREATE INDEX slots_hold ON slots (hold) WHERE hold IS NOT NULL;
CREATE TABLE music_tracks (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),     -- of the uploaded bytes
  name TEXT NOT NULL,                                       -- display only, sanitized
  file TEXT NOT NULL,                                       -- relative to DATA_DIR: music/<sha256>.m4a
  seconds REAL NOT NULL,
  lufs REAL NOT NULL,                                       -- integrated loudness of the transcoded file
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1)),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE video_models (                                 -- immutable once added; change = add a new one
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  params_json TEXT NOT NULL,
  max_credits REAL NOT NULL,
  keep_credits REAL NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,                                         -- set by the first Post of a test post made with it
  removed_at TEXT
);
