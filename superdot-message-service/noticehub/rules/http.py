"""SuperDot HTTP handlers for rules."""

from __future__ import annotations

from noticehub.rules import lab
from noticehub.rules.package import parse_rule, subscribed_qq_group


class RuleRoutes:
    def _lab_reply(self, result: dict[str, Any]) -> None:
        # 门面统一返回 {"ok": ..., "error": ...}：开关关→403；用户自己填错的东西
        # （规则非法、消息缺字段）→400，别让他以为是服务端坏了；其余→503。
        # 门面只包一层：底层函数自己也可能返回 {"ok": False, "error": ...}（比如规则校验失败），
        # 这时外层 ok 仍是 True。不摊平就会把「第 2 条规则非法」当成保存成功回给页面。
        inner = result.get("result")
        if result.get("ok") and isinstance(inner, dict) and "ok" in inner:
            result = inner
        error = str(result.get("error") or "")
        if result.get("ok"):
            self._json(200, result)
        elif "未开启" in error or "已关闭" in error:
            self._json(403, {"ok": False, "error": error})
        elif any(mark in error for mark in ("非法", "必须是一个数组", "缺少", "过长", "必须是对象")):
            self._json(400, {"ok": False, "error": error})
        else:
            self._json(503, {"ok": False, "error": error})

    def _route_get_api_lab_rules(self, path: str) -> None:  # noqa: N802 - 路由处理
        self._lab_reply(lab.list_rules(self.server.settings))  # type: ignore[attr-defined]
        return

    def _route_post_api_lab_rules(self, path: str) -> None:  # noqa: N802 - 路由处理
        payload = self._read_payload()
        if payload is None:
            return
        self._lab_reply(lab.save_rules(self.server.settings, payload.get("rules")))  # type: ignore[attr-defined]
        return

    def _route_get_package_rule(self, path: str) -> None:
        from noticehub.rules.user_rules import load_rules

        settings = self.server.settings
        names = self.store.group_names()
        groups = [
            {"id": group, "name": settings.group_aliases.get(group) or names.get(group) or settings.group_name(group)}
            for group in settings.group_whitelist if subscribed_qq_group(group, settings.group_whitelist)
        ]
        self._json(200, {
            "ok": True, "rule": {**self.store.get_package_rule(), "group_ids": [group["id"] for group in groups]}, "groups": groups,
            "legacy_rules": {"count": load_rules(settings)["count"], "enabled": settings.lab_rules},
        })

    def _subscribed_package_rule(self, payload):
        rule = parse_rule(payload)
        if not set(rule["group_ids"]) <= set(self.server.settings.group_whitelist):
            raise ValueError("只能对已订阅的 QQ 群启用这条规则")
        subscriptions = self.server.settings.group_whitelist
        rule["group_ids"] = [group for group in subscriptions if subscribed_qq_group(group, subscriptions)]
        return parse_rule(rule)

    def _route_post_package_rule(self, path: str) -> None:
        payload = self._read_payload()
        if payload is None:
            return
        try:
            rule = self._subscribed_package_rule(payload)
            self.store.save_package_rule({**rule, "group_ids": []})
        except ValueError as error:
            self._json(400, {"ok": False, "error": str(error)})
            return
        self._json(200, {"ok": True, "rule": rule})

    def _route_get_screening(self, path: str) -> None:
        if self._product_host_allowed():
            from noticehub.rules.package import default_keyword_library

            import json
            saved = self.store.meta_get("keyword_library")
            library = json.loads(saved) if saved else default_keyword_library()
            screening = self.store.get_screening()
            known = {word for words in library.values() for word in words}
            library["通知"] = [*library["通知"], *(w for w in screening["keywords"] if w not in known)]
            self._json(200, {"ok": True, "screening": screening, "keyword_library": library})

    def _route_post_screening(self, path: str) -> None:
        if not self._product_host_allowed():
            return
        try:
            payload = self._product_body()
            qq_rule = None
            if isinstance(payload, dict) and "qq_rule" in payload:
                qq_rule = self._subscribed_package_rule(payload["qq_rule"])
                qq_rule["group_ids"] = []
            screening = self.store.save_screening(payload, qq_rule=qq_rule)
        except ValueError as error:
            self._json(400, {"ok": False, "error": str(error)})
            return
        self._json(200, {"ok": True, "screening": screening})
