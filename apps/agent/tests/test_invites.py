from xmppm_agent.invites import (
    account_password_change_url,
    account_password_form_url,
    extract_invite_url,
    run_invite_command,
)


def test_extract_invite_url_from_output():
    output = "Invite generated:\nhttps://xmp.pm/invites/abc123\n"
    assert extract_invite_url(output) == "https://xmp.pm/invites/abc123"


def test_extract_invite_prefers_landing_page_over_xmpp_uri():
    output = "xmpp:xmp.pm?register;preauth=abc123\thttps://xmp.pm/invites/abc123"
    assert extract_invite_url(output) == "https://xmp.pm/invites/abc123"


def test_extract_invite_uri_from_output():
    output = "xmpp:xmp.pm?register;preauth=abc123"
    assert extract_invite_url(output) == "https://xmp.pm/invites/abc123"


def test_account_setup_urls_encode_values():
    assert account_password_form_url("alice") == "account://password-form?username=alice"
    assert (
        account_password_change_url("alice", "p a/s?&")
        == "account://password-change?username=alice&password=p+a%2Fs%3F%26"
    )


def test_run_invite_command_uses_fixed_argv(monkeypatch):
    calls = []

    class Result:
        returncode = 0
        stdout = "https://xmp.pm/invites/abc123"
        stderr = ""

    def fake_run(argv, capture_output, text, timeout, check):
        calls.append(argv)
        return Result()

    monkeypatch.setattr("subprocess.run", fake_run)
    invite = run_invite_command(("sudo", "ejabberdctl", "generate_invite", "xmp.pm"))
    assert invite == "https://xmp.pm/invites/abc123"
    assert calls == [("sudo", "ejabberdctl", "generate_invite", "xmp.pm")]
