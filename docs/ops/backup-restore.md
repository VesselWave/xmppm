# Backup and restore

Daily backups are created by `xmppm-backup.timer` using `/usr/local/sbin/xmppm-backup`.

## Snapshot contents

- PostgreSQL `ejabberd` dump (`pg_dump -Fc`).
- ejabberd Mnesia state and upload directories when present.
- ejabberd config, DH params, agent env, and relevant systemd units.

Snapshots live in `/var/backups/xmppm/` as `xmppm-<host>-<utc>.tar.gz.enc` and are retained for 14 days. Encryption uses `openssl enc -aes-256-cbc -pbkdf2` with `/etc/xmppm-backup.key` (`0400 root:root`).

`/var/lib/xmppm-agent/backup-ok` is touched only after decrypt+tar-list integrity verification succeeds. The monitoring agent fails the `backup` check if this marker is older than 30h or missing.

## Manual backup

```bash
sudo systemctl start xmppm-backup.service
sudo systemctl status xmppm-backup.service --no-pager
sudo ls -lh /var/backups/xmppm/
sudo stat /var/lib/xmppm-agent/backup-ok
```

## Restore drill to a clean temp dir

```bash
SNAPSHOT=/var/backups/xmppm/xmppm-<host>-<utc>.tar.gz.enc
RESTORE_DIR=$(mktemp -d)
sudo openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass file:/etc/xmppm-backup.key \
  -in "$SNAPSHOT" \
  | sudo tar -xz -C "$RESTORE_DIR"

sudo pg_restore --list "$RESTORE_DIR/postgres/ejabberd.pgcustom" >/dev/null
sudo test -s "$RESTORE_DIR/MANIFEST.txt"
```

## Full restore outline

1. Stop writers: `sudo systemctl stop xmppm-agent ejabberd`.
2. Restore PostgreSQL: recreate `ejabberd` DB/role, then `sudo -u postgres pg_restore -d ejabberd <dump>`.
3. Restore files under `/opt/ejabberd`, `/usr/local/etc/ejabberd`, `/etc/xmppm-agent.env`, and systemd units from `files/`.
4. Fix ownership/perms: `/opt/ejabberd/*` as expected by ejabberd, `/etc/xmppm-agent.env` `0600 root:root`.
5. `sudo systemctl daemon-reload && sudo systemctl start ejabberd xmppm-agent`.
6. Verify: `sudo ejabberdctl status`, `sudo ejabberdctl registered_users xmp.pm`, `sudo systemctl is-active xmppm-agent`.
