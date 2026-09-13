-- D1 schema for Google sign-in. Apply with:
--   wrangler d1 execute pdf-scroll-db --remote --file=src/db/schema.sql   (production)
--   wrangler d1 execute pdf-scroll-db --local --file=src/db/schema.sql    (local wrangler pages dev)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',       -- column only; no plan-gating logic built yet, forward-compat placeholder
  created_at REAL NOT NULL,                -- Date.now() ms epoch; sole input to the 90-day upgrade-banner gate
  upgrade_banner_dismissed_at REAL         -- NULL until dismissed; lives on the user row so it survives logout/login
);

-- Session tokens are stored as a SHA-256 hash only — the raw cookie value never
-- touches the database, so a DB leak alone can't be replayed as a live session.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL                 -- created_at + 90 days
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
