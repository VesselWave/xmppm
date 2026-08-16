from __future__ import annotations

import json
from dataclasses import dataclass
from urllib import error, parse, request


@dataclass(frozen=True)
class InviteJob:
    id: str
    desired_username: str
    setup_url: str | None = None


class WorkerClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, object]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req_headers = {
            "authorization": f"Bearer {self.token}",
            "content-type": "application/json",
            "user-agent": "xmppm-agent/0.1",
        }
        if headers:
            req_headers.update(headers)
        req = request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers=req_headers,
        )
        try:
            with request.urlopen(req, timeout=20) as response:
                payload = response.read().decode("utf-8")
                return json.loads(payload) if payload else {}
        except error.HTTPError as exc:
            raise RuntimeError(f"Worker API HTTP {exc.code}: {exc.read().decode('utf-8')}") from exc

    def get_jobs(self, public_key: str | None = None) -> list[InviteJob]:
        headers = {}
        if public_key:
            headers["x-agent-public-key"] = parse.quote(public_key)
        payload = self._request("GET", "/agent/jobs", headers=headers)
        items = payload.get("jobs", [])
        if not isinstance(items, list):
            return []
        jobs: list[InviteJob] = []
        for item in items:
            if isinstance(item, dict):
                job_id = str(item.get("id", ""))
                username = str(item.get("desired_username", ""))
                setup_url = item.get("setup_url")
                if job_id and username:
                    jobs.append(
                        InviteJob(
                            id=job_id,
                            desired_username=username,
                            setup_url=str(setup_url) if setup_url is not None else None,
                        )
                    )
        return jobs

    def post_invite(self, request_id: str, invite_url: str) -> None:
        self._request("POST", f"/agent/jobs/{request_id}/invite", {"invite_url": invite_url})

    def post_failure(self, request_id: str, message: str) -> None:
        self._request("POST", f"/agent/jobs/{request_id}/fail", {"error": message[:500]})
