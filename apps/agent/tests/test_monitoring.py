import os
import time

from xmppm_agent import monitoring
from xmppm_agent.monitoring import (
    AlertState,
    CheckResult,
    alert_state_changes,
    check_backup_freshness,
    check_docker_container,
    check_resource_headroom,
    check_systemd,
    state_changes,
    summarize_results,
)


def test_summarize_results():
    results = [CheckResult("ejabberd", True, "ok"), CheckResult("disk", False, "91%")]
    text = summarize_results(results)
    assert "ejabberd: OK" in text
    assert "disk: FAIL 91%" in text


def test_state_changes_only_reports_changes():
    old = {"a": True, "b": False}
    new = [CheckResult("a", True, "ok"), CheckResult("b", True, "ok")]
    changes = state_changes(old, new)
    assert len(changes) == 1
    assert changes[0].name == "b"


def test_alert_state_changes_alerts_resources_after_three_low_readings():
    state: dict[str, AlertState] = {}
    changes, state = alert_state_changes(
        state, [CheckResult("resources", False, "255MiB available, 567MiB swap free")]
    )
    assert changes == []
    assert state["resources"] == AlertState(ok=True, failure_count=1)

    changes, state = alert_state_changes(
        state, [CheckResult("resources", False, "254MiB available, 567MiB swap free")]
    )
    assert changes == []
    assert state["resources"] == AlertState(ok=True, failure_count=2)

    changes, state = alert_state_changes(
        state, [CheckResult("resources", False, "253MiB available, 567MiB swap free")]
    )
    assert changes == [CheckResult("resources", False, "253MiB available, 567MiB swap free")]
    assert state["resources"] == AlertState(ok=False, failure_count=3)


def test_alert_state_changes_alerts_resources_immediately_below_critical_memory():
    changes, state = alert_state_changes(
        {}, [CheckResult("resources", False, "191MiB available, 567MiB swap free")]
    )

    assert changes == [CheckResult("resources", False, "191MiB available, 567MiB swap free")]
    assert state["resources"] == AlertState(ok=False, failure_count=1)


def test_alert_state_changes_keeps_resources_failed_until_recovery_headroom():
    state = {"resources": AlertState(ok=False, failure_count=3)}

    changes, state = alert_state_changes(
        state, [CheckResult("resources", True, "260MiB available, 567MiB swap free")]
    )
    assert changes == []
    assert state["resources"] == AlertState(ok=False, failure_count=0)

    changes, state = alert_state_changes(
        state, [CheckResult("resources", True, "320MiB available, 567MiB swap free")]
    )
    assert changes == [CheckResult("resources", True, "320MiB available, 567MiB swap free")]
    assert state["resources"] == AlertState(ok=True, failure_count=0)


def test_alert_state_changes_keeps_other_checks_as_edge_triggered():
    state = {"disk": AlertState(ok=True, failure_count=0)}
    changes, state = alert_state_changes(state, [CheckResult("disk", False, "91% used")])

    assert changes == [CheckResult("disk", False, "91% used")]
    assert state["disk"] == AlertState(ok=False, failure_count=1)


def test_systemd_check_includes_recent_reason(monkeypatch, tmp_path):
    class Result:
        returncode = 3
        stdout = "deactivating\n"
        stderr = ""

    monkeypatch.setattr(monitoring.subprocess, "run", lambda *args, **kwargs: Result())
    monkeypatch.setattr(
        monitoring, "_recent_service_reason", lambda unit: "scheduled TLS certificate update"
    )

    assert check_systemd("ejabberd") == CheckResult(
        "ejabberd", False, "deactivating; reason: scheduled TLS certificate update"
    )


def test_systemd_recovery_includes_recent_reason(monkeypatch):
    class Result:
        returncode = 0
        stdout = "active\n"
        stderr = ""

    monkeypatch.setattr(monitoring.subprocess, "run", lambda *args, **kwargs: Result())
    monkeypatch.setattr(
        monitoring, "_recent_service_reason", lambda unit: "scheduled TLS certificate update"
    )

    assert check_systemd("ejabberd") == CheckResult(
        "ejabberd", True, "active; reason: scheduled TLS certificate update"
    )


def test_systemd_check_reports_unplanned_failure_result(monkeypatch):
    class Result:
        returncode = 3
        stdout = "failed\n"
        stderr = ""

    monkeypatch.setattr(monitoring.subprocess, "run", lambda *args, **kwargs: Result())
    monkeypatch.setattr(monitoring, "_recent_service_reason", lambda unit: None)
    monkeypatch.setattr(
        monitoring,
        "_systemd_failure_reason",
        lambda unit: "systemd result exit-code, exited 1",
    )

    assert check_systemd("ejabberd") == CheckResult(
        "ejabberd", False, "failed; reason: systemd result exit-code, exited 1"
    )


def test_docker_container_check_uses_sudo_for_read_only_inspect(monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))

        class Result:
            returncode = 0
            stdout = '{"Status":"running","Running":true,"OOMKilled":false,"ExitCode":0}\n'
            stderr = ""

        return Result()

    monkeypatch.setattr(monitoring.subprocess, "run", fake_run)

    result = check_docker_container("xmppm-traefik")

    assert result == CheckResult("docker:xmppm-traefik", True, "running")
    assert calls == [
        (
            [
                "sudo",
                "-n",
                "/usr/bin/docker",
                "inspect",
                "-f",
                "{{json .State}}",
                "xmppm-traefik",
            ],
            {"capture_output": True, "text": True, "check": False, "timeout": 10},
        )
    ]


