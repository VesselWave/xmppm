import {
  cleanupExpired,
  consumeRateLimit,
  decideRequest,
  expireStalePasswordChanges,
  findRequestById,
  findRequestBySecretHash,
  getAgentPublicKey,
  insertInviteRequest,
  listApprovedJobs,
  markInviteFailed,
  markInviteReady,
  nowSeconds,
  queuePasswordChange,
  rateLimitKey,
  retryFailedInvite,
  setAgentPublicKey,
  setTelegramMessageId,
} from "./db";
import {
  answerCallback,
  parseCallbackData,
  sendInviteFailedMessage,
  sendInviteRequestMessage,
  sendPasswordCompleteMessage,
  sendPasswordQueuedMessage,
} from "./telegram";
import type { Env, InviteRequest } from "./types";
import {
  adminUserAllowed,
  createId,
  hashSecret,
  htmlEscape,
  normalizeUsername,
  safeSummary,
  verifyTurnstile,
} from "./security";

function html(body: string, status = 200, head = ""): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>xmp.pm invites</title>${head}<body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    }
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; style-src 'self'; frame-src https://challenges.cloudflare.com; connect-src 'self' https://xmpp.xmp.pm wss://xmpp.xmp.pm; img-src 'self' data:",
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function asset(env: Env, path: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  return await env.ASSETS.fetch(new Request(url.toString(), request));
}

async function discoveryAsset(env: Env, request: Request): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  if (new URL(request.url).pathname.endsWith(".json")) {
    headers.set("content-type", "application/jrd+json; charset=utf-8");
  } else {
    headers.set("content-type", "application/xrd+xml; charset=utf-8");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function statusTicket(title: string, body: string, stub = ["queue", "xmp.pm", "federated"], status = 200): Response {
  return html(`
    <main class="ticket">
      <section class="main">
        <h1>${htmlEscape(title)}</h1>
        ${body}
        <div class="actions">
          <a class="secondary" href="/">Go back home</a>
        </div>
      </section>
      <aside class="stub" aria-hidden="true">
        ${stub.map((item) => `<span>${htmlEscape(item)}</span>`).join("")}
      </aside>
    </main>
  `, status, `<link rel="stylesheet" href="/css/invite.css?v=2">`);
}

function statusRefreshPanel(refreshUrl: string, refreshKey: string): string {
  const checkedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  return `
    <section class="status-refresh" data-refresh-minutes="30" data-refresh-key="${htmlEscape(refreshKey)}" data-refresh-url="${htmlEscape(refreshUrl)}">
      <p class="note">Last checked: <time>${htmlEscape(checkedAt)}</time></p>
      <button type="button" data-refresh-now>Check again now</button>
      <p class="note">If this is stuck for more than 12h, contact <a href="mailto:vesselwave@protonmail.com">vesselwave@protonmail.com</a> or <a href="xmpp:admin@xmp.pm">admin@xmp.pm on XMPP</a>.</p>
    </section>
    <script src="/js/status-refresh.js?v=2" defer></script>
  `;
}

function ipSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0)
  );
}

function cfConnectingIp(request: Request): string | undefined {
  return request.headers.get("cf-connecting-ip")?.trim();
}

function isListedCfIp(request: Request, ips: string | undefined): boolean {
  const cfIp = cfConnectingIp(request);
  return cfIp !== undefined && ipSet(ips).has(cfIp);
}

function isTrustedFormIp(request: Request, env: Env): boolean {
  return isListedCfIp(request, env.TRUSTED_FORM_IPS);
}

function isRateLimitBypassIp(request: Request, env: Env): boolean {
  return isListedCfIp(request, env.RATE_LIMIT_BYPASS_IPS);
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isLocalPreviewHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1";
}

function inviteTokenFromUrl(inviteUrl: string): string | null {
  try {
    const url = new URL(inviteUrl);
    const match = url.pathname.match(/^\/invites\/([^/]+)$/);
    return match ? decodeURIComponent(match[1] ?? "") : null;
  } catch {
    return null;
  }
}

