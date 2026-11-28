"""消息层的持久化包队列。已接管的行保留回执，不再参与排队。"""

from __future__ import annotations


import json
import sqlite3
import uuid

from noticehub.storage.sqlite import raw_records

SCHEMA = """
CREATE TABLE IF NOT EXISTS package_delivery (
    sequence INTEGER PRIMARY KEY,
    package_id TEXT NOT NULL UNIQUE,
    enqueued_at TEXT NOT NULL,
    accepted_at TEXT,
    receipt_code TEXT CHECK(receipt_code IN ('OK','REPLAYED'))
);
CREATE INDEX IF NOT EXISTS idx_package_delivery_pending
    ON package_delivery(sequence) WHERE accepted_at IS NULL;
CREATE TABLE IF NOT EXISTS package_delivery_retry (
    package_id TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    last_attempt_at TEXT NOT NULL,
    last_error TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS frontend_packages (
    package_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    msg_id TEXT NOT NULL,
    text TEXT NOT NULL,
    attachment_refs TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def enqueue(connection: sqlite3.Connection, package_id: str, stamp: str) -> None:
    connection.execute(
        "INSERT INTO package_delivery (package_id,enqueued_at) VALUES (?,?)", (package_id, stamp),
    )


def next_pending(connection: sqlite3.Connection, stamp: str) -> str | None:
    row = connection.execute(
        """SELECT p.package_id
           FROM package_delivery p LEFT JOIN package_delivery_retry r USING (package_id)
           WHERE p.accepted_at IS NULL AND (
               r.package_id IS NULL OR CAST(strftime('%s', r.last_attempt_at) AS INTEGER)
               + min(300, 5 << min(r.attempts - 1, 6)) <= CAST(strftime('%s', ?) AS INTEGER)
           )
           ORDER BY coalesce(r.last_attempt_at, p.enqueued_at), p.sequence LIMIT 1""", (stamp,),
    ).fetchone()
    return row["package_id"] if row else None


def acknowledge(connection: sqlite3.Connection, package_id: str, receipt: dict, stamp: str) -> bool:
    ref = receipt.get("package_ref")
    code = receipt.get("code")
    if code not in ("OK", "REPLAYED") or not isinstance(ref, dict) or ref.get("id") != package_id:
        return False
    row = connection.execute(
        """UPDATE package_delivery SET accepted_at=?,receipt_code=?
        WHERE package_id=? AND accepted_at IS NULL""",
        (stamp, code, package_id),
    )
    if row.rowcount != 1:
        return False
    connection.execute("DELETE FROM package_delivery_retry WHERE package_id=?", (package_id,))
    return True


def record_failure(connection: sqlite3.Connection, package_id: str, error: str, stamp: str) -> None:
    connection.execute(
        """INSERT INTO package_delivery_retry(package_id, attempts, last_attempt_at, last_error)
        SELECT package_id, 1, ?, ? FROM package_delivery WHERE package_id=? AND accepted_at IS NULL
        ON CONFLICT(package_id) DO UPDATE SET attempts=attempts+1,
            last_attempt_at=excluded.last_attempt_at, last_error=excluded.last_error""",
        (stamp, error, package_id),
    )


def status(connection: sqlite3.Connection) -> dict:
    head = connection.execute(
        """SELECT p.package_id, p.enqueued_at, COALESCE(r.attempts, 0) AS attempts,
                  r.last_attempt_at, r.last_error
           FROM package_delivery AS p LEFT JOIN package_delivery_retry AS r USING(package_id)
           WHERE p.accepted_at IS NULL ORDER BY p.sequence LIMIT 1""",
    ).fetchone()
    row = connection.execute(
        """SELECT COUNT(*) FILTER (WHERE accepted_at IS NULL), MAX(accepted_at) FROM package_delivery""",
    ).fetchone()
    return {"pending_count": row[0], "head": dict(head) if head else None, "last_accepted_at": row[1]}


def submit_frontend(connection: sqlite3.Connection, request: dict, stamp: str) -> dict:
    operation_id = request.get("operation_id")
    text = request.get("text", "")
    refs = request.get("attachment_refs", [])
    if (
        request.get("kind") != "new_task"
        or not isinstance(operation_id, str) or not operation_id.strip() or len(operation_id) > 256
        or not isinstance(text, str) or not isinstance(refs, list) or len(refs) > 100
        or not all(isinstance(ref, dict) and set(ref) == {"id"}
                   and isinstance(ref["id"], str) and ref["id"].strip() for ref in refs)
        or not (text.strip() or refs)
        or set(request) - {"kind", "operation_id", "text", "attachment_refs"}
    ):
        return {"code": "INVALID_INPUT"}
    encoded_refs = json.dumps(refs, ensure_ascii=False)
    connection.execute("BEGIN IMMEDIATE")
    previous = connection.execute(
        "SELECT package_id,text,attachment_refs FROM frontend_packages WHERE operation_id=?", (operation_id,),
    ).fetchone()
    if previous:
        if (previous["text"], previous["attachment_refs"]) != (text, encoded_refs):
            return {"code": "CONFLICT"}
        return {"code": "REPLAYED", "package_ref": {"id": previous["package_id"]}}
    if refs:
        attachments = raw_records.read_raw_in_batch(connection, [ref["id"] for ref in refs])
        if attachments["code"] != "OK":
            return {"code": attachments["code"]}
        if attachments["missing_refs"]:
            return {"code": "REF_NOT_FOUND"}
        if any(record["type"] != "file" for record in attachments["records"]):
            return {"code": "INVALID_INPUT"}
    package_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "superdot:frontend-package:" + operation_id))
    msg_id = "frontend:" + package_id
    connection.execute(
        "INSERT INTO frontend_packages VALUES (?,?,?,?,?,?)",
        (package_id, operation_id, msg_id, text, encoded_refs, stamp),
    )
    if text:
        raw_records.save_frontend_text(connection, msg_id, text, stamp)
    enqueue(connection, package_id, stamp)
    return {"code": "QUEUED", "package_ref": {"id": package_id}}
