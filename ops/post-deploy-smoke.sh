#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://xmp.pm}"
XMPP_URL="${XMPP_URL:-https://xmpp.xmp.pm}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-15}"

# Default concrete launch-gate URLs checked:
# - https://xmp.pm/request
# - https://xmp.pm/.well-known/host-meta
# - https://xmp.pm/.well-known/host-meta.json
# - https://xmpp.xmp.pm/healthz
# - https://xmpp.xmp.pm/bosh
# - https://xmpp.xmp.pm/ws

curl_ok() {
  local url="$1"
  curl --fail --silent --show-error --max-time "$TIMEOUT_SECONDS" --output /dev/null "$url"
  echo "ok $url"
}

curl_status_any() {
  local url="$1"
  shift
  local status expected
  status="$(curl --silent --show-error --max-time "$TIMEOUT_SECONDS" --output /dev/null --write-out '%{http_code}' "$url")"
  for expected in "$@"; do
    if [[ "$status" == "$expected" ]]; then
      echo "ok $url -> $status"
      return 0
    fi
  done
  echo "expected one of [$*] from $url, got $status" >&2
  return 1
}

require_header() {
  local url="$1"
  local header="$2"
  curl --fail --silent --show-error --max-time "$TIMEOUT_SECONDS" --head "$url" \
    | tr -d '\r' \
    | grep -iq "^${header}:" \
    || { echo "missing ${header} header on ${url}" >&2; return 1; }
  echo "ok $url has $header"
}

curl_ok "$BASE_URL/"
curl_ok "$BASE_URL/request"
curl_ok "$BASE_URL/.well-known/host-meta"
curl_ok "$BASE_URL/.well-known/host-meta.json"
require_header "$BASE_URL/" "content-security-policy"
require_header "$BASE_URL/request" "content-security-policy"
require_header "$BASE_URL/request" "strict-transport-security"

curl_ok "$XMPP_URL/healthz"
# ejabberd BOSH returns an informational page (200) for GET and may return 400 for invalid BOSH payloads.
curl_status_any "$XMPP_URL/bosh" 200 400
curl_status_any "$XMPP_URL/ws" 200

echo "post-deploy smoke passed"
