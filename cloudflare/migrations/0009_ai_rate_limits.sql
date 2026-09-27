CREATE TABLE IF NOT EXISTS ai_rate_limits (
  ip_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, operation)
);
