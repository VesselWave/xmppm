from __future__ import annotations

import re
import subprocess
from urllib.parse import urlencode


class InviteError(RuntimeError):
    pass


def extract_invite_url(output: str) -> str:
    landing_page = re.search(r"(https://\S+/invites/\S+)", output)
    if landing_page:
        return landing_page.group(1).strip()

    uri = re.search(r"xmpp:xmp\.pm\?register;preauth=([^\s;&]+)", output)
    if uri:
        return f"https://xmp.pm/invites/{uri.group(1).strip()}"

    raise InviteError("Invite command output did not contain an invite URL/URI")


def account_password_form_url(username: str) -> str:
    return f"account://password-form?{urlencode({'username': username})}"


def account_password_change_url(username: str, password: str) -> str:
    return f"account://password-change?{urlencode({'username': username, 'password': password})}"


def account_complete_url(username: str) -> str:
    return f"account://complete?{urlencode({'username': username})}"


def account_ready_url(username: str, password: str) -> str:
    return account_password_change_url(username, password)


def create_account_setup(
    register_command: tuple[str, ...], username: str, password: str, timeout_seconds: int = 30
) -> str:
    argv = (*register_command[:-1], username, register_command[-1], password)
    run_account_command(argv, timeout_seconds)
    return account_password_form_url(username)


def change_account_password(
    register_command: tuple[str, ...], username: str, password: str, timeout_seconds: int = 30
) -> str:
    argv = (*register_command[:-2], "change_password", username, register_command[-1], password)
    run_account_command(argv, timeout_seconds)
    return account_complete_url(username)


def run_account_command(argv: tuple[str, ...], timeout_seconds: int = 30) -> None:
    result = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise InviteError(stderr[:500])


def run_invite_command(argv: tuple[str, ...], timeout_seconds: int = 30) -> str:
    result = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise InviteError(stderr[:500])
    return extract_invite_url(result.stdout.strip())
