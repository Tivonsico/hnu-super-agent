"""SuperDot 路由、处理器和鉴权次序。"""

from __future__ import annotations

import ast
import inspect
import unittest
from textwrap import dedent

from noticehub.web import routes, webapp

# 产品路由的精确清单。增删入口时同步检查公开权限和客户端依赖。
EXPECTED_GET = {
    "/api/desktop-pet/state",
    "/api/settings/reminders",
    "/api/settings/desktop-pet",
    "/api/settings/screening",
    "/",
    "/api/app/qr.png",
    "/api/artifacts/<id>",
    "/api/backup",
    "/api/chaoxing/cookie/status",
    "/api/chaoxing/courses",
    "/api/chaoxing/status",
    "/api/config/audit",
    "/api/dingtalk/groups",
    "/api/dingtalk/status",
    "/api/execution/status",
    "/api/firewall/status",
    "/api/groups/suggest",
    "/api/health",
    "/api/history/fetch/status",
    "/api/hosting/status",
    "/api/inbox",
    "/api/inbox/image",
    "/api/lab/rules",
    "/api/meta",
    "/api/napcat/doctor",
    "/api/napcat/groups",
    "/api/napcat/install/status",
    "/api/napcat/qrcode",
    "/api/napcat/status",
    "/api/notices",
    "/api/notifications",
    "/api/onboarding",
    "/api/overview",
    "/api/packages/<id>",
    "/api/pair/info",
    "/api/pair/pending",
    "/api/pair/status",
    "/api/ping",
    "/api/qq/conversations",
    "/api/qq/groups/status",
    "/api/router/orders",
    "/api/router/queue",
    "/api/selfcheck",
    "/api/settings",
    "/api/settings/package-rule",
    "/api/setup/status",
    "/api/sync/info",
    "/api/sync/qr.png",
    "/api/sync/test",
    "/api/tasks",
    "/api/tickets",
    "/api/tickets/<id>",
    "/api/tunnel/status",
    "/api/wechat/groups",
    "/api/wechat/status",
    "/api/work-orders",
    "/api/work-orders/events",
    "/calendar",
    "/calendar.ics",
    "/floatball",
    "/floatball.html",
    "/health",
    "/icon.svg",
    "/index.html",
    "/js/*",
    "/manifest.webmanifest",
    "/setup",
    "/sw.js",
    "/whale/hello.png",
    "/whale/done.png",
    "/whale/inbox.png",
    "/whale/settings.png",
    "/whale/pat.gif",
    "/whale/brand-still.png", "/whale/brand-react.gif", "/whale/key-token.png",
    "/whale/inbox-checklist.png", "/whale/guide-wave.png",
    "/workbench.css",
}
EXPECTED_POST = {
    "/api/desktop-pet/action",
    "/api/settings/reminders",
    "/api/settings/desktop-pet",
    "/api/settings/screening",
    "/api/chaoxing/auto_cookie",
    "/api/chaoxing/cookie/validate",
    "/api/dingtalk/scan",
    "/api/firewall/allow",
    "/api/history/fetch",
    "/api/history/fetch/cancel",
    "/api/hosting/start",
    "/api/hosting/stop",
    "/api/inbox/manual",
    "/api/inbox/promote",
    "/api/lab/rules",
    "/api/napcat/autosetup",
    "/api/napcat/connect",
    "/api/napcat/install",
    "/api/napcat/launch",
    "/api/napcat/restart",
    "/api/notifications/<id>/handle",
    "/api/onboarding/accept",
    "/api/packages",
    "/api/pair/approve",
    "/api/pair/deny",
    "/api/pair/pending/clear",
    "/api/pair/public",
    "/api/pair/start",
    "/api/raw/attachments",
    "/api/raw/batch",
    "/api/raw/download",
    "/api/router/decide",
    "/api/session/exchange",
    "/api/settings",
    "/api/settings/package-rule",
    "/api/settings/test-push",
    "/api/subscriptions",
    "/api/tasks/<id>",
    "/api/tasks/create",
    "/api/tasks/pin",
    "/api/tasks/urgent",
    "/api/tickets/actions",
    "/api/tunnel/start",
    "/api/tunnel/stop",
    "/api/wechat/scan",
    "/api/work-orders/action",
    "/api/work-orders/worker",
}

