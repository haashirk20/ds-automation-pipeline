CREATE TABLE oauth_tokens (
  provider TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);
