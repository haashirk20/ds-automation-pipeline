CREATE TABLE spend (
  id INTEGER PRIMARY KEY,
  slot_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','submitted','succeeded','failed','rejected')),
  quoted_usd REAL NOT NULL,
  job_id TEXT,
  file_path TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX spend_created ON spend (created_at);
