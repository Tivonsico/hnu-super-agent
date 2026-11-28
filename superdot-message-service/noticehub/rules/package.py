"""默认 QQ 组包规则及其可编辑参数。"""

from __future__ import annotations

import re
from typing import Any

RULE_KEY = "qq_package_rule"
DEFAULT_RULE = {
    "group_ids": [], "sender_ids": [], "roles": ["owner", "admin"], "keywords": [],
    "include_self": False,
    "lookback_minutes": 120, "lookback_count": 10,
    "collect_minutes": 5, "quiet_minutes": 1, "max_minutes": 20,
}
WINDOW_LIMITS = {
    "lookback_minutes": 10080, "lookback_count": 200, "collect_minutes": 1440,
    "quiet_minutes": 1440, "max_minutes": 1440,
}


def parse_rule(value: Any) -> dict:
    if not isinstance(value, dict):
        raise ValueError("请提供有效的组包规则")
    rule = {**DEFAULT_RULE, **{key: value[key] for key in DEFAULT_RULE if key in value}}
    if type(rule["include_self"]) is not bool:
        raise ValueError("请选择是否监听本人发出的消息")
    for key in ("group_ids", "sender_ids", "roles", "keywords"):
        items = rule[key]
        if not isinstance(items, list) or len(items) > 1000 or any(
            not isinstance(item, str) or not item.strip() or len(item) > 100 for item in items
        ):
            raise ValueError("群号、QQ 号、成员身份和关键词必须为有效的列表")
        rule[key] = list(dict.fromkeys(item.strip() for item in items))
    for key in ("group_ids", "sender_ids"):
        if any(not re.fullmatch(r"[0-9]{5,15}", item) for item in rule[key]):
            raise ValueError("群号和 QQ 号须为 5 至 15 位数字")
    if not set(rule["roles"]) <= {"owner", "admin"}:
        raise ValueError("成员身份仅支持群主和管理员")
    for key, upper in WINDOW_LIMITS.items():
        if type(rule[key]) is not int or not 1 <= rule[key] <= upper:
            raise ValueError("回看和收集参数必须是有效的正整数")
    if not rule["quiet_minutes"] <= rule["collect_minutes"] <= rule["max_minutes"]:
        raise ValueError("静默时间不能超过初始收集时间，初始收集时间不能超过最长收集时间")
    if rule["group_ids"] and not (rule["roles"] or rule["sender_ids"] or rule["include_self"]):
        raise ValueError("请至少选择一种成员身份或填写一个监听 QQ 号")
    return rule


def subscribed_qq_group(group_id: str, subscriptions) -> bool:
    return bool(re.fullmatch(r"[0-9]{5,15}", group_id)) and group_id in subscriptions


def includes_own_qq_messages(rule: dict, group_id: str) -> bool:
    # 旧设置可能只对指定群开启“监听自己”；保留当时选择的范围。
    return rule["include_self"] and (not rule["group_ids"] or group_id in rule["group_ids"])


def default_keyword_library() -> dict:
    from qq_digest import ACADEMIC_WORDS, ACTION_WORDS, ADMIN_WORDS, URGENT_WORDS
    return {"学业": ACADEMIC_WORDS, "行动": ACTION_WORDS, "通知": ADMIN_WORDS, "紧急": URGENT_WORDS}


def default_screening() -> dict:
    return parse_screening({"keywords": list(dict.fromkeys(word for words in default_keyword_library().values() for word in words)), "channels": {
        source: {"enabled": True, "inherit": source != "qq"} for source in SCREENING_CHANNELS
    }})


def monitors(row: Any, rule: dict) -> bool:
    if "senders" in rule:
        senders = rule["senders"]
        return not senders or row["sender_id"] in senders or row["sender_name"] in senders
    if row["sender_id"] and row["sender_id"] == row["account_id"]:
        return bool(rule.get("include_self"))
    return row["sender_id"] in rule["sender_ids"] or row["sender_role"] in rule["roles"]


def triggers(row: Any, rule: dict) -> bool:
    if not monitors(row, rule):
        return False
    if row["message_kind"] == "file":
        return True
    text = row["content"].casefold()
    return row["message_kind"] == "text" and (
        not rule["keywords"] or any(word.casefold() in text for word in rule["keywords"])
    )


SCREENING_KEY = "channel_screening"
SCREENING_CHANNELS = ("qq", "wechat", "dingtalk", "chaoxing")


def _screening_words(value: Any, limit: int = 100) -> list[str]:
    if not isinstance(value, list) or len(value) > limit or any(
        not isinstance(word, str) or not word.strip() or len(word.strip()) > 100 for word in value
    ):
        raise ValueError(f"每项须为 1 至 100 个字符，最多填写 {limit} 项")
    return list(dict.fromkeys(word.strip() for word in value))


def parse_screening(value: Any) -> dict:
    if not isinstance(value, dict) or not isinstance(value.get("channels", {}), dict):
        raise ValueError("请提供有效的渠道粗筛规则")
    raw_channels = value.get("channels", {})
    if set(raw_channels) - set(SCREENING_CHANNELS):
        raise ValueError("粗筛规则含未知渠道")
    channels = {}
    for source in SCREENING_CHANNELS:
        raw = raw_channels.get(source, {})
        if not isinstance(raw, dict) or type(raw.get("inherit", True)) is not bool:
            raise ValueError("请选择是否继承通用关键词")
        if type(raw.get("enabled", source == "qq")) is not bool:
            raise ValueError("请选择是否开启渠道规则")
        channels[source] = {
            "enabled": raw.get("enabled", source == "qq"),
            "inherit": raw.get("inherit", True),
            "keywords": _screening_words(raw.get("keywords", [])),
            "senders": _screening_words(raw.get("senders", [])),
        }
    windows = value.get("windows", {})
    if not isinstance(windows, dict) or set(windows) - set(WINDOW_LIMITS):
        raise ValueError("请提供有效的通用组包时间")
    common = parse_rule(windows)
    return {
        "keywords": _screening_words(value.get("keywords", []), 4000),
        "windows": {key: common[key] for key in WINDOW_LIMITS},
        "channels": channels,
    }


def rule_for_channel(
    source: str, group_id: str, qq_rule: dict | None, screening: dict | None, *, qq_private: bool = False,
) -> dict | None:
    if qq_private:
        if screening is None or not screening["channels"]["qq"]["inherit"]:
            return None
        return {**DEFAULT_RULE, **screening["windows"], "senders": [], "keywords": screening["keywords"]}
    if source == "qq":
        if qq_rule is None or group_id not in qq_rule["group_ids"]:
            return None
        if screening is None or not screening["channels"][source]["inherit"]:
            return qq_rule
        return {**qq_rule, **screening["windows"], "keywords": screening["keywords"]}
    if screening is None or not screening["channels"][source]["enabled"]:
        return None
    channel = screening["channels"][source]
    return {**DEFAULT_RULE, **screening["windows"], "senders": channel["senders"],
            "keywords": screening["keywords"] if channel["inherit"] else channel["keywords"]}


def parse_keyword_library(raw: Any) -> dict:
    categories = ("学业", "行动", "通知", "紧急")
    if not isinstance(raw, dict) or set(raw) != set(categories):
        raise ValueError("关键词需要按学业、行动、通知、紧急四类保存")
    return {category: _screening_words(raw[category], 1000) for category in categories}
