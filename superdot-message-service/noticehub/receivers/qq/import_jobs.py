"""历史回溯和收件箱分类共用的任务槽操作。槽本身由调用方持有。"""

from __future__ import annotations

import datetime as dt
import threading
from typing import Any, Callable


def parse_groups(value: Any) -> list[str]:
    if not isinstance(value, list) or not value or len(value) > 500:
        raise ValueError("请至少选择一个群，最多可选择 500 个")
    groups: list[str] = []
    for item in value:
        group_id = str(item or "").strip()
        if not group_id or len(group_id) > 128:
            raise ValueError("群号无效")
        if group_id not in groups:
            groups.append(group_id)
    return groups


def parse_day(value: Any, *, end: bool = False) -> dt.datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    day = dt.date.fromisoformat(text)
    if day.isoformat() != text:
        raise ValueError("日期格式应为 YYYY-MM-DD")
    return dt.datetime.combine(day, dt.time(23, 59, 59) if end else dt.time.min)


def poll_job(kind: str, *, snapshot: Callable[[str], dict[str, Any]]) -> dict[str, Any]:
    """读取历史导入任务的当前快照。detail 缺省为空对象。"""
    if kind != "history":
        raise ValueError("kind 必须是 history")
    data = snapshot(kind)
    data["detail"] = dict(data.get("detail") or {})
    return data


def cancel_job(state: dict[str, Any], lock: Any) -> dict[str, Any]:
    """取消正在跑的历史回溯。没有在跑时由 Web 回 409。"""
    with lock:
        cancel_event = state["cancel"]
        active = state["active"]
        running = state["history"]["running"]
        if active == "history" and running and isinstance(cancel_event, threading.Event):
            cancel_event.set()
            cancelled = True
        else:
            cancelled = False
    if not cancelled:
        return {"ok": False, "cancelled": False, "error": "当前没有正在进行的历史消息导入"}
    return {"ok": True, "cancelled": True}



def start_history_backfill(
    groups: Any,
    since: Any = "",
    until: Any = "",
    *,
    start: Callable[..., tuple[bool, str]],
    run: Callable[..., Any],
) -> dict[str, Any]:
    """校验后启动历史回溯。槽被占时带回占用者，由 Web 回 409。"""
    selected = parse_groups(groups)
    start_at = parse_day(since)
    end_at = parse_day(until, end=True)
    if start_at and end_at and start_at > end_at:
        raise ValueError("开始日期不能晚于结束日期")
    started, active = start(
        "history",
        lambda progress, cancel: run(
            groups=selected, since=start_at, until=end_at, progress=progress, cancel=cancel
        ),
    )
    if not started:
        return {"ok": False, "started": False, "active": active}
    return {"ok": True, "started": True}
