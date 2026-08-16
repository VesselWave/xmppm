# VPS reverse-proxy source of truth

Active gateway path: `$TARGET:$REMOTE_GATEWAY_DIR/docker-compose.yml` + `xmppm-nginx.conf`.

`gateway-docker-compose.yml` runs Traefik + `xmppm-worker-proxy` on the same VPS as ejabberd:

- `Host(\`xmpp.xmp.pm\`)` -> `xmppm-worker-proxy:80`
- `/ws` -> local ejabberd WebSocket port `5280`
- `/bosh` -> local ejabberd BOSH port `5281`
- `/upload` -> local ejabberd upload port `5443`
- `/healthz` returns `ok`

`xmp.pm` public pages and invite/API routes are served by Cloudflare Worker Assets + Worker code.

## Firewall

The VPS firewall must allow public TCP `80` and `443` to Traefik, plus native XMPP/STUN ports: TCP `5222`, `5223`, `5269`, `5270`, `3478`, `5349`; UDP `3478`. Keep SSH restricted where possible.

## Update procedure

```bash
ops/deploy.sh --only proxy
curl -fsS https://xmpp.xmp.pm/healthz
just smoke
```

## Pinned image update procedure

Current pins:

- `traefik:v3.6`
- `nginx:1.30.3-alpine3.23-slim`

Update pins only during a gateway maintenance window:

```bash
ssh "$TARGET"
cd "${REMOTE_GATEWAY_DIR:-/srv/xmppm-gateway}"
cp docker-compose.yml docker-compose.yml.bak
cp xmppm-nginx.conf xmppm-nginx.conf.bak
docker compose config
docker compose pull
docker compose up -d
curl -fsS https://xmpp.xmp.pm/healthz
```

Then run `just smoke` from the repo. If any check fails, restore the `.bak` files and run `docker compose up -d`.
