from __future__ import annotations

import io
from urllib import error, parse

import pytest

from xmppm_agent.smoke import SmokeConfig, delete_account, run_smoke_check


class FakeResponse:
    def __init__(self, body: str, code: int = 200, headers: dict[str, str] | None = None):
        self._body = body.encode("utf-8")
        self._code = code
        self.headers = headers or {}
        self.closed = False

    def read(self):
        return self._body

    def getcode(self):
        return self._code

    def geturl(self):
        return self.headers.get("Location", "")

    def close(self):
        self.closed = True


class FakeOpener:
    def __init__(self):
        self.calls: list[tuple[str, str, bytes | None]] = []
        self.status_hits = 0
        self.request_path = "https://xmp.pm/request"
        self.status_path = "https://xmp.pm/status/secret-123"
        self.password_path = "https://xmp.pm/status/secret-123/password"
        self.password_error = False
        self.password_body = b""

    def open(self, req, timeout=None):
        body = req.data
        method = req.get_method()
        url = req.full_url
        self.calls.append((method, url, body))

        if method == "POST" and url == self.request_path:
            headers = {"Location": "/status/secret-123"}
            raise error.HTTPError(url, 303, "See Other", headers, io.BytesIO(b""))

        if method == "GET" and url == self.status_path:
            self.status_hits += 1
            if self.status_hits == 1:
                return FakeResponse("<html><body>waiting</body></html>")
            html = (
                '<html><form action="/status/secret-123/password">'
                '<input name="password"></form></html>'
            )
            return FakeResponse(html)

        if method == "POST" and url == self.password_path:
            self.password_body = body or b""
            if self.password_error:
                raise RuntimeError("password submit failed")
            return FakeResponse("ok")

        raise AssertionError(f"unexpected request: {method} {url}")


class Completed:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_run_smoke_check_success_flow(monkeypatch):
    opener = FakeOpener()
    command_calls: list[tuple[str, ...]] = []
    sleeps: list[float] = []
    token_values = iter(["cafe", "deadbeef"])

    def fake_run_cmd(argv, capture_output, text, timeout, check):
        command_calls.append(argv)
        return Completed()

    def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr("xmppm_agent.smoke.secrets.token_hex", lambda size: next(token_values))

    result = run_smoke_check(
        SmokeConfig(base_url="https://xmp.pm", command=("ejabberdctl",), prefix="smoke"),
        opener=opener,
        run_cmd=fake_run_cmd,
        sleep=fake_sleep,
        now=lambda: 1700000000.9,
    )

    assert result.username == "smoke-1700000000-cafe"
    assert result.status_url == "https://xmp.pm/status/secret-123"
    assert result.password_url == "https://xmp.pm/status/secret-123/password"
    assert command_calls == [
        ("ejabberdctl", "check_account", "smoke-1700000000-cafe", "xmp.pm"),
        ("ejabberdctl", "unregister", "smoke-1700000000-cafe", "xmp.pm"),
    ]
    assert sleeps == [1.0]

    first_method, first_url, first_body = opener.calls[0]
    assert (first_method, first_url) == ("POST", "https://xmp.pm/request")
    first_fields = parse.parse_qs(first_body.decode("utf-8"))
    assert first_fields == {
        "username": ["smoke-1700000000-cafe"],
        "message": ["smoke check"],
        "aup": ["yes"],
    }

    password_fields = parse.parse_qs(opener.password_body.decode("utf-8"))
    assert set(password_fields) == {"password"}
    assert password_fields["password"][0] == result.password


def test_delete_account_refuses_non_smoke_names():
    calls: list[tuple[str, ...]] = []

    def fake_run_cmd(argv, capture_output, text, timeout, check):
        calls.append(argv)
        return Completed()

    with pytest.raises(ValueError):
        delete_account(("ejabberdctl",), "alice", "smoke", run_cmd=fake_run_cmd)

    assert calls == []


def test_run_smoke_check_cleans_up_after_password_post_failure(monkeypatch):
    opener = FakeOpener()
    opener.password_error = True
    command_calls: list[tuple[str, ...]] = []
    token_values = iter(["cafe", "deadbeef"])

    def fake_run_cmd(argv, capture_output, text, timeout, check):
        command_calls.append(argv)
        return Completed()

    monkeypatch.setattr("xmppm_agent.smoke.secrets.token_hex", lambda size: next(token_values))

    with pytest.raises(RuntimeError, match="password submit failed"):
        run_smoke_check(
            SmokeConfig(base_url="https://xmp.pm", command=("ejabberdctl",), prefix="smoke"),
            opener=opener,
            run_cmd=fake_run_cmd,
            sleep=lambda _: None,
            now=lambda: 1700000000.9,
        )

    assert command_calls == [
        ("ejabberdctl", "unregister", "smoke-1700000000-cafe", "xmp.pm"),
    ]
