"""为本地工单预览复用已有消息。"""

from __future__ import annotations

import json


def promote(settings, store, msg_id, *, title=None, due=None, connection=None):
    rows = store.inbox_items(msg_id=str(msg_id), limit=1, include_noise=True)
    if not rows:
        return {"ok": False, "task_id": None, "error": "消息不存在或未分类"}
    row = rows[0]
    defaults = json.loads(row["task_defaults"] or "{}")
    content = row["content"]
    summary = title or defaults.get("summary") or next(iter(content.splitlines()), "消息工单")
    task_id = store.upsert_task(
        task_key=str(msg_id),
        inbox_msg_id=str(msg_id),
        summary=str(summary)[:500],
        deadline=due or defaults.get("deadline", ""),
        groups=defaults.get("groups") or ([row["group_name"]] if row["group_name"] else []),
        sender=defaults.get("sender") or row["sender_name"],
        evidence=content,
        audience=defaults.get("audience", ""),
        condition=defaults.get("condition", ""),
        details=defaults.get("details", []),
        action=defaults.get("action", ""),
        digest_id=defaults.get("digest_id", 0),
        confidence=defaults.get("confidence", 0.0),
        source="inbox",
        category=str(defaults.get("category") or "info"),
        importance=defaults.get("importance", 3),
        classification_reason=row["reason"],
        **({"_connection": connection} if connection is not None else {}),
    )
    return {"ok": bool(task_id), "task_id": task_id, "error": "" if task_id else "工单创建失败"}