function accountPayload(value: string): { action: string; username: string; password?: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "account:") return null;
    const username = url.searchParams.get("username") ?? "";
    const password = url.searchParams.get("password") ?? undefined;
    if (!username) return null;
    return password === undefined
      ? { action: url.hostname, username }
      : { action: url.hostname, username, password };
  } catch {
    return null;
  }
}

function passwordFormPage(username: string, secret: string): Response {
  return statusTicket(
    "Set your password",
    `<p>Your account <strong>${htmlEscape(username)}@xmp.pm</strong> has been created. Choose a password to finish setup.</p>` +
    `<p class="note">Use 12+ characters.</p>` +
    `<form id="password-form" method="post" action="/status/${encodeURIComponent(secret)}/password">` +
      `<label class="password-label">` +
        `New password` +
        `<input id="password-input" class="password-input" name="password" type="password" required minlength="12" maxlength="200" autocomplete="new-password">` +
      `</label>` +
      `<p id="password-state" class="note" aria-live="polite"></p>` +
      `<button id="submit-btn" type="submit">Set password</button>` +
    `</form>` +
    `<script src="/js/password-form.js?v=1" defer></script>`,
    ["ready", "xmp.pm", "password"]
  );
}

function accountCompletePage(username: string): Response {
  return statusTicket(
    "Account ready",
    `<p>Your password is set. Sign in from your XMPP client as <strong>${htmlEscape(username)}@xmp.pm</strong>.</p>` +
    `<p class="note">Most clients auto-detect xmp.pm server settings.</p>`,
    ["ready", "xmp.pm", "account"]
  );
}

