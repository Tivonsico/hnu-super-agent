"""按群名关键词推荐订阅。"""
from __future__ import annotations

from typing import Any

KEYWORDS = {
    "course": ("课程", "教务", "学院", "班级", "专业", "考试", "上课", "作业", "通知", "年级"),
    "activity": ("社团", "活动", "协会", "讲座", "比赛", "招新", "志愿"),
    "market": ("二手", "交易", "闲置", "买卖", "出物"),
    "chat": ("闲聊", "聊天", "水群", "摸鱼", "交流群"),
}
CATEGORIES = ("course", "activity", "market", "chat", "other")


def _heuristic(groups: list[dict[str, Any]], error: str = "") -> dict[str, Any]:
    output = []
    for group in groups:
        gid = str(group.get("group_id") or group.get("id") or "")
        name = str(group.get("group_name") or group.get("name") or gid)
        category = "other"
        for candidate in CATEGORIES[:-1]:
            if any(word in name for word in KEYWORDS[candidate]):
                category = candidate
                break
        output.append({"group_id": gid, "name": name, "category": category,
                       "suggested": category in {"course", "activity"},
                       "reason": {"course": "课程/教学通知", "activity": "社团/活动通知", "market": "二手/交易信息", "chat": "聊天交流", "other": "未识别"}[category]})
    return _result(output, "heuristic", error)


def _result(items: list[dict[str, Any]], source: str, error: str = "") -> dict[str, Any]:
    counts = {category: 0 for category in CATEGORIES}
    for item in items:
        counts[item["category"]] += 1
    return {"ok": True, "source": source, "groups": items, "counts": counts, "error": error}


def suggest(settings: Any, groups: list[dict]) -> dict:
    return _heuristic(list(groups or []))


def _source_groups(source: str, groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if source not in {"wechat", "dingtalk"}:
        raise ValueError("不支持的群组来源")
    if source == "dingtalk":
        return [{"group_id": str(g.get("cid") or ""), "group_name": str(g.get("title") or "")} for g in groups]
    return [{"group_id": str(g.get("id") or ""), "group_name": str(g.get("name") or "")} for g in groups]


def heuristic_for_source(source: str, groups: list[dict[str, Any]]) -> dict[str, Any]:
    result = _heuristic(_source_groups(source, groups))
    for item in result["groups"]:
        item["source"] = "heuristic"
    return result
