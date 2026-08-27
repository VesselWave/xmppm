ALTER TABLE invite_requests ADD COLUMN merged_into_request_id TEXT REFERENCES invite_requests(id);

CREATE INDEX IF NOT EXISTS idx_invite_requests_active_username
  ON invite_requests(desired_username, status, created_at)
  WHERE merged_into_request_id IS NULL;
