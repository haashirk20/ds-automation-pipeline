CREATE TABLE config_versions (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, overrides_json TEXT NOT NULL, note TEXT);
CREATE TABLE text_versions (id INTEGER PRIMARY KEY, key TEXT NOT NULL, body TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, note TEXT);
CREATE INDEX text_versions_key ON text_versions (key, id);
CREATE TABLE admin_sessions (token_sha TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at TEXT NOT NULL, seen_at TEXT NOT NULL);
CREATE TABLE audit (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT NOT NULL);
