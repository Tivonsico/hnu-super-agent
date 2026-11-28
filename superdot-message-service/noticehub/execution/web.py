"""同源工单和通知接口，按执行宿主契约转发。"""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path
from typing import BinaryIO
from urllib.parse import parse_qs, quote, unquote, urlsplit

TICKET_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")
OPERATIONS = {"supplement", "feedback", "stop", "resume", "recover", "merge", "confirm"}


def forward(execution, method: str, path: str, request_url: str, read_body) -> tuple[int, dict]:
    payload = None
    if method == "GET" and path == "/api/notifications":
        try:
            state = parse_qs(urlsplit(request_url).query, max_num_fields=8, keep_blank_values=True).get("state")
        except ValueError:
            return 400, {"code": "INVALID_INPUT"}
        if state is not None:
            if state not in (["pending"], ["handled"]):
                return 400, {"code": "INVALID_INPUT"}
            path += "?state=" + state[0]
    elif method == "GET" and path.startswith("/api/tickets/"):
        ticket_id = unquote(path.removeprefix("/api/tickets/"))
        if not TICKET_ID.fullmatch(ticket_id):
            return 400, {"code": "INVALID_INPUT"}
        path = "/api/tickets/" + ticket_id
    elif method == "POST":
        if path != "/api/tickets/actions":
            parts = path.split("/")
            if len(parts) != 5 or parts[-1] != "handle":
                return 404, {"code": "REF_NOT_FOUND"}
            notice_id = unquote(parts[3])
            if not notice_id.strip() or notice_id in {".", ".."} or "/" in notice_id or "\\" in notice_id:
                return 400, {"code": "INVALID_INPUT"}
            path = "/api/notifications/" + quote(notice_id, safe="") + "/handle"
        try:
            payload = read_body()
        except ValueError:
            return 400, {"code": "INVALID_INPUT"}
        if path == "/api/tickets/actions":
            operation = payload.get("operation")
            operation_id = payload.get("operation_id")
            if (not isinstance(operation, str) or operation not in OPERATIONS
                    or not isinstance(operation_id, str) or not operation_id.strip()):
                return 400, {"code": "INVALID_INPUT"}
    return execution.request(path, payload)


def open_artifact(
    execution, data_root: Path | None, path: str,
) -> tuple[int, dict | tuple[str, BinaryIO, int]]:
    if data_root is None:
        return 503, {"code": "ARTIFACTS_NOT_CONFIGURED"}
    parts = path.removeprefix("/api/artifacts/").split("/")
    if len(parts) != 2:
        return 400, {"code": "INVALID_INPUT"}
    ticket_id, filename = (unquote(part) for part in parts)
    if (not TICKET_ID.fullmatch(ticket_id) or not filename.strip() or filename in (".", "..")
            or filename.endswith((".", " ")) or any(char in '/\\:' or ord(char) < 32 for char in filename)):
        return 400, {"code": "INVALID_INPUT"}

    status, view = execution.request("/api/tickets/" + ticket_id)
    if status != 200 or view.get("code") != "OK":
        return (status, view) if status >= 400 else (502, {"code": "INVALID_EXECUTION_RESPONSE"})
    ticket = view.get("ticket")
    if not isinstance(ticket, dict) or ticket.get("ticket_id") != ticket_id or not isinstance(ticket.get("nodes"), list):
        return 502, {"code": "INVALID_EXECUTION_RESPONSE"}
    ref = {"kind": "artifact", "id": f"{ticket_id}/{filename}"}
    if not any(
        isinstance(node, dict) and node.get("kind") == "result"
        and isinstance(node.get("refs"), list) and ref in node["refs"]
        for node in ticket["nodes"]
    ):
        return 404, {"code": "REF_NOT_FOUND"}
    try:
        root = data_root.resolve(strict=True) / "artifacts"
        file_path = root / ticket_id / filename
        if file_path.resolve(strict=True) != file_path or not file_path.is_file():
            return 404, {"code": "REF_NOT_FOUND"}
        descriptor = os.open(file_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
                             | getattr(os, "O_BINARY", 0))
        file = os.fdopen(descriptor, "rb")
        try:
            st = os.fstat(file.fileno())
            if stat.S_ISREG(st.st_mode):
                return 200, (filename, file, st.st_size)
        except BaseException:
            file.close()
            raise
        file.close()
        return 404, {"code": "REF_NOT_FOUND"}
    except (FileNotFoundError, RuntimeError):
        return 404, {"code": "REF_NOT_FOUND"}
    except OSError:
        return 503, {"code": "STORE_UNAVAILABLE"}
