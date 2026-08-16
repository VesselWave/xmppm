import os
import re
import socket
import ssl
import subprocess
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from xml.sax.saxutils import escape

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
DEPLOY_SH = REPO_ROOT / "ops" / "deploy.sh"
DOMAIN = os.getenv("XMPPM_TEST_DOMAIN", "xmp.pm")
PORT = int(os.getenv("XMPPM_TEST_XMPP_PORT", "5222"))

pytestmark = pytest.mark.skipif(
    os.getenv("XMPPM_LIVE_EJABBERD") != "1",
    reason="set XMPPM_LIVE_EJABBERD=1 to run live ejabberd hardening tests",
)


def deploy_default(name: str) -> str:
    text = DEPLOY_SH.read_text()
    match = re.search(rf"^{name}=\${{{name}:-([^}}]+)}}", text, re.MULTILINE)
    if not match:
        raise AssertionError(f"{name} default not found in {DEPLOY_SH}")
    return match.group(1)


def live_host() -> str:
    return os.getenv("XMPPM_TEST_XMPP_HOST") or deploy_default("PUBLIC_IPV4")


def remote_target() -> str:
    return os.getenv("XMPPM_TEST_SSH_TARGET") or deploy_default("TARGET")


def extract_invite_token(output: str) -> str:
    xmpp_match = re.search(r"xmpp:[^\s<>]+", output)
    if xmpp_match:
        query = urlparse(xmpp_match.group(0)).query
        token = parse_qs(query).get("preauth", [""])[0]
        if token:
            return token

    url_match = re.search(r"https?://[^\s<>]+/invites/([^\s<>/?#]+)", output)
    if url_match:
        return url_match.group(1)

    raise AssertionError(f"invite token not found in output: {output!r}")


