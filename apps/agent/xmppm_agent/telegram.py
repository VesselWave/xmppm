from __future__ import annotations

import json
from urllib import request


class TelegramClient:
    def __init__(self, bot_token: str, chat_id: str):
        self.bot_token = bot_token
        self.chat_id = chat_id

    def send_message(self, text: str) -> int | None:
        response = self._post(
            "sendMessage",
            {"chat_id": self.chat_id, "text": text},
        )
        return self._message_id_from_response(response)

    def edit_message(self, message_id: int, text: str) -> None:
        self._post(
            "editMessageText",
            {"chat_id": self.chat_id, "message_id": message_id, "text": text},
        )

    def _post(self, method_name: str, payload: dict[str, object]) -> dict[str, object]:
        data = json.dumps(payload).encode("utf-8")
        req = request.Request(
            f"https://api.telegram.org/bot{self.bot_token}/{method_name}",
            data=data,
            method="POST",
            headers={"content-type": "application/json"},
        )
        with request.urlopen(req, timeout=20) as response:
            body = response.read().decode("utf-8")
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {}

    @staticmethod
    def _message_id_from_response(response: dict[str, object]) -> int | None:
        if not response.get("ok"):
            return None
        result = response.get("result")
        if isinstance(result, dict):
            message_id = result.get("message_id")
            if isinstance(message_id, int):
                return message_id
        return None
