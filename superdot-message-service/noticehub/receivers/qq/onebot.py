"""OneBot v11 对话消息。只产出 MessageEvent，不写库。"""

from __future__ import annotations

import hashlib
from typing import Any, Callable

from noticehub.domain.message import MessageEvent
from noticehub.domain.time import iso

SEGMENT_LABEL = {
    "image": "[图片]",
    "face": "[表情]",
    "record": "[语音]",
    "video": "[视频]",
    "forward": "[合并转发]",
    "json": "[卡片消息]",
    "file": "[文件]",
    "mface": "[表情]",
    "dice": "[骰子]",
    "rps": "[猜拳]",
}


def flatten_message(message: Any, *, preserve_whitespace: bool = False) -> str:
    if isinstance(message, str):
        return message if preserve_whitespace else message.strip()
    parts: list[str] = []
    for segment in message or []:
        if not isinstance(segment, dict):
            parts.append(str(segment))
            continue
        kind = str(segment.get("type") or "")
        data = segment.get("data") or {}
        if kind == "text":
            parts.append(str(data.get("text") or ""))
        elif kind == "at":
            name = data.get("name") or data.get("qq") or "某人"
            parts.append(f"@{name}")
        elif kind == "reply":
            continue
        elif kind == "file":
            name = str(data.get("file") or data.get("file_name") or "").strip()
            parts.append(f"[文件]{name}" if name else "[文件]")
        else:
            parts.append(SEGMENT_LABEL.get(kind, f"[{kind}]"))
    text = "".join(parts)
    return text if preserve_whitespace else text.strip()


def mentions_self(payload: dict[str, Any]) -> bool:
    segments = payload.get("message")
    self_id = str(payload.get("self_id") or "")
    return bool(self_id and isinstance(segments, list) and any(
        isinstance(segment, dict)
        and segment.get("type") == "at"
        and isinstance(segment.get("data"), dict)
        and str(segment["data"].get("qq") or "") == self_id
        for segment in segments
    ))


def parse_onebot_message(payload: Any, settings: Any, *, now: Callable[[], Any], include_self: bool = False) -> MessageEvent | None:
    """转换群聊和用户明确选择监听的 QQ 私聊。"""
    if not isinstance(payload, dict):
        return None
    message_type = str(payload.get("message_type") or "")
    is_self = bool(payload.get("self_id") and str(payload.get("user_id")) == str(payload["self_id"]))
    allow_self = message_type == "group" and is_self and include_self
    if payload.get("post_type") != "message" and not (allow_self and payload.get("post_type") == "message_sent"):
        return None
    if message_type not in {"group", "private"}:
        return None

    user_id = str(payload.get("user_id") or "")
    if is_self and not allow_self:
        return None

    private = message_type == "private"
    if private and user_id not in getattr(settings, "qq_private_ids", ()):
        return None
    group_id = f"private:{user_id}" if private else str(payload.get("group_id") or "")
    if not group_id:
        return None

    content = flatten_message(payload.get("message"))
    if not content:
        content = flatten_message(payload.get("raw_message"))
    if not content:
        return None

    sender = payload.get("sender") or {}
    sender = sender if isinstance(sender, dict) else {}
    sender_name = str(sender.get("card") or sender.get("nickname") or user_id or "未知发送人")
    message_id = str(payload.get("message_id") or "")
    if not message_id:
        digest = hashlib.sha1(f"{group_id}:{user_id}:{payload.get('time')}:{content}".encode("utf-8"))
        message_id = "hash-" + digest.hexdigest()[:16]

    segments = payload.get("message")
    kinds = {part.get("type") for part in segments if isinstance(part, dict) and isinstance(part.get("type"), str)} if isinstance(segments, list) else set()
    if "file" in kinds or content.startswith("[文件]"):
        message_kind = "file"
    elif content == "[图片]" or ("image" in kinds and not any(
        isinstance(part, dict) and part.get("type") == "text" and
        isinstance(part.get("data"), dict) and str(part["data"].get("text") or "").strip()
        for part in segments
    )):
        message_kind = "image"
    else:
        message_kind = "text"

    return MessageEvent(
        msg_id=f"onebot:{group_id}:{message_id}",
        group_id=group_id,
        source="onebot",
        content=content,
        ts=iso(payload.get("time")) or iso(now()),
        received_at=iso(now()),
        event="PRIVATE_MESSAGE_CREATE" if private else "GROUP_MESSAGE_CREATE",
        sender_id=user_id,
        sender_name=sender_name,
        group_name=sender_name if private else settings.group_name(group_id),
        account_id=str(payload.get("self_id") or ""),
        sender_role=str(sender.get("role") or ""),
        message_kind=message_kind,
    )


