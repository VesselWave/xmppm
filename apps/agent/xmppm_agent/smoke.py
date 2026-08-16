from __future__ import annotations

import secrets
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from urllib import error, parse, request


class SmokeError(RuntimeError):
    pass


@dataclass(frozen=True)
class SmokeConfig:
    base_url: str
    command: tuple[str, ...] = ("ejabberdctl",)
    prefix: str = "smoke"
    message: str = "smoke check"
    domain: str = "xmp.pm"
    poll_seconds: float = 1.0
    timeout_seconds: float = 30.0


@dataclass(frozen=True)
class SmokeResult:
    username: str
    request_url: str
    status_url: str
    password_url: str
    password: str
    account_checked: bool
    cleaned_up: bool


class _NoRedirectHandler(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open(opener: object, req: request.Request, timeout_seconds: float):
    return opener.open(req, timeout=timeout_seconds)


def _read_text(response: object) -> str:
    data = response.read()
    if isinstance(data, bytes):
        return data.decode("utf-8", "replace")
    return str(data)


def _response_location(response: object) -> str:
    headers = getattr(response, "headers", None)
    if headers is None:
        headers = getattr(response, "hdrs", None)
    if headers is None:
        raise SmokeError("smoke request did not return a redirect location")
    location = headers.get("Location") or headers.get("location")
    if not location:
        raise SmokeError("smoke request did not return a redirect location")
    return location


def _run_command(
    run_cmd: Callable[..., subprocess.CompletedProcess[str]] | None,
    argv: tuple[str, ...],
    timeout_seconds: float,
):
    runner = subprocess.run if run_cmd is None else run_cmd
    try:
        return runner(argv, capture_output=True, text=True, timeout=timeout_seconds, check=False)
    except OSError as exc:
        raise SmokeError(str(exc)) from exc


def account_exists(
    command: tuple[str, ...],
    username: str,
    *,
    run_cmd: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    timeout_seconds: float = 30.0,
    domain: str = "xmp.pm",
) -> bool:
    result = _run_command(run_cmd, (*command, "check_account", username, domain), timeout_seconds)
    return getattr(result, "returncode", 1) == 0


def delete_account(
    command: tuple[str, ...],
    username: str,
    prefix: str,
    *,
    run_cmd: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    timeout_seconds: float = 30.0,
    domain: str = "xmp.pm",
) -> None:
    if not username.startswith(f"{prefix}-"):
        raise ValueError("refusing to delete non-smoke account")

    result = _run_command(run_cmd, (*command, "unregister", username, domain), timeout_seconds)
    if getattr(result, "returncode", 1) != 0:
        stderr = (
            getattr(result, "stderr", "")
            or getattr(result, "stdout", "")
            or "unregister failed"
        )
        raise SmokeError(str(stderr).strip()[:500])


def _request_form(base_url: str, username: str, message: str) -> request.Request:
    data = parse.urlencode({"username": username, "message": message, "aup": "yes"}).encode(
        "utf-8"
    )
    return request.Request(
        parse.urljoin(base_url.rstrip("/") + "/", "request"),
        data=data,
        method="POST",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )


def _password_form_request(password_url: str, password: str) -> request.Request:
    data = parse.urlencode({"password": password}).encode("utf-8")
    return request.Request(
        password_url,
        data=data,
        method="POST",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )


def _status_html_to_password_url(status_url: str, html: str) -> str | None:
    marker = 'action="'
    index = html.find(marker)
    if index < 0:
        marker = "action='"
        index = html.find(marker)
        if index < 0:
            return None

    start = index + len(marker)
    end = html.find('"' if marker.endswith('"') else "'", start)
    if end < 0:
        return None
    action = html[start:end]
    if "/status/" not in action or not action.endswith("/password"):
        return None
    return parse.urljoin(status_url, action)


def run_smoke_check(
    config: SmokeConfig,
    *,
    opener: object | None = None,
    run_cmd: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.time,
) -> SmokeResult:
    http = opener or request.build_opener(_NoRedirectHandler())
    username = f"{config.prefix}-{int(now())}-{secrets.token_hex(2)}"
    request_url = parse.urljoin(config.base_url.rstrip("/") + "/", "request")
    password = secrets.token_hex(8)
    status_url = ""
    password_url = ""
    result: SmokeResult | None = None
    primary_exc: BaseException | None = None

    try:
        try:
            request_resp = _open(
                http,
                _request_form(config.base_url, username, config.message),
                config.timeout_seconds,
            )
        except error.HTTPError as exc:
            if exc.code != 303:
                raise
            request_resp = exc

        try:
            status_location = _response_location(request_resp)
        except SmokeError:
            status_location = request_resp.geturl() if hasattr(request_resp, "geturl") else ""
        finally:
            close = getattr(request_resp, "close", None)
            if close is not None:
                close()

        if not status_location:
            raise SmokeError("smoke request did not return a status URL")

        status_url = parse.urljoin(request_url, status_location)
        started = now()
        while True:
            status_resp = _open(http, request.Request(status_url), config.timeout_seconds)
            try:
                html = _read_text(status_resp)
            finally:
                close = getattr(status_resp, "close", None)
                if close is not None:
                    close()

            password_url = _status_html_to_password_url(status_url, html) or ""
            if password_url:
                break
            if now() - started >= config.timeout_seconds:
                raise SmokeError("smoke password form not found")
            sleep(config.poll_seconds)

        password_resp = _open(
            http,
            _password_form_request(password_url, password),
            config.timeout_seconds,
        )
        close = getattr(password_resp, "close", None)
        if close is not None:
            close()

        account_ok = account_exists(
            config.command,
            username,
            run_cmd=run_cmd,
            timeout_seconds=config.timeout_seconds,
            domain=config.domain,
        )
        if not account_ok:
            raise SmokeError("smoke account check failed")

        result = SmokeResult(
            username=username,
            request_url=request_url,
            status_url=status_url,
            password_url=password_url,
            password=password,
            account_checked=True,
            cleaned_up=False,
        )
    except BaseException as exc:
        primary_exc = exc
        raise
    finally:
        try:
            delete_account(
                config.command,
                username,
                config.prefix,
                run_cmd=run_cmd,
                timeout_seconds=config.timeout_seconds,
                domain=config.domain,
            )
        except Exception:
            if primary_exc is None:
                raise

    if result is None:
        raise AssertionError("smoke result missing")
    return replace(result, cleaned_up=True)