# 桌宠桥接在分派后检查独立的本机令牌，其余路由按网页会话鉴权。
PUBLIC_GET = {
    "/api/desktop-pet/state",
    "/health", "/api/health", "/manifest.webmanifest", "/icon.svg", "/sw.js",
    "/api/onboarding", "/api/pair/status", "/api/ping", "/workbench.css", "/whale/hello.png", "/whale/done.png",
    "/whale/inbox.png", "/whale/settings.png", "/whale/pat.gif",
    "/whale/brand-still.png", "/whale/brand-react.gif", "/whale/key-token.png",
    "/whale/inbox-checklist.png", "/whale/guide-wave.png",
}
PUBLIC_POST = {"/api/desktop-pet/action", "/api/onboarding/accept", "/api/pair/start", "/api/session/exchange"}

ALIASES = (
    ("GET", "/health", "/api/health"),
    ("GET", "/floatball", "/floatball.html"),
    ("GET", "/", "/index.html"),
    ("POST", "/api/tunnel/start", "/api/pair/public"),
    ("POST", "/api/hosting/start", "/api/hosting/stop"),
)


def _table(method: str) -> dict:
    return routes.GET_ROUTES if method == "GET" else routes.POST_ROUTES


def _labels(method: str) -> set:
    """表项 + 模式项登记名，合起来就是「分派 path 清单」。"""
    table = _table(method)
    patterns = routes.GET_PATTERN_ROUTES if method == "GET" else routes.POST_PATTERN_ROUTES
    return set(table) | {label for *_rest, label in patterns}


def _handler_src(name: str) -> str:
    # 以实际 Handler 的 MRO 找实现，覆盖各业务 mixin。
    return dedent(inspect.getsource(getattr(webapp._Handler, name)))


def _handler_node(name: str) -> ast.FunctionDef:
    node, = ast.parse(_handler_src(name)).body
    assert isinstance(node, ast.FunctionDef)
    return node


class RoutesTableTests(unittest.TestCase):
    def test_product_routes_are_exact(self) -> None:
        self.assertEqual(_labels("GET"), EXPECTED_GET)
        self.assertEqual(_labels("POST"), EXPECTED_POST)

    def test_every_registered_handler_exists(self) -> None:
        for method, patterns in (("GET", routes.GET_PATTERN_ROUTES), ("POST", routes.POST_PATTERN_ROUTES)):
            names = {handler for handler, _ in _table(method).values()}
            names.update(handler for _, handler, _, _ in patterns)
            for name in names:
                with self.subTest(method=method, handler=name):
                    self.assertTrue(callable(getattr(webapp._Handler, name)))

    def test_alias_groups_share_one_handler(self) -> None:
        for method, first, second in ALIASES:
            with self.subTest(pair=(first, second)):
                table = _table(method)
                self.assertEqual(table[first][0], table[second][0])

    def test_public_routes_are_exactly_the_pre_auth_ones(self) -> None:
        public_get = {path for path, (_, public) in routes.GET_ROUTES.items() if public}
        public_post = {path for path, (_, public) in routes.POST_ROUTES.items() if public}
        self.assertEqual(public_get, PUBLIC_GET)
        self.assertEqual(public_post, PUBLIC_POST)
        self.assertEqual(
            [(prefix, public, label) for prefix, _, public, label in routes.GET_PATTERN_ROUTES],
            [
                ("/js/", True, "/js/*"),
                ("/api/packages/", False, "/api/packages/<id>"),
                ("/api/tickets/", False, "/api/tickets/<id>"),
                ("/api/artifacts/", False, "/api/artifacts/<id>"),
            ],
        )

    def test_post_patterns_match_tasks_and_notification_replies(self) -> None:
        self.assertNotIn("/api/tasks/<id>", routes.POST_ROUTES)  # 不能按字面量登记
        self.assertEqual(
            [(prefix, public, label) for prefix, _, public, label in routes.POST_PATTERN_ROUTES],
            [
                ("/api/tasks/", False, "/api/tasks/<id>"),
                ("/api/notifications/", False, "/api/notifications/<id>/handle"),
            ],
        )
        self.assertEqual(routes.match_pattern("POST", "/api/tasks/7"), ("_route_post_tasks", False))
        self.assertEqual(
            routes.match_pattern("POST", "/api/notifications/note-1/handle"), ("_route_execution_proxy", False),
        )
        self.assertIsNone(routes.match_pattern("POST", "/api/tasks"))
        self.assertIsNone(routes.match_pattern("POST", "/api/meta"))

    def test_js_prefix_miss_falls_back_to_auth(self) -> None:
        """GET /js/ 未命中必须返回 False，让调用方继续走鉴权/404，不能回空响应。"""
        body = _handler_src("_route_get_js")
        self.assertIn("return True", body)
        self.assertIn("return False", body)


