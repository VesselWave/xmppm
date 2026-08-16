set shell := ["bash", "-euo", "pipefail", "-c"]

shell_files := "ops/deploy.sh ops/fetch-converse.sh ops/post-deploy-smoke.sh ops/dependency-security-review.sh ops/reconcile-accounts.sh ops/vps/xmppm-ejabberd-cert-sync ops/vps/xmppm-backup"

# List commands
_default:
    just --list

# Download latest stable Converse.js distribution with registry integrity verification
assets:
    ops/fetch-converse.sh

# Run all local checks
check: assets lint typecheck test

# Run local wrangler dev server with static assets
dev: assets
    bunx wrangler dev --ip 0.0.0.0 --port 4000 --assets apps/website

# Show explicit deploy targets; does not deploy by default
deploy:
    @just --list | grep -E '^    deploy'

# Deploy Cloudflare Worker/D1 only
deploy-worker:
    ops/deploy.sh --only worker

# Deploy full VPS stack, leaving Worker/D1 untouched
deploy-vps:
    ops/deploy.sh --only vps

# Deploy VPS agent only; reset is intentionally unavailable
deploy-agent:
    ops/deploy.sh --only agent

# Deploy XMPP gateway proxy only
deploy-proxy:
    ops/deploy.sh --only proxy

# Run public post-deploy launch-gate smoke checks
smoke:
    ops/post-deploy-smoke.sh

# Run monthly dependency/security review checklist
security-review:
    ops/dependency-security-review.sh

# Compare D1 invite/account jobs against live ejabberd registered users
reconcile-accounts:
    ops/reconcile-accounts.sh

# Create or update admin@xmp.pm password
set-admin-password password:
    target="${TARGET:?set TARGET=user@host}"; password_b64="$(printf '%s' {{quote(password)}} | base64 -w0)"; ssh "$target" 'sh -c '\''password="$(printf "%s" "$1" | base64 -d)"; if sudo ejabberdctl registered_users xmp.pm | grep -Fxq admin; then sudo ejabberdctl change_password admin xmp.pm "$password"; else sudo ejabberdctl register admin xmp.pm "$password"; fi'\'' sh' "$password_b64"

# Open SSH tunnel to loopback-only ejabberd Web Admin; keep running, then browse https://127.0.0.1:5444/admin
webui-tunnel local_port='5444':
    ops_env_file="${XMPPM_OPS_ENV:-private/ops.env}"; if [[ -f "$ops_env_file" ]]; then set -a; . "$ops_env_file"; set +a; fi; target="${TARGET:-}"; if [[ -z "$target" && -n "${VPS_USER:-}" && -n "${PUBLIC_IPV4:-}" ]]; then target="${VPS_USER}@${PUBLIC_IPV4}"; fi; target="${target:?set TARGET=user@host or VPS_USER/PUBLIC_IPV4 in private/ops.env}"; ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:{{local_port}}:127.0.0.1:5444 "$target"  # https://127.0.0.1:5444/admin

# Run all linters
lint: lint-py lint-sh

# Format Python and shell files
fmt: fmt-py fmt-sh

# Type-check TypeScript worker/tests
typecheck:
    bun run typecheck

# Run TS + Python tests
test: test-ts test-py

# Run Bun tests
test-ts:
    bun test

# Run Python agent tests
test-py:
    cd apps/agent && uv run pytest

# Lint Python agent
lint-py:
    cd apps/agent && uv run ruff check .

# Format Python agent
fmt-py:
    cd apps/agent && uv run ruff format .

# Lint shell scripts. Install shellcheck with your OS package manager.
lint-sh:
    command -v shellcheck >/dev/null || { echo "missing shellcheck" >&2; exit 1; }
    shellcheck {{shell_files}}

# Format shell scripts. Install shfmt with your OS package manager.
fmt-sh:
    command -v shfmt >/dev/null || { echo "missing shfmt" >&2; exit 1; }
    shfmt -w -i 2 -ci {{shell_files}}
