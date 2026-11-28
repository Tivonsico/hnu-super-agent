from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from noticehub.storage.sqlite.store import Store
from noticehub.platform.config import Settings
from noticehub.web import webapp


class FrameworkModeTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        settings = Settings.from_env({
            "NOTICEHUB_WEB_HOST": "127.0.0.1",
            "NOTICEHUB_WEB_TOKEN": "framework-test",
        }, env_file=root / ".env")
        settings.web_port = 0
        settings.data_dir = root
        self.server = webapp.TaskWebServer(settings, Store(root / "test.sqlite3"))
        self.assertTrue(self.server.start())
        self.addCleanup(self.server.stop)
        self.base = f"http://127.0.0.1:{self.server.server.server_address[1]}"

    def read(self, path: str) -> dict:
        request = Request(self.base + path, headers={"X-Token": "framework-test"})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def write(self, path: str, body: dict | None = None) -> tuple[int, dict]:
        request = Request(self.base + path, data=json.dumps(body or {}).encode(),
                          headers={"X-Token": "framework-test", "Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_connected_framework_keeps_existing_group_read(self) -> None:
        actions = {
            "get_status": {"online": True, "good": True},
            "get_login_info": {"nickname": "演示账号", "user_id": 123},
            "get_group_list": [{"group_id": 42, "group_name": "演示群"}],
        }
        with patch.object(webapp, "_request_napcat_action",
                          side_effect=lambda settings, action, timeout: actions[action]):
            status = self.read("/api/napcat/status")
            self.assertEqual(status["mode"], "framework")
            self.assertTrue(status["online"])
            self.assertEqual(status["nickname"], "演示账号")
            self.assertEqual(self.read("/api/napcat/groups")["groups"], [
                {"group_id": "42", "name": "演示群", "member_count": 0, "selected": False},
            ])
            setup = self.read("/api/setup/status")["platforms"]["qq"]
            self.assertTrue(setup["configured"])
            self.assertIsNone(setup["action"])

    def test_disconnected_framework_does_not_offer_install_or_scan(self) -> None:
        with patch.object(webapp, "_request_napcat_action", side_effect=OSError("offline")):
            status = self.read("/api/napcat/status")
            self.assertEqual(status["stage"], "framework_unavailable")
            self.assertFalse(status["online"])
            self.assertIn("桌面 QQ", status["error"])

    def test_unavailable_framework_names_the_connection_in_group_errors(self) -> None:
        self.assertEqual(self.server.settings.napcat_mode, "framework")
        with patch.object(webapp, "_napcat_port_accepts", return_value=False):
            for path in ("/api/napcat/groups", "/api/groups/suggest"):
                with self.subTest(path=path):
                    result = self.read(path)
                    self.assertFalse(result["ok"])
                    self.assertIn("无法连接 Framework", result["error"])
                    self.assertIn("QQ 接入", result["error"])
                    self.assertNotIn("127.0.0.1", result["error"])
            setup = self.read("/api/setup/status")["platforms"]["qq"]
            self.assertEqual(setup["headline"], "Framework 未连接")
            self.assertEqual(setup["action"]["label"], "检查 QQ 接入")

    def test_saved_shell_mode_from_older_env_does_not_reenable_shell(self) -> None:
        settings = Settings.from_env({"NOTICEHUB_NAPCAT_MODE": "shell"})
        self.assertEqual(settings.napcat_mode, "framework")

    def test_connected_framework_with_no_logged_in_account_prompts_for_qq_login(self) -> None:
        with patch.object(webapp, "_request_napcat_action", return_value={"online": False}) as request:
            status = self.read("/api/napcat/status")
            self.assertTrue(status["ok"])
            self.assertFalse(status["online"])
            self.assertEqual(status["stage"], "framework_waiting_login")
            self.assertEqual(request.call_count, 1)
            self.assertEqual(request.call_args.args[1], "get_status")

    def test_connect_uses_discovered_local_port_without_returning_token(self) -> None:
        def request(settings, action, timeout):
            self.assertEqual(settings.napcat_api_url, "http://127.0.0.1:33795")
            self.assertEqual(settings.napcat_api_token, "test-secret")
            return {
                "get_version_info": {"app_name": "NapCat.Onebot"},
                "get_status": {"online": True},
                "get_login_info": {"user_id": 42, "nickname": "演示"},
            }[action]

        with patch.object(webapp.framework, "local_connections", return_value=[("http://127.0.0.1:33795", "test-secret")]), \
             patch.object(webapp, "_request_napcat_action", side_effect=request):
            code, result = self.write("/api/napcat/connect")
            self.assertEqual(code, 200)
            self.assertEqual(result, {"ok": True, "online": True, "user_id": "42", "nickname": "演示"})
            self.assertTrue(self.read("/api/napcat/status")["online"])

    def test_shell_lifecycle_requests_never_reach_the_engine(self) -> None:
        blocked = ("napcat/install", "napcat/launch", "napcat/restart", "napcat/autosetup",
                   "hosting/start", "hosting/stop")
        with patch.object(webapp.napcat_admin, "install") as install, \
             patch.object(webapp.napcat_admin, "launch") as launch, \
             patch.object(webapp.napcat_admin, "restart") as restart:
            for action in blocked:
                with self.subTest(action=action):
                    code, response = self.write(f"/api/{action}")
                    self.assertEqual(code, 409)
                    self.assertFalse(response["ok"])
            for method in (install, launch, restart):
                method.assert_not_called()

    def test_conversation_list_distinguishes_group_and_private_ids(self) -> None:
        recent = [
            {"peerUin": "42", "peerName": "作业群", "chatType": 2, "msgTime": "200", "lastestMsg": {"raw_message": "不可出现在列表"}},
            {"peerUin": "42", "peerName": "同学", "chatType": 1, "msgTime": "100"},
            {"peerUin": "33", "peerName": "课程群", "chatType": 2, "msgTime": "300"},
        ]
        actions = {"get_recent_contact": recent,
                   "get_group_list": [{"group_id": 42, "group_name": "作业群"},
                                      {"group_id": 77, "group_name": "置顶群", "isGroupAssistantTop": True}],
                   "get_friend_list": [{"user_id": 12345, "nickname": "好友"}]}
        with patch.object(webapp, "_request_napcat_action", side_effect=lambda settings, action, timeout: actions[action]):
            payload = self.read("/api/qq/conversations")
            self.assertEqual([(row["id"], row["pinned"]) for row in payload["conversations"]],
                             [("33", False), ("42", False), ("private:42", False), ("77", True), ("private:12345", False)])
            self.assertNotIn("不可出现在列表", json.dumps(payload, ensure_ascii=False))
            self.assertEqual(self.write("/api/qq/conversations", {"all_enabled": True})[0], 404)

    def test_history_group_order_uses_pins_and_latest_qq_activity(self) -> None:
        self.server.settings.group_whitelist = ("42",)
        groups = [{"group_id": 42}, {"group_id": 77, "isGroupAssistantTop": True}, {"group_id": 33}, {"group_id": 11}]
        recent = [
            {"peerUin": "42", "chatType": 2, "msgTime": "200"},
            {"peerUin": "11", "chatType": 1, "msgTime": "500"},
            {"peerUin": "33", "chatType": 2, "msgTime": "300"},
        ]
        with patch.object(webapp, "_request_napcat_action", side_effect=lambda settings, action, timeout: {
            "get_group_list": groups, "get_recent_contact": recent,
        }[action]):
            payload = self.read("/api/napcat/groups?order=conversation")
            self.assertEqual([row["group_id"] for row in payload["groups"]], ["77", "33", "42", "11"])
            self.assertEqual([row["group_id"] for row in payload["groups"] if row["selected"]], ["42"])
            self.assertEqual([row["group_id"] for row in self.read("/api/napcat/groups")["groups"]], ["42", "77", "33", "11"])
        with patch.object(webapp, "_request_napcat_action", side_effect=[groups, OSError("unsupported")]):
            payload = self.read("/api/napcat/groups?order=conversation")
            self.assertEqual([row["group_id"] for row in payload["groups"]], ["77", "42", "33", "11"])

    def test_unified_save_preserves_private_subscriptions_from_group_only_clients(self) -> None:
        config = Path(self.server.settings.env_file)
        config.touch()
        code, data = self.write("/api/subscriptions", {"groups": ["12345"], "private_ids": ["67890"]})
        self.assertEqual(code, 200, data)
        self.assertEqual(self.server.settings.group_whitelist, ("12345",))
        with patch.object(webapp, "_request_napcat_action", return_value=[]):
            subscribed = [row["id"] for row in self.read("/api/qq/conversations")["conversations"] if row["selected"]]
            self.assertEqual(subscribed, ["private:67890"])
        self.assertIn("NOTICEHUB_QQ_PRIVATE_IDS=67890", config.read_text())
        self.assertEqual(self.write("/api/subscriptions", {"groups": ["23456"]})[0], 200)
        with patch.object(webapp, "_request_napcat_action", return_value=[]):
            subscribed = [row["id"] for row in self.read("/api/qq/conversations")["conversations"] if row["selected"]]
            self.assertEqual(subscribed, ["private:67890"])
