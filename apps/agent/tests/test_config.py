from xmppm_agent.config import Config


def test_config_from_env(monkeypatch):
    monkeypatch.setenv("XMPPM_WORKER_BASE_URL", "https://xmp.pm")
    monkeypatch.setenv("XMPPM_AGENT_TOKEN", "agent-token")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "bot-token")
    monkeypatch.setenv("TELEGRAM_ADMIN_CHAT_ID", "123")
    config = Config.from_env()
    assert config.worker_base_url == "https://xmp.pm"
    assert config.agent_token == "agent-token"
    assert config.telegram_admin_chat_id == "123"
    assert config.smoke_enabled is False
    assert config.smoke_interval_seconds == 3600
    assert config.smoke_username_prefix == "smoke"
    assert config.smoke_state_path == "/var/lib/xmppm-agent/smoke-state.json"


def test_default_invite_command_uses_deployed_ejabberdctl_path(monkeypatch):
    monkeypatch.setenv("XMPPM_WORKER_BASE_URL", "https://xmp.pm")
    monkeypatch.setenv("XMPPM_AGENT_TOKEN", "agent-token")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "bot-token")
    monkeypatch.setenv("TELEGRAM_ADMIN_CHAT_ID", "123")
    assert Config.from_env().invite_command[:5] == (
        "sudo",
        "-n",
        "-u",
        "ejabberd",
        "/usr/sbin/ejabberdctl",
    )


def test_config_from_env_overrides_smoke_settings(monkeypatch):
    monkeypatch.setenv("XMPPM_WORKER_BASE_URL", "https://xmp.pm")
    monkeypatch.setenv("XMPPM_AGENT_TOKEN", "agent-token")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "bot-token")
    monkeypatch.setenv("TELEGRAM_ADMIN_CHAT_ID", "123")
    monkeypatch.setenv("XMPPM_SMOKE_ENABLED", "yes")
    monkeypatch.setenv("XMPPM_SMOKE_INTERVAL_SECONDS", "900")
    monkeypatch.setenv("XMPPM_SMOKE_USERNAME_PREFIX", "nightly")
    monkeypatch.setenv("XMPPM_SMOKE_STATE_PATH", "/tmp/smoke-state.json")
    config = Config.from_env()
    assert config.smoke_enabled is True
    assert config.smoke_interval_seconds == 900
    assert config.smoke_username_prefix == "nightly"
    assert config.smoke_state_path == "/tmp/smoke-state.json"
