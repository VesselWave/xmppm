# xmp.pm server config

This repository is the deployable configuration and support code for
[`xmp.pm`](https://xmp.pm/), an invite-only, donation-funded public XMPP service.

It includes the public website, XMPP discovery files, Cloudflare Worker invite
workflow, D1 migrations, ejabberd configuration, nginx/gateway templates,
systemd units, backup helpers, and the outbound VPS agent used for operational
automation.

## Service At A Glance

| Item | Value |
|---|---|
| Service domain | `xmp.pm` |
| Public site | `https://xmp.pm/` |
| XMPP admin | [`admin@xmp.pm`](xmpp:admin@xmp.pm) |
| Admin email | [`vesselwave@protonmail.com`](mailto:vesselwave@protonmail.com) |
| Registration | Invite-only |
| Chat archive retention | 7 days by default |
| Backups | 14 daily encrypted snapshots |
| Website analytics/tracking | None run by xmp.pm; Cloudflare handles edge delivery and security metadata |

## Architecture

```text
Visitors and users
  |
  | HTTPS: website, invite requests, status links, Telegram webhook, agent API
  v
Cloudflare Worker + Assets + D1
  |
  | outbound polling only
  v
VPS agent
  |
  | local commands / health checks
  v
ejabberd + PostgreSQL + gateway proxy + backups
```

`xmp.pm` pages and invite routes are served by Cloudflare Worker Assets and the
Worker in `apps/worker/`. Native XMPP traffic and the WebSocket/BOSH/upload
gateway are served from the VPS through `xmpp.xmp.pm`.

## Repository Map

| Path | Purpose |
|---|---|
| `apps/website/` | Static public site, invite pages, legal/info pages, XEP-0156 files |
| `apps/worker/` | Cloudflare Worker invite workflow, Telegram approvals, agent API |
| `apps/agent/` | Python VPS agent for invite creation, monitoring, smoke checks |
| `config/` | DNS template, nginx notes, ejabberd configuration |
| `migrations/` | Cloudflare D1 schema migrations |
| `ops/` | Deploy scripts, VPS templates, systemd units, backup/cert-sync helpers |
| `docs/ops/` | Operator runbooks for deploy, restore, and failure handling |
| `tests/` | Worker and website tests |

## Local Development

Install the local tools used by the repo:

- Bun for the Worker and TypeScript tests
- `uv` for the Python agent environment
- `just` for task shortcuts
- `shellcheck` and `shfmt` for shell script checks

Then run:

```bash
bun install
bun run assets  # download latest stable Converse.js; generated dist/ stays untracked
cd apps/agent && uv sync && cd ../..
just check
```

Useful commands:

```bash
just --list      # show available tasks
just assets      # refresh latest stable Converse.js distribution
just dev         # fetch assets, then run local Wrangler dev server on port 4000
just typecheck   # TypeScript only
just test        # Bun + pytest
just lint        # Python and shell lint
just fmt         # Python and shell formatting
just smoke       # public post-deploy smoke checks
```

## Configuration

Start with the example files and keep real secrets out of git:

```bash
cp wrangler.toml.example wrangler.toml
cp .env.example .env
```

Set Cloudflare Worker secrets with Wrangler instead of committing them:

```bash
bunx wrangler secret put TELEGRAM_ADMIN_CHAT_ID
bunx wrangler secret put TELEGRAM_ADMIN_USER_IDS
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET
bunx wrangler secret put AGENT_BEARER_TOKEN
bunx wrangler secret put TURNSTILE_SECRET_KEY
```

The VPS agent environment is installed separately as `/etc/xmppm-agent.env`.
Use `.env.example` as the reference for variable names.

## Deploy

The root `justfile` wraps the common deploy tasks:

```bash
just deploy-worker   # Cloudflare Worker/D1/Assets
just deploy-vps      # VPS stack
just deploy-agent    # VPS agent only
just deploy-proxy    # xmpp.xmp.pm HTTPS gateway only
```

The underlying deploy script is `ops/deploy.sh`:

```bash
ops/deploy.sh              # VPS stack by default
ops/deploy.sh --only all   # Worker + VPS
ops/deploy.sh --reset --only all
```

`--reset` is destructive and intended only for this service's zero-user or
launch-test rebuild windows.

Backup and restore steps are in
[`docs/ops/backup-restore.md`](docs/ops/backup-restore.md).

## DNS And Discovery

Use `config/dns-records` as the Cloudflare zone template.

Expected ownership:

- `xmp.pm` and `www.xmp.pm` are Worker-routed hostnames with proxied
  placeholder records.
- Native XMPP SRV records target `xmpp.xmp.pm`.
- `xmpp.xmp.pm/ws`, `xmpp.xmp.pm/bosh`, and `/upload` are served by the VPS
  gateway.
- XEP-0156 discovery files live in `apps/website/.well-known/`.

After deploy, the basic public checks are:

```bash
curl -fsS https://xmp.pm/ >/dev/null
curl -fsS https://xmp.pm/info.html >/dev/null
curl -fsS https://xmp.pm/.well-known/host-meta | grep xmpp.xmp.pm
curl -fsS https://xmp.pm/request >/dev/null
curl -fsS https://xmpp.xmp.pm/healthz
```

## Operations

Important operator references:

- [`docs/ops/backup-restore.md`](docs/ops/backup-restore.md)
- [`ops/vps/README.md`](ops/vps/README.md)

Local-only ejabberd Web Admin is bound to `127.0.0.1:5444` by
`config/ejabberd.yml`. Open an SSH tunnel, keep that terminal running, then
browse `https://127.0.0.1:5444/admin`:

```bash
just webui-tunnel
```

Essential service accounts:

- `admin@xmp.pm` - primary admin account
- `test@xmp.pm` - live service check account
- `test2@xmp.pm` - live service check account

Do not purge these accounts during account cleanup unless replacing the
operational/test-account plan first.

The initial public cohort is intentionally capped at 10 active users on the
current small VPS. Re-evaluate CPU, memory, swap, disk, PostgreSQL, ejabberd,
and upload usage before raising the cap to 25 or 50 active users.

## Retention Policy

| Data | Retention |
|---|---:|
| MAM chat archive | 7 days default |
| MAM opt-out | yes, if client supports |
| Offline messages | 30 days or until delivered, whichever is sooner |
| HTTP uploads | 7 days |
| Upload quota | 100 MB/user |
| IP/security logs | up to 7 days |
| Abuse reports/evidence | up to 7 days |
| Backups | 14 daily encrypted snapshots |
| Invite tokens | 14 days or used once |
| Deleted accounts | removed live immediately; backups age out within 14 days |
| Website analytics/tracking | none run by xmp.pm; Cloudflare handles edge delivery and security metadata |

## Security Notes

- Keep real secrets out of `.env.example` and `wrangler.toml.example`.
- Set Worker secrets with `bunx wrangler secret put ...`.
- Keep `/agent/*` and `/telegram/webhook/*` behind their bearer/header secrets.
- The trusted-IP invite shortcut only trusts Cloudflare's `CF-Connecting-IP`
  header. Do not auto-approve based on client-controlled `X-Forwarded-For`.
- Before publishing changes, run a secret scan and review tracked config files
  that intentionally contain live infrastructure details.

See [`SECURITY.md`](SECURITY.md) for vulnerability reporting and public-repo
handling notes.

## License

This repository contains mixed materials:

- Project-specific website, Worker, agent, and ops glue are licensed under the
  [MIT License](LICENSE), using SPDX identifier `MIT`.
- OSI reference: <https://opensource.org/license/mit>
- `config/ejabberd.yml`: GPLv2, following the upstream config lineage.
- `config/dns-records`: public domain.
- Converse.js is not stored in git. `ops/fetch-converse.sh` downloads the latest
  stable npm release, verifies its registry SHA-512 integrity, and copies its
  MPL-2.0 `LICENSE` and `COPYRIGHT` files beside the generated distribution.
- The project-owned Nord theme remains tracked separately at
  `apps/website/css/converse-nord-dark.css`; refreshing Converse.js does not
  overwrite it.
