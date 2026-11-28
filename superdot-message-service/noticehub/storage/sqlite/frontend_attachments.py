"""Store an uploaded file and publish its stable raw reference after commit."""

from __future__ import annotations

import base64
import binascii
import hashlib
import os
import sqlite3
import uuid
from pathlib import Path

from noticehub.storage.sqlite import raw_records

RESERVED_FILENAMES = {"CON", "PRN", "AUX", "NUL"} | {
    prefix + str(index) for prefix in ("COM", "LPT") for index in range(1, 10)
}
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_BODY_BYTES = ((MAX_ATTACHMENT_BYTES + 2) // 3) * 4 + 4096

SCHEMA = """
CREATE TABLE IF NOT EXISTS frontend_attachments (
    operation_id TEXT PRIMARY KEY,
    raw_id TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    digest TEXT NOT NULL
);
"""


def upload(connection: sqlite3.Connection, root: Path, request: dict, stamp: str) -> dict:
    operation_id = request.get("operation_id")
    filename = request.get("filename")
    encoded = request.get("content_base64")
    if (
        set(request) != {"operation_id", "filename", "content_base64"}
        or not isinstance(operation_id, str) or not operation_id.strip() or len(operation_id) > 256
        or not isinstance(filename, str) or not filename.strip() or filename in {".", ".."}
        or len(filename.encode("utf-8")) > 240 or filename.endswith((".", " "))
        or any(character in '<>:"/\\|?*' or ord(character) < 32 for character in filename)
        or filename.split(".", 1)[0].upper() in RESERVED_FILENAMES
        or not isinstance(encoded, str) or len(encoded) > MAX_UPLOAD_BODY_BYTES
    ):
        return {"code": "INVALID_INPUT"}
    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        return {"code": "INVALID_INPUT"}
    if len(content) > MAX_ATTACHMENT_BYTES:
        return {"code": "INVALID_INPUT"}

    raw_id = "upload-" + uuid.uuid5(uuid.NAMESPACE_URL, "superdot:upload:" + operation_id).hex
    digest = hashlib.sha256(content).hexdigest()
    connection.execute("BEGIN IMMEDIATE")
    saved = connection.execute(
        "SELECT raw_id,filename,digest FROM frontend_attachments WHERE operation_id=?", (operation_id,),
    ).fetchone()
    if saved and (saved["filename"], saved["digest"]) != (filename, digest):
        return {"code": "CONFLICT"}

    folder = root / raw_id
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / filename
    if not destination.is_file() or hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
        partial = folder / ".upload-part"
        if partial == destination:
            partial = folder / ".upload-part-tmp"
        try:
            with partial.open("wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            partial.replace(destination)
        finally:
            partial.unlink(missing_ok=True)
    if saved:
        return {"code": "REPLAYED", "ref": {"id": saved["raw_id"]}}
    raw_records.save_frontend_file(connection, raw_id, filename, stamp, str(destination))
    connection.execute(
        "INSERT INTO frontend_attachments VALUES (?,?,?,?)", (operation_id, raw_id, filename, digest),
    )
    return {"code": "OK", "ref": {"id": raw_id}}