class DispatchStructureTests(unittest.TestCase):
    def test_dispatch_methods_have_no_hand_written_path_branches(self) -> None:
        for name in ("do_GET", "do_POST"):
            with self.subTest(method=name):
                leftovers = []
                for sub in ast.walk(_handler_node(name)):
                    if isinstance(sub, ast.If):
                        text = ast.unparse(sub.test)
                        if "path" in text and ("==" in text or " in " in text or "startswith" in text):
                            leftovers.append(text)
                if name == "do_POST":
                    # Framework 模式的写操作禁用检查也受网页鉴权保护。
                    gate, = [test for test in leftovers if "napcat_mode" in test]
                    gate_node = ast.parse(gate, mode="eval").body
                    self.assertIsInstance(gate_node, ast.BoolOp)
                    membership = gate_node.values[-1]
                    self.assertIsInstance(membership, ast.Compare)
                    self.assertEqual(ast.unparse(membership.left), "path")
                    self.assertIsInstance(membership.ops[0], ast.In)
                    self.assertEqual(ast.literal_eval(membership.comparators[0]), {
                        "/api/napcat/install", "/api/napcat/launch", "/api/napcat/restart",
                        "/api/napcat/autosetup", "/api/hosting/start", "/api/hosting/stop",
                    })
                    body = _handler_src(name)
                    self.assertLess(body.index("self._authorized()"), body.index("napcat_mode"))
                    leftovers.remove(gate)
                self.assertEqual(leftovers, [], "业务路径应登记在路由表")

    def test_dispatch_uses_tables_and_patterns(self) -> None:
        for method in ("GET", "POST"):
            with self.subTest(method=method):
                body = _handler_src(f"do_{method}")
                self.assertIn(f"routes.{method}_ROUTES.get(path)", body)
                self.assertEqual(body.count(f'routes.match_pattern("{method}", path)'), 1)

    def test_auth_gate_sits_between_public_and_private_dispatch(self) -> None:
        for name in ("do_GET", "do_POST"):
            with self.subTest(method=name):
                body = _handler_src(name)
                public_at = body.index("entry[1]")
                auth_at = body.index("self._authorized()")
                private_at = body.index("getattr(self, entry[0])(path)", auth_at)
                self.assertLess(public_at, auth_at)
                self.assertLess(auth_at, private_at)
                self.assertIn("getattr(self, pattern[0])(path)", body[auth_at:])
                if name == "do_GET":
                    self.assertIn("pattern[1] and getattr(self, pattern[0])(path)", body[:auth_at])
                    self.assertIn("not pattern[1]", body[auth_at:])
                else:
                    self.assertNotIn("getattr(self, pattern[0])(path)", body[:auth_at])


class AliasBehaviourTests(unittest.TestCase):
    def test_tunnel_confirm_gate_only_applies_to_the_new_path(self) -> None:
        body = _handler_src("_route_post_api_tunnel_start")
        self.assertIn('path == "/api/tunnel/start"', body)
        # 请求体只能读一次，所以确认闸改成 handler 自己比对 payload；
        # 但「只对新路径要确认」这条没变：path 判断必须排在 confirm 判断前面。
        self.assertLess(body.index('path == "/api/tunnel/start"'), body.index('payload.get("confirm") is not True'))

    def test_hosting_alias_keeps_path_identity(self) -> None:
        self.assertIn('path.endswith("/start")', _handler_src("_route_post_api_hosting_start"))


if __name__ == "__main__":
    unittest.main()
