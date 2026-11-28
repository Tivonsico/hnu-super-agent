"""收消息和规则接线。不启动推送。"""

from __future__ import annotations

from typing import Any, Callable, Mapping

from noticehub.domain.message import MessageEvent
from noticehub.rules.package import subscribed_qq_group


def accept_message(
    event: MessageEvent,
    *,
    service: Any,
    record: Mapping[str, Any],
    now: Callable[[], Any],
    retry_on_failure: bool = False,
) -> bool:
    """是否新插入。重复消息返回 False，保留该消息原有的识别结果。"""
    store = service.store
    settings = service.settings
    logger = service.logger
    msg_id = event.msg_id
    if not msg_id:
        logger.warning("忽略没有 msg_id 的消息：%s", str(record)[:200])
        return False
    group_id = event.group_id
    source = event.source
    if source == "onebot" and event.event == "PRIVATE_MESSAGE_CREATE":
        accepted = (
            event.sender_id in settings.qq_private_ids
            and group_id == f"private:{event.sender_id}"
        )
    elif source == "dingtalk":
        accepted = bool(settings.dingtalk_group_whitelist) and group_id in settings.dingtalk_group_whitelist
    elif source == "chaoxing":
        accepted = bool(settings.chaoxing_enabled and settings.chaoxing_group_whitelist) and group_id in settings.chaoxing_group_whitelist
    elif source == "wechat":
        accepted = bool(settings.wechat_enabled and settings.wechat_group_whitelist) and group_id in settings.wechat_group_whitelist
    else:
        accepted = not group_id or settings.accepts_group(group_id)
    if not accepted:
        logger.debug("忽略未监听的对话：%s", group_id)
        return False
    group_name = event.group_name or settings.group_name(group_id)
    try:
        inserted = store.insert_message(
            msg_id=msg_id,
            group_id=group_id,
            content=event.content,
            source_text=event.source_text,
            ts=event.ts,
            received_at=event.received_at or now(),
            source=source,
            event=event.event,
            sender_id=event.sender_id,
            sender_name=event.sender_name,
            group_name=group_name,
            inbox_mark=rule_mark(record, group_id, settings=settings, logger=logger),
            route_to_router=bool(group_id),
            subscribed_qq=source == "onebot" and subscribed_qq_group(group_id, settings.group_whitelist),
            account_id=event.account_id,
            sender_role=event.sender_role,
            message_kind=event.message_kind,
            raw_metadata=record.get("raw_metadata"),
        )
    except Exception:  # noqa: BLE001 - 入库失败不能让机器人线程崩掉
        logger.exception("消息入库失败：%s", msg_id)
        if retry_on_failure:
            raise
        return False
    if inserted:
        logger.info(
            "收到消息 group=%s sender=%s id=%s text=%s",
            group_name,
            record.get("sender_name") or record.get("sender_id") or "?",
            msg_id,
            str(record.get("content") or "")[:60].replace("\n", " "),
        )
    return inserted


def rule_mark(
    record: Mapping[str, Any],
    group_id: str,
    *,
    settings: Any,
    logger: Any,
) -> tuple[str, str, dict[str, Any]] | None:
    """保留所有命中规则的名称，优先级最高的规则提供工单默认值。"""
    if not getattr(settings, "lab_rules", False):
        return None
    try:
        from noticehub.rules import user_rules as rules

        hits = rules.match(
            {
                "content": str(record.get("content") or ""),
                "group_id": group_id,
                "sender": str(record.get("sender_id") or record.get("sender_name") or ""),
                "sender_name": str(record.get("sender_name") or ""),
                "at_me": bool(record.get("at_me")),
            },
            rules.parse_rules(rules.load_rules(settings)["rules"]),
        )
    except Exception:  # noqa: BLE001 - 规则故障不能影响收消息
        logger.exception("规则匹配失败：%s", record.get("msg_id"))
        return None
    if not hits:
        return None
    reason = "命中规则 " + "、".join(str(hit["rule_id"]) for hit in hits)
    defaults = (hits[0].get("action") or {}).get("payload") or {}
    return "rule", reason, defaults
