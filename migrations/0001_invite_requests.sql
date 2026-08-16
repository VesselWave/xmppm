CREATE TABLE IF NOT EXISTS invite_requests (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  claim_code_hash TEXT NOT NULL,
  desired_username TEXT NOT NULL,
  message TEXT NOT NULL,
  contact TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending',
    'approved_pending_invite',
    'invite_ready',
    'invite_failed',
    'denied',
    'expired'
  )),
  invite_url TEXT,
  telegram_message_id TEXT,
  failure_summary TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  invite_ready_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_requests_status
  ON invite_requests(status, created_at);

CREATE INDEX IF NOT EXISTS idx_invite_requests_expires_at
  ON invite_requests(expires_at);

CREATE TABLE IF NOT EXISTS invite_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  telegram_user_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(request_id) REFERENCES invite_requests(id)
);

CREATE INDEX IF NOT EXISTS idx_invite_audit_request_id
  ON invite_audit(request_id);
