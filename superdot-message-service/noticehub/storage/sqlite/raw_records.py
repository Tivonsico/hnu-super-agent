"""消息层原件索引与已封存消息包的有序成员。"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import uuid

SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_records (
    raw_id TEXT PRIMARY KEY,
    parent_msg_id TEXT NOT NULL,
    segment_order INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'file')),
    source TEXT NOT NULL,
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    reply_to_message_id TEXT,
    content TEXT NOT NULL,
    locator TEXT,
    download_state TEXT,
    file_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_parent ON raw_records(parent_msg_id,segment_order);
CREATE TABLE IF NOT EXISTS package_raw_members (
    package_id TEXT NOT NULL,
    raw_id TEXT NOT NULL,
    member_order INTEGER NOT NULL,
    PRIMARY KEY(package_id,member_order)
);
CREATE INDEX IF NOT EXISTS idx_package_raw_id ON package_raw_members(raw_id);
"""


def valid_id(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _sent_at(stamp: str) -> str:
    value = dt.datetime.fromisoformat(stamp)
    if value.tzinfo is None:
        value = value.astimezone()
    return value.isoformat()


def save_message(connection: sqlite3.Connection, record: dict, metadata: dict | None = None) -> None:
    metadata = metadata or {}
    key = record["msg_id"]
    source = "qq" if record["source"] in {"onebot", "onebot-catchup", "qqbot"} else record["source"]
    conversation = record["group_id"]
    prefix = f"onebot:{conversation}:"
    message_id = metadata.get("message_id") or key.removeprefix(prefix)
    reply_id = metadata.get("reply_to_message_id")
    original_text = metadata.get("text", record["content"])
    files = metadata.get("files", [])
    if not files and record.get("message_kind") in {"file", "image"}:
        original_text = ""
        files = [{"name": record["content"].removeprefix("[文件]").strip() or record["content"]}]
    records = []
    if original_text or not files:
        records.append(("text", original_text, None, None))
    for file in files:
        records.append(("file", file["name"], json.dumps(file, ensure_ascii=False), "NOT_DOWNLOADED"))
    for position, (kind, content, locator, state) in enumerate(records):
        raw_id = key if position == 0 else str(uuid.uuid5(uuid.NAMESPACE_URL, f"superdot:raw:{key}:{position}"))
        connection.execute(
            "INSERT OR IGNORE INTO raw_records"
            " (raw_id,parent_msg_id,segment_order,kind,source,account_id,conversation_id,message_id,"
            " sender_id,sent_at,reply_to_message_id,content,locator,download_state)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (raw_id, key, position, kind, source, record["account_id"], conversation, message_id,
             record["sender_id"], _sent_at(record["ts"]), reply_id, content, locator, state),
        )


def save_frontend_text(connection: sqlite3.Connection, msg_id: str, text: str, stamp: str) -> None:
    if text:
        save_message(connection, {
            "msg_id": msg_id, "source": "frontend", "group_id": "global-input", "account_id": "local",
            "sender_id": "user", "ts": stamp, "content": text,
        })


def save_frontend_file(
    connection: sqlite3.Connection, raw_id: str, filename: str, stamp: str, file_path: str,
) -> None:
    connection.execute(
        "INSERT INTO raw_records (raw_id,parent_msg_id,segment_order,kind,source,account_id,"
        " conversation_id,message_id,sender_id,sent_at,content,download_state,file_path)"
        " VALUES (?, ?, 0, 'file', 'frontend', 'local', 'global-input', ?, 'user', ?, ?, 'DOWNLOADED', ?)",
        (raw_id, raw_id, raw_id, _sent_at(stamp), filename, file_path),
    )


def freeze_members(connection: sqlite3.Connection, package_id: str, messages: list[dict]) -> None:
    ids = []
    for message in messages:
        key = message["msg_id"]
        rows = connection.execute(
            "SELECT raw_id FROM raw_records WHERE parent_msg_id=? ORDER BY segment_order", (key,),
        ).fetchall()
        if not rows:
            save_message(connection, message)
        ids.extend([row["raw_id"] for row in rows] or [key])
    connection.executemany(
        "INSERT INTO package_raw_members(package_id,raw_id,member_order) VALUES (?,?,?)",
        [(package_id, raw_id, position) for position, raw_id in enumerate(dict.fromkeys(ids))],
    )


