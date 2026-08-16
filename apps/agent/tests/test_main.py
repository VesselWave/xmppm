from __future__ import annotations

import pytest

from xmppm_agent.config import Config
from xmppm_agent.http_client import InviteJob
from xmppm_agent.main import process_jobs, run_forever
from xmppm_agent.monitoring import CheckResult
from xmppm_agent.smoke import SmokeResult


def test_process_jobs_registers_exact_username_and_posts_password_form_url(monkeypatch):
    events = []
    account_calls = []

    class Client:
        def get_jobs(self):
            return [InviteJob("req1", "alice")]

        def post_invite(self, request_id, invite_url):
            events.append(("invite", request_id, invite_url))

        def post_failure(self, request_id, message):
            events.append(("failure", request_id, message))

    def fake_generate_password():
        return "pw-123"

    def fake_create_account_setup(argv, username, password):
        account_calls.append((argv, username, password))
        return "account://password-form?username=alice"

    monkeypatch.setattr("xmppm_agent.main.generate_password", fake_generate_password)
    monkeypatch.setattr("xmppm_agent.main.create_account_setup", fake_create_account_setup)
    process_jobs(Client(), ("sudo", "ejabberdctl", "register", "xmp.pm"))
    assert account_calls == [(("sudo", "ejabberdctl", "register", "xmp.pm"), "alice", "pw-123")]
    assert events == [("invite", "req1", "account://password-form?username=alice")]


def test_process_jobs_changes_queued_password(monkeypatch):
    events = []
    password_calls = []

    class Client:
        def get_jobs(self):
            return [
                InviteJob(
                    "req1",
                    "alice",
                    "account://password-change?username=alice&password=new-pass-1234",
                )
            ]

        def post_invite(self, request_id, invite_url):
            events.append(("invite", request_id, invite_url))

        def post_failure(self, request_id, message):
            events.append(("failure", request_id, message))

    def fake_change_account_password(argv, username, password):
        password_calls.append((argv, username, password))
        return "account://complete?username=alice"

    monkeypatch.setattr("xmppm_agent.main.change_account_password", fake_change_account_password)
    process_jobs(Client(), ("sudo", "ejabberdctl", "register", "xmp.pm"))
    assert password_calls == [
        (("sudo", "ejabberdctl", "register", "xmp.pm"), "alice", "new-pass-1234")
    ]
    assert events == [("invite", "req1", "account://complete?username=alice")]


def test_process_jobs_fails_closed_when_encrypted_password_cannot_decrypt(tmp_path, monkeypatch):
    events = []
    password_calls = []
    priv_key_path = str(tmp_path / "priv.pem")
    priv_key = """-----BEGIN PRIVATE KEY-----
MIIB
-----END PRIVATE KEY-----
"""
    (tmp_path / "priv.pem").write_text(priv_key)

    class Client:
        def get_jobs(self):
            return [
                InviteJob(
                    "req1",
                    "alice",
                    "account://password-change?username=alice&password=" + "A" * 344,
                )
            ]

        def post_invite(self, request_id, invite_url):
            events.append(("invite", request_id, invite_url))

        def post_failure(self, request_id, message):
            events.append(("failure", request_id, message))

    def fake_change_account_password(argv, username, password):
        password_calls.append((argv, username, password))
        return "account://complete?username=alice"

    monkeypatch.setattr("xmppm_agent.main.change_account_password", fake_change_account_password)
    process_jobs(
        Client(), ("sudo", "ejabberdctl", "register", "xmp.pm"), private_key_path=priv_key_path
    )
    assert password_calls == []
    assert events[0][0:2] == ("failure", "req1")
    assert "decrypt" in events[0][2].lower()


