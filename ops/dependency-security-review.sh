#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cat <<'NOTE'
Review cadence: run monthly and after security advisories for Bun/Worker deps,
Python agent deps, container images, Wrangler/Cloudflare platform notes, and
ejabberd releases. Record findings in docs/ops or the launch-audit fixed list.
NOTE

printf '\n== Bun package updates ==\n'
bun outdated || true

printf '\n== Python package updates ==\n'
(
  cd apps/agent
  uv tree --outdated || true
)

printf '\n== Pinned container images ==\n'
grep -nE '^\s*image:' ops/vps/gateway-docker-compose.yml
if grep -nE '^\s*image:\s*\S+:latest\b' ops/vps/gateway-docker-compose.yml; then
  echo "ERROR: floating :latest image tag found" >&2
  exit 1
fi

cat <<'NOTE'

Manual checks:
- Review https://github.com/processone/ejabberd/releases for security releases.
- Review Traefik and nginx image release notes.
- Review Cloudflare Workers/D1/Wrangler changelogs for breaking/security notes.
- If image tags change, update ops/vps/gateway-docker-compose.yml, run
  `docker compose config`, pull during a maintenance window, run `just smoke`,
  and keep the previous compose file for rollback.
NOTE
