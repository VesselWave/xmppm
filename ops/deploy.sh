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

VPS_USER=${VPS_USER:-}
PUBLIC_IPV4=${PUBLIC_IPV4:-}
TARGET=${TARGET:-}
if [[ -z "$TARGET" && -n "$VPS_USER" && -n "$PUBLIC_IPV4" ]]; then
  TARGET="$VPS_USER@$PUBLIC_IPV4"
fi
PUBLIC_IPV6=${PUBLIC_IPV6:-}
REMOTE_RELEASE=${REMOTE_RELEASE:-/tmp/xmppm-deploy}
REMOTE_GATEWAY_DIR=${REMOTE_GATEWAY_DIR:-/srv/xmppm-gateway}
SSL_BACKUP_DIR=${SSL_BACKUP_DIR:-$HOME/.xmppm/backups}
SKIP_SSL_BACKUP=${SKIP_SSL_BACKUP:-0}
SKIP_REGISTRATION_SMOKE=${SKIP_REGISTRATION_SMOKE:-0}
RESET=0
ONLY=vps

usage() {
  cat <<'USAGE'
Usage: ops/deploy.sh [--reset] [--only all|worker|vps|agent|proxy]

Deploy xmp.pm VPS by default. Use --only worker or --only all for Worker/D1/Assets.

Env overrides:
  XMPPM_OPS_ENV=private/ops.env          # optional env file; defaults to private/ops.env
  VPS_USER=deploy                      # SSH username; TARGET defaults to VPS_USER@PUBLIC_IPV4
  PUBLIC_IPV4=203.0.113.10             # required for --only all|vps
  TARGET=deploy@xmpp.example.net       # optional explicit SSH target override
  PUBLIC_IPV6=2001:db8::10             # auto-detected if unset
  REMOTE_RELEASE=/tmp/xmppm-deploy
  REMOTE_GATEWAY_DIR=/srv/xmppm-gateway
  SSL_BACKUP_DIR=~/.xmppm/backups
  SKIP_SSL_BACKUP=1                    # disable pre-deploy SSL backup
  SKIP_REGISTRATION_SMOKE=1            # emergency bypass for live invite-only registration smoke

Flags:
  --reset        destructive: clear D1 rows, recreate ejabberd PostgreSQL DB,
                 remove ejabberd mnesia/upload/log state before restart
  --only all|worker|vps|agent|proxy
                 deploy one place; vps means ejabberd+agent+gateway, no Worker/D1
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) RESET=1 ;;
    --only)
      [[ $# -ge 2 ]] || {
        echo "--only requires a value" >&2
        usage >&2
        exit 2
      }
      ONLY=$2
      shift
      ;;
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

case "$ONLY" in
  all | worker | vps | agent | proxy) ;;
  *)
    echo "invalid --only value: $ONLY" >&2
    usage >&2
    exit 2
    ;;
esac
if [[ "$RESET" -eq 1 && "$ONLY" != "all" && "$ONLY" != "worker" && "$ONLY" != "vps" ]]; then
  echo "RESET is only allowed with --only all, worker, or vps" >&2
  exit 2
fi
need() { command -v "$1" >/dev/null || {
  echo "missing command: $1" >&2
  exit 1
}; }
if [[ "$ONLY" == "all" || "$ONLY" == "worker" ]]; then
  need bun
fi
if [[ "$ONLY" != "worker" ]]; then
  [[ -n "$TARGET" ]] || {
    echo "TARGET is required for --only $ONLY" >&2
    exit 2
  }
  need ssh
  need rsync
fi
if [[ "$ONLY" == "all" || "$ONLY" == "vps" ]]; then
  [[ -n "$PUBLIC_IPV4" ]] || {
    echo "PUBLIC_IPV4 is required for --only $ONLY" >&2
    exit 2
  }
fi
if [[ "$SKIP_REGISTRATION_SMOKE" != "1" && ("$ONLY" == "all" || "$ONLY" == "vps") ]]; then
  need uv
