CREATE TABLE products (
  handle TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  updated_at TEXT,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE TABLE briefs (
  handle TEXT PRIMARY KEY REFERENCES products(handle),
  source_hash TEXT NOT NULL,
  json TEXT NOT NULL,
  built_at TEXT NOT NULL
);
