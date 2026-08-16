import type { InviteRequest, InviteStatus } from "./types";
import { hashSecret } from "./security";

export type Decision = "approve" | "deny";

export const markInviteReadySql =
  "UPDATE invite_requests SET status = 'invite_ready', invite_url = ?, invite_ready_at = ?, failure_summary = NULL WHERE id = ? AND status = 'approved_pending_invite'";

export const markInviteFailedSql =
  "UPDATE invite_requests SET status = 'invite_failed', failure_summary = ? WHERE id = ? AND status = 'approved_pending_invite'";

export const expireSupersededFailedInvitesSql =
  "UPDATE invite_requests SET status = 'expired', failure_summary = 'superseded by ready request ' || ?, invite_url = NULL WHERE desired_username = ? AND id <> ? AND status = 'invite_failed'";

export const retryFailedInviteSql =
  "UPDATE invite_requests SET status = 'approved_pending_invite', failure_summary = NULL, decided_at = ? WHERE id = ? AND status = 'invite_failed'";

export const PASSWORD_CHANGE_MAX_AGE_SECONDS = 6 * 60 * 60;

export const expireStalePasswordChangesSql =
  "UPDATE invite_requests SET status = 'invite_failed', invite_url = NULL, failure_summary = 'password setup expired', decided_at = ? WHERE status = 'approved_pending_invite' AND invite_url LIKE 'account://password-change?%' AND decided_at < ?";

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function nextStatusAfterDecision(decision: Decision): InviteStatus {
  return decision === "approve" ? "approved_pending_invite" : "denied";
}

export function requestIsExpired(
  row: Pick<InviteRequest, "expires_at">,
  now: number
): boolean {
  return row.expires_at <= now;
}

function isTransientD1Error(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("D1_ERROR") && (
    message.includes("exceeded timeout") ||
    message.includes("object to be reset") ||
    message.includes("network connection lost")
  );
}

export async function withD1Retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientD1Error(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 75));
    }
  }
  throw lastError;
}

