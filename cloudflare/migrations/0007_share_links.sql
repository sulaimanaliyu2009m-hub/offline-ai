CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS share_links_owner_conversation
  ON share_links(owner_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS share_links_token_expiry
  ON share_links(token_hash, expires_at, revoked_at);