fi

run_registration_hardening_smoke() {
  if [[ "$SKIP_REGISTRATION_SMOKE" == "1" ]]; then
    echo "registration hardening smoke skipped"
    return
  fi

  echo "running registration hardening smoke"
  (
    cd apps/agent
    XMPPM_LIVE_EJABBERD=1 \
      XMPPM_TEST_XMPP_HOST="$PUBLIC_IPV4" \
      XMPPM_TEST_SSH_TARGET="$TARGET" \
      uv run pytest tests/test_live_ejabberd_hardening.py -q \
      -k "test_plain_xmpp_registration_without_invite_token_is_rejected or test_xmpp_registration_with_invite_token_is_accepted"
  )
}

backup_ssl_certs() {
  if [[ "$SKIP_SSL_BACKUP" == "1" ]]; then
    echo "ssl backup skipped"
    return
  fi

  mkdir -p "$SSL_BACKUP_DIR"
  chmod 700 "$SSL_BACKUP_DIR"

  local target_name timestamp output
  target_name=${TARGET#*@}
  target_name=${target_name//[^A-Za-z0-9_.-]/_}
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  output="$SSL_BACKUP_DIR/ssl-vps-$target_name-$timestamp.tar.gz"

  echo "backing up SSL certs to $output"
  ssh "$TARGET" 'sudo tar --ignore-failed-read --warning=no-file-changed -czf - \
    /etc/ssl/certs/ejabberd \
    /etc/ssl/private/ejabberd \
    /var/lib/docker/volumes/xmppm-gateway_traefik_letsencrypt/_data/acme.json \
    2>/tmp/xmppm-ssl-backup-tar.err; rc=$?; cat /tmp/xmppm-ssl-backup-tar.err >&2; exit $rc' >"$output"
  chmod 600 "$output"
  sha256sum "$output"
}

cd "$ROOT"

if [[ "$ONLY" == "all" || "$ONLY" == "worker" ]]; then
  ops/fetch-converse.sh
  bun test
  bun run typecheck
  bunx wrangler d1 migrations apply xmppm_invites --remote
  if [[ $RESET -eq 1 ]]; then
    bunx wrangler d1 execute xmppm_invites --remote --command \
      "DELETE FROM invite_audit; DELETE FROM invite_requests; DELETE FROM rate_limits;"
  fi
  bunx wrangler deploy
fi

if [[ "$ONLY" == "worker" ]]; then
  echo "deploy worker ok"
  exit 0
fi

if [[ "$ONLY" == "all" || "$ONLY" == "vps" ]]; then
  if [[ -z "$PUBLIC_IPV6" ]]; then
    PUBLIC_IPV6=$(ssh "$TARGET" "ip -6 -o addr show scope global | awk '{print \$4}' | cut -d/ -f1 | head -1" || true)
  fi
  backup_ssl_certs
fi

ssh "$TARGET" bash -s -- "$REMOTE_RELEASE" <<'REMOTE_PREPARE'
set -euo pipefail
mkdir -p "$1"
REMOTE_PREPARE
rsync_args=(
  -az --relative
  --exclude '.git'
  --exclude 'node_modules'
  --exclude '.wrangler'
  --exclude '.env'
  --exclude '.env.*'
  --exclude '.dev.vars'
  --exclude '*.pem'
  --exclude 'apps/agent/.venv'
  --exclude 'apps/agent/.pytest_cache'
  --exclude 'apps/agent/*.egg-info'
)
case "$ONLY" in
  all | vps)
    rsync_args+=(--delete ./)
    ;;
  agent)
    rsync_args+=(apps/agent/ ops/sudoers.d/xmppm-agent ops/systemd/xmppm-agent.service)
    ;;
  proxy)
    rsync_args+=(
      ops/vps/xmppm-nginx.conf
      ops/vps/gateway-docker-compose.yml
      ops/vps/xmppm-ejabberd-cert-sync
      ops/systemd/xmppm-ejabberd-cert-sync.service
      ops/systemd/xmppm-ejabberd-cert-sync.timer
    )
    ;;
