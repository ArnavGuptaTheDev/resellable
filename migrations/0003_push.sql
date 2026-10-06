-- Web Push subscriptions, one per browser/device. Removed when the push
-- service reports them gone (404/410) or the user turns notifications off.
CREATE TABLE push_subscriptions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,      -- base64url, browser's P-256 public key
  auth         TEXT NOT NULL,      -- base64url, 16-byte auth secret
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  last_sent_at INTEGER,
  failures     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
