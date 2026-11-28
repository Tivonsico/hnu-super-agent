"""SuperDot HTTP handlers for storage."""

from __future__ import annotations

import hmac

from noticehub.platform.timeutil import now_local


class RawRecordRoutes:
    def _route_post_raw_batch(self, path: str) -> None:
        def read_batch():
            payload = self._product_body()
            if set(payload) != {"raw_ids"}:
                raise ValueError("请输入原件 ID 列表")
            return self.store.read_raw_in_batch(payload["raw_ids"])

        self._product_response(read_batch, {"OK": 200, "INVALID_INPUT": 400})

    def _route_post_raw_attachment(self, path: str) -> None:
        from noticehub.storage.sqlite.frontend_attachments import MAX_UPLOAD_BODY_BYTES

        self._product_response(
            lambda: self.store.upload_raw_attachment(self._product_body(max_bytes=MAX_UPLOAD_BODY_BYTES), now_local()),
            {"OK": 201, "REPLAYED": 200, "INVALID_INPUT": 400, "CONFLICT": 409},
        )

    def _route_post_raw_download(self, path: str) -> None:
        from noticehub.storage.raw_downloads import ask_download_file
        from noticehub.receivers.qq.history_client import NapCatClient

        if not self._product_host_allowed():
            return
        settings = self.server.settings
        token = settings.execution_token
        authorization = str(self.headers.get("Authorization", ""))
        if not token or not hmac.compare_digest(authorization.encode(), ("Bearer " + token).encode()):
            self._json(403, {"code": "AUTHORIZATION_REQUIRED"})
            return
        try:
            payload = self._product_body()
        except ValueError:
            self._json(400, {"code": "INVALID_INPUT"})
            return
        if set(payload) - {"raw_id", "authorized"} or type(payload.get("authorized", False)) is not bool:
            self._json(400, {"code": "INVALID_INPUT"})
            return
        napcat = NapCatClient(
            settings.napcat_api_url, settings.napcat_api_token, settings.http_timeout,
            framework_mode=settings.napcat_mode == "framework",
        )
        result = ask_download_file(
            self.store, payload.get("raw_id"), authorized=payload.get("authorized", False),
            settings=settings, napcat_call=napcat.call,
        )
        if isinstance(result, str):
            self._json(200, {"code": "OK", "file_path": result})
            return
        status = {"INVALID_INPUT": 400, "AUTHORIZATION_REQUIRED": 403, "REF_NOT_FOUND": 404, "CONFLICT": 409}
        self._json(status.get(result["code"], 503), result)
