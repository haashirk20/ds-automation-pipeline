CREATE TABLE hooks (
  id INTEGER PRIMARY KEY,
  product_handle TEXT NOT NULL,
  framework TEXT NOT NULL,
  headline TEXT NOT NULL,
  say TEXT NOT NULL,
  fact_ids_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (product_handle, headline)
);
CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  slot_id TEXT
);
CREATE INDEX llm_calls_ts ON llm_calls (ts);
ALTER TABLE slots ADD COLUMN product_handle TEXT;
ALTER TABLE slots ADD COLUMN hook_id INTEGER REFERENCES hooks(id);
