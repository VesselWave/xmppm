#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OPS_ENV_FILE=${XMPPM_OPS_ENV:-$ROOT/private/ops.env}
if [[ -f "$OPS_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$OPS_ENV_FILE"
  set +a
fi

DB_NAME=${DB_NAME:-xmppm_invites}
SERVICE_DOMAIN=${SERVICE_DOMAIN:-xmp.pm}
VPS_USER=${VPS_USER:-}
PUBLIC_IPV4=${PUBLIC_IPV4:-}
TARGET=${TARGET:-}
if [[ -z "$TARGET" && -n "$VPS_USER" && -n "$PUBLIC_IPV4" ]]; then
  TARGET="$VPS_USER@$PUBLIC_IPV4"
fi
D1_JSON=${D1_JSON:-}
REGISTERED_USERS=${REGISTERED_USERS:-}
REPORT_ONLY=${REPORT_ONLY:-0}

usage() {
  cat <<'USAGE'
Usage: ops/reconcile-accounts.sh [--report-only]

Compare Cloudflare D1 invite/account jobs with live ejabberd registered_users.

Env overrides:
  XMPPM_OPS_ENV=private/ops.env                 # optional env file; defaults to private/ops.env
  DB_NAME=xmppm_invites
  SERVICE_DOMAIN=xmp.pm
  VPS_USER=deploy                               # SSH username; TARGET defaults to VPS_USER@PUBLIC_IPV4
  PUBLIC_IPV4=203.0.113.10
  TARGET=deploy@xmpp.example.net                # optional explicit SSH target override
  D1_JSON=/path/to/wrangler-json-fixture          # optional offline input
  REGISTERED_USERS=/path/to/registered-users.txt # optional offline input
  REPORT_ONLY=1                                  # never exit nonzero for drift
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --report-only) REPORT_ONLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

need() { command -v "$1" >/dev/null || { echo "missing command: $1" >&2; exit 1; }; }
need python3

SQL="SELECT id, desired_username, status, invite_url, created_at, decided_at, invite_ready_at, expires_at FROM invite_requests WHERE status IN ('pending', 'approved_pending_invite', 'invite_ready', 'invite_failed') ORDER BY status, desired_username;"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
D1_OUT="$TMPDIR/d1.json"
USERS_OUT="$TMPDIR/registered_users.txt"

if [[ -n "$D1_JSON" ]]; then
  cp "$D1_JSON" "$D1_OUT"
else
  need bunx
  bunx wrangler d1 execute "$DB_NAME" --remote --json --command "$SQL" >"$D1_OUT"
fi

if [[ -n "$REGISTERED_USERS" ]]; then
  cp "$REGISTERED_USERS" "$USERS_OUT"
else
  [[ -n "$TARGET" ]] || {
    echo "TARGET is required unless REGISTERED_USERS is set" >&2
    exit 2
  }
  need ssh
  # SERVICE_DOMAIN is intentionally expanded locally before invoking the remote shell.
  # shellcheck disable=SC2029
  ssh "$TARGET" "sudo ejabberdctl registered_users '$SERVICE_DOMAIN'" >"$USERS_OUT"
fi

python3 - "$D1_OUT" "$USERS_OUT" "$REPORT_ONLY" <<'PY'
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def load_rows(path: Path) -> list[dict[str, object]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        if isinstance(data.get("results"), list):
            return data["results"]
        result = data.get("result")
        if isinstance(result, list) and result and isinstance(result[0], dict):
            rows = result[0].get("results")
            if isinstance(rows, list):
                return rows
    if isinstance(data, list):
        if data and isinstance(data[0], dict) and isinstance(data[0].get("results"), list):
            return data[0]["results"]
        if all(isinstance(item, dict) for item in data):
            return data
    raise SystemExit(f"unsupported wrangler d1 JSON shape in {path}")


def password_change_username(invite_url: object) -> str | None:
    if not isinstance(invite_url, str):
        return None
    parsed = urlparse(invite_url)
    if parsed.scheme == "account" and parsed.netloc == "password-change":
        return parse_qs(parsed.query).get("username", [None])[0]
    return None


def format_names(names: list[str]) -> str:
    return ", ".join(names) if names else "-"

rows = load_rows(Path(sys.argv[1]))
registered = {
    line.strip()
    for line in Path(sys.argv[2]).read_text(encoding="utf-8").splitlines()
    if line.strip()
}
report_only = sys.argv[3] == "1"

by_status: dict[str, list[dict[str, object]]] = defaultdict(list)
for row in rows:
    by_status[str(row.get("status", "unknown"))].append(row)

tracked_ready = {
    str(row.get("desired_username", ""))
    for row in by_status["invite_ready"]
    if row.get("desired_username")
}
tracked_pending = {
    str(row.get("desired_username", ""))
    for row in by_status["approved_pending_invite"]
    if row.get("desired_username")
}
tracked_failed = {
    str(row.get("desired_username", ""))
    for row in by_status["invite_failed"]
    if row.get("desired_username")
}
password_queue = sorted(
    name
    for row in by_status["approved_pending_invite"]
    if (name := password_change_username(row.get("invite_url")))
)
tracked_all = tracked_ready | tracked_pending | tracked_failed

invite_ready_missing = sorted(tracked_ready - registered)
approved_already_registered = sorted(tracked_pending & registered)
invite_failed_registered = sorted(tracked_failed & registered)
password_change_queue_missing = sorted(set(password_queue) - registered)
registered_without_d1_record = sorted(registered - tracked_all)

print("xmp.pm account reconciliation")
print(f"d1_tracked_rows: {len(rows)}")
print(f"ejabberd_registered_users: {len(registered)}")
for status, count in sorted(Counter(str(row.get("status", "unknown")) for row in rows).items()):
    print(f"d1_status.{status}: {count}")
print(f"password_change_queue: {format_names(password_queue)}")
print(f"invite_ready_missing_registered_user: {format_names(invite_ready_missing)}")
print(f"approved_pending_invite_already_registered: {format_names(approved_already_registered)}")
print(f"invite_failed_but_registered: {format_names(invite_failed_registered)}")
print(f"password_change_queue_missing_registered_user: {format_names(password_change_queue_missing)}")
print(f"registered_without_d1_record: {format_names(registered_without_d1_record)}")

drift = any([
    invite_ready_missing,
    approved_already_registered,
    invite_failed_registered,
    password_change_queue_missing,
    registered_without_d1_record,
])
if drift and not report_only:
    raise SystemExit(1)
PY
