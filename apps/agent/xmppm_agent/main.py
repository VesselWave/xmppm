from __future__ import annotations

import json
import logging
import secrets
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from xmppm_agent.config import Config
from xmppm_agent.http_client import WorkerClient
from xmppm_agent.invites import InviteError, change_account_password, create_account_setup
from xmppm_agent.monitoring import AlertState, alert_state_changes, run_checks, summarize_results
from xmppm_agent.smoke import SmokeConfig, run_smoke_check
from xmppm_agent.telegram import TelegramClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def generate_password() -> str:
    return secrets.token_urlsafe(24)


def password_change_from_url(setup_url: str | None) -> tuple[str, str] | None:
    if setup_url is None:
        return None
    url = urlparse(setup_url)
    if url.scheme != "account" or url.netloc != "password-change":
        return None
    query = parse_qs(url.query)
    username = query.get("username", [""])[0]
    password = query.get("password", [""])[0]
    if not username or not password:
        return None
    return username, password


def decrypt_password_if_encrypted(password: str, private_key_path: str) -> str:
    import base64
    import os
    import subprocess

    # Base64 RSA 2048 ciphertext is exactly 344 characters.
    if len(password) > 200 and os.path.exists(private_key_path):
        try:
            ciphertext_bytes = base64.b64decode(password)
            cmd = [
                "openssl",
                "pkeyutl",
                "-decrypt",
                "-inkey",
                private_key_path,
                "-pkeyopt",
                "rsa_padding_mode:oaep",
                "-pkeyopt",
                "rsa_oaep_md:sha256",
            ]
            result = subprocess.run(
                cmd,
                input=ciphertext_bytes,
                capture_output=True,
                check=True,
                timeout=10,
            )
            decrypted = result.stdout.decode("utf-8")
            if decrypted:
                return decrypted
        except Exception as exc:
            logger.exception("failed to decrypt password ciphertext")
            raise InviteError("Failed to decrypt password ciphertext") from exc
    return password


def get_public_key(private_key_path: str) -> str | None:
    import os
    import subprocess
    if not os.path.exists(private_key_path):
        return None
    try:
        cmd = ["openssl", "rsa", "-pubout", "-in", private_key_path]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        return result.stdout
    except Exception:
        logger.exception("failed to extract public key from %s", private_key_path)
        return None


@dataclass(frozen=True)
class SmokeAlertState:
    message_id: int
    failure_count: int
    first_failed_at: float


def load_smoke_alert_state(path: str) -> SmokeAlertState | None:
    state_path = Path(path)
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        logger.exception("failed to load smoke alert state from %s", path)
        return None
    message_id = data.get("message_id")
    failure_count = data.get("failure_count")
    first_failed_at = data.get("first_failed_at")
    if not isinstance(message_id, int) or not isinstance(failure_count, int):
        return None
    if not isinstance(first_failed_at, (int, float)):
        return None
    return SmokeAlertState(
        message_id=message_id,
        failure_count=failure_count,
        first_failed_at=float(first_failed_at),
    )