def generate_invite_token() -> str:
    existing_token = os.getenv("XMPPM_TEST_INVITE_TOKEN")
    if existing_token:
        return existing_token

    command_template = os.getenv("XMPPM_TEST_GENERATE_INVITE_COMMAND")
    if command_template:
        result = subprocess.run(
            command_template.format(domain=DOMAIN),
            shell=True,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    else:
        result = subprocess.run(
            ["ssh", remote_target(), "sudo", "ejabberdctl", "generate_invite", DOMAIN],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    return extract_invite_token(f"{result.stdout}\n{result.stderr}")


def generate_invite_token_for_username(username: str) -> str:
    result = subprocess.run(
        [
            "ssh",
            remote_target(),
            "sudo",
            "ejabberdctl",
            "generate_invite_with_username",
            username,
            DOMAIN,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return extract_invite_token(f"{result.stdout}\n{result.stderr}")


class XmppRegistrationClient:
    def __init__(self, host: str, domain: str, port: int) -> None:
        self.host = host
        self.domain = domain
        self.port = port
        self.sock: socket.socket | ssl.SSLSocket | None = None

    def __enter__(self) -> "XmppRegistrationClient":
        raw_sock = socket.create_connection((self.host, self.port), timeout=10)
        raw_sock.settimeout(10)
        self.sock = raw_sock
        self._open_stream()
        self._start_tls()
        self._open_stream()
        return self

    def __exit__(self, *_exc: object) -> None:
        if self.sock is not None:
            try:
                self._send("</stream:stream>")
            except OSError:
                pass
            finally:
                self.sock.close()

    def _send(self, data: str) -> None:
        assert self.sock is not None
        self.sock.sendall(data.encode())

    def _recv_until(self, needle: str) -> str:
        assert self.sock is not None
        chunks: list[str] = []
        deadline = time.monotonic() + 10
        while needle not in "".join(chunks):
            if time.monotonic() > deadline:
                raise TimeoutError(f"timed out waiting for {needle!r}; got {''.join(chunks)!r}")
            chunk = self.sock.recv(65536)
            if not chunk:
                received = "".join(chunks)
                raise ConnectionError(f"connection closed waiting for {needle!r}; got {received!r}")
            chunks.append(chunk.decode(errors="replace"))
        return "".join(chunks)

    def _open_stream(self) -> str:
        self._send(
            "<?xml version='1.0'?>"
            f"<stream:stream to='{self.domain}' version='1.0' "
            "xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>"
        )
        return self._recv_until("</stream:features>")

    def _start_tls(self) -> None:
        self._send("<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>")
        response = self._recv_until("<proceed")
        assert "urn:ietf:params:xml:ns:xmpp-tls" in response
        assert self.sock is not None
        context = ssl.create_default_context()
        self.sock = context.wrap_socket(self.sock, server_hostname=self.domain)
        self.sock.settimeout(10)

    def preauth(self, token: str, jid: str | None = None) -> str:
        iq_id = f"preauth-{uuid.uuid4().hex}"
        target = escape(jid or self.domain)
        self._send(
            f"<iq type='set' to='{target}' id='{iq_id}'>"
            f"<preauth xmlns='urn:xmpp:pars:0' token='{escape(token)}'/>"
            "</iq>"
        )
        return self._recv_until(iq_id)

    def register(self, username: str, password: str) -> str:
        iq_id = f"register-{uuid.uuid4().hex}"
        self._send(
            f"<iq type='set' id='{iq_id}'>"
            "<query xmlns='jabber:iq:register'>"
            f"<username>{escape(username)}</username>"
            f"<password>{escape(password)}</password>"
            "</query>"
            "</iq>"
        )
        return self._recv_until(iq_id)


def unique_username(prefix: str = "hardening") -> str:
    return f"{prefix}-{int(time.time())}-{uuid.uuid4().hex[:8]}"


def unregister_test_user(username: str) -> None:
    command_template = os.getenv("XMPPM_TEST_UNREGISTER_COMMAND")
    if command_template:
        subprocess.run(
            command_template.format(username=username, domain=DOMAIN),
            shell=True,
            check=False,
            timeout=30,
        )
        return

    subprocess.run(
        ["ssh", remote_target(), "sudo", "ejabberdctl", "unregister", username, DOMAIN],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )


def is_iq_result(response: str) -> bool:
    return "type='result'" in response or 'type="result"' in response


def is_iq_error(response: str) -> bool:
    return "type='error'" in response or 'type="error"' in response


def test_plain_xmpp_registration_without_invite_token_is_rejected() -> None:
    username = unique_username("noinvite")
    password = uuid.uuid4().hex
    with XmppRegistrationClient(live_host(), DOMAIN, PORT) as client:
        response = client.register(username, password)
    assert is_iq_error(response)
    assert not is_iq_result(response)


def test_random_bogus_invite_token_is_rejected() -> None:
    bogus_token = f"bogus-{uuid.uuid4().hex}"
    with XmppRegistrationClient(live_host(), DOMAIN, PORT) as client:
        response = client.preauth(bogus_token)
    assert is_iq_error(response)
    assert "item-not-found" in response
    assert not is_iq_result(response)


def test_xmpp_registration_with_invite_token_is_accepted() -> None:
    token = generate_invite_token()
    username = unique_username("invite")
    password = uuid.uuid4().hex
    try:
        with XmppRegistrationClient(live_host(), DOMAIN, PORT) as client:
            preauth_response = client.preauth(token)
            assert is_iq_result(preauth_response)
            register_response = client.register(username, password)
        assert is_iq_result(register_response)
        assert not is_iq_error(register_response)
    finally:
        unregister_test_user(username)


def test_invite_token_cannot_be_reused_after_successful_registration() -> None:
    token = generate_invite_token()
    username = unique_username("reuse")
    password = uuid.uuid4().hex
    try:
        with XmppRegistrationClient(live_host(), DOMAIN, PORT) as client:
            assert is_iq_result(client.preauth(token))
            assert is_iq_result(client.register(username, password))

        with XmppRegistrationClient(live_host(), DOMAIN, PORT) as client:
            reuse_response = client.preauth(token)
        assert is_iq_error(reuse_response)
        assert not is_iq_result(reuse_response)
    finally:
        unregister_test_user(username)


@pytest.mark.xfail(reason="ejabberd preselected invite username is not server-enforced")
def test_username_restricted_invite_only_registers_preselected_username() -> None:
    username = unique_username("restricted")
    wrong_username = unique_username("wrong")
    password = uuid.uuid4().hex
    token = generate_invite_token_for_username(username)
    try:
        with XmppRegistrationClient(live_host(), DOMAIN, PORT) as client:
            assert is_iq_result(client.preauth(token, f"{username}@{DOMAIN}"))
            wrong_response = client.register(wrong_username, password)
        assert is_iq_error(wrong_response)
        assert not is_iq_result(wrong_response)

        with XmppRegistrationClient(live_host(), DOMAIN, PORT) as client:
            assert is_iq_result(client.preauth(token, f"{username}@{DOMAIN}"))
            correct_response = client.register(username, password)
        assert is_iq_result(correct_response)
        assert not is_iq_error(correct_response)
    finally:
        unregister_test_user(wrong_username)
        unregister_test_user(username)
