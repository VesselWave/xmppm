import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import worker from "../../apps/worker/index";
import type { Env, InviteRequest } from "../../apps/worker/types";

describe("repository config", () => {
  it("allows and advertises invite registration", () => {
    const config = readFileSync("config/ejabberd.yml", "utf8");
    expect(config).toContain("access_create_account: configure");
    expect(config).toContain("allow_modules:");
    expect(config).toContain("- mod_invites");
    expect(config).toContain('redirect_url: "https://xmp.pm/request"');
  });

  it("enables PubSub server information for XEP-0485", () => {
    const config = readFileSync("config/ejabberd.yml", "utf8");
    expect(config).toContain("mod_pubsub_serverinfo:");
    expect(config).toContain('pubsub_host: "pubsub.@HOST@"');
  });

  it("keeps VPS nginx focused on the xmpp gateway", () => {
    const config = readFileSync("ops/vps/xmppm-nginx.conf", "utf8");
    expect(config).toContain("server_name xmpp.xmp.pm");
    expect(config).toContain("location /ws");
    expect(config).toContain("location /bosh");
    expect(config).not.toContain("worker_origin");
    expect(config).not.toContain("/request");
    expect(config).not.toContain("/status/");
  });

  it("disables the extra workers.dev production route", () => {
    for (const path of ["wrangler.toml.example", "wrangler.toml"]) {
      const config = readFileSync(path, "utf8");
      expect(config).toContain("workers_dev = false");
      expect(config).not.toContain("workers_dev = true");
    }
  });

  it("routes www.xmp.pm through the worker for canonical redirects", () => {
    for (const path of ["wrangler.toml.example", "wrangler.toml"]) {
      const config = readFileSync(path, "utf8");
      expect(config).toContain('{ pattern = "www.xmp.pm/*", zone_name = "xmp.pm" }');
    }
  });
});