def test_docker_container_check_reports_oom_and_exit_code(monkeypatch):
    class Result:
        returncode = 0
        stdout = '{"Status":"exited","Running":false,"OOMKilled":true,"ExitCode":137}'
        stderr = ""

    monkeypatch.setattr(monitoring.subprocess, "run", lambda *args, **kwargs: Result())

    assert check_docker_container("xmppm-traefik") == CheckResult(
        "docker:xmppm-traefik", False, "exited; reason: OOM killed; exit code: 137"
    )


def test_resource_headroom_accepts_available_memory_and_swap():
    meminfo = """
MemTotal:         983040 kB
MemAvailable:    393216 kB
SwapTotal:       1048576 kB
SwapFree:        786432 kB
"""

    result = check_resource_headroom(meminfo, min_available_mib=256, min_swap_free_mib=256)

    assert result == CheckResult("resources", True, "384MiB available, 768MiB swap free")


def test_resource_headroom_alerts_on_low_memory_or_swap():
    meminfo = """
MemTotal:         983040 kB
MemAvailable:    131072 kB
SwapTotal:       1048576 kB
SwapFree:        65536 kB
"""

    result = check_resource_headroom(meminfo, min_available_mib=256, min_swap_free_mib=256)

    assert result == CheckResult("resources", False, "128MiB available, 64MiB swap free")


def test_backup_freshness_reports_missing_marker(tmp_path):
    result = check_backup_freshness(tmp_path / "missing")

    assert result == CheckResult("backup", False, "marker missing")


def test_backup_freshness_reports_recorded_failure_reason(tmp_path):
    marker = tmp_path / "backup-ok"
    error_marker = tmp_path / "backup-error"
    error_marker.write_text("exit 1 at line 42: pg_dump -Fc ejabberd")

    result = check_backup_freshness(marker)

    assert result == CheckResult(
        "backup", False, "marker missing; reason: exit 1 at line 42: pg_dump -Fc ejabberd"
    )


def test_backup_freshness_accepts_recent_marker(tmp_path):
    marker = tmp_path / "backup-ok"
    marker.touch()

    result = check_backup_freshness(marker, max_age_hours=30)

    assert result.name == "backup"
    assert result.ok is True


def test_backup_freshness_rejects_stale_marker(tmp_path):
    marker = tmp_path / "backup-ok"
    marker.touch()
    stale = time.time() - 31 * 3600
    os.utime(marker, (stale, stale))

    result = check_backup_freshness(marker, max_age_hours=30)

    assert result.name == "backup"
    assert result.ok is False


def test_run_checks_includes_resource_headroom(monkeypatch):
    def fake_check(name: str):
        return lambda *args, **kwargs: CheckResult(name, True, "ok")

    monkeypatch.setattr(monitoring, "check_systemd", fake_check("systemd"))
    monkeypatch.setattr(monitoring, "check_docker_container", fake_check("docker"))
    monkeypatch.setattr(monitoring, "check_tcp", fake_check("tcp"))
    monkeypatch.setattr(monitoring, "check_disk", fake_check("disk"))
    monkeypatch.setattr(monitoring, "check_cert_expiry", fake_check("cert"))
    monkeypatch.setattr(monitoring, "check_backup_freshness", fake_check("backup"))
    monkeypatch.setattr(monitoring, "check_resource_headroom", fake_check("resources"))

    results = monitoring.run_checks()

    assert any(result.name == "resources" for result in results)


def test_run_checks_includes_backup_freshness(monkeypatch):
    def fake_check(name: str):
        return lambda *args, **kwargs: CheckResult(name, True, "ok")

    monkeypatch.setattr(monitoring, "check_systemd", fake_check("systemd"))
    monkeypatch.setattr(monitoring, "check_docker_container", fake_check("docker"))
    monkeypatch.setattr(monitoring, "check_tcp", fake_check("tcp"))
    monkeypatch.setattr(monitoring, "check_disk", fake_check("disk"))
    monkeypatch.setattr(monitoring, "check_cert_expiry", fake_check("cert"))
    monkeypatch.setattr(monitoring, "check_backup_freshness", fake_check("backup"))

    results = monitoring.run_checks()

    assert any(result.name == "backup" for result in results)


def test_run_checks_probes_upload_on_private_gateway_bind(monkeypatch):
    tcp_checks = []

    def fake_tcp(host: str, port: int):
        tcp_checks.append((host, port))
        return CheckResult(f"tcp:{host}:{port}", True, "connected")

    monkeypatch.setattr(monitoring, "check_systemd", lambda unit: CheckResult(unit, True, "ok"))
    monkeypatch.setattr(
        monitoring,
        "check_docker_container",
        lambda name: CheckResult(f"docker:{name}", True, "running"),
    )
    monkeypatch.setattr(monitoring, "check_tcp", fake_tcp)
    monkeypatch.setattr(monitoring, "check_disk", lambda: CheckResult("disk", True, "ok"))
    monkeypatch.setattr(
        monitoring, "check_cert_expiry", lambda host: CheckResult("cert", True, "ok")
    )
    monkeypatch.setattr(
        monitoring, "check_backup_freshness", lambda: CheckResult("backup", True, "ok")
    )

    monitoring.run_checks()

    assert ("172.17.0.1", 5443) in tcp_checks
    assert ("127.0.0.1", 5443) not in tcp_checks
