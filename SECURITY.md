# Security Policy

## Reporting A Vulnerability

Please do not open a public issue for vulnerabilities, abuse bypasses, leaked
credentials, or operational weaknesses.

Report security concerns by email:

- [`vesselwave@protonmail.com`](mailto:vesselwave@protonmail.com)

Include the affected route, config file, or service name; a short impact
summary; and enough reproduction detail to verify the issue.

## Public Repository Notes

This repository is intended to be publishable, but it contains live service
configuration and operational detail. Before publishing a change:

- Run a secret scan.
- Review `wrangler.toml`, `.env*`, systemd units, deploy scripts, and config
  templates for accidental credentials.
- Keep Worker secrets in Cloudflare via `wrangler secret put`.
- Keep VPS agent secrets in `/etc/xmppm-agent.env`, not in git.
- Treat bearer tokens, Telegram bot tokens, webhook secrets, Turnstile secrets,
  database credentials, private keys, backup keys, and admin passwords as
  non-public.

Public IP addresses, DNS records, and service ports may be intentionally tracked
as part of the server configuration. Re-check them when the infrastructure
changes.
