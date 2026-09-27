CREATE TABLE IF NOT EXISTS user_preferences (
  owner_id TEXT PRIMARY KEY,
  memory_enabled INTEGER NOT NULL DEFAULT 0 CHECK(memory_enabled IN (0, 1)),
  memory_content TEXT NOT NULL DEFAULT '',
  custom_instructions TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
