from __future__ import annotations

import json

from xmppm_agent.telegram import TelegramClient


class _FakeResponse:
    def __init__(self, body: str):
        self._body = body.encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def test_send_message_returns_message_id(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["data"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse('{"ok": true, "result": {"message_id": 77}}')

    monkeypatch.setattr("xmppm_agent.telegram.request.urlopen", fake_urlopen)

    client = TelegramClient("bot-token", "123")
    assert client.send_message("hello") == 77
    assert captured["url"].endswith("/sendMessage")
    assert captured["data"] == {"chat_id": "123", "text": "hello"}


def test_edit_message_posts_edit_message_text(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["data"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse('{"ok": true, "result": true}')

    monkeypatch.setattr("xmppm_agent.telegram.request.urlopen", fake_urlopen)

    client = TelegramClient("bot-token", "123")
    assert client.edit_message(77, "updated") is None
    assert captured["url"].endswith("/editMessageText")
    assert captured["data"] == {"chat_id": "123", "message_id": 77, "text": "updated"}
