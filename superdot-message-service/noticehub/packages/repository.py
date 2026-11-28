"""持久化消息包的收集窗口、冻结内容与覆盖标记。"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import uuid

from noticehub.rules.package import monitors, triggers
from noticehub.domain.time import iso, parse_iso
from noticehub.storage.sqlite import raw_records
from noticehub.queue.repository import enqueue

SCHEMA = """
CREATE TABLE IF NOT EXISTS message_packages (
    package_id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'onebot',
    account_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    trigger_msg_id TEXT NOT NULL UNIQUE,
    start_order INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    closes_at TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    sealed_at TEXT,
    payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_open_package_due
    ON message_packages(closes_at) WHERE sealed_at IS NULL;
CREATE TABLE IF NOT EXISTS message_package_coverage (
    msg_id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL REFERENCES message_packages(package_id)
);
"""

_SCOPED_MESSAGES = (
    "SELECT m.msg_id,m.source,m.account_id,m.sender_id,m.sender_name,m.sender_role,m.message_kind,m.ts,"
    " m.received_at,m.content,m.rowid AS position,c.package_id AS covered_by"
    " FROM messages AS m LEFT JOIN message_package_coverage AS c ON c.msg_id=m.msg_id"
    " WHERE (m.source=? OR (?='onebot' AND m.source='onebot-catchup' AND m.package_managed=1))"
    " AND m.account_id=? AND m.group_id=?"
)


def _before(connection: sqlite3.Connection, package: sqlite3.Row, rule: dict) -> tuple[list[dict], list[str]]:
    context = []
    stamp, position = package["started_at"], package["start_order"]
    scope = (package["source"], package["source"], package["account_id"], package["group_id"])
    while True:
        earliest = iso(parse_iso(stamp) - dt.timedelta(minutes=rule["lookback_minutes"]))
        rows = connection.execute(
            _SCOPED_MESSAGES
            + " AND m.received_at>=? AND (m.received_at,m.rowid)<(?,?)"
            " ORDER BY m.received_at DESC,m.rowid DESC LIMIT ?",
            (*scope, earliest, stamp, position, rule["lookback_count"]),
        ).fetchall()
        for row in rows:
            if row["covered_by"]:
                return list(reversed(context)), [row["covered_by"]]
            context.append(dict(row))
        if "senders" in rule or not any(monitors(row, rule) for row in rows):
            return list(reversed(context)), []
        stamp, position = rows[-1]["received_at"], rows[-1]["position"]


def _seal(connection: sqlite3.Connection, package: sqlite3.Row, now: str) -> None:
    rule = json.loads(package["rule_json"])
    context, references = _before(connection, package, rule)
    rows = connection.execute(
        _SCOPED_MESSAGES
        + " AND (m.received_at,m.rowid)>=(?,?) AND m.received_at<? AND c.package_id IS NULL"
        " ORDER BY m.received_at,m.rowid",
        (package["source"], package["source"], package["account_id"], package["group_id"],
         package["started_at"], package["start_order"], package["closes_at"]),
    )
    current = [dict(row) for row in rows]
    content = {
        "context": context, "messages": current, "context_package_refs": references,
    }
    raw_records.freeze_members(connection, package["package_id"], [
        {**row, "source": package["source"], "group_id": package["group_id"]} for row in context + current
    ])
    connection.execute(
        "UPDATE message_packages SET sealed_at=?,payload=? WHERE package_id=?",
        (now, json.dumps(content, ensure_ascii=False), package["package_id"]),
    )
    connection.executemany(
        "INSERT INTO message_package_coverage (msg_id,package_id) VALUES (?,?)",
        [(row["msg_id"], package["package_id"]) for row in context + current],
    )
    enqueue(connection, package["package_id"], now)


def accept(connection: sqlite3.Connection, row: dict, position: int, rule: dict | None) -> bool:
    """在同一笔消息写入事务中启动或延长窗口。"""
    stamp = row["received_at"]
    current = parse_iso(stamp)
    source = "onebot" if row["source"] == "onebot-catchup" else row["source"]
    scope = (source, row["account_id"], row["group_id"])
    package = connection.execute(
        "SELECT * FROM message_packages WHERE source=? AND account_id=? AND group_id=? AND sealed_at IS NULL", scope,
    ).fetchone()
    if package is not None and stamp >= package["closes_at"]:
        _seal(connection, package, stamp)
        package = None
    if package is not None:
        saved_rule = json.loads(package["rule_json"])
        if monitors(row, saved_rule):
            cap = parse_iso(package["started_at"]) + dt.timedelta(minutes=saved_rule["max_minutes"])
            close_at = min(cap, current + dt.timedelta(minutes=saved_rule["quiet_minutes"]))
            if iso(close_at) > package["closes_at"]:
                connection.execute(
                    "UPDATE message_packages SET closes_at=? WHERE package_id=?", (iso(close_at), package["package_id"]),
                )
        return True
    if rule is None:
        return False
    if triggers(row, rule):
        close_at = current + dt.timedelta(minutes=rule["collect_minutes"])
        package_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "superdot:message-package:" + row["msg_id"]))
        connection.execute(
            "INSERT INTO message_packages"
            " (package_id,source,account_id,group_id,group_name,trigger_msg_id,start_order,started_at,closes_at,rule_json)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (package_id, *scope, row["group_name"], row["msg_id"], position, stamp, iso(close_at), json.dumps(rule)),
        )
    return True


def seal_due(connection: sqlite3.Connection, now: str, *, group_id: str | None = None, source: str | None = None) -> int:
    where = "sealed_at IS NULL AND closes_at<=?"
    params = (now,)
    if group_id is not None:
        where += " AND group_id=?"
        params += (group_id,)
    if source is not None:
        where += " AND source=?"
        params += (source,)
    packages = connection.execute(
        "SELECT * FROM message_packages WHERE " + where + " ORDER BY closes_at,rowid", params,
    ).fetchall()
    for package in packages:
        _seal(connection, package, now)
    return len(packages)


def list_sealed(connection: sqlite3.Connection, limit: int = 30) -> list[dict]:
    rows = connection.execute(
        "SELECT package_id,group_id,group_name,started_at,closes_at,sealed_at,payload FROM message_packages"
        " WHERE sealed_at IS NOT NULL ORDER BY closes_at DESC,package_id LIMIT ?", (limit,),
    )
    return [{**{key: row[key] for key in row.keys() if key != "payload"}, **json.loads(row["payload"])} for row in rows]
