"""SuperDot HTTP handlers for execution."""

from __future__ import annotations

import re
import logging
import shutil
import sqlite3
import urllib.parse


LOGGER = logging.getLogger(__name__)


class ExecutionRoutes:
    def _route_get_execution_status(self, path: str) -> None:
        try:
            queue = self.store.package_delivery_status()
        except sqlite3.Error:
            LOGGER.exception("读取消息包队列状态失败")
            queue = None
        self._json(200, {
            "configured": self.server.execution.configured,
            "artifacts_available": bool(self.server.execution.configured and self.server.execution_data_root),
            "queue": queue,
        })

    def _route_open_worker(self, path: str) -> None:
        if not self._product_host_allowed():
            return
        try:
            ticket_id = self._product_body().get("ticket_id")
            if not isinstance(ticket_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", ticket_id):
                raise ValueError
        except ValueError:
            self._json(400, {"code": "INVALID_INPUT"})
            return
        execution = self.server.execution
        status, data = execution.request("/api/tickets/" + ticket_id)
        if status != 200:
            self._json(status, data)
            return
        worker = next((ref["id"] for node in reversed(data["ticket"]["nodes"]) if node["kind"] == "session"
                       for ref in node["refs"] if ref.get("role") == "worker" and ref.get("kind") == "session"), None)
        if worker != "worker-" + ticket_id:
            self._json(404, {"code": "REF_NOT_FOUND"})
            return
        query = urllib.parse.urlencode({"id": worker})
        status, link = execution.request("/superdot-session/open?" + query, {})
        if status != 200 or not isinstance(link.get("fragment"), str):
            self._json(status if status >= 400 else 502, {"code": link.get("code", "DSH_UNAVAILABLE")})
            return
        url = execution.base_url + "/superdot-session?" + query + "#" + link["fragment"]
        self._json(200, {"code": "OK", "url": url})

    def _route_get_artifact(self, path: str) -> None:
        from noticehub.execution.web import open_artifact

        if not self._product_host_allowed():
            return
        status, result = open_artifact(self.server.execution, self.server.execution_data_root, path)
        if status != 200:
            self._json(status, result)
            return
        filename, file, size = result
        with file:
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(size))
                self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(filename))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                shutil.copyfileobj(file, self.wfile, 64 * 1024)
            except (ConnectionError, OSError):
                self.close_connection = True

    def _route_execution_proxy(self, path: str) -> None:
        from noticehub.execution.web import forward

        if not self._product_host_allowed():
            return
        status, result = forward(
            self.server.execution, self.command, path, self.path, self._product_body,
        )
        if status == 200 and self.command == "GET" and path.startswith("/api/tickets"):
            self._add_ticket_conversations(path, result)
        if status == 200 and self.command == "GET" and path == "/api/notifications":
            desktop_notice_id = self.server.desktop_pet.active_notice_id()
            if desktop_notice_id:
                result["desktop_notice_id"] = desktop_notice_id
        self._json(status, result)


    def _add_ticket_conversations(self, path: str, result: dict) -> None:
        entries = result.get("items") if path == "/api/tickets" else [result]
        if not isinstance(entries, list):
            return
        refs = []
        for entry in entries:
            ticket = entry.get("ticket") if isinstance(entry, dict) else None
            packages = ticket.get("package_refs") if isinstance(ticket, dict) else None
            if not isinstance(packages, list):
                continue
            ids = [ref["id"] for ref in packages
                   if isinstance(ref, dict) and isinstance(ref.get("id"), str)]
            if ids:
                refs.append((entry, ids))
        if not refs:
            return
        try:
            names = self.store.package_conversations([id_ for _, ids in refs for id_ in ids])
        except sqlite3.Error:
            LOGGER.warning("工单会话名称暂不可用", exc_info=True)
            return
        aliases = self.server.settings.group_aliases
        for entry, ids in refs:
            entry["available_package_ids"] = [id_ for id_ in ids if id_ in names]
            source = next((names[id_] for id_ in ids if id_ in names), None)
            if source:
                alias = aliases.get(source["id"]) if source["source"] == "qq" else None
                entry["source_conversation"] = {**source, "name": alias or source["name"]}
