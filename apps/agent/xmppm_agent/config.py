from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    worker_base_url: str
    agent_token: str
    telegram_bot_token: str
    telegram_admin_chat_id: str
    poll_seconds: int = 30
    private_key_path: str = "/var/lib/xmppm-agent/private_key.pem"
    invite_command: tuple[str, ...] = (
        "sudo",
        "-n",
        "-u",
        "ejabberd",
        "/usr/sbin/ejabberdctl",
        "register",
        "xmp.pm",
    )
    smoke_enabled: bool = False
    smoke_interval_seconds: int = 3600
    smoke_username_prefix: str = "smoke"
    smoke_state_path: str = "/var/lib/xmppm-agent/smoke-state.json"

    @classmethod
    def from_env(cls) -> Config:
        return cls(
            worker_base_url=require_env("XMPPM_WORKER_BASE_URL").rstrip("/"),
            agent_token=require_env("XMPPM_AGENT_TOKEN"),
            telegram_bot_token=require_env("TELEGRAM_BOT_TOKEN"),
            telegram_admin_chat_id=require_env("TELEGRAM_ADMIN_CHAT_ID"),
            poll_seconds=int(os.environ.get("XMPPM_POLL_SECONDS", "30")),
            private_key_path=os.environ.get(
                "XMPPM_PRIVATE_KEY_PATH", "/var/lib/xmppm-agent/private_key.pem"
            ),
            smoke_enabled=_env_truthy("XMPPM_SMOKE_ENABLED"),
            smoke_interval_seconds=int(os.environ.get("XMPPM_SMOKE_INTERVAL_SECONDS", "3600")),
            smoke_username_prefix=os.environ.get("XMPPM_SMOKE_USERNAME_PREFIX", "smoke"),
            smoke_state_path=os.environ.get(
                "XMPPM_SMOKE_STATE_PATH", "/var/lib/xmppm-agent/smoke-state.json"
            ),
        )


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value
