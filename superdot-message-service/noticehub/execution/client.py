"""HTTP client for the SuperDot execution host."""

from __future__ import annotations

import http.client
import json
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

REQUEST_TIMEOUT = 5
RESPONSE_LIMIT = 8 * 1024 * 1024


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ExecutionHost:
    def __init__(self, base_url: str, token: str = "") -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.opener = build_opener(ProxyHandler({}), _NoRedirect())
        if self.base_url:
            parts = urlsplit(self.base_url)
            if (parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None
                    or parts.query or parts.fragment or parts.path):
                raise ValueError("NOTICEHUB_EXECUTION_URL 必须是执行宿主的 HTTP(S) 源地址")
            parts.port  # 验证配置中的端口格式与范围

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def request(self, path: str, payload: dict | None = None, *, extra_headers: dict[str, str] | None = None, method: str | None = None) -> tuple[int, dict]:
        if not self.configured:
            return 503, {"code": "EXECUTION_NOT_CONFIGURED"}
        headers = {"Accept": "application/json", **(extra_headers or {})}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            request = Request(self.base_url + path, data=data, headers=headers, method=method)
            try:
                response = self.opener.open(request, timeout=REQUEST_TIMEOUT)
            except HTTPError as error:
                if not 400 <= error.code <= 599:
                    error.close()
                    return 502, {"code": "INVALID_EXECUTION_RESPONSE"}
                response = error
            with response:
                raw = response.read(RESPONSE_LIMIT + 1)
                status = response.getcode()
        except (OSError, http.client.HTTPException):
            return 503, {"code": "EXECUTION_UNAVAILABLE"}
        try:
            body = json.loads(raw) if len(raw) <= RESPONSE_LIMIT else None
        except (ValueError, RecursionError):
            body = None
        if not isinstance(body, dict):
            return 502, {"code": "INVALID_EXECUTION_RESPONSE"}
        return status, body
