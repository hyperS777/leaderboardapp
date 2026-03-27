-- Cloudflare D1 schema for leaderboard state
-- Create one row (id = 1) and store the full JSON state in the "data" column.

CREATE TABLE IF NOT EXISTS leaderboard_state (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