def test_process_jobs_decrypts_encrypted_password(tmp_path, monkeypatch):
    from urllib.parse import quote

    events = []
    password_calls = []

    priv_key_path = str(tmp_path / "priv.pem")
    pub_key_path = str(tmp_path / "pub.pem")
    import subprocess

    subprocess.run(
        [
            "openssl",
            "genpkey",
            "-algorithm",
            "RSA",
            "-out",
            priv_key_path,
            "-pkeyopt",
            "rsa_keygen_bits:2048",
        ],
        check=True,
    )
    subprocess.run(
        ["openssl", "rsa", "-pubout", "-in", priv_key_path, "-out", pub_key_path],
        check=True,
    )

    plaintext_pass = "super-secret-pass-999"
    enc_cmd = [
        "openssl",
        "pkeyutl",
        "-encrypt",
        "-pubin",
        "-inkey",
        pub_key_path,
        "-pkeyopt",
        "rsa_padding_mode:oaep",
        "-pkeyopt",
        "rsa_oaep_md:sha256",
    ]
    enc_res = subprocess.run(
        enc_cmd,
        input=plaintext_pass.encode(),
        capture_output=True,
        check=True,
    )
    import base64

    encrypted_pass_b64 = base64.b64encode(enc_res.stdout).decode()

    class Client:
        def get_jobs(self):
            return [
                InviteJob(
                    "req1",
                    "alice",
                    f"account://password-change?username=alice&password={quote(encrypted_pass_b64)}",
                )
            ]

        def post_invite(self, request_id, invite_url):
            events.append(("invite", request_id, invite_url))

        def post_failure(self, request_id, message):
            events.append(("failure", request_id, message))

    def fake_change_account_password(argv, username, password):
        password_calls.append((argv, username, password))
        return "account://complete?username=alice"

    monkeypatch.setattr("xmppm_agent.main.change_account_password", fake_change_account_password)
    process_jobs(
        Client(), ("sudo", "ejabberdctl", "register", "xmp.pm"), private_key_path=priv_key_path
    )
    assert password_calls == [
        (("sudo", "ejabberdctl", "register", "xmp.pm"), "alice", plaintext_pass)
    ]
    assert events == [("invite", "req1", "account://complete?username=alice")]


class _ExitAfterNSleeps:
    def __init__(self, limit: int):
        self.limit = limit
        self.calls = 0

    def __call__(self, seconds):
        self.calls += 1
        if self.calls >= self.limit:
            raise SystemExit


class _FakeWorkerClient:
    def __init__(self, *args, **kwargs):
        pass


class _FakeTelegramClient:
    def __init__(self, *args, **kwargs):
        self.sent: list[tuple[int, str]] = []
        self.edited: list[tuple[int, str]] = []
        self.next_message_id = 101

    def send_message(self, text: str) -> int:
        message_id = self.next_message_id
        self.next_message_id += 1
        self.sent.append((message_id, text))
        return message_id

    def edit_message(self, message_id: int, text: str) -> None:
        self.edited.append((message_id, text))


def test_run_forever_delays_resource_alert_until_policy_trips(monkeypatch):
    telegram = _FakeTelegramClient()
    checks = iter(
        [
            [CheckResult("resources", False, "255MiB available, 567MiB swap free")],
            [CheckResult("resources", False, "254MiB available, 567MiB swap free")],
            [CheckResult("resources", False, "253MiB available, 567MiB swap free")],
        ]
    )

    monkeypatch.setattr("xmppm_agent.main.WorkerClient", _FakeWorkerClient)
    monkeypatch.setattr("xmppm_agent.main.TelegramClient", lambda *args, **kwargs: telegram)
    monkeypatch.setattr("xmppm_agent.main.process_jobs", lambda *args, **kwargs: None)
    monkeypatch.setattr("xmppm_agent.main.run_checks", lambda: next(checks))
    monkeypatch.setattr("xmppm_agent.main.time.sleep", _ExitAfterNSleeps(3))

    config = Config(
        worker_base_url="https://xmp.pm",
        agent_token="token",
        telegram_bot_token="bot",
        telegram_admin_chat_id="123",
        smoke_enabled=False,
    )

    with pytest.raises(SystemExit):
        run_forever(config)

    assert telegram.sent == [(101, "xmp.pm ALERT: resources - 253MiB available, 567MiB swap free")]
    assert telegram.edited == []


