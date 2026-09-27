ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
CREATE INDEX IF NOT EXISTS conversations_owner_archived_updated
ON conversations(owner_id, archived_at, updated_at DESC);
