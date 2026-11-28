"""读取已保存的原件，或在执行宿主核验许可后向来源取回。"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
from pathlib import Path
from typing import Any, Callable

from noticehub.storage.sqlite.raw_records import valid_id
from noticehub.storage.attachment_files import AttachmentError, AttachmentHTTPError, download, sanitize_name
from noticehub.receivers.qq.history_client import NapCatError

LOGGER = logging.getLogger(__name__)
_LOCKS = tuple(threading.Lock() for _ in range(32))


def _readable(path: Path) -> bool:
    if not path.is_absolute() or not path.is_file() or path.is_symlink():
        return False
    try:
        with path.open("rb"):
            return True
    except OSError:
        return False


def _source_url(row: sqlite3.Row, locator: dict, napcat_call: Callable | None) -> str:
    url = locator.get("url", "")
    if not napcat_call or not locator.get("file_id") or locator.get("kind") != "file":
        return url
    conversation = row["conversation_id"]
    if conversation.startswith("private:"):
        return url
    payload = {"group_id": conversation, "file_id": locator["file_id"]}
    busid = locator.get("busid")
    if busid:
        payload["busid"] = int(busid) if busid.isascii() and busid.isdecimal() else busid
    try:
        response = napcat_call("get_group_file_url", payload)
    except NapCatError:
        if url:
            return url
        raise
    return str((response.get("data") or {}).get("url") or url)


def _save_state(store: Any, raw_id: str, state: str, path: str | None = None) -> bool:
    with store._connect() as connection:
        saved = connection.execute(
            "UPDATE raw_records SET download_state=?,file_path=? WHERE raw_id=?",
            (state, path, raw_id),
        )
        return saved.rowcount == 1


def ask_download_file(
    store: Any, raw_id: str, *, authorized: bool, settings: Any, napcat_call: Callable | None,
) -> str | dict:
    if not valid_id(raw_id):
        return {"code": "INVALID_INPUT"}
    with _LOCKS[hash((store.path, raw_id)) % len(_LOCKS)]:
        try:
            with store._connect() as connection:
                row = connection.execute("SELECT * FROM raw_records WHERE raw_id=?", (raw_id,)).fetchone()
            if row is None:
                return {"code": "REF_NOT_FOUND"}
            if row["kind"] != "file":
                return {"code": "INVALID_INPUT"}
            if row["download_state"] == "DOWNLOADED" and row["file_path"] and _readable(Path(row["file_path"])):
                return row["file_path"]
            if row["download_state"] == "UNAVAILABLE":
                return {"code": "CONFLICT"}
            if authorized is not True:
                return {"code": "AUTHORIZATION_REQUIRED"}

            locator = json.loads(row["locator"] or "{}")
            url = _source_url(row, locator, napcat_call)
            if not url:
                _save_state(store, raw_id, "UNAVAILABLE")
                return {"code": "CONFLICT"}

            destination = (
                store.path.parent.resolve() / "downloads" / hashlib.sha256(raw_id.encode()).hexdigest()
                / sanitize_name(row["content"])
            )
            if not _readable(destination):
                try:
                    download(
                        url, destination, max(1, settings.attachment_max_mb) * 1024 * 1024,
                        timeout=max(20, settings.http_timeout * 2),
                    )
                except AttachmentHTTPError as error:
                    if error.status not in {404, 410}:
                        raise
                    _save_state(store, raw_id, "UNAVAILABLE")
                    return {"code": "CONFLICT"}
            if not _readable(destination):
                return {"code": "STORE_UNAVAILABLE"}
            if not _save_state(store, raw_id, "DOWNLOADED", str(destination)):
                destination.unlink(missing_ok=True)
                return {"code": "REF_NOT_FOUND"}
            return str(destination)
        except (AttachmentError, NapCatError, OSError, ValueError, sqlite3.Error) as error:
            LOGGER.warning("读取或下载消息原件失败（%s）", type(error).__name__)
            return {"code": "STORE_UNAVAILABLE"}
