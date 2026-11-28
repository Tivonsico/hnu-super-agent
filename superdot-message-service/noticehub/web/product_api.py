"""SuperDot HTTP handlers for web."""

from __future__ import annotations

import hmac
import json
import logging
import sqlite3
import urllib.parse
from typing import Any

from noticehub.web.desktop_pet import DEFAULTS
from noticehub.web.settings_api import MAX_BODY_BYTES

LOGGER = logging.getLogger(__name__)


class ProductRequestMixin:
    def _product_host_allowed(self) -> bool:
        if self.server.token:
            return True
        try:
            host = urllib.parse.urlsplit("//" + self.headers.get("Host", "")).hostname
        except ValueError:
            host = None
        if host in {"127.0.0.1", "localhost", "::1"}:
            return True
        self._json(403, {"code": "INVALID_HOST"})
        return False

    def _product_body(self, *, max_bytes: int = MAX_BODY_BYTES) -> dict[str, Any]:
        if self.headers.get_content_type() != "application/json":
            raise ValueError("需要 application/json")
        origin = self.headers.get("Origin")
        if origin and origin not in {
            "http://" + self.headers.get("Host", ""), "https://" + self.headers.get("Host", ""),
        }:
            raise ValueError("来源与当前页面不同")
        return self._json_body(max_bytes=max_bytes)

    def _product_response(self, call: Any, statuses: dict[str, int]) -> None:
        if not self._product_host_allowed():
            return
        try:
            result = call()
        except ValueError:
            self._json(400, {"code": "INVALID_INPUT"})
            return
        except (sqlite3.Error, OSError):
            LOGGER.exception("消息存储请求失败")
            self._json(503, {"code": "STORE_UNAVAILABLE"})
            return
        self._json(statuses.get(result["code"], 503), result)

    def _route_get_reminder_settings(self, path: str) -> None:
        def read():
            defaults = {"action": True, "result": True, "problem": True}
            try:
                saved = json.loads(self.store.meta_get("web_reminder_preferences", "{}"))
            except ValueError:
                saved = {}
            if isinstance(saved, dict):
                defaults.update({key: saved[key] for key in defaults if type(saved.get(key)) is bool})
            return {"code": "OK", "preferences": defaults}

        self._product_response(read, {"OK": 200})

    def _route_post_reminder_settings(self, path: str) -> None:
        def save():
            preferences = self._product_body()
            if set(preferences) != {"action", "result", "problem"} or any(
                type(value) is not bool for value in preferences.values()
            ):
                raise ValueError("提醒设置需要布尔值")
            self.store.meta_set("web_reminder_preferences", json.dumps(preferences))
            return {"code": "OK", "preferences": preferences}

        self._product_response(save, {"OK": 200})

    def _route_get_desktop_pet(self, path: str) -> None:
        if self._product_host_allowed():
            self._json(200, self.server.desktop_pet.status())

    def _desktop_pet_local(self) -> bool:
        try:
            host = urllib.parse.urlsplit("//" + self.headers.get("Host", "")).hostname
        except ValueError:
            host = None
        return self.client_address[0] in {"127.0.0.1", "::1"} and host in {"127.0.0.1", "localhost", "::1"}

    def _route_post_desktop_pet(self, path: str) -> None:
        if not self._product_host_allowed():
            return
        pet = self.server.desktop_pet
        try:
            payload = self._product_body()
            action = payload.get("action")
            if action in ("launch", "quit", "native", "preview", "open-settings"):
                if not self._desktop_pet_local():
                    self._json(403, {"ok": False, "error": "请在桌宠所在电脑打开 SuperDot。"})
                    return
                if action == "launch":
                    pet.launch()
                elif action == "quit":
                    pet.quit()
                elif action == "native":
                    if not isinstance(payload.get("key"), str) or "value" not in payload:
                        raise ValueError("桌宠设置参数无效。")
                    pet.set_native(payload["key"], payload["value"])
                elif action == "preview":
                    pet.preview()
                elif not pet.open_settings():
                    raise OSError("无法打开桌宠设置，请从桌宠右键菜单打开。")
            else:
                preferences = payload.get("preferences")
                if type(payload.get("enabled")) is not bool:
                    raise ValueError("请选择是否开启桌宠播报。")
                if preferences is not None and (not isinstance(preferences, dict) or
                        set(preferences) != set(DEFAULTS) or any(type(value) is not bool for value in preferences.values())):
                    raise ValueError("桌宠提醒设置无效。")
                pet.set_enabled(payload["enabled"], preferences)
        except ValueError as error:
            self._json(400, {"ok": False, "error": str(error)})
            return
        except (OSError, sqlite3.Error) as error:
            message = str(error) if not isinstance(error, sqlite3.Error) else "无法保存桌宠设置，请重试。"
            self._json(503, {"ok": False, "error": message})
            return
        self._json(200, pet.status())

    def _desktop_pet_bridge_allowed(self) -> bool:
        supplied = self.headers.get("X-SuperDot-Desktop-Pet", "")
        if (self._desktop_pet_local() and supplied.isascii() and
                hmac.compare_digest(supplied, self.server.desktop_pet.bridge_key)):
            return True
        self._json(403, {"ok": False, "message": "桌宠连接已失效，请重新打开 SuperDot。"})
        return False

    def _route_get_desktop_pet_state(self, path: str) -> None:
        if self._desktop_pet_bridge_allowed():
            self._json(200, self.server.desktop_pet.snapshot())

    def _route_post_desktop_pet_action(self, path: str) -> None:
        if not self._desktop_pet_bridge_allowed():
            return
        try:
            status, result = self.server.desktop_pet.native_action(self._product_body())
        except ValueError as error:
            status, result = 400, {"ok": False, "message": str(error)}
        except (sqlite3.Error, OSError):
            LOGGER.exception("桌宠请求处理失败")
            status, result = 503, {"ok": False, "message": "暂时无法处理，请稍后重试。"}
        self._json(status, result)