describe("worker routes", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const baseEnv = {
    DB: {} as D1Database,
    SERVICE_DOMAIN: "xmp.pm",
    TELEGRAM_ADMIN_CHAT_ID: "1",
    TELEGRAM_ADMIN_USER_IDS: "42",
    STATUS_BASE_URL: "https://xmp.pm",
    REQUEST_RETENTION_DAYS: "7",
    APPROVED_RETENTION_DAYS: "14",
    RATE_LIMIT_WINDOW_SECONDS: "3600",
    RATE_LIMIT_MAX_SUBMISSIONS: "3",
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    AGENT_BEARER_TOKEN: "agent-secret",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    TURNSTILE_SITE_KEY: "site-key",
  } satisfies Omit<Env, "ASSETS">;

  function assetEnv(overrides: Partial<Env> = {}): Env {
    const assets = {
      fetch: async (request: RequestInfo | URL): Promise<Response> => {
        const url = new URL(request instanceof Request ? request.url : String(request));
        const files: Record<string, string> = {
          "/index.html": '<h1>xmp.pm</h1><a href="/request">Request invite</a>',
          "/info.html": "<h1>Service details</h1>",
          "/invite.html": '<h1>xmp.pm invite</h1><code id="token">reading token…</code>',
          "/.well-known/host-meta": '<XRD><Link href="wss://xmpp.xmp.pm/ws" /></XRD>',
          "/.well-known/host-meta.json": JSON.stringify({ links: [{ href: "wss://xmpp.xmp.pm/ws" }] }),
        };
        const body = files[url.pathname];
        if (body === undefined) return new Response("asset not found", { status: 404 });
        return new Response(body, {
          status: 200,
          headers: { "content-type": url.pathname.endsWith(".json") ? "application/json" : "text/html" },
        });
      },
      connect: () => {
        throw new Error("asset mock does not support sockets");
      },
    } as unknown as Fetcher;

    return { ...baseEnv, ASSETS: assets, ...overrides };
  }

  const env = assetEnv();

  it("redirects www.xmp.pm to xmp.pm preserving path and query", async () => {
    const response = await worker.fetch(new Request("https://www.xmp.pm/request?u=alice"), env);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://xmp.pm/request?u=alice");
  });

  it("serves styled request form", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/request"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("https://challenges.cloudflare.com");
    expect(response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(response.headers.get("content-security-policy")).toContain("'wasm-unsafe-eval'");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains; preload");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("geolocation=()");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await response.text();
    expect(text).toContain("Request an xmp.pm invite");
    expect(text).toContain("Username");
    expect(text).toContain("How to reach you (optional)");
    expect(text).toContain('class="required">*</span>');
    expect(text).toContain('class="suffix">@xmp.pm</span>');
    expect(text).toContain('<link rel="stylesheet" href="/css/request.css?v=1">');
    expect(text).toContain('<script src="/js/request-form.js?v=1" defer></script>');
    expect(text).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    expect(text).toContain('data-sitekey="site-key"');
    expect(text).toContain('data-callback="onTurnstileSuccess"');
    expect(text).toContain('data-expired-callback="onTurnstileUnavailable"');
    expect(text).toContain('data-error-callback="onTurnstileUnavailable"');
    expect(text).toContain('<button id="request-submit" type="submit" disabled aria-disabled="true">Submit request</button>');
    expect(text).not.toContain("submitBtn.textContent");
    expect(text).toContain('id="turnstile-state"');
    expect(text).toContain('If Turnstile fails or stays blocked');
    expect(text).toContain('xmpp:admin@xmp.pm');
    expect(text).toContain('mailto:vesselwave@protonmail.com');
    expect(text).toContain('<noscript>');
    expect(text).toContain('JavaScript is required for Turnstile');
    expect(text).not.toContain('window.onTurnstileSuccess =');
    expect(text).not.toContain("document.addEventListener('DOMContentLoaded'");
    expect(text).not.toContain("submitBtn.disabled = false");
    expect(text).not.toContain("form.addEventListener('submit'");
    expect(text).not.toContain("event.preventDefault()");
    expect(text).not.toContain("<style>");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain('style="');
    expect(text).toContain('minlength="10"');
    expect(text).toContain("10+ characters");
    expect(text).toContain("You’ll get a private status link");
    expect(text).not.toContain("overflow-x: hidden");
    expect(text).not.toContain(".cf-turnstile { min-height: 4rem; max-width: 100%; overflow: hidden; }");
  });

  it("serves request form for HEAD checks", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/request", { method: "HEAD" }), env);
    expect(response.status).toBe(200);
  });

  it("adds security headers to static asset responses", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains; preload");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves pending status pages with invite ticket styling", async () => {
    const row = {
      id: "req_1",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "hello",
      contact: null,
      status: "pending",
      invite_url: null,
      telegram_message_id: "123",
      failure_summary: null,
      created_at: 1,
      decided_at: null,
      invite_ready_at: null,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => row,
        }),
      }),
    };
    const response = await worker.fetch(new Request("https://xmp.pm/status/secret"), assetEnv({ DB: fakeDb as never }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('<link rel="stylesheet" href="/css/invite.css?v=2">');
    expect(text).toContain('<main class="ticket">');
    expect(text).toContain('<h1>Request pending</h1>');
    expect(text).toContain('Usually approved in less than 15m, up to 12h');
    expect(text).toContain('Keep this link. Check again manually any time');
    expect(text).toContain('Request received');
    expect(text).toContain('Human review');
    expect(text).toContain('Account setup');
    expect(text).toContain('data-state="waiting"');
    expect(text).toContain('Last checked:');
    expect(text).toContain('Check again now');
    expect(text).toContain('If this is stuck for more than 12h');
    expect(text).toContain('xmpp:admin@xmp.pm');
    expect(text).toContain('mailto:vesselwave@protonmail.com');
    expect(text).toContain('data-refresh-minutes="30"');
    expect(text).toContain('data-refresh-url="/status/secret"');
    expect(text).toContain('<script src="/js/status-refresh.js?v=2" defer></script>');
    expect(text).not.toContain('const durationMs = minutes * 60 * 1000;');
    expect(text).not.toContain('Date.now() - startedAt >= durationMs');
    expect(text).not.toContain('Math.min(60000, 7000 * 2 ** attempt)');
    expect(text).not.toContain('setTimeout(() => location.reload(), 7000)');
    expect(text).toContain('<aside class="stub"');
  });

  it("resends missing Telegram notification when pending status page is viewed", async () => {
    const row = {
      id: "req_1",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "please invite me",
      contact: "alice@example.com",
      status: "pending",
      invite_url: null,
      telegram_message_id: null,
      failure_summary: null,
      created_at: 1,
      decided_at: null,
      invite_ready_at: null,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;
    const bindings: { sql: string; args: unknown[] }[] = [];
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          bindings.push({ sql, args });
          return {
            first: async () => row,
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      }),
    };
    const telegramCalls: unknown[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      telegramCalls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 456 } }));
    }) as unknown as typeof fetch;

    const response = await worker.fetch(new Request("https://xmp.pm/status/secret"), assetEnv({ DB: fakeDb as never }));

    expect(response.status).toBe(200);
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0]).toMatchObject({ chat_id: "1", disable_web_page_preview: true });
    expect(JSON.stringify(telegramCalls[0])).toContain("https://xmp.pm/status/secret");
    const update = bindings.find((binding) => binding.sql.startsWith("UPDATE invite_requests SET telegram_message_id"));
    expect(update?.args).toEqual(["456", "req_1"]);
  });

  it("does not resend Telegram notification when pending row already has a message id", async () => {
    const row = {
      id: "req_1",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "please invite me",
      contact: null,
      status: "pending",
      invite_url: null,
      telegram_message_id: "456",
      failure_summary: null,
      created_at: 1,
      decided_at: null,
      invite_ready_at: null,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => row,
        }),
      }),
    };
    let telegramCalls = 0;
    globalThis.fetch = (async () => {
      telegramCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 456 } }));
    }) as unknown as typeof fetch;

    const response = await worker.fetch(new Request("https://xmp.pm/status/secret"), assetEnv({ DB: fakeDb as never }));

    expect(response.status).toBe(200);
    expect(telegramCalls).toBe(0);
  });

  it("returns a safe client error for malformed status secrets", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/status/%"), env);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("Invalid status link");
  });

  it("returns a safe client error for malformed password status secrets", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/status/%/password", { method: "POST" }), env);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("Invalid status link");
  });

  it("renders username taken page on invite conflict failure", async () => {
    const row = {
      id: "req_1",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "hello",
      contact: null,
      status: "invite_failed",
      invite_url: null,
      telegram_message_id: null,
      failure_summary: "Error: conflict",
      created_at: 1,
      decided_at: null,
      invite_ready_at: null,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => row,
        }),
      }),
    };
    const response = await worker.fetch(new Request("https://xmp.pm/status/secret"), assetEnv({ DB: fakeDb as never }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Username taken");
    expect(text).toContain("alice");
    expect(text).toContain("already taken");
  });

  it("renders password form for newly created accounts", async () => {
    const row = {
      id: "req_1",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "hello",
      contact: null,
      status: "invite_ready",
      invite_url: "account://password-form?username=alice",
      telegram_message_id: null,
      failure_summary: null,
      created_at: 1,
      decided_at: 2,
      invite_ready_at: 3,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => row,
        }),
      }),
    };
    const response = await worker.fetch(new Request("https://xmp.pm/status/secret"), assetEnv({ DB: fakeDb as never }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Set your password");
    expect(text).toContain("alice@xmp.pm");
    expect(text).toContain('action="/status/secret/password"');
    expect(text).toContain('<script src="/js/password-form.js?v=1" defer></script>');
    expect(text).not.toContain("crypto.subtle.importKey");
    expect(text).not.toContain("crypto.subtle.encrypt");
    expect(text).not.toContain("fetch('/agent-pubkey.pem')");
    expect(text).not.toContain('style="');
    expect(text).not.toContain("<script>");
    expect(text).toContain("12+ characters");
    expect(text).not.toContain("Your browser encrypts this password before sending it for account setup");
    expect(text).not.toContain("Queued encrypted passwords expire after 6 hours");
    const passwordJs = readFileSync("apps/website/js/password-form.js", "utf8");
    expect(passwordJs).toContain("Securing locally…");
    expect(text.includes("Encrypt" + "ing")).toBe(false);
    expect(text).not.toContain("pw-123");
  });

  it("queues password changes from status password form", async () => {
    const row = {
      id: "req_1",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "hello",
      contact: null,
      status: "invite_ready",
      invite_url: "account://password-form?username=alice",
      telegram_message_id: "888",
      failure_summary: null,
      created_at: 1,
      decided_at: 2,
      invite_ready_at: 3,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;
    const bindings: { sql: string; args: unknown[] }[] = [];
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          bindings.push({ sql, args });
          return {
            first: async () => row,
            run: async () => ({ success: true }),
          };
        },
      }),
    };
    const fetchedRequests: { url: string; body: any }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchedRequests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ ok: true, result: { message_id: 999 } });
    }) as typeof fetch;

    const form = new FormData();
    form.set("password", "new-password-1234");
    const response = await worker.fetch(
      new Request("https://xmp.pm/status/secret/password", { method: "POST", body: form }),
      assetEnv({ DB: fakeDb as never })
    );
    expect(response.status).toBe(200);
    const update = bindings.find((binding) => String(binding.args[0]).startsWith("account://password-change"));
    expect(update?.args[0]).toContain("username=alice");
    expect(update?.args[0]).toContain("password=new-password-1234");
    const staleExpiry = bindings.find((binding) => binding.sql.includes("password setup expired"));
    expect(staleExpiry?.sql).toContain("invite_url = NULL");

    const text = await response.text();
    expect(text).toContain("Password queued");
    expect(text).toContain("Finalizing account setup");
    expect(text).toContain("Last checked:");
    expect(text).toContain("Check again now");
    expect(text).toContain("If this is stuck for more than 12h");
    expect(text).toContain('data-refresh-minutes="30"');
    expect(text).toContain('data-refresh-url="/status/secret"');
    expect(text).toContain('<script src="/js/status-refresh.js?v=2" defer></script>');
    expect(text).not.toContain('const durationMs = minutes * 60 * 1000;');
    expect(text).not.toContain('Date.now() - startedAt >= durationMs');
    expect(text).not.toContain('location.href = "/status/secret"');
    expect(text).not.toContain('setTimeout(() => location.href = "/status/secret", 7000)');
    expect(text).not.toContain("sessionStorage.getItem('xmppm_hash')");

    const tgCall = fetchedRequests.find((r) => r.url.includes("api.telegram.org/bottoken/sendMessage"));
    expect(tgCall).toBeDefined();
    expect(tgCall?.body?.chat_id).toBe(env.TELEGRAM_ADMIN_CHAT_ID);
    expect(tgCall?.body?.reply_to_message_id).toBe(888);
    expect(tgCall?.body?.text).toContain("Password setup queued");
    expect(tgCall?.body?.text).toContain("alice");
  });

  it("renders account complete page after password is changed", async () => {
    const row = {
      id: "req_1",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "hello",
      contact: null,
      status: "invite_ready",
      invite_url: "account://complete?username=alice",
      telegram_message_id: null,
      failure_summary: null,
      created_at: 1,
      decided_at: 2,
      invite_ready_at: 3,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => row,
        }),
      }),
    };
    const response = await worker.fetch(new Request("https://xmp.pm/status/secret"), assetEnv({ DB: fakeDb as never }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Account ready");
    expect(text).toContain("Your password is set");
    expect(text).toContain("Sign in from your XMPP client");
    expect(text).toContain("alice@xmp.pm");
    expect(text).not.toContain("sessionStorage.getItem('xmppm_hash')");
  });

  it("serves password queued status page when password change is pending", async () => {
    const row = {
      id: "req_1",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "hello",
      contact: null,
      status: "approved_pending_invite",
      invite_url: "account://password-change?username=alice&password=enc",
      telegram_message_id: null,
      failure_summary: null,
      created_at: 1,
      decided_at: 2,
      invite_ready_at: 3,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => row,
        }),
      }),
    };
    const response = await worker.fetch(new Request("https://xmp.pm/status/secret"), assetEnv({ DB: fakeDb as never }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Password queued");
    expect(text).toContain("Finalizing account setup");
    expect(text).toContain("Check again manually any time");
    expect(text).toContain("Last checked:");
    expect(text).toContain("Check again now");
    expect(text).toContain("If this is stuck for more than 12h");
    expect(text).toContain('data-refresh-minutes="30"');
    expect(text).toContain('data-refresh-url="/status/secret"');
    expect(text).toContain('<script src="/js/status-refresh.js?v=2" defer></script>');
    expect(text).not.toContain('const durationMs = minutes * 60 * 1000;');
    expect(text).not.toContain('Date.now() - startedAt >= durationMs');
    expect(text).not.toContain("setTimeout(() => location.reload(), 7000)");
  });

  it("redirects ready status pages to the invite URL", async () => {
    const row = {
      id: "req_1",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "hello",
      contact: null,
      status: "invite_ready",
      invite_url: "https://xmp.pm/invites/abc123",
      telegram_message_id: null,
      failure_summary: null,
      created_at: 1,
      decided_at: 2,
      invite_ready_at: 3,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => row,
        }),
      }),
    };
    const response = await worker.fetch(new Request("https://xmp.pm/status/secret"), assetEnv({ DB: fakeDb as never }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://xmp.pm/invites/abc123");
  });

  it("invite page includes a raw token copy fallback", () => {
    const html = readFileSync("apps/website/invite.html", "utf8");
    expect(html).toContain("Copy invite token");
    expect(html).toContain("tokenCopyNode");
    expect(html).toContain("navigator.clipboard.writeText(token)");
  });

  it("rejects unauthenticated agent jobs", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/agent/jobs"), env);
    expect(response.status).toBe(401);
  });

  it("processes agent jobs with url-encoded multiline public key", async () => {
    let savedPubKey = "";
    const sqlStatements: string[] = [];
    const fakeDb = {
      prepare: (sql: string) => {
        sqlStatements.push(sql);
        if (sql.includes("agent_config")) {
          return {
            bind: (...args: unknown[]) => {
              savedPubKey = String(args[0]);
              return {
                run: async () => ({ success: true }),
              };
            },
          };
        }
        return {
          bind: () => ({
            run: async () => ({ success: true }),
            all: async () => ({ results: [] }),
          }),
        };
      },
    };

    const pem = "-----BEGIN PUBLIC KEY-----\nABC123\n-----END PUBLIC KEY-----";
    const encodedPem = encodeURIComponent(pem);

    const response = await worker.fetch(
      new Request("https://xmp.pm/agent/jobs", {
        headers: {
          authorization: `Bearer ${env.AGENT_BEARER_TOKEN}`,
          "x-agent-public-key": encodedPem,
        },
      }),
      assetEnv({ DB: fakeDb as never })
    );

    expect(response.status).toBe(200);
    expect(savedPubKey).toBe(pem);
    expect(sqlStatements.some((sql) => sql.includes("password setup expired") && sql.includes("invite_url = NULL"))).toBe(true);
  });

  it("rejects telegram webhook without secret header", async () => {
    const response = await worker.fetch(
      new Request("https://xmp.pm/telegram/webhook/secret", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      env
    );
    expect(response.status).toBe(403);
  });

  it("extends approved request retention when Telegram approves", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bindings: { sql: string; args: unknown[] }[] = [];
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          bindings.push({ sql, args });
          return {
            run: async () => ({ success: true, meta: { changes: 1 } }),
          };
        },
      }),
    };

    const response = await worker.fetch(
      new Request("https://xmp.pm/telegram/webhook/secret", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "secret" },
        body: JSON.stringify({
          callback_query: {
            id: "cb1",
            data: "invite:approve:req_123",
            from: { id: 42 },
            message: { chat: { id: 1 } },
          },
        }),
      }),
      { ...env, DB: fakeDb as never, APPROVED_RETENTION_DAYS: "14" }
    );

    expect(response.status).toBe(200);
    const update = bindings.find((binding) => binding.sql.startsWith("UPDATE invite_requests SET status"));
    expect(update?.sql).toContain("expires_at");
    const expiresAt = update?.args.find((arg) => typeof arg === "number" && arg >= now + 14 * 86400) as number | undefined;
    expect(expiresAt).toBeDefined();
  });

  it("requeues failed invites when Telegram admin taps Retry", async () => {
    const bindings: { sql: string; args: unknown[] }[] = [];
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          bindings.push({ sql, args });
          return {
            run: async () => ({ success: true, meta: { changes: 1 } }),
          };
        },
      }),
    };

    const response = await worker.fetch(
      new Request("https://xmp.pm/telegram/webhook/secret", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "secret" },
        body: JSON.stringify({
          callback_query: {
            id: "cb1",
            data: "invite:retry:req_123",
            from: { id: 42 },
            message: { chat: { id: 1 } },
          },
        }),
      }),
      assetEnv({ DB: fakeDb as never })
    );

    expect(response.status).toBe(200);
    const update = bindings.find((binding) => binding.sql.includes("status = 'approved_pending_invite'"));
    expect(update?.sql).toContain("WHERE id = ? AND status = 'invite_failed'");
    expect(update?.args).toContain("req_123");
  });

  it("does not audit stale Telegram decisions that changed no request", async () => {
    const sqls: string[] = [];
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
    const fakeDb = {
      prepare: (sql: string) => {
        sqls.push(sql);
        return {
          bind: () => ({
            run: async () => ({ success: true, meta: { changes: sql.startsWith("UPDATE") ? 0 : 1 } }),
          }),
        };
      },
    };

    const response = await worker.fetch(
      new Request("https://xmp.pm/telegram/webhook/secret", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "secret" },
        body: JSON.stringify({
          callback_query: {
            id: "cb1",
            data: "invite:approve:req_123",
            from: { id: 42 },
            message: { chat: { id: 1 } },
          },
        }),
      }),
      assetEnv({ DB: fakeDb as never })
    );

    expect(response.status).toBe(200);
    expect(sqls.some((sql) => sql.startsWith("INSERT INTO invite_audit"))).toBe(false);
  });

  it("ignores telegram callbacks without admin chat context", async () => {
    let prepared = false;
    const response = await worker.fetch(
      new Request("https://xmp.pm/telegram/webhook/secret", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "secret" },
        body: JSON.stringify({
          callback_query: {
            id: "cb1",
            data: "invite:approve:req_123",
            from: { id: 42 },
          },
        }),
      }),
      { ...env, DB: { prepare: () => { prepared = true; throw new Error("DB should not be touched"); } } as never }
    );
    expect(response.status).toBe(200);
    expect(prepared).toBe(false);
  });

  it("auto-approves env-listed trusted IP submissions from Cloudflare IP header without Turnstile or rate-limit", async () => {
    const bindings: { sql: string; args: unknown[] }[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      throw new Error("trusted IP submission should not call external services");
    }) as unknown as typeof fetch;
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          bindings.push({ sql, args });
          return {
            first: async () => null,
            run: async () => ({ success: true }),
          };
        },
      }),
    };
    const form = new FormData();
    form.set("username", "alice");
    form.set("message", "I would like an invite for testing.");
    form.set("aup", "yes");
    const response = await worker.fetch(
      new Request("https://xmp.pm/request", {
        method: "POST",
        body: form,
        headers: { "cf-connecting-ip": "203.0.113.10" },
      }),
      { ...env, DB: fakeDb as never, TRUSTED_FORM_IPS: "203.0.113.10" }
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toStartWith("https://xmp.pm/status/");
    expect(bindings.some((binding) => binding.sql.includes("rate_limits"))).toBe(false);
    const insertBinding = bindings.find((binding) => binding.args.length === 14);
    expect(insertBinding?.args[6]).toBe("approved_pending_invite");
    expect(typeof insertBinding?.args[11]).toBe("number");
  });

  it("bypasses only rate-limit for env-listed rate-limit bypass IPs", async () => {
    const bindings: { sql: string; args: unknown[] }[] = [];
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      if (String(input).includes("turnstile")) return Response.json({ success: true });
      if (String(input).includes("api.telegram.org")) return Response.json({ ok: true, result: { message_id: 123 } });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          bindings.push({ sql, args });
          return {
            first: async () => sql.includes("rate_limits") ? { count: 999 } : null,
            run: async () => ({ success: true }),
          };
        },
      }),
    };
    const form = new FormData();
    form.set("username", "alice");
    form.set("message", "I would like an invite for testing.");
    form.set("aup", "yes");
    form.set("cf-turnstile-response", "token");
    const response = await worker.fetch(
      new Request("https://xmp.pm/request", {
        method: "POST",
        body: form,
        headers: { "cf-connecting-ip": "203.0.113.10" },
      }),
      { ...env, DB: fakeDb as never, RATE_LIMIT_BYPASS_IPS: "203.0.113.10" }
    );
    expect(response.status).toBe(303);
    expect(bindings.some((binding) => binding.sql.includes("rate_limits"))).toBe(false);
    expect(fetchedUrls.some((url) => url.includes("turnstile"))).toBe(true);
    const insertBinding = bindings.find((binding) => binding.args.length === 14);
    expect(insertBinding?.args[6]).toBe("pending");
  });

  it("does not auto-approve trusted IP submissions when trusted IP list is empty", async () => {
    const bindings: { sql: string; args: unknown[] }[] = [];
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      if (String(input).includes("turnstile")) return Response.json({ success: true });
      if (String(input).includes("api.telegram.org")) return Response.json({ ok: true, result: { message_id: 123 } });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          bindings.push({ sql, args });
          return {
            first: async () => sql.includes("rate_limits") ? { count: 1 } : null,
            run: async () => ({ success: true }),
          };
        },
      }),
    };
    const form = new FormData();
    form.set("username", "alice");
    form.set("message", "I would like an invite for testing.");
    form.set("aup", "yes");
    form.set("cf-turnstile-response", "token");
    const response = await worker.fetch(
      new Request("https://xmp.pm/request", {
        method: "POST",
        body: form,
        headers: { "cf-connecting-ip": "203.0.113.10" },
      }),
      { ...env, DB: fakeDb as never, TRUSTED_FORM_IPS: "" }
    );
    expect(response.status).toBe(303);
    expect(bindings.some((binding) => binding.sql.includes("rate_limits"))).toBe(true);
    expect(fetchedUrls.some((url) => url.includes("turnstile"))).toBe(true);
    const insertBinding = bindings.find((binding) => binding.args.length === 14);
    expect(insertBinding?.args[6]).toBe("pending");
  });

  it("uses request-retention days for new request expiry", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bindings: unknown[][] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("turnstile")) return Response.json({ success: true });
      if (url.includes("api.telegram.org")) return Response.json({ ok: true, result: { message_id: 123 } });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          bindings.push(args);
          return {
            first: async () => sql.includes("rate_limits") ? { count: 1 } : null,
            run: async () => ({ success: true }),
          };
        },
      }),
    };
    const form = new FormData();
    form.set("username", "alice");
    form.set("message", "I would like an invite for testing.");
    form.set("aup", "yes");
    form.set("cf-turnstile-response", "token");
    const response = await worker.fetch(
      new Request("https://xmp.pm/request", { method: "POST", body: form }),
      { ...env, DB: fakeDb as never, REQUEST_RETENTION_DAYS: "7", APPROVED_RETENTION_DAYS: "14" }
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toStartWith("https://xmp.pm/status/");
    const insertArgs = bindings.find((args) => args.length === 14);
    expect(insertArgs).toBeDefined();
    const expiresAt = insertArgs?.[13] as number;
    expect(expiresAt).toBeGreaterThanOrEqual(now + 7 * 86400);
    expect(expiresAt).toBeLessThan(now + 8 * 86400);
  });

  it("notifies telegram admin on agent job failure", async () => {
    const row = {
      id: "req_123",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "hello",
      contact: null,
      status: "approved_pending_invite",
      invite_url: null,
      telegram_message_id: "777",
      failure_summary: null,
      created_at: 1,
      decided_at: 2,
      invite_ready_at: null,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;

    const bindings: { sql: string; args: unknown[] }[] = [];
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          bindings.push({ sql, args });
          return {
            first: async () => row,
            run: async () => ({ success: true }),
          };
        },
      }),
    };

    const fetchedRequests: { url: string; body: any }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchedRequests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const req = new Request("https://xmp.pm/agent/jobs/req_123/fail", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.AGENT_BEARER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ error: "conflict" }),
    });

    const response = await worker.fetch(req, assetEnv({ DB: fakeDb as never }));
    expect(response.status).toBe(200);

    // Should update db status to invite_failed
    expect(bindings.some((b) => b.sql.includes("status = 'invite_failed'") && b.args.includes("req_123"))).toBe(true);

    // Should notify via Telegram
    const telegramCall = fetchedRequests.find((r) => r.url.includes("api.telegram.org/bottoken/sendMessage"));
    expect(telegramCall).toBeDefined();
    expect(telegramCall?.body?.chat_id).toBe(env.TELEGRAM_ADMIN_CHAT_ID);
    expect(telegramCall?.body?.reply_to_message_id).toBe(777);
    expect(telegramCall?.body?.text).toContain("Invite generation failed");
    expect(telegramCall?.body?.text).toContain("alice");
    expect(telegramCall?.body?.text).toContain("conflict");
  });

  it("falls back to sending new telegram message on failure if reply fails", async () => {
    const row = {
      id: "req_123",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "hello",
      contact: null,
      status: "approved_pending_invite",
      invite_url: null,
      telegram_message_id: "777",
      failure_summary: null,
      created_at: 1,
      decided_at: 2,
      invite_ready_at: null,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;

    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => row,
          run: async () => ({ success: true }),
        }),
      }),
    };

    const fetchedRequests: { url: string; body: any }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchedRequests.push({ url, body });
      if (body && body.reply_to_message_id === 777) {
        return Response.json({ ok: false, description: "Bad Request: reply message not found" });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    const req = new Request("https://xmp.pm/agent/jobs/req_123/fail", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.AGENT_BEARER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ error: "conflict" }),
    });

    const response = await worker.fetch(req, assetEnv({ DB: fakeDb as never }));
    expect(response.status).toBe(200);

    // Should have tried with reply first, then fallen back to no reply
    expect(fetchedRequests.length).toBe(2);
    expect(fetchedRequests[0]?.body?.reply_to_message_id).toBe(777);
    expect(fetchedRequests[1]?.body?.reply_to_message_id).toBeUndefined();
    expect(fetchedRequests[1]?.body?.text).toContain("Invite generation failed");
  });

  it("notifies telegram admin on password setup completion", async () => {
    const row = {
      id: "req_123",
      secret_hash: "hash",
      claim_code_hash: "claim",
      desired_username: "alice",
      message: "hello",
      contact: null,
      status: "approved_pending_invite",
      invite_url: "account://password-change?username=alice&password=enc",
      telegram_message_id: "777",
      failure_summary: null,
      created_at: 1,
      decided_at: 2,
      invite_ready_at: null,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    } satisfies InviteRequest;

    const bindings: { sql: string; args: unknown[] }[] = [];
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          bindings.push({ sql, args });
          return {
            first: async () => row,
            run: async () => ({ success: true }),
          };
        },
      }),
    };

    const fetchedRequests: { url: string; body: any }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchedRequests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const req = new Request("https://xmp.pm/agent/jobs/req_123/invite", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.AGENT_BEARER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ invite_url: "account://complete?username=alice" }),
    });

    const response = await worker.fetch(req, assetEnv({ DB: fakeDb as never }));
    expect(response.status).toBe(200);

    // Should update db status/url
    expect(bindings.some((b) => b.sql.includes("UPDATE invite_requests") && b.args.includes("req_123") && b.args.includes("account://complete?username=alice"))).toBe(true);

    // Should notify via Telegram
    const telegramCall = fetchedRequests.find((r) => r.url.includes("api.telegram.org/bottoken/sendMessage"));
    expect(telegramCall).toBeDefined();
    expect(telegramCall?.body?.chat_id).toBe(env.TELEGRAM_ADMIN_CHAT_ID);
    expect(telegramCall?.body?.reply_to_message_id).toBe(777);
    expect(telegramCall?.body?.text).toContain("Password setup completed");
    expect(telegramCall?.body?.text).toContain("alice");
  });

  it("serves agent public key from database", async () => {
    const fakeDb = {
      prepare: (sql: string) => {
        expect(sql).toContain("FROM agent_config WHERE key = 'public_key'");
        return {
          first: async () => ({ value: "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..." }),
        };
      },
    };

    const response = await worker.fetch(new Request("https://xmp.pm/agent-pubkey.pem"), assetEnv({ DB: fakeDb as never }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-pem-file");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const text = await response.text();
    expect(text).toContain("-----BEGIN PUBLIC KEY-----");
  });

  it("serves dev-preview route only on local development addresses", async () => {
    const localReq = new Request("http://localhost:4000/dev-preview/pending");
    const localRes = await worker.fetch(localReq, env);
    expect(localRes.status).toBe(200);
    const localText = await localRes.text();
    expect(localText).toContain("Request pending");

    const ipReq = new Request("http://0.0.0.0:4000/dev-preview/pending");
    const ipRes = await worker.fetch(ipReq, env);
    expect(ipRes.status).toBe(200);

    const indexReq = new Request("http://127.0.0.1:4000/dev-preview");
    const indexRes = await worker.fetch(indexReq, env);
    expect(indexRes.status).toBe(200);
    const indexText = await indexRes.text();
    expect(indexText).toContain("Dev UI/UX Preview");
    expect(indexText).toContain("href=\"/dev-preview/request\"");

    const remoteReq = new Request("https://xmp.pm/dev-preview/pending");
    const remoteRes = await worker.fetch(remoteReq, env);
    expect(remoteRes.status).toBe(404);

    const workersDevReq = new Request("https://xmppm-invites.example.workers.dev/dev-preview/pending");
    const workersDevRes = await worker.fetch(workersDevReq, env);
    expect(workersDevRes.status).toBe(404);
  });

  it("serves homepage from Worker Assets at root", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/"), env);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("xmp.pm");
    expect(response.headers.get("location")).toBeNull();
  });

  it("serves invite page asset for invite token paths", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/invites/abc123"), env);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("xmp.pm invite");
    expect(text).toContain("reading token");
  });

  it("serves well-known discovery from Worker Assets with XEP-0156 headers", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/.well-known/host-meta"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("content-type")).toContain("application/xrd+xml");
    const text = await response.text();
    expect(text).toContain("wss://xmpp.xmp.pm/ws");

    const jsonResponse = await worker.fetch(new Request("https://xmp.pm/.well-known/host-meta.json"), env);
    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.headers.get("access-control-allow-origin")).toBe("*");
    expect(jsonResponse.headers.get("content-type")).toContain("application/jrd+json");
  });

  it("serves styled 404 page for unknown paths", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/unknown-path-xyz"), env);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain("Page not found");
    expect(text).toContain("Go back home");
    expect(text).toContain('<main class="ticket">');
  });

  it("includes Go back home link in request form", async () => {
    const response = await worker.fetch(new Request("https://xmp.pm/request"), env);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Go back home");
    expect(text).toContain('class="secondary" href="/"');
  });
});
