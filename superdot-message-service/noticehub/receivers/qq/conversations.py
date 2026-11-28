from __future__ import annotations

from typing import Any

def conversation_list(recent: list, groups: list, friends: list) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}

    def add(identity: Any, source: dict, *, private: bool = False, recent_contact: bool = False) -> None:
        if not identity:
            return
        key = f"private:{identity}" if private else str(identity)
        name = source.get("remark") or source.get("peerName") or source.get("nickname") or str(identity)
        pinned = any(source.get(flag) is True for flag in ("isTop", "isPinned", "isGroupAssistantTop"))
        if key in rows:
            rows[key]["pinned"] |= pinned
            return
        stamp = str(source.get("msgTime") or "")
        rows[key] = {"id": key, "name": str(name), "private": private, "pinned": pinned, "recent": recent_contact,
                     "timestamp": int(stamp) if stamp.isascii() and stamp.isdecimal() and len(stamp) <= 16 else 0}

    for item in recent:
        if not isinstance(item, dict):
            continue
        message = item.get("lastestMsg") or {}
        kind = message.get("message_type") if isinstance(message, dict) else ""
        if kind not in {"group", "private"}:
            kind = {1: "private", 2: "group"}.get(item.get("chatType"))
        if kind in {"group", "private"}:
            add(item.get("peerUin"), item, private=kind == "private", recent_contact=True)
    for item in groups:
        if isinstance(item, dict):
            add(item.get("group_id"), item)
    for item in friends:
        if isinstance(item, dict):
            add(item.get("user_id"), item, private=True)
    return sorted(rows.values(), key=lambda row: (not row["recent"], -row["timestamp"]))