def onebot_record(event: MessageEvent) -> dict[str, Any]:
    """旧回调仍收这条记录。键与原来的 parse_onebot_event 相同。"""
    return {
        "msg_id": event.msg_id,
        "source": event.source,
        "event": event.event,
        "group_id": event.group_id,
        "group_name": event.group_name,
        "sender_id": event.sender_id,
        "sender_name": event.sender_name,
        "ts": event.ts,
        "received_at": event.received_at,
        "content": event.content,
        "account_id": event.account_id,
        "sender_role": event.sender_role,
        "message_kind": event.message_kind,
    }


def raw_metadata(payload: dict[str, Any], event: MessageEvent) -> dict[str, Any]:
    """保留来源消息 ID、回复关系和逐附件下载定位。"""
    segments = payload.get("message")
    if not isinstance(segments, list):
        original = segments if isinstance(segments, str) and segments else payload.get("raw_message")
        return {
            "message_id": str(payload.get("message_id") or ""),
            "text": original if isinstance(original, str) and original else event.content,
        }
    files = []
    reply_id = None
    text_segments = []
    for segment in segments:
        if not isinstance(segment, dict) or not isinstance(segment.get("data"), dict):
            continue
        kind, data = segment.get("type"), segment["data"]
        if kind == "reply":
            reply_id = str(data.get("id") or "") or None
        elif kind in {"file", "image", "video", "record"}:
            name = str(data.get("file_name") or data.get("name") or data.get("file") or "")
            files.append({
                "name": name or SEGMENT_LABEL[kind],
                "kind": kind,
                "url": str(data.get("url") or ""),
                "file_id": str(data.get("file_id") or (data.get("file") if kind != "file" else "") or ""),
                "busid": str(data.get("busid") or ""),
                "size": str(data.get("file_size") or data.get("size") or ""),
            })
        else:
            text_segments.append(segment)
    return {
        "message_id": str(payload.get("message_id") or ""),
        "reply_to_message_id": reply_id,
        "text": flatten_message(text_segments, preserve_whitespace=True),
        "files": files,
    }


def qqbot_group_event(event_name: str, message: Any, *, now: Callable[[], Any]) -> MessageEvent:
    """官方机器人的群消息。私聊不是这条路径。"""
    author = getattr(message, "author", None)
    return MessageEvent(
        msg_id=str(getattr(message, "id", "") or ""),
        group_id=str(getattr(message, "group_openid", "") or ""),
        source="qqbot",
        content=str(getattr(message, "content", "") or ""),
        ts=iso(getattr(message, "timestamp", None)) or iso(now()),
        received_at=iso(now()),
        event=event_name,
        sender_id=str(getattr(author, "member_openid", "") or ""),
        sender_name=str(getattr(author, "username", "") or ""),
    )


def qqbot_group_record(event: MessageEvent) -> dict[str, Any]:
    """旧回调仍收这条记录。键与原来的 _record_group 相同。"""
    return {
        "msg_id": event.msg_id,
        "source": event.source,
        "event": event.event,
        "group_id": event.group_id,
        "sender_id": event.sender_id,
        "sender_name": event.sender_name,
        "ts": event.ts,
        "received_at": event.received_at,
        "content": event.content,
    }
