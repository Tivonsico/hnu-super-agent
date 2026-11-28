"""Workflow shared by the workbench and the worker API."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from noticehub.domain.time import iso, parse_iso

TRANSITIONS = {
    "claim": ({"queued"}, "running", "ai"),
    "request_approval": ({"running"}, "blocked", "ai"),
    "approve": ({"blocked"}, "queued", "ai"),
    "complete": ({"running"}, "completed", None),
    "terminate": ({"queued", "running", "blocked"}, "terminated", None),
    "ignore": ({"queued", "running", "blocked"}, "ignored", None),
    "restore": ({"terminated", "ignored"}, "queued", "ai"),
}
WORKER_ACTIONS = {"claim", "request_approval", "complete"}
USER_ACTIONS = {"set_deadline", "supplement", "confirm_result", "merge"}


class WorkOrderConflict(ValueError):
    pass


def list_work_orders(store: Any, now: datetime, aliases: dict[str, str] | None = None) -> dict[str, Any]:
    orders = store.list_work_orders()
    names = {**store.group_names(), **(aliases or {})} if orders else {}
    for order in orders:
        identity = order["source_conversation_id"]
        if identity and identity in names:
            order["source_conversation_name"] = names[identity]
        order["groups"] = [names.get(group, group) for group in order["groups"]]
    return {"today": now.date().isoformat(), "orders": orders}


def change_work_order(
    store: Any, payload: dict[str, Any], now: datetime, *, worker: bool = False,
) -> dict[str, Any]:
    order_id = payload.get("id")
    revision = payload.get("revision")
    action = payload.get("action")
    if type(order_id) is not int or not 0 < order_id < 2**63:
        raise ValueError("工单编号无效")
    if type(revision) is not int or revision < 0:
        raise ValueError("工单修订号无效")
    if not isinstance(action, str) or action not in (TRANSITIONS.keys() | USER_ACTIONS):
        raise ValueError("未知工单操作")
    if (worker and action not in WORKER_ACTIONS) or (
        not worker and action in WORKER_ACTIONS
    ):
        raise ValueError("当前接口不支持该操作")
    note = payload.get("note", "")
    if not isinstance(note, str) or len(note) > 8000:
        raise ValueError("工单说明最多 8000 个字符")
    note = note.strip()
    if action == "approve" and not note:
        raise ValueError("请输入审批提示词")
    options = []
    if action == "request_approval":
        if not note:
            raise ValueError("请填写需要审批的问题")
        raw_options = payload.get("options", [])
        if not isinstance(raw_options, list) or len(raw_options) > 8 or any(
            not isinstance(option, str) or not option.strip() or len(option) > 200
            for option in raw_options
        ):
            raise ValueError("审批选项最多 8 项，每项为 1 到 200 字")
        options = list(dict.fromkeys(option.strip() for option in raw_options))
    if action == "set_deadline":
        raw = payload.get("deadline")
        if not isinstance(raw, str) or len(raw) > 64:
            raise ValueError("截止时间无效")
        deadline = parse_iso(raw) if raw else None
        if raw and deadline is None:
            raise ValueError("截止时间无效")
        note = iso(deadline) if deadline else ""

    target_id = None
    if action == "merge":
        target_id = payload.get("target_id")
        if type(target_id) is not int or not 0 < target_id < 2**63 or target_id == order_id:
            raise ValueError("请选择另一张有效工单")
        note = str(target_id)

    def apply(order: dict[str, Any]) -> dict[str, Any]:
        state, executor = order["state"], order["executor"]
        if order["revision"] != revision:
            raise WorkOrderConflict("工单已变更，请重新确认操作")
        if action == "set_deadline":
            if state in {"completed", "terminated", "ignored"}:
                raise WorkOrderConflict("当前状态无法修改截止时间")
            return {"deadline": note}
        if action == "merge":
            if state not in {"queued", "running", "blocked", "completed"}:
                raise WorkOrderConflict("当前工单无法并出")
            return {"state": "merged"}
        if action == "confirm_result":
            if state != "completed" or not order["result"] or order["result_confirmed"]:
                raise WorkOrderConflict("当前没有待确认的阶段成果")
            return {"result_confirmed": True}
        if action == "supplement":
            if not note:
                raise ValueError("请填写补充内容")
            if state not in {"queued", "running", "completed"}:
                raise WorkOrderConflict("当前工单状态无法补充")
            fields = {"latest_supplement": note}
            if state == "completed":
                fields.update(state="queued", executor="ai", result="", result_confirmed=False,
                              checkpoint="", approval_options=[], approval_response="")
            return fields
        allowed, target, next_executor = TRANSITIONS[action]
        if state not in allowed or (worker and executor != "ai"):
            raise WorkOrderConflict("当前工单状态不支持该操作")
        changes = {"state": target, "executor": executor if next_executor is None else next_executor}
        if action == "request_approval":
            changes.update(checkpoint=note, approval_options=options, approval_response="")
        if action == "approve":
            changes["approval_response"] = note
        if action == "restore":
            changes.update(checkpoint="", approval_options=[], approval_response="")
        if action == "complete":
            changes.update(result=note, result_confirmed=False)
        return changes

    return store.change_work_order(order_id, action, note, iso(now), apply, target_id=target_id)
