CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, name)
);

CREATE INDEX IF NOT EXISTS projects_owner_updated ON projects(owner_id, updated_at DESC);

ALTER TABLE conversations ADD COLUMN project_id TEXT;

CREATE INDEX IF NOT EXISTS conversations_owner_project_updated
  ON conversations(owner_id, project_id, updated_at DESC);