def save_smoke_alert_state(path: str, state: SmokeAlertState) -> None:
    state_path = Path(path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = state_path.with_suffix(state_path.suffix + ".tmp")
    tmp_path.write_text(
        json.dumps(
            {
                "message_id": state.message_id,
                "failure_count": state.failure_count,
                "first_failed_at": state.first_failed_at,
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    tmp_path.replace(state_path)


def clear_smoke_alert_state(path: str) -> None:
    with suppress(FileNotFoundError):
        Path(path).unlink()


def format_smoke_timestamp(timestamp: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(timestamp))


def format_smoke_alert_text(
    state: SmokeAlertState, latest_error: str, last_checked_at: float
) -> str:
    return "\n".join(
        [
            "xmp.pm ALERT: smoke",
            f"count: {state.failure_count}",
            f"first_failed_at: {format_smoke_timestamp(state.first_failed_at)}",
            f"last_checked_at: {format_smoke_timestamp(last_checked_at)}",
            f"latest_error: {latest_error}",
        ]
    )


def format_smoke_recovery_text(smoke_result: object) -> str:
    username = getattr(smoke_result, "username", "")
    suffix = f" - {username}" if username else ""
    return f"xmp.pm RECOVERY: smoke{suffix}"


def process_jobs(
    client: WorkerClient,
    invite_command: tuple[str, ...],
    private_key_path: str = "/var/lib/xmppm-agent/private_key.pem",
) -> None:
    public_key = get_public_key(private_key_path)
    try:
        jobs = client.get_jobs(public_key)
    except TypeError:
        jobs = client.get_jobs()

    for job in jobs:
        logger.info(
            "processing invite job %s for requested username %s",
            job.id,
            job.desired_username,
        )
        try:
            password_change = password_change_from_url(job.setup_url)
            if password_change:
                username, password = password_change
                password = decrypt_password_if_encrypted(password, private_key_path)
                invite_url = change_account_password(invite_command, username, password)
            else:
                invite_url = create_account_setup(
                    invite_command, job.desired_username, generate_password()
                )
            client.post_invite(job.id, invite_url)
        except (InviteError, RuntimeError, TimeoutError) as exc:
            logger.exception("invite job failed: %s", job.id)
            client.post_failure(job.id, str(exc))


def run_forever(config: Config) -> None:
    worker = WorkerClient(config.worker_base_url, config.agent_token)
    telegram = TelegramClient(config.telegram_bot_token, config.telegram_admin_chat_id)
    previous_states: dict[str, AlertState] = {}
    next_smoke_at: float | None = None
    smoke_alert_state = load_smoke_alert_state(config.smoke_state_path)

    while True:
        try:
            process_jobs(worker, config.invite_command, config.private_key_path)
            checks = run_checks()
            changes, previous_states = alert_state_changes(previous_states, checks)
            for changed in changes:
                prefix = "RECOVERY" if changed.ok else "ALERT"
                telegram.send_message(f"xmp.pm {prefix}: {changed.name} - {changed.detail}")
            logger.info("health\n%s", summarize_results(checks))

            if config.smoke_enabled:
                now = time.time()
                if next_smoke_at is None:
                    next_smoke_at = now + config.smoke_interval_seconds
                if now >= next_smoke_at:
                    smoke_config = SmokeConfig(
                        base_url=config.worker_base_url,
                        command=config.invite_command[:-2],
                        prefix=config.smoke_username_prefix,
                    )
                    try:
                        smoke_result = run_smoke_check(smoke_config)
                    except Exception as exc:
                        if smoke_alert_state is None:
                            smoke_alert_state = SmokeAlertState(
                                message_id=-1,
                                failure_count=1,
                                first_failed_at=now,
                            )
                            message_id = telegram.send_message(
                                format_smoke_alert_text(smoke_alert_state, str(exc), now)
                            )
                            if message_id is not None:
                                smoke_alert_state = SmokeAlertState(
                                    message_id=message_id,
                                    failure_count=smoke_alert_state.failure_count,
                                    first_failed_at=smoke_alert_state.first_failed_at,
                                )
                                save_smoke_alert_state(config.smoke_state_path, smoke_alert_state)
                            else:
                                smoke_alert_state = None
                        else:
                            updated_state = SmokeAlertState(
                                message_id=smoke_alert_state.message_id,
                                failure_count=smoke_alert_state.failure_count + 1,
                                first_failed_at=smoke_alert_state.first_failed_at,
                            )
                            save_smoke_alert_state(config.smoke_state_path, updated_state)
                            telegram.edit_message(
                                updated_state.message_id,
                                format_smoke_alert_text(updated_state, str(exc), now),
                            )
                            smoke_alert_state = updated_state
                    else:
                        if smoke_alert_state is not None:
                            telegram.edit_message(
                                smoke_alert_state.message_id,
                                format_smoke_recovery_text(smoke_result),
                            )
                            clear_smoke_alert_state(config.smoke_state_path)
                            smoke_alert_state = None
                    next_smoke_at = now + config.smoke_interval_seconds
        except Exception:
            logger.exception("agent loop failed")
        time.sleep(config.poll_seconds)


def main() -> None:
    run_forever(Config.from_env())


if __name__ == "__main__":
    main()
