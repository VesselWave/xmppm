import { describe, expect, it } from "bun:test";
import {
  markInviteFailedSql,
  markInviteReadySql,
  expireSupersededFailedInvitesSql,
  retryFailedInviteSql,
  expireStalePasswordChangesSql,
  PASSWORD_CHANGE_MAX_AGE_SECONDS,
  nextStatusAfterDecision,
  requestIsExpired,
  withD1Retry,
} from "../../apps/worker/db";

describe("db state helpers", () => {
  it("maps approval to approved_pending_invite", () => {
    expect(nextStatusAfterDecision("approve")).toBe("approved_pending_invite");
  });

  it("maps denial to denied", () => {
    expect(nextStatusAfterDecision("deny")).toBe("denied");
  });

  it("detects expired request", () => {
    expect(requestIsExpired({ expires_at: 100 }, 101)).toBe(true);
    expect(requestIsExpired({ expires_at: 100 }, 99)).toBe(false);
  });

  it("only marks invites ready from approved jobs", () => {
    expect(markInviteReadySql).toContain("WHERE id = ? AND status = 'approved_pending_invite'");
  });

  it("expires older failed duplicate username requests when a later request becomes ready", () => {
    expect(expireSupersededFailedInvitesSql).toContain("SET status = 'expired'");
    expect(expireSupersededFailedInvitesSql).toContain("superseded by ready request");
    expect(expireSupersededFailedInvitesSql).toContain("desired_username = ?");
    expect(expireSupersededFailedInvitesSql).toContain("id <> ?");
    expect(expireSupersededFailedInvitesSql).toContain("status = 'invite_failed'");
  });

  it("only marks approved jobs failed", () => {
    expect(markInviteFailedSql).toContain("WHERE id = ? AND status = 'approved_pending_invite'");
  });

  it("only retries failed invite jobs", () => {
    expect(retryFailedInviteSql).toContain("SET status = 'approved_pending_invite'");
    expect(retryFailedInviteSql).toContain("failure_summary = NULL");
    expect(retryFailedInviteSql).toContain("WHERE id = ? AND status = 'invite_failed'");
  });

  it("expires stale password-change jobs and removes stored password ciphertext", () => {
    expect(PASSWORD_CHANGE_MAX_AGE_SECONDS).toBeLessThan(24 * 60 * 60);
    expect(expireStalePasswordChangesSql).toContain("status = 'invite_failed'");
    expect(expireStalePasswordChangesSql).toContain("invite_url = NULL");
    expect(expireStalePasswordChangesSql).toContain("failure_summary = 'password setup expired'");
    expect(expireStalePasswordChangesSql).toContain("status = 'approved_pending_invite'");
    expect(expireStalePasswordChangesSql).toContain("invite_url LIKE 'account://password-change?%'");
    expect(expireStalePasswordChangesSql).toContain("decided_at < ?");
  });

  it("retries transient D1 storage resets", async () => {
    let attempts = 0;
    const result = await withD1Retry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });
});