export async function insertInviteRequest(db: D1Database, row: InviteRequest): Promise<void> {
  await withD1Retry(() => db
    .prepare(
      `INSERT INTO invite_requests (
        id, secret_hash, claim_code_hash, desired_username, message, contact,
        status, invite_url, telegram_message_id, failure_summary,
        created_at, decided_at, invite_ready_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.secret_hash,
      row.claim_code_hash,
      row.desired_username,
      row.message,
      row.contact,
      row.status,
      row.invite_url,
      row.telegram_message_id,
      row.failure_summary,
      row.created_at,
      row.decided_at,
      row.invite_ready_at,
      row.expires_at
    )
    .run());
}

export async function setTelegramMessageId(
  db: D1Database,
  requestId: string,
  telegramMessageId: string
): Promise<void> {
  await withD1Retry(() => db
    .prepare("UPDATE invite_requests SET telegram_message_id = ? WHERE id = ?")
    .bind(telegramMessageId, requestId)
    .run());
}

export async function findRequestById(
  db: D1Database,
  id: string
): Promise<InviteRequest | null> {
  return await withD1Retry(() => db.prepare("SELECT * FROM invite_requests WHERE id = ?").bind(id).first<InviteRequest>());
}

export async function findRequestBySecretHash(
  db: D1Database,
  secretHash: string
): Promise<InviteRequest | null> {
  return await withD1Retry(() => db
    .prepare("SELECT * FROM invite_requests WHERE secret_hash = ?")
    .bind(secretHash)
    .first<InviteRequest>());
}

export async function decideRequest(
  db: D1Database,
  requestId: string,
  decision: Decision,
  telegramUserId: string,
  at: number,
  approvedRetentionDays: number
): Promise<boolean> {
  const status = nextStatusAfterDecision(decision);
  const approvedExpiresAt = at + approvedRetentionDays * 86400;
  const result = await withD1Retry(() => db
    .prepare("UPDATE invite_requests SET status = ?, decided_at = ?, expires_at = CASE WHEN ? = 'approve' THEN ? ELSE expires_at END WHERE id = ? AND status = 'pending'")
    .bind(status, at, decision, approvedExpiresAt, requestId)
    .run()) as D1Result<unknown>;
  if ((result.meta?.changes ?? 0) !== 1) return false;
  await withD1Retry(() => db
    .prepare(
      "INSERT INTO invite_audit (id, request_id, action, telegram_user_id, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(crypto.randomUUID(), requestId, decision, telegramUserId, at)
    .run());
  return true;
}

export async function listApprovedJobs(db: D1Database, limit: number): Promise<InviteRequest[]> {
  const result = await withD1Retry(() => db
    .prepare(
      "SELECT * FROM invite_requests WHERE status = 'approved_pending_invite' ORDER BY decided_at ASC LIMIT ?"
    )
    .bind(limit)
    .all<InviteRequest>());
  return result.results ?? [];
}

export async function queuePasswordChange(
  db: D1Database,
  requestId: string,
  setupUrl: string,
  at: number
): Promise<void> {
  await withD1Retry(() => db
    .prepare(
      "UPDATE invite_requests SET status = 'approved_pending_invite', invite_url = ?, decided_at = ?, failure_summary = NULL WHERE id = ? AND status = 'invite_ready'"
    )
    .bind(setupUrl, at, requestId)
    .run());
}

export async function markInviteReady(
  db: D1Database,
  requestId: string,
  inviteUrl: string,
  at: number
): Promise<void> {
  const result = await withD1Retry(() => db
    .prepare(markInviteReadySql)
    .bind(inviteUrl, at, requestId)
    .run()) as D1Result<unknown>;
  if ((result.meta?.changes ?? 0) !== 1) return;

  const row = await findRequestById(db, requestId);
  if (!row) return;
  await withD1Retry(() => db
    .prepare(expireSupersededFailedInvitesSql)
    .bind(requestId, row.desired_username, requestId)
    .run());
}

export async function markInviteFailed(
  db: D1Database,
  requestId: string,
  summary: string
): Promise<void> {
  await withD1Retry(() => db
    .prepare(markInviteFailedSql)
    .bind(summary, requestId)
    .run());
}

export async function retryFailedInvite(
  db: D1Database,
  requestId: string,
  at: number
): Promise<boolean> {
  const result = await withD1Retry(() => db
    .prepare(retryFailedInviteSql)
    .bind(at, requestId)
    .run());
  return (result.meta?.changes ?? 0) === 1;
}

export async function expireStalePasswordChanges(db: D1Database, at: number): Promise<D1Result<unknown>> {
  return await withD1Retry(() => db
    .prepare(expireStalePasswordChangesSql)
    .bind(at, at - PASSWORD_CHANGE_MAX_AGE_SECONDS)
    .run());
}

export async function cleanupExpired(db: D1Database, at: number): Promise<D1Result<unknown>> {
  await expireStalePasswordChanges(db, at);
  const result = await withD1Retry(() => db.prepare("DELETE FROM invite_requests WHERE expires_at < ?").bind(at).run());
  await withD1Retry(() => db.prepare("DELETE FROM rate_limits WHERE updated_at < ?").bind(at - 86400).run());
  return result;
}

export async function rateLimitKey(ip: string, _userAgent: string): Promise<string> {
  return `submit:${await hashSecret(ip)}`;
}

export async function consumeRateLimit(
  db: D1Database,
  key: string,
  now: number,
  windowSeconds: number,
  maxCount: number
): Promise<boolean> {
  const row = await withD1Retry(() => db
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE
           WHEN rate_limits.window_start + ? <= ? THEN 1
           ELSE rate_limits.count + 1
         END,
         window_start = CASE
           WHEN rate_limits.window_start + ? <= ? THEN ?
           ELSE rate_limits.window_start
         END,
         updated_at = ?
       RETURNING count`
    )
    .bind(key, now, now, windowSeconds, now, windowSeconds, now, now, now)
    .first<{ count: number }>());

  return (row?.count ?? maxCount + 1) <= maxCount;
}

export async function getAgentPublicKey(db: D1Database): Promise<string | null> {
  const row = await withD1Retry(() => db
    .prepare("SELECT value FROM agent_config WHERE key = 'public_key'")
    .first<{ value: string }>());
  return row ? row.value : null;
}

export async function setAgentPublicKey(db: D1Database, publicKey: string): Promise<void> {
  await withD1Retry(() => db
    .prepare("INSERT OR REPLACE INTO agent_config (key, value) VALUES ('public_key', ?)")
    .bind(publicKey)
    .run());
}
