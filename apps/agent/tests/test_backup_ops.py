from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_backup_ops_files_install_daily_encrypted_verified_snapshots():
    backup_script = ROOT / "ops/vps/xmppm-backup"
    service = ROOT / "ops/systemd/xmppm-backup.service"
    timer = ROOT / "ops/systemd/xmppm-backup.timer"

    assert backup_script.exists()
    script = backup_script.read_text()
    assert "pg_dump" in script
    assert "openssl enc -aes-256-cbc -pbkdf2" in script
    assert "tar -tzf" in script
    assert "backup-ok" in script
    assert "backup-error" in script
    assert "record_error" in script

    assert service.exists()
    assert "ExecStart=/usr/local/sbin/xmppm-backup" in service.read_text()

    assert timer.exists()
    timer_text = timer.read_text()
    assert "OnCalendar=daily" in timer_text
    assert "Persistent=true" in timer_text

    deploy = (ROOT / "ops/deploy.sh").read_text()
    assert "ops/vps/xmppm-backup" in deploy
    assert "xmppm-backup.timer" in deploy
