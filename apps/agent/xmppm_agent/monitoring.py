from __future__ import annotations

import json
import os
import socket
import ssl
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str


@dataclass(frozen=True)
class AlertState:
    ok: bool
    failure_count: int = 0


def _recent_service_reason(unit: str, max_age_seconds: int = 300) -> str | None:
    marker = Path(f"/var/lib/xmppm-agent/{unit}-reason")
    try:
        if time.time() - marker.stat().st_mtime > max_age_seconds:
            return None
        return marker.read_text(encoding="utf-8").strip() or None
    except (FileNotFoundError, OSError):
        return None


def _systemd_failure_reason(unit: str) -> str | None:
    result = subprocess.run(
        [
            "systemctl",
            "show",
            unit,
            "--property=Result",
            "--property=ExecMainCode",
            "--property=ExecMainStatus",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    values = dict(
        line.split("=", 1) for line in result.stdout.splitlines() if "=" in line
    )
    service_result = values.get("Result", "")
    code = values.get("ExecMainCode", "")
    status = values.get("ExecMainStatus", "")
    if service_result and service_result != "success":
        exit_detail = f", {code} {status}" if code or status else ""
        return f"systemd result {service_result}{exit_detail}"
    return None


def check_systemd(unit: str) -> CheckResult:
    result = subprocess.run(
        ["systemctl", "is-active", unit], capture_output=True, text=True, check=False, timeout=10
    )
    status = result.stdout.strip() or result.stderr.strip()
    ok = result.returncode == 0 and status == "active"
    reason = _recent_service_reason(unit)
    if not ok and reason is None:
        reason = _systemd_failure_reason(unit)
    detail = f"{status}; reason: {reason}" if reason else status
    return CheckResult(unit, ok, detail)


def check_tcp(host: str, port: int, timeout: float = 5.0) -> CheckResult:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return CheckResult(f"tcp:{host}:{port}", True, "connected")
    except OSError as exc:
        return CheckResult(f"tcp:{host}:{port}", False, str(exc))


def check_disk(path: str = "/", max_percent: int = 85) -> CheckResult:
    stat = os.statvfs(path)
    total = stat.f_blocks * stat.f_frsize
    free = stat.f_bavail * stat.f_frsize
    used_percent = int(((total - free) / total) * 100) if total else 0
    return CheckResult("disk", used_percent < max_percent, f"{used_percent}% used")


def check_docker_container(name: str) -> CheckResult:
    result = subprocess.run(
        ["sudo", "-n", "/usr/bin/docker", "inspect", "-f", "{{json .State}}", name],
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    try:
        state = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        detail = result.stderr.strip() or result.stdout.strip() or "not found"
        return CheckResult(f"docker:{name}", False, detail[:240])

    ok = bool(state.get("Running"))
    if ok:
        detail = "running"
    else:
        parts = [str(state.get("Status") or "not running")]
        if state.get("OOMKilled"):
            parts.append("reason: OOM killed")
        elif state.get("Error"):
            parts.append(f"reason: {str(state['Error'])[:160]}")
        if state.get("ExitCode") is not None:
            parts.append(f"exit code: {state['ExitCode']}")
        detail = "; ".join(parts)
    return CheckResult(f"docker:{name}", ok, detail)


def check_cert_expiry(host: str, port: int = 443, min_days: int = 14) -> CheckResult:
    context = ssl.create_default_context()
    try:
        with (
            socket.create_connection((host, port), timeout=10) as sock,
            context.wrap_socket(sock, server_hostname=host) as tls,
        ):
            cert = tls.getpeercert()
        not_after = cert["notAfter"]
        expires = ssl.cert_time_to_seconds(not_after)
        days = int((expires - time.time()) / 86400)
        return CheckResult("cert", days >= min_days, f"{days} days left")
    except Exception as exc:
        return CheckResult("cert", False, str(exc))


def check_resource_headroom(
    meminfo: str | None = None,
    min_available_mib: int = 256,
    min_swap_free_mib: int = 256,
) -> CheckResult:
    if meminfo is None:
        meminfo = Path("/proc/meminfo").read_text(encoding="utf-8")
    values: dict[str, int] = {}
    for line in meminfo.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            values[parts[0].rstrip(":")] = int(parts[1])
    available_mib = values.get("MemAvailable", 0) // 1024
    swap_free_mib = values.get("SwapFree", 0) // 1024
    ok = available_mib >= min_available_mib and swap_free_mib >= min_swap_free_mib
    detail = f"{available_mib}MiB available, {swap_free_mib}MiB swap free"
    return CheckResult("resources", ok, detail)


def check_backup_freshness(
    marker: Path = Path("/var/lib/xmppm-agent/backup-ok"), max_age_hours: int = 30
) -> CheckResult:
    error_marker = marker.with_name("backup-error")
    try:
        error = error_marker.read_text(encoding="utf-8").strip()[:200]
    except (FileNotFoundError, OSError):
        error = ""
    try:
        age_hours = (time.time() - marker.stat().st_mtime) / 3600
        ok = age_hours <= max_age_hours
        detail = f"{age_hours:.1f}h old"
        if not ok and error:
            detail += f"; reason: {error}"
        return CheckResult("backup", ok, detail)
    except FileNotFoundError:
        detail = "marker missing"
        if error:
            detail += f"; reason: {error}"
        return CheckResult("backup", False, detail)


def run_checks() -> list[CheckResult]:
    return [
        check_systemd("ejabberd"),
        check_docker_container("xmppm-traefik"),
        check_docker_container("xmppm-worker-proxy"),
        check_tcp("127.0.0.1", 5222),
        check_tcp("127.0.0.1", 5269),
        check_tcp("172.17.0.1", 5443),
        check_disk(),
        check_resource_headroom(),
        check_backup_freshness(),
        check_cert_expiry("xmp.pm"),
    ]


def summarize_results(results: list[CheckResult]) -> str:
    lines = []
    for result in results:
        state = "OK" if result.ok else "FAIL"
        lines.append(f"{result.name}: {state} {result.detail}".strip())
    return "\n".join(lines)


def state_changes(previous: dict[str, bool], current: list[CheckResult]) -> list[CheckResult]:
    return [
        result
        for result in current
        if previous.get(result.name) is not None and previous[result.name] != result.ok
    ]


def _resource_mib_values(result: CheckResult) -> tuple[int, int]:
    parts = result.detail.split()
    available_mib = int(parts[0].removesuffix("MiB"))
    swap_free_mib = int(parts[2].removesuffix("MiB"))
    return available_mib, swap_free_mib


def _next_resource_alert_state(
    previous: AlertState | None,
    result: CheckResult,
    min_available_mib: int = 256,
    critical_available_mib: int = 192,
    recover_available_mib: int = 320,
    recover_swap_free_mib: int = 320,
    consecutive_failures: int = 3,
) -> AlertState:
    available_mib, swap_free_mib = _resource_mib_values(result)
    previous_ok = True if previous is None else previous.ok
    failure_count = 0 if previous is None else previous.failure_count

    if available_mib < critical_available_mib:
        return AlertState(False, failure_count + 1)
    if available_mib < min_available_mib:
        failure_count += 1
        return AlertState(failure_count < consecutive_failures and previous_ok, failure_count)
    if not previous_ok:
        recovered = (
            available_mib >= recover_available_mib and swap_free_mib >= recover_swap_free_mib
        )
        return AlertState(recovered, 0)
    return AlertState(True, 0)


def alert_state_changes(
    previous: dict[str, AlertState], current: list[CheckResult]
) -> tuple[list[CheckResult], dict[str, AlertState]]:
    changes: list[CheckResult] = []
    next_states: dict[str, AlertState] = {}
    for result in current:
        old = previous.get(result.name)
        if result.name == "resources":
            new = _next_resource_alert_state(old, result)
        else:
            new = AlertState(result.ok, 0 if result.ok else (old.failure_count + 1 if old else 1))
        next_states[result.name] = new
        if old is not None and old.ok != new.ok:
            changes.append(CheckResult(result.name, new.ok, result.detail))
        if old is None and not new.ok:
            changes.append(CheckResult(result.name, new.ok, result.detail))
    return changes, next_states