function requestForm(env: Env): Response {
  return html(`
    <main class="request-card">
      <h1>Request an xmp.pm invite</h1>
      <p class="intro">Tell us enough to keep the service small, quiet, and abuse-resistant.</p>
      <form id="request-form" method="post" action="/request">
        <label>
          <span>Username <span class="required">*</span></span>
          <div class="input-group">
            <input name="username" required minlength="3" maxlength="32" autocomplete="username">
            <span class="suffix">@xmp.pm</span>
          </div>
        </label>
        <label><span>How to reach you (optional)</span> <input name="contact" maxlength="200" autocomplete="email"></label>
        <label><span>Why do you want an account? <span class="required">*</span></span><textarea name="message" required minlength="10" maxlength="2000" aria-describedby="message-help"></textarea></label>
        <p id="message-help" class="help">10+ characters. Say how you heard about xmp.pm, what client you plan to use, or why this small server fits you.</p>
        <label class="check"><input type="checkbox" name="aup" value="yes" required> I agree to follow the xmp.pm acceptable-use rules.</label>
        <div class="cf-turnstile" data-sitekey="${htmlEscape(env.TURNSTILE_SITE_KEY)}" data-callback="onTurnstileSuccess" data-expired-callback="onTurnstileUnavailable" data-error-callback="onTurnstileUnavailable"></div>
        <p id="turnstile-state" class="submit-note" aria-live="polite">Complete Turnstile to enable submit.</p>
        <p class="submit-note">If Turnstile fails or stays blocked, contact <a href="mailto:vesselwave@protonmail.com">vesselwave@protonmail.com</a> or <a href="xmpp:admin@xmp.pm">admin@xmp.pm on XMPP</a>.</p>
        <noscript><p class="submit-note">JavaScript is required for Turnstile. If you cannot enable it, contact <a href="mailto:vesselwave@protonmail.com">vesselwave@protonmail.com</a> or <a href="xmpp:admin@xmp.pm">admin@xmp.pm on XMPP</a>.</p></noscript>
        <p class="submit-note">You’ll get a private status link. Usually reviewed within 15m, sometimes up to 12h.</p>
        <div class="actions">
          <button id="request-submit" type="submit" disabled aria-disabled="true">Submit request</button>
          <a class="secondary" href="/">Go back home</a>
        </div>
      </form>
    </main>
  `, 200, `<link rel="stylesheet" href="/css/request.css?v=1"><script src="/js/request-form.js?v=1" defer></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`);
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  try {
    const form = await request.formData();
    const username = normalizeUsername(String(form.get("username") ?? ""));
    const message = safeSummary(String(form.get("message") ?? ""), 2000);
    if (message.length < 10) return html("Message must be at least 10 characters.", 400);
    const contactRaw = safeSummary(String(form.get("contact") ?? ""), 200);
    const contact = contactRaw.length > 0 ? contactRaw : null;
    if (String(form.get("aup") ?? "") !== "yes") return html("AUP agreement is required.", 400);

    const remoteIp = request.headers.get("cf-connecting-ip");
    const trustedFormIp = isTrustedFormIp(request, env);
    if (!trustedFormIp) {
      if (!isRateLimitBypassIp(request, env)) {
        const key = await rateLimitKey(remoteIp ?? "unknown", request.headers.get("user-agent") ?? "");
        const allowed = await consumeRateLimit(
          env.DB,
          key,
          nowSeconds(),
          Number(env.RATE_LIMIT_WINDOW_SECONDS),
          Number(env.RATE_LIMIT_MAX_SUBMISSIONS)
        );
        if (!allowed) return html("Too many requests. Try again later.", 429);
      }

      const turnstileToken = String(form.get("cf-turnstile-response") ?? "");
      const okTurnstile = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileToken, remoteIp);
      if (!okTurnstile) return html("Turnstile validation failed.", 400);
    }

    const secret = createId(32);
    const claimCode = createId(8);
    const id = `req_${createId(12)}`;
    const now = nowSeconds();
    const expiresAt = now + Number(env.REQUEST_RETENTION_DAYS) * 86400;
    const row: InviteRequest = {
      id,
      secret_hash: await hashSecret(secret),
      claim_code_hash: await hashSecret(claimCode),
      desired_username: username,
      message,
      contact,
      status: trustedFormIp ? "approved_pending_invite" : "pending",
      invite_url: null,
      telegram_message_id: null,
      failure_summary: null,
      created_at: now,
      decided_at: trustedFormIp ? now : null,
      invite_ready_at: null,
      expires_at: expiresAt,
    };
    await insertInviteRequest(env.DB, row);

    const statusUrl = `${env.STATUS_BASE_URL}/status/${secret}`;
    if (!trustedFormIp) {
      try {
        const msgId = await sendInviteRequestMessage(env, {
          requestId: id,
          desiredUsername: username,
          message,
          contact,
          statusUrl,
        });
        await setTelegramMessageId(env.DB, id, msgId);
      } catch (error) {
        console.error("telegram_send_failed", error);
      }
    }

    return new Response(null, {
      status: 303,
      headers: { location: statusUrl },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return html(htmlEscape(message), 400);
  }
}

async function ensureTelegramNotification(env: Env, row: InviteRequest, statusUrl: string): Promise<void> {
  if (row.status !== "pending" || row.telegram_message_id !== null) return;
  try {
    const msgId = await sendInviteRequestMessage(env, {
      requestId: row.id,
      desiredUsername: row.desired_username,
      message: row.message,
      contact: row.contact,
      statusUrl,
    });
    await setTelegramMessageId(env.DB, row.id, msgId);
  } catch (error) {
    console.error("telegram_resend_failed", error);
  }
}

async function handleStatus(pathname: string, env: Env): Promise<Response> {
  const secret = safeDecodeURIComponent(pathname.replace("/status/", ""));
  if (secret === null) return html("Invalid status link.", 400);
  if (!secret) return html("Missing status secret.", 400);
  const row = await findRequestBySecretHash(env.DB, await hashSecret(secret));
  if (!row) return html("Request not found.", 404);
  if (row.expires_at <= nowSeconds()) return html("This request expired.", 410);
  await ensureTelegramNotification(env, row, `${env.STATUS_BASE_URL}/status/${encodeURIComponent(secret)}`);
  if (row.status === "invite_ready" && row.invite_url) {
    const account = accountPayload(row.invite_url);
    if (account?.action === "password-form") return passwordFormPage(account.username, secret);
    if (account?.action === "complete") return accountCompletePage(account.username);
    return new Response(null, {
      status: 303,
      headers: { location: row.invite_url },
    });
  }
  if (row.status === "denied") return statusTicket("Request denied", `<p>Your invite request was not approved.</p>`, ["closed", "xmp.pm", "federated"]);
  if (row.status === "invite_failed") {
    const isConflict =
      row.failure_summary?.toLowerCase().includes("conflict") ||
      row.failure_summary?.toLowerCase().includes("already exists") ||
      row.failure_summary?.toLowerCase().includes("exists");
    if (isConflict) {
      return statusTicket(
        "Username taken",
        `<p>Your request was approved, but the username <strong>${htmlEscape(row.desired_username)}</strong> is already taken. Please submit a new request with a different username.</p>`,
        ["username", "taken", "conflict"]
      );
    }
    return statusTicket("Invite delayed", `<p>Approved, but invite generation needs operator attention.</p>`, ["approved", "operator", "needed"]);
  }
  if (row.invite_url) {
    const account = accountPayload(row.invite_url);
    if (account?.action === "password-change") {
      return statusTicket(
        "Password queued",
        `<p>Finalizing account setup. Check again manually any time; this page also checks.</p>` +
          statusRefreshPanel(`/status/${encodeURIComponent(secret)}`, `xmppm_password_queued_${encodeURIComponent(secret)}`),
        ["queued", "xmp.pm", "password"]
      );
    }
  }
  return statusTicket(
    "Request pending",
    `<p>Your request is pending. Keep this link. Check again manually any time; this page also checks for up to 30 minutes with backoff, then stops.</p>` +
    `<ol class="status-steps" aria-label="request progress"><li data-state="done">Request received</li><li data-state="waiting">Human review</li><li>Account setup</li></ol>` +
    `<p class="note">Usually approved in less than 15m, up to 12h. You do not need to resubmit.</p>` +
    statusRefreshPanel(`/status/${encodeURIComponent(secret)}`, `xmppm_pending_${encodeURIComponent(secret)}`)
  );
}

async function handlePasswordSubmit(pathname: string, request: Request, env: Env): Promise<Response> {
  const secret = safeDecodeURIComponent(pathname.replace(/^\/status\//, "").replace(/\/password$/, ""));
  if (secret === null) return html("Invalid status link.", 400);
  const row = await findRequestBySecretHash(env.DB, await hashSecret(secret));
  if (!row || row.status !== "invite_ready" || !row.invite_url) return html("Request not found.", 404);
  const account = accountPayload(row.invite_url);
  if (account?.action !== "password-form") return html("Password is not pending.", 400);
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  if (password.length < 12 || password.length > 500) return html("Password must be 12-500 characters.", 400);
  const setupUrl = `account://password-change?username=${encodeURIComponent(account.username)}&password=${encodeURIComponent(password)}`;
  const now = nowSeconds();
  await expireStalePasswordChanges(env.DB, now);
  await queuePasswordChange(env.DB, row.id, setupUrl, now);
  try {
    await sendPasswordQueuedMessage(env, {
      requestId: row.id,
      desiredUsername: account.username,
      telegramMessageId: row.telegram_message_id,
    });
  } catch (error) {
    console.error("Failed to send Telegram notification for password queued:", error);
  }
  const statusPath = `/status/${encodeURIComponent(secret)}`;
  return statusTicket(
    "Password queued",
    `<p>Finalizing account setup. Check again manually any time; this page also checks.</p>` +
      statusRefreshPanel(statusPath, `xmppm_password_submitted_${encodeURIComponent(secret)}`),
    ["queued", "xmp.pm", "password"]
  );
}

async function handleTelegram(request: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname !== `/telegram/webhook/${env.TELEGRAM_WEBHOOK_SECRET}`) return json({ ok: false }, 404);
  const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (headerSecret !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false }, 403);

  const update = (await request.json()) as {
    callback_query?: {
      id: string;
      data?: string;
      from?: { id: number };
      message?: { chat?: { id: number } };
    };
  };
  const callback = update.callback_query;
  if (!callback?.data || !callback.from) return json({ ok: true });
  if (!adminUserAllowed(env.TELEGRAM_ADMIN_USER_IDS, callback.from.id)) {
    await answerCallback(env, callback.id, "Not authorized");
    return json({ ok: true });
  }
  if (callback.message?.chat?.id === undefined || String(callback.message.chat.id) !== env.TELEGRAM_ADMIN_CHAT_ID) {
    return json({ ok: true });
  }
  const parsed = parseCallbackData(callback.data);
  if (!parsed) return json({ ok: true });
  if (parsed.action === "retry") {
    const changed = await retryFailedInvite(env.DB, parsed.requestId, nowSeconds());
    await answerCallback(env, callback.id, changed ? "Retry queued" : "Already queued");
    return json({ ok: true });
  }
  const changed = await decideRequest(
    env.DB,
    parsed.requestId,
    parsed.action,
    String(callback.from.id),
    nowSeconds(),
    Number(env.APPROVED_RETENTION_DAYS)
  );
  await answerCallback(env, callback.id, changed ? (parsed.action === "approve" ? "Approved" : "Denied") : "Already decided");
  return json({ ok: true });
}

function requireAgent(request: Request, env: Env): Response | null {
  const expected = `Bearer ${env.AGENT_BEARER_TOKEN}`;
  return request.headers.get("authorization") === expected ? null : json({ error: "unauthorized" }, 401);
}

async function handleAgentJobs(request: Request, env: Env): Promise<Response> {
  const auth = requireAgent(request, env);
  if (auth) return auth;
  let pubKey = request.headers.get("x-agent-public-key");
  if (pubKey) {
    if (pubKey.includes("%")) {
      try {
        pubKey = decodeURIComponent(pubKey);
      } catch {}
    }
    await setAgentPublicKey(env.DB, pubKey);
  }
  const now = nowSeconds();
  await expireStalePasswordChanges(env.DB, now);
  const jobs = await listApprovedJobs(env.DB, 5);
  return json({ jobs: jobs.map((job) => ({ id: job.id, desired_username: job.desired_username, setup_url: job.invite_url })) });
}

async function handleAgentInvite(request: Request, env: Env, pathname: string): Promise<Response> {
  const auth = requireAgent(request, env);
  if (auth) return auth;
  const match = pathname.match(/^\/agent\/jobs\/([^/]+)\/(invite|fail)$/);
  if (!match) return json({ error: "not found" }, 404);
  const requestId = match[1];
  const action = match[2];
  if (!requestId || (action !== "invite" && action !== "fail")) return json({ error: "not found" }, 404);
  const body = (await request.json()) as { invite_url?: string; error?: string };
  if (action === "invite" && body.invite_url) {
    await markInviteReady(env.DB, requestId, body.invite_url, nowSeconds());
    const account = accountPayload(body.invite_url);
    if (account?.action === "complete") {
      try {
        const row = await findRequestById(env.DB, requestId);
        if (row) {
          await sendPasswordCompleteMessage(env, {
            requestId,
            desiredUsername: account.username,
            telegramMessageId: row.telegram_message_id,
          });
        }
      } catch (error) {
        console.error("Failed to send Telegram notification for password complete:", error);
      }
    }
    return json({ ok: true });
  }
  const errorMsg = safeSummary(body.error ?? "unknown error");
  await markInviteFailed(env.DB, requestId, errorMsg);
  try {
    const row = await findRequestById(env.DB, requestId);
    if (row) {
      await sendInviteFailedMessage(env, {
        requestId,
        desiredUsername: row.desired_username,
        error: errorMsg,
        telegramMessageId: row.telegram_message_id,
      });
    }
  } catch (error) {
    console.error("Failed to send Telegram notification for invite failure:", error);
  }
  return json({ ok: true });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === "www.xmp.pm") {
    url.protocol = "https:";
    url.hostname = "xmp.pm";
    return new Response(null, { status: 301, headers: { location: url.toString() } });
  }
  const isLocal = isLocalPreviewHost(url.hostname);
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
    return await asset(env, "/index.html", request);
  }
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/invites/")) {
    return await asset(env, "/invite.html", request);
  }
  if (url.pathname.startsWith("/dev-preview")) {
    if (!isLocal) return html("Not found", 404);

    const previews: Record<string, () => Response> = {
      request: () => requestForm(env),
      pending: () => statusTicket(
        "Request pending",
        `<p>Your request is pending. This page can check again automatically, then redirect when the invite is ready.</p>` +
        `<p class="note">Usually approved in less than 15m, up to 12h. Save this page to get status and set password later.</p>` +
        statusRefreshPanel("/dev-preview/pending", "xmppm_dev_pending")
      ),
      denied: () => statusTicket("Request denied", `<p>Your invite request was not approved.</p>`, ["closed", "xmp.pm", "federated"]),
      taken: () => statusTicket(
        "Username taken",
        `<p>Your request was approved, but the username <strong>testuser</strong> is already taken. Please submit a new request with a different username.</p>`,
        ["username", "taken", "conflict"]
      ),
      delayed: () => statusTicket("Invite delayed", `<p>Approved, but invite generation needs operator attention.</p>`, ["approved", "operator", "needed"]),
      queued: () => statusTicket(
        "Password queued",
        `<p>Finalizing account setup. This page checks again automatically.</p>` + statusRefreshPanel("/dev-preview/queued", "xmppm_dev_queued"),
        ["queued", "xmp.pm", "password"]
      ),
      password: () => passwordFormPage("testuser", "dummy-secret"),
      ready: () => accountCompletePage("testuser"),
    };

    if (url.pathname === "/dev-preview" || url.pathname === "/dev-preview/") {
      const linkItems = Object.keys(previews)
        .map((key) => `<li><a href="/dev-preview/${key}">/dev-preview/${key}</a></li>`)
        .join("");

      return html(`
        <main class="request-card request-card--narrow">
          <h1>Dev UI/UX Preview</h1>
          <p>Direct links to dynamic worker page templates:</p>
          <ul class="preview-list">
            ${linkItems}
          </ul>
        </main>
      `, 200, `<link rel="stylesheet" href="/css/request.css?v=1">`);
    }

    const page = url.pathname.replace(/^\/dev-preview\//, "");
    const previewFn = previews[page];
    if (previewFn) return previewFn();
    return html(`Available pages: ${Object.keys(previews).join(", ")}`, 404);
  }
  if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/.well-known/host-meta" || url.pathname === "/.well-known/host-meta.json")) {
    return await discoveryAsset(env, request);
  }
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/agent-pubkey.pem") {
    const pubKey = await getAgentPublicKey(env.DB);
    if (!pubKey) return new Response("Public key not found", { status: 404 });
    return new Response(pubKey, {
      headers: {
        "content-type": "application/x-pem-file",
        "access-control-allow-origin": "*",
      },
    });
  }
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/request") return requestForm(env);
  if (request.method === "POST" && url.pathname === "/request") return await handleSubmit(request, env);
  if (request.method === "POST" && url.pathname.match(/^\/status\/[^/]+\/password$/)) return await handlePasswordSubmit(url.pathname, request, env);
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/status/")) return await handleStatus(url.pathname, env);
  if (request.method === "POST" && url.pathname.startsWith("/telegram/webhook/")) return await handleTelegram(request, env, url.pathname);
  if (request.method === "GET" && url.pathname === "/agent/jobs") return await handleAgentJobs(request, env);
  if (request.method === "POST" && url.pathname.startsWith("/agent/jobs/")) return await handleAgentInvite(request, env, url.pathname);
  if (request.method === "GET" || request.method === "HEAD") {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;
  }
  return statusTicket("Page not found", "<p>The requested page does not exist or has expired.</p>", ["404", "xmp.pm", "closed"], 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withSecurityHeaders(await handleRequest(request, env));
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await cleanupExpired(env.DB, nowSeconds());
  },
};