esac
rsync "${rsync_args[@]}" "$TARGET:$REMOTE_RELEASE/"

printf -v remote_command 'bash -s -- %q %q %q %q %q %q' \
  "$ONLY" "$RESET" "$PUBLIC_IPV4" "$PUBLIC_IPV6" "$REMOTE_RELEASE" "$REMOTE_GATEWAY_DIR"
# Expansion is intentional: printf %q shell-quotes every remote argument.
# shellcheck disable=SC2029
ssh "$TARGET" "$remote_command" <<'REMOTE'
set -euo pipefail

ONLY=$1
RESET=$2
PUBLIC_IPV4=$3
PUBLIC_IPV6=$4
REMOTE_RELEASE=$5
REMOTE_GATEWAY_DIR=$6
cd "$REMOTE_RELEASE"

deploy_vps() {
packages=(postgresql postgresql-client imagemagick erlang-base python3-venv ufw)
if ! command -v docker >/dev/null; then
  packages+=(docker.io)
fi
missing_packages=()
for package in "${packages[@]}"; do
  dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -qx 'installed' || missing_packages+=("$package")
done
if ((${#missing_packages[@]})); then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}" >/tmp/xmppm-apt.log
fi
sudo systemctl enable --now docker
sudo ufw allow 5223/tcp comment 'xmppm XEP-0368 c2s direct TLS' >/dev/null || true
sudo ufw allow 5270/tcp comment 'xmppm XEP-0368 s2s direct TLS' >/dev/null || true
sudo ufw allow 5349/tcp comment 'xmppm STUN/TURN TLS' >/dev/null || true
sudo ufw delete allow 5280/tcp >/dev/null || true
sudo ufw delete allow 5281/tcp >/dev/null || true
sudo ufw delete allow 5443/tcp >/dev/null || true
sudo systemctl enable --now postgresql

DBPASS=$(openssl rand -base64 32 | tr -d '=/+' | cut -c1-32)
if [[ "$RESET" == "1" ]]; then
  sudo systemctl stop xmppm-agent || true
  sudo systemctl stop ejabberd || true
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DROP DATABASE IF EXISTS ejabberd;
DROP ROLE IF EXISTS ejabberd;
CREATE ROLE ejabberd LOGIN PASSWORD '$DBPASS';
CREATE DATABASE ejabberd OWNER ejabberd;
SQL
  sudo rm -rf /opt/ejabberd/database/ejabberd@localhost /opt/ejabberd/upload /opt/ejabberd/uploads
  sudo find /opt/ejabberd/logs -type f -name '*.log' -exec truncate -s 0 {} + 2>/dev/null || true
else
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ejabberd') THEN
    CREATE ROLE ejabberd LOGIN PASSWORD '$DBPASS';
  ELSE
    ALTER ROLE ejabberd WITH PASSWORD '$DBPASS';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ejabberd OWNER ejabberd'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ejabberd')\gexec
SQL
fi

sudo mkdir -p /usr/local/etc/ejabberd
if [[ ! -s /usr/local/etc/ejabberd/dh2048.pem ]]; then
  sudo openssl dhparam -out /usr/local/etc/ejabberd/dh2048.pem 2048
fi
sudo chown root:ejabberd /usr/local/etc/ejabberd/dh2048.pem
sudo chmod 0640 /usr/local/etc/ejabberd/dh2048.pem
sudo install -d -o ejabberd -g ejabberd -m 0750 /opt/ejabberd/upload

sudo install -o root -g root -m 0755 ops/vps/xmppm-ejabberd-cert-sync /usr/local/sbin/xmppm-ejabberd-cert-sync
sudo install -o root -g root -m 0644 ops/systemd/xmppm-ejabberd-cert-sync.service /etc/systemd/system/xmppm-ejabberd-cert-sync.service
sudo install -o root -g root -m 0644 ops/systemd/xmppm-ejabberd-cert-sync.timer /etc/systemd/system/xmppm-ejabberd-cert-sync.timer
sudo install -o root -g root -m 0755 ops/vps/xmppm-backup /usr/local/sbin/xmppm-backup
sudo install -o root -g root -m 0644 ops/systemd/xmppm-backup.service /etc/systemd/system/xmppm-backup.service
sudo install -o root -g root -m 0644 ops/systemd/xmppm-backup.timer /etc/systemd/system/xmppm-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now xmppm-ejabberd-cert-sync.timer
sudo systemctl enable --now xmppm-backup.timer

TMP_EJABBERD=$(mktemp)
cp config/ejabberd.yml "$TMP_EJABBERD"
python3 - "$TMP_EJABBERD" "$PUBLIC_IPV4" "$PUBLIC_IPV6" "$DBPASS" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
ipv4, ipv6, dbpass = sys.argv[2:5]
s = path.read_text()
s = s.replace('VPS_IPV4_ADDRESS', ipv4)
if ipv6:
    s = s.replace('VPS_IPV6_ADDRESS', ipv6)
else:
    s = "\n".join(line for line in s.splitlines() if 'turn_ipv6_address: VPS_IPV6_ADDRESS' not in line) + "\n"
s = s.replace('/usr/local/lib/ejabberd-26.4/priv/bin/captcha.sh', '/opt/ejabberd-26.04/lib/captcha.sh')
s = s.replace('port: 3478', 'port: 5478')
s = s.replace('#sql_server: "localhost"', 'sql_server: "127.0.0.1"')
s = s.replace('#sql_database: "ejabberd"', 'sql_database: "ejabberd"')
s = s.replace('#sql_username: "ejabberd"', 'sql_username: "ejabberd"')
s = s.replace('sql_password: "PASSWORD"  ## xmp.pm: set this to your pgsql password', f'sql_password: "{dbpass}"')
s = s.replace('sql_password: "PASSWORD"', f'sql_password: "{dbpass}"')
path.write_text(s)
PY
sudo install -o ejabberd -g ejabberd -m 0640 "$TMP_EJABBERD" /opt/ejabberd/conf/ejabberd.yml
rm -f "$TMP_EJABBERD"

# ejabberd-contrib's mod_pubsub_serverinfo currently duplicates records
# already present in ejabberd 26.04's xmpp.hrl. Remove the stale include
# before compiling/installing the contrib module for XEP-0485.
sudo ejabberdctl modules_update_specs >/dev/null || true
PUBSUB_SERVERINFO_SRC="/opt/ejabberd/.ejabberd-modules/sources/ejabberd-contrib/mod_pubsub_serverinfo/src/mod_pubsub_serverinfo.erl"
if [[ -f "$PUBSUB_SERVERINFO_SRC" ]]; then
  sudo sed -i '/^-include("pubsub_serverinfo_codec.hrl")\./d' "$PUBSUB_SERVERINFO_SRC"
fi
if ! sudo ejabberdctl module_check mod_pubsub_serverinfo >/dev/null 2>&1; then
  sudo ejabberdctl module_install mod_pubsub_serverinfo >/tmp/xmppm-mod-pubsub-serverinfo.log 2>&1 || {
    cat /tmp/xmppm-mod-pubsub-serverinfo.log >&2
    exit 1
  }
fi

# ejabberd 26.04 mod_invites_register rejects x:data registration submits when
# captcha_protected is false; Conversations may submit x:data anyway. Patch it
# to accept username/password from x:data without CAPTCHA and avoid CAPTCHA
# error-path hook crashes. Remove when upstream includes an equivalent fix.
PATCH_SRC="$REMOTE_RELEASE/ops/patches/mod_invites_register.erl"
if [[ -f "$PATCH_SRC" ]]; then
  PATCH_WORK=$(mktemp -d)
  cp "$PATCH_SRC" "$PATCH_WORK/mod_invites_register.erl"
  cp /opt/ejabberd-26.04/lib/xmpp-*/include/xmpp.hrl "$PATCH_WORK/xmpp_abs.hrl"
  python3 - "$PATCH_WORK" <<'PY'
import glob
import sys
from pathlib import Path
work = Path(sys.argv[1])
fast_xml = glob.glob('/opt/ejabberd-26.04/lib/fast_xml-*/include/fxml.hrl')[0]
xmpp = work / 'xmpp_abs.hrl'
s = xmpp.read_text().replace('-include_lib("fast_xml/include/fxml.hrl").', f'-include("{fast_xml}").')
xmpp.write_text(s)
src = work / 'mod_invites_register.erl'
s = src.read_text().replace('-include_lib("xmpp/include/xmpp.hrl").', '-include("xmpp_abs.hrl").')
src.write_text(s)
PY
  erlc \
    -I "$PATCH_WORK" \
    -I /opt/ejabberd-26.04/lib/ejabberd-*/include \
    -I /opt/ejabberd-26.04/lib/xmpp-*/include \
    -I /opt/ejabberd-26.04/lib/fast_xml-*/include \
    -o "$PATCH_WORK" "$PATCH_WORK/mod_invites_register.erl"
  EJABBERD_EBIN=$(echo /opt/ejabberd-26.04/lib/ejabberd-*/ebin)
  if [[ ! -e "$EJABBERD_EBIN/mod_invites_register.beam.orig" ]]; then
    sudo cp "$EJABBERD_EBIN/mod_invites_register.beam" "$EJABBERD_EBIN/mod_invites_register.beam.orig"
  fi
  sudo install -o root -g root -m 0644 "$PATCH_WORK/mod_invites_register.beam" "$EJABBERD_EBIN/mod_invites_register.beam"
  rm -rf "$PATCH_WORK"
fi

sudo systemctl reset-failed ejabberd || true
sudo systemctl restart ejabberd
sudo ejabberdctl started
}

deploy_agent() {
cd "$REMOTE_RELEASE"
sudo install -o root -g root -m 0440 ops/sudoers.d/xmppm-agent /etc/sudoers.d/xmppm-agent
sudo visudo -cf /etc/sudoers.d/xmppm-agent

# Ensure agent state directory exists with secure permissions
sudo install -d -o xmppm-agent -g xmppm-agent -m 0750 /var/lib/xmppm-agent

# Generate RSA keypair if private key does not exist
if ! sudo test -f /var/lib/xmppm-agent/private_key.pem; then
  echo "generating agent RSA keypair..."
  sudo openssl genpkey -algorithm RSA -out /var/lib/xmppm-agent/private_key.pem -pkeyopt rsa_keygen_bits:2048
  sudo chown xmppm-agent:xmppm-agent /var/lib/xmppm-agent/private_key.pem
  sudo chmod 0600 /var/lib/xmppm-agent/private_key.pem
fi

# Always export the public key to the web directory for the browser to fetch
sudo mkdir -p /srv/www/xmp.pm
sudo openssl rsa -pubout -in /var/lib/xmppm-agent/private_key.pem -out /srv/www/xmp.pm/agent-pubkey.pem
sudo chown "$USER:$USER" /srv/www/xmp.pm/agent-pubkey.pem
sudo chmod 0644 /srv/www/xmp.pm/agent-pubkey.pem

sudo systemctl stop xmppm-agent || true
sudo install -d -o root -g root -m 0755 /opt/xmppm-agent/agent
sudo rsync -a --delete --exclude .venv apps/agent/ /opt/xmppm-agent/agent/
cd /opt/xmppm-agent/agent
if [[ ! -x .venv/bin/python ]]; then
  sudo python3 -m venv .venv
fi
pyproject_hash=$(sha256sum pyproject.toml | cut -d' ' -f1)
installed_hash=$(sudo cat .venv/.xmppm-pyproject-hash 2>/dev/null || true)
if [[ "$pyproject_hash" != "$installed_hash" ]]; then
  sudo .venv/bin/pip install -q --disable-pip-version-check -e .
  printf '%s\n' "$pyproject_hash" | sudo tee .venv/.xmppm-pyproject-hash >/dev/null
fi
sudo install -o root -g root -m 0644 "$REMOTE_RELEASE/ops/systemd/xmppm-agent.service" /etc/systemd/system/xmppm-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now xmppm-agent
}

deploy_proxy() {
sudo install -d -o "$USER" -g "$USER" -m 0755 "$REMOTE_GATEWAY_DIR"
cd "$REMOTE_GATEWAY_DIR"
cp "$REMOTE_RELEASE/ops/vps/xmppm-nginx.conf" ./xmppm-nginx.conf
cp "$REMOTE_RELEASE/ops/vps/gateway-docker-compose.yml" ./docker-compose.yml
sudo install -o root -g root -m 0755 "$REMOTE_RELEASE/ops/vps/xmppm-ejabberd-cert-sync" /usr/local/sbin/xmppm-ejabberd-cert-sync
sudo install -o root -g root -m 0644 "$REMOTE_RELEASE/ops/systemd/xmppm-ejabberd-cert-sync.service" /etc/systemd/system/xmppm-ejabberd-cert-sync.service
sudo install -o root -g root -m 0644 "$REMOTE_RELEASE/ops/systemd/xmppm-ejabberd-cert-sync.timer" /etc/systemd/system/xmppm-ejabberd-cert-sync.timer
sudo systemctl daemon-reload
sudo systemctl enable --now xmppm-ejabberd-cert-sync.timer
sudo ufw allow 80/tcp comment 'xmppm HTTPS gateway ACME' >/dev/null || true
sudo ufw allow 443/tcp comment 'xmppm HTTPS gateway' >/dev/null || true
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo docker compose up -d --remove-orphans
}

run_cert_sync_with_retry() {
  # Traefik obtains SAN certificates after Docker labels are applied. Give ACME a
  # short window before copying cert material into ejabberd.
  for attempt in 1 2 3 4 5 6; do
    if sudo systemctl start xmppm-ejabberd-cert-sync.service; then
      return 0
    fi
    echo "cert sync failed after Traefik label deploy; retry $attempt/6" >&2
    sleep 10
  done
  sudo journalctl -u xmppm-ejabberd-cert-sync -n 50 --no-pager >&2 || true
  return 1
}

case "$ONLY" in
  all | vps)
    deploy_vps
    deploy_agent
    deploy_proxy
    run_cert_sync_with_retry
    sudo docker compose --project-directory "$REMOTE_GATEWAY_DIR" ps
    systemctl is-active --quiet postgresql
    systemctl is-active --quiet ejabberd
    systemctl is-active --quiet xmppm-agent
    sudo ejabberdctl status
    sudo ejabberdctl registered_users xmp.pm || true
    ;;
  agent)
    deploy_agent
    systemctl is-active --quiet xmppm-agent
    ;;
  proxy)
    deploy_proxy
    run_cert_sync_with_retry
    sudo docker compose --project-directory "$REMOTE_GATEWAY_DIR" ps
    ;;
esac
REMOTE

case "$ONLY" in
  all | vps)
    curl -fsS https://xmp.pm/ >/dev/null
    curl -fsS https://xmp.pm/.well-known/host-meta >/dev/null
    curl -fsS https://xmp.pm/request >/dev/null
    ;;
esac

case "$ONLY" in
  all | vps)
    run_registration_hardening_smoke
    ;;
esac

echo "deploy $ONLY ok"
