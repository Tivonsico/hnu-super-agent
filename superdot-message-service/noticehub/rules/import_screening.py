"""本机历史导入使用的粗筛。"""
from __future__ import annotations
from types import SimpleNamespace
from noticehub.notifications.digest import is_notice_item, is_quiet_group_item


def _heuristic(row, settings):
    item = dict(row)
    item["message"] = SimpleNamespace(text=str(row.get("content", "")))
    if is_notice_item(item, settings): return "notice", "已有通知判定命中"
    if is_quiet_group_item(item, settings) or len(str(row.get("content", "")).strip()) < 5: return "noise", "安静群或短闲聊"
    return "suspect", "疑似通知，需人工确认"

def classify_messages(settings, store, *, since=None, until=None, groups=None, limit=1000, progress=None, cancel=None, source=""):
    rows = store.unmarked_messages(since=since, until=until, groups=groups, limit=limit, source=source)
    counts = {"notice": 0, "suspect": 0, "noise": 0}
    cancelled = False
    for start in range(0, len(rows), 20):
        if cancel and cancel():
            cancelled = True
            break
        batch = rows[start:start + 20]
        for row in batch:
            verdict, reason = _heuristic(row, settings)
            store.save_mark(row["msg_id"], verdict, reason, "heuristic")
            counts[verdict] += 1
        if progress:
            progress(len(batch), len(rows))
    return {"ok": True, "cancelled": cancelled, "classified": sum(counts.values()),
            "counts": counts, "method": "heuristic", "error": "", "llm_error": ""}