def backfill(connection: sqlite3.Connection) -> None:
    """从旧的冻结快照补建引用，已清理消息缓存的包也可读取。"""
    rows = connection.execute(
        "SELECT package_id,source,group_id,account_id,payload FROM message_packages AS p"
        " WHERE sealed_at IS NOT NULL AND NOT EXISTS"
        " (SELECT 1 FROM package_raw_members AS m WHERE m.package_id=p.package_id)"
    )
    for row in rows:
        payload = json.loads(row["payload"])
        snapshots = payload["context"] + payload["messages"]
        freeze_members(connection, row["package_id"], [
            {**item, "source": row["source"], "group_id": row["group_id"], "account_id": row["account_id"]}
            for item in snapshots
        ])


def read_raw_in_batch(connection: sqlite3.Connection, raw_ids: list[str]) -> dict:
    if not isinstance(raw_ids, list) or not all(valid_id(key) for key in raw_ids):
        return {"code": "INVALID_INPUT"}
    ids = list(dict.fromkeys(raw_ids))
    found = {}
    for start in range(0, len(ids), 500):
        batch = ids[start:start + 500]
        placeholders = ",".join("?" for _ in batch)
        rows = connection.execute(f"SELECT * FROM raw_records WHERE raw_id IN ({placeholders})", batch)
        found.update((row["raw_id"], row) for row in rows)
    ordered = sorted(
        (found[key] for key in ids if key in found),
        key=lambda row: dt.datetime.fromisoformat(row["sent_at"]).timestamp(),
    )
    records = []
    for row in ordered:
        record = {key: row[key] for key in (
            "source", "account_id", "conversation_id", "message_id", "sender_id", "sent_at",
            "reply_to_message_id", "content",
        )}
        record.update(ref={"id": row["raw_id"]}, type=row["kind"], sent_at=_sent_at(row["sent_at"]))
        if row["kind"] == "file":
            record["download_state"] = row["download_state"]
        records.append(record)
    return {"code": "OK", "records": records, "missing_refs": [{"id": key} for key in ids if key not in found]}


def read_package(connection: sqlite3.Connection, package_id: str) -> dict:
    if not valid_id(package_id):
        return {"code": "INVALID_INPUT"}
    package = connection.execute(
        "SELECT trigger_msg_id,payload FROM message_packages WHERE package_id=? AND sealed_at IS NOT NULL",
        (package_id,),
    ).fetchone()
    if package:
        history = {message["msg_id"] for message in json.loads(package["payload"])["context"]}
        members = connection.execute(
            "SELECT m.raw_id,r.parent_msg_id FROM package_raw_members m"
            " LEFT JOIN raw_records r ON r.raw_id=m.raw_id WHERE m.package_id=? ORDER BY m.member_order",
            (package_id,),
        )
        roles = {}
        for member in members:
            parent = member["parent_msg_id"]
            role = "trigger" if parent == package["trigger_msg_id"] else "followup"
            roles[member["raw_id"]] = "history" if parent in history else role
    else:
        task = connection.execute(
            "SELECT msg_id,text,attachment_refs FROM frontend_packages WHERE package_id=?", (package_id,),
        ).fetchone()
        if not task:
            return {"code": "REF_NOT_FOUND"}
        ids = [task["msg_id"]] if task["text"] else []
        ids.extend(ref["id"] for ref in json.loads(task["attachment_refs"]))
        roles = dict.fromkeys(ids, "trigger")
    batch = read_raw_in_batch(connection, list(roles))
    for record in batch["records"]:
        record["package_role"] = roles[record["ref"]["id"]]
    return batch


def prune_cache(connection: sqlite3.Connection) -> None:
    connection.execute(
        "DELETE FROM raw_records WHERE source<>'frontend'"
        " AND NOT EXISTS (SELECT 1 FROM messages WHERE msg_id=raw_records.parent_msg_id)"
        " AND NOT EXISTS (SELECT 1 FROM package_raw_members AS m WHERE m.raw_id=raw_records.raw_id)"
        " AND NOT EXISTS (SELECT 1 FROM frontend_packages AS p, json_each(p.attachment_refs) AS ref"
        " WHERE json_extract(ref.value, '$.id')=raw_records.raw_id)"
    )
