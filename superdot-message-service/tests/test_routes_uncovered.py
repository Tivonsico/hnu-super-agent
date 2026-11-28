"""用实际 HTTP 服务覆盖通知摘要、学习通状态和拒绝配对。"""

from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from noticehub.receivers.qq import pairing
from noticehub.platform.config import Settings
from noticehub.storage.sqlite.store import Store
from noticehub.web.webapp import TaskWebServer


class _ServerCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name) / "routes.sqlite3")
        self.settings = Settings(
            group_whitelist=("g1",),
            group_aliases={"g1": "学院通知群"},
            web_host="127.0.0.1",
            web_port=0,
            web_token="secret",
            data_dir=Path(self.tmp.name) / "data",
        )
        self.server = TaskWebServer(self.settings, self.store)
        self.assertTrue(self.server.start())
        self.addCleanup(self.server.stop)
        assert self.server.server is not None
        self.base = f"http://127.0.0.1:{self.server.server.server_address[1]}"

    def _get(self, path: str, token: str = "secret") -> tuple[int, dict]:
        request = urllib.request.Request(self.base + path, headers={"X-Token": token} if token else {})
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def _post(self, path: str, payload: dict, token: str = "secret") -> tuple[int, dict]:
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"X-Token": token, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def _insert_digest(self, body: str = "正文", items: int = 1) -> int:
        payload = [{"summary": "条目 %d" % i} for i in range(items)]
        return self.store.insert_digest(
            kind="window",
            window_start="2026-10-01T08:00:00",
            window_end="2026-10-01T08:10:00",
            body=body,
            payload=payload,
            message_count=items,
            llm_used=False,
        )


class NoticesTests(_ServerCase):
    def test_empty_store_returns_empty_items_list(self) -> None:
        status, body = self._get("/api/notices")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"items": []})

    def test_items_shape_limit_and_newest_first(self) -> None:
        for index in range(9):
            self._insert_digest(body="正文 %d" % index, items=3)
        status, body = self._get("/api/notices")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["items"]), 8, "handler 固定 limit=8")
        ids = [item["id"] for item in body["items"]]
        self.assertEqual(ids, sorted(ids, reverse=True), "最新的在前（ORDER BY id DESC）")
        first = body["items"][0]
        self.assertEqual(
            set(first), {"id", "kind", "created_at", "window_end", "summary", "body"}
        )
        self.assertEqual(first["window_end"], "2026-10-01T08:10:00", "抬头时间取摘要的 window_end")
        self.assertEqual(first["summary"], "3 条重点")
        self.assertEqual(first["kind"], "window")

    def test_body_is_not_truncated_to_600_chars(self) -> None:
        """新契约：正文上限 4000 字，不再硬切 600（第 5 条曾断在半句、后面几条看不到）。"""
        self._insert_digest(body="长" * 1000)
        _status, body = self._get("/api/notices")
        self.assertEqual(body["items"][0]["body"], "长" * 1000)

    def test_body_over_4000_is_cut_on_a_whole_line_with_a_note(self) -> None:
        lines = ["第 %03d 行 %s" % (index, "长" * 20) for index in range(200)]
        self._insert_digest(body="\n".join(lines))
        _status, body = self._get("/api/notices")
        text = body["items"][0]["body"]
        self.assertLessEqual(len(text), 4000)
        self.assertTrue(text.endswith("\n…（以下省略）"), "超长要标出省略，不能悄悄截断")
        kept = text[: -len("\n…（以下省略）")].splitlines()
        self.assertEqual(kept[-1], lines[len(kept) - 1], "最后一行要完整，不切半行")
        self.assertNotIn(lines[len(kept)], text)

    def test_broken_store_degrades_to_200_with_error_text(self) -> None:
        """读库失败不能断连接：回 200 + 空列表 + 给用户看的原因，前端才能显示。"""
        def boom(*_args, **_kwargs):
            raise OSError("database is locked")

        original = self.store.recent_digests
        self.store.recent_digests = boom  # type: ignore[assignment]
        self.addCleanup(setattr, self.store, "recent_digests", original)
        status, body = self._get("/api/notices")
        self.assertEqual(status, 200, "不能断连接，也不能回 500")
        self.assertEqual(body["items"], [])
        self.assertIn("读取推送记录失败", body["error"])
        self.assertIn("database is locked", body["error"], "要把库的原话带出来")


class ChaoxingCookieStatusTests(_ServerCase):
    def test_unconfigured_cookie(self) -> None:
        status, body = self._get("/api/chaoxing/cookie/status")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertFalse(body["has_cookie"])
        self.assertEqual(body["result"], "未配置")
        self.assertEqual(body["last_checked_at"], "")

    def test_configured_but_unverified_cookie(self) -> None:
        self.settings.chaoxing_cookie = "sessionid=abc123"
        status, body = self._get("/api/chaoxing/cookie/status")
        self.assertEqual(status, 200)
        self.assertTrue(body["has_cookie"])
        self.assertEqual(body["result"], "未校验", "换了 Cookie 但没自检过")
        self.assertEqual(body["error"], "")


class PairDenyTests(_ServerCase):
    def test_deny_is_post_only(self) -> None:
        """盘点说它是 GET；实际路线表里是 POST，GET 不该命中。"""
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._get("/api/pair/deny")
        self.assertNotEqual(caught.exception.code, 200)

    def test_non_six_digit_code_is_rejected(self) -> None:
        for code in ("12345", "1234567", "abcdef", ""):
            with self.subTest(code=code):
                status, body = self._post("/api/pair/deny", {"code": code})
                self.assertEqual(status, 400)
                self.assertFalse(body["ok"])
                self.assertEqual(body["error"], "配对码必须是 6 位数字")

    def test_unknown_code_does_not_change_pending_state(self) -> None:
        before = pairing.pending()
        status, body = self._post("/api/pair/deny", {"code": "000000"})
        self.assertEqual(status, 400)
        self.assertFalse(body["ok"])
        self.assertEqual(pairing.pending(), before, "拒绝一个不存在的配对码不能动任何状态")


if __name__ == "__main__":
    unittest.main()