def test_run_forever_skips_smoke_when_disabled(monkeypatch):
    telegram = _FakeTelegramClient()
    smoke_calls: list[object] = []

    monkeypatch.setattr("xmppm_agent.main.WorkerClient", _FakeWorkerClient)
    monkeypatch.setattr("xmppm_agent.main.TelegramClient", lambda *args, **kwargs: telegram)
    monkeypatch.setattr("xmppm_agent.main.process_jobs", lambda *args, **kwargs: None)
    monkeypatch.setattr("xmppm_agent.main.run_checks", lambda: [])
    monkeypatch.setattr(
        "xmppm_agent.main.run_smoke_check", lambda *args, **kwargs: smoke_calls.append(1)
    )
    monkeypatch.setattr("xmppm_agent.main.time.time", lambda: 100.0)
    monkeypatch.setattr("xmppm_agent.main.time.sleep", _ExitAfterNSleeps(1))

    config = Config(
        worker_base_url="https://xmp.pm",
        agent_token="token",
        telegram_bot_token="bot",
        telegram_admin_chat_id="123",
        smoke_enabled=False,
    )

    with pytest.raises(SystemExit):
        run_forever(config)

    assert smoke_calls == []
    assert telegram.sent == []
    assert telegram.edited == []


def test_run_forever_smoke_lifecycle_persists_and_reuses_message(monkeypatch, tmp_path):
    telegram = _FakeTelegramClient()
    smoke_calls = []
    state_path = tmp_path / "smoke-state.json"
    time_values = iter([100.0, 111.0, 122.0, 133.0, 144.0])
    outcomes = [
        RuntimeError("smoke failed-1"),
        RuntimeError("smoke failed-2"),
        SmokeResult(
            username="smoke-133-ok",
            request_url="https://xmp.pm/request",
            status_url="https://xmp.pm/status/ok",
            password_url="https://xmp.pm/status/ok/password",
            password="pw",
            account_checked=True,
            cleaned_up=True,
        ),
        RuntimeError("smoke failed-3"),
    ]

    def fake_run_smoke_check(smoke_config):
        smoke_calls.append(smoke_config)
        outcome = outcomes[len(smoke_calls) - 1]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr("xmppm_agent.main.WorkerClient", _FakeWorkerClient)
    monkeypatch.setattr("xmppm_agent.main.TelegramClient", lambda *args, **kwargs: telegram)
    monkeypatch.setattr("xmppm_agent.main.process_jobs", lambda *args, **kwargs: None)
    monkeypatch.setattr("xmppm_agent.main.run_checks", lambda: [])
    monkeypatch.setattr("xmppm_agent.main.run_smoke_check", fake_run_smoke_check)
    monkeypatch.setattr("xmppm_agent.main.time.time", lambda: next(time_values))
    monkeypatch.setattr("xmppm_agent.main.time.sleep", _ExitAfterNSleeps(5))

    config = Config(
        worker_base_url="https://xmp.pm",
        agent_token="token",
        telegram_bot_token="bot",
        telegram_admin_chat_id="123",
        smoke_enabled=True,
        smoke_interval_seconds=10,
        smoke_username_prefix="smoke",
        smoke_state_path=str(state_path),
    )

    with pytest.raises(SystemExit):
        run_forever(config)

    assert len(smoke_calls) == 4
    assert smoke_calls[0].command == (
        "sudo",
        "-n",
        "-u",
        "ejabberd",
        "/usr/sbin/ejabberdctl",
    )
    assert [call.prefix for call in smoke_calls] == ["smoke", "smoke", "smoke", "smoke"]
    assert len(telegram.sent) == 2
    assert telegram.sent[0][0] == 101
    assert "count: 1" in telegram.sent[0][1]
    assert "latest_error: smoke failed-1" in telegram.sent[0][1]
    assert telegram.sent[1][0] == 102
    assert "count: 1" in telegram.sent[1][1]
    assert "latest_error: smoke failed-3" in telegram.sent[1][1]
    assert len(telegram.edited) == 2
    assert telegram.edited[0][0] == 101
    assert "count: 2" in telegram.edited[0][1]
    assert "latest_error: smoke failed-2" in telegram.edited[0][1]
    assert telegram.edited[1][0] == 101
    assert "RECOVERY" in telegram.edited[1][1]
    assert state_path.exists()
    assert state_path.read_text() == '{"message_id":102,"failure_count":1,"first_failed_at":144.0}'
