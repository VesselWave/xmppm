# Better Stack status page

The public Better Stack page is `xmppm.betteruptime.com`. It was created on
September 13, 2026, using the free tier. It is intentionally not linked from the
website or otherwise advertised yet.

## Displayed services

The page has one section, **Current status by service**, containing four
components with status history:

| Public component | Source | Purpose |
| --- | --- | --- |
| Website and invite service | `https://xmp.pm/` | Public website, discovery, and invite workflow |
| XMPP service | `https://xmpp.xmp.pm/healthz/xmpp` | Native XMPP and web gateway availability |
| File uploads | `https://xmpp.xmp.pm/healthz/upload` | HTTP upload service availability |
| Encrypted backups | Better Stack heartbeat | Daily encrypted backup completion |

The page uses the system color theme and the modern layout. Its contact link is
`mailto:vesselwave@protonmail.com`. There are no subscribers, announcements,
custom domains, or promotional links configured.

## Health probes

The gateway exposes separate probes so Better Stack tests the real backing
service instead of only checking nginx:

- `/healthz/xmpp` proxies to the ejabberd BOSH backend.
- `/healthz/upload` proxies to the ejabberd HTTP upload backend.

The probe locations translate expected application-level `400`, `401`, `403`,
`404`, and `405` responses to `200`. Connection and gateway failures, including
`502`, remain failures. The general `/healthz` endpoint continues to report only
gateway health.

`ops/deploy.sh --only proxy` reloads nginx after Compose applies the mounted
configuration. This is required because updating the mounted file alone does not
make a running nginx process reread it.

## Backup heartbeat

`xmppm-backup.service` reads the optional root-only
`/etc/xmppm-backup.env`. The production file contains the private
`XMPPM_BACKUP_HEARTBEAT_URL`; never copy its value into documentation, source
control, tickets, or logs.

The heartbeat expects one successful encrypted backup per day with a two-hour
grace period. `xmppm-backup` reports success only after encryption and archive
verification complete, and reports `/fail` from its error handler. After changing
the heartbeat resource, update the VPS environment file, preserve mode `0600`,
and run a real backup to establish the first successful event.

## September 13, 2026 production drill

A deliberate end-to-end outage drill verified that every displayed component
could fail and recover based on real production state:

1. The Cloudflare Worker was temporarily deployed with a `503` response for the
   website and invite surface.
2. `xmppm-worker-proxy` was stopped on the VPS, making the XMPP and upload probes
   fail against their real upstream path.
3. The backup timer was stopped and the Better Stack heartbeat failure endpoint
   was called.
4. The public status page was observed with all four components in downtime.
5. The Worker change was reverted and redeployed, the proxy was restarted, the
   backup timer was enabled, and a successful backup heartbeat was sent.
6. Production was checked directly: the website, XMPP probe, and upload probe all
   returned HTTP `200`; the backup timer was active and its service result was
   successful.
7. Better Stack was observed again with all four components operational.

The temporary `503` implementation was removed immediately after the failure was
confirmed and was never retained in source control.

## Clean public history

Deleting and recreating only the status page did not clear the availability data
because Better Stack history belongs to its monitor and heartbeat resources. To
start the published view clean, fresh monitors and a fresh backup heartbeat were
created, the VPS was updated to use the new private heartbeat URL, and a real
backup established its successful state. The page was then switched to those
fresh resources with status-history widgets enabled.

After the replacement, the public page was verified to show **All services are
online**, all four components as **Operational**, and `100% uptime` for every
component, with no red history ticks. The prior resources are not displayed on
the page.

## Verification

Check production independently before trusting the aggregate page:

```bash
curl -fsS https://xmp.pm/ >/dev/null
curl -fsS https://xmpp.xmp.pm/healthz/xmpp
curl -fsS https://xmpp.xmp.pm/healthz/upload
```

On the VPS, also verify the backup path:

```bash
sudo systemctl is-active xmppm-backup.timer
sudo systemctl show xmppm-backup.service -p Result --value
sudo systemctl start xmppm-backup.service
```

The setup remains within the Better Stack free tier. Before adding another paid
monitor type, subscriber feature, or custom domain, confirm that it is available
on the free plan.
