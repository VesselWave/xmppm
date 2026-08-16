export type Env = {
  ASSETS: Fetcher;
  DB: D1Database;
  SERVICE_DOMAIN: string;
  TELEGRAM_ADMIN_CHAT_ID: string;
  TELEGRAM_ADMIN_USER_IDS: string;
  STATUS_BASE_URL: string;
  REQUEST_RETENTION_DAYS: string;
  APPROVED_RETENTION_DAYS: string;
  RATE_LIMIT_WINDOW_SECONDS: string;
  RATE_LIMIT_MAX_SUBMISSIONS: string;
  RATE_LIMIT_BYPASS_IPS?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  AGENT_BEARER_TOKEN: string;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
  TRUSTED_FORM_IPS?: string;
};

export type InviteStatus =
  | "pending"
  | "approved_pending_invite"
  | "invite_ready"
  | "invite_failed"
  | "denied"
  | "expired";

export type InviteRequest = {
  id: string;
  secret_hash: string;
  claim_code_hash: string;
  desired_username: string;
  message: string;
  contact: string | null;
  status: InviteStatus;
  invite_url: string | null;
  telegram_message_id: string | null;
  failure_summary: string | null;
  created_at: number;
  decided_at: number | null;
  invite_ready_at: number | null;
  expires_at: number;
};
