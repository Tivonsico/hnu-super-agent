"""浏览器级行为测试（Playwright + runner 预装 Edge，channel=BROWSER_CHANNEL，零浏览器下载）。

只验最关键的两种真行为（替代 tests/test_webapp.py 里对 QR 相关内联 JS 源码字符串的断言；本文件是增量，老测试未动）：

1. NapCat 装了没启动时：`#qrbox` 容器可见，卡片上的主按钮是 `#go`（不是一张永远 hidden 的 `<img>`）。
2. 点 `#go` 走真实「启动引擎」链路（stub 掉 /api/napcat/launch）后：二维码图片真的加载出来、
   `#qrbox` 被页面自己滚进视口且有真实高度。

约定：
* 未安装 playwright 时整类 skipTest，本地与现有三平台 CI 照常绿（requirements-dev.txt 不进 requirements.txt）。
* 自起 TaskWebServer（随机端口、127.0.0.1）、跑完自停，绝不触碰 F:\\notice-hub 实例。
* 不跑 playwright install：channel=BROWSER_CHANNEL 用系统 Edge（windows-latest 预装 155）。
* 设 NH_BROWSER_ARTIFACT_DIR 时留存 trace.zip 与失败截图（CI 失败上传 artifact 用）。
"""

from __future__ import annotations

import datetime
import json
import os
import re
import sys
import tempfile
import time
import unittest
import urllib.request
from io import BytesIO
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# 推送设置那张「后端键名 → 输入框 id」对照表，直接从产品代码里读出来（不在这里另抄一份）：
# 抄一份的话，产品和测试会一起错，正是这个 bug 之前的模样。
SETTINGS_JS_SOURCE = (PROJECT_ROOT / "noticehub" / "web" / "web_static" / "js" / "settings.js").read_text(
    encoding="utf-8")
PUSH_FIELD_PAIRS = re.findall(r"\['([a-z_]+)','(push-[a-z_\-]+)'\]", SETTINGS_JS_SOURCE)

from noticehub.storage.sqlite.store import Store  # noqa: E402
from noticehub.platform.config import Settings  # noqa: E402
from noticehub.web.webapp import SESSION_COOKIE_NAME, TaskWebServer  # noqa: E402
from tests import (  # noqa: E402
    harden, isolate_browser_temp_env, open_authed_page, restore_browser_temp_env,
    scroll_into_view, wait_for_page_settled, open_settings, safe_close,
)

# 浏览器通道：CI 的 Windows runner 预装 Edge，用 msedge；macOS 本地没有 Edge，
# 用 NH_BROWSER_CHANNEL=chrome 直接跑本机 Chrome（不下载 playwright 自带浏览器）。
BROWSER_CHANNEL = os.environ.get("NH_BROWSER_CHANNEL", "msedge")

try:
    from playwright.sync_api import expect, sync_playwright
    HAVE_PLAYWRIGHT = True
except ImportError:  # pragma: no cover - 无 playwright 的环境走 skip
    HAVE_PLAYWRIGHT = False

# CI 的 browser job 设 NH_REQUIRE_BROWSER=1：那时「缺 playwright」不许再静默跳过，
# 否则这条防线在 CI 里等于不存在（没人知道自己没被保护）。本地不设，没装依赖也能跑别的。
REQUIRE_BROWSER = os.environ.get("NH_REQUIRE_BROWSER") == "1"
if REQUIRE_BROWSER and not HAVE_PLAYWRIGHT:  # pragma: no cover - 只在 CI 缺依赖时触发
    raise RuntimeError(
        "NH_REQUIRE_BROWSER=1 但没装 playwright：先 pip install -r requirements-dev.txt。"
        "这道检查不允许被 skip 掉。")

TOKEN = "browser-test-token"


@unittest.skipUnless(HAVE_PLAYWRIGHT, "playwright 未安装（pip install -r requirements-dev.txt）")
class QrViewportBrowserTest(unittest.TestCase):
    _temp_env_restore: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        # Playwright 的 Node 驱动用 os.tmpdir()（TEMP/TMP 环境变量）建 artifacts 目录，
        # 不看 Python 的 tempfile.tempdir；%TEMP% 不可写的机器上会 EPERM。
        # 共用逻辑在 tests/__init__.py，别在这里再写一份。
        cls._temp_env_restore = isolate_browser_temp_env()

    @classmethod
    def tearDownClass(cls) -> None:
        restore_browser_temp_env(cls._temp_env_restore)
        cls._temp_env_restore = {}

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        # 清理顺序（addCleanup 是后进先出）：先 _stop_server，再 _remove_temp_dir。
        self.addCleanup(self._remove_temp_dir)
        self.artifact_dir = os.environ.get("NH_BROWSER_ARTIFACT_DIR", "").strip()
        store = Store(Path(self.tmp.name) / "api.sqlite3")
        settings = Settings(
            web_host="127.0.0.1",
            web_port=0,
            web_token=TOKEN,
            data_dir=Path(self.tmp.name) / "data",
        )
        self.server = TaskWebServer(settings, store)
        self.assertTrue(self.server.start(), "TaskWebServer 启动失败")
        self.addCleanup(self._stop_server)
        assert self.server.server is not None
        self.base = "http://127.0.0.1:%d" % self.server.server.server_address[1]
        # 冷装首开有 onboarding 遮罩层（<div id="onboarding">）。本测试虽不点击页面，
        # 仍走真实接口先把引导标记为已读，让浏览器里的首屏状态与「用户已过引导」一致、可复现。
        accept = urllib.request.Request(
            self.base + "/api/onboarding/accept", data=b"{}",
            headers={"X-Token": TOKEN, "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(accept, timeout=10) as response:
            self.assertEqual(response.status, 200)
        # 服务端 hosting 动作一律打桩：本类只验浏览器渲染，不起 QQ/NapCat、不查进程
        # （照抄 tests/test_webapp.py TaskApiTest.setUp 的做法）。
        for target, value in (
            ("noticehub.web.webapp.hosting.quit_user_qq",
             {"ok": True, "pids": [], "already_closed": True, "forced": False, "remaining": [], "error": None}),
            ("noticehub.web.webapp.hosting.start_user_qq",
             {"ok": True, "pid": None, "already_running": True, "error": None}),
            ("noticehub.web.webapp.hosting._processes", []),
            ("noticehub.web.webapp.hosting._bridge", {"ok": True, "error": None}),
        ):
            patcher = mock.patch(target, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # 浏览器侧 NapCat 运行态：点「启动并获取二维码」之后才变 true，模拟真实一键接入。
        self.napcat_running = False

    # —— 用例清理：先让服务停稳，再删隔离目录 ——

    def _stop_server(self) -> None:
        """停服务，并等正在处理的请求真正退干净。

        服务端是 `_BoundedThreadingHTTPServer`（`daemon_threads = True`），
        `server_close()` 只关监听套接字、**不会** join 请求线程：页面 5s/10s 的轮询
        可能在 teardown 时仍有一个请求正在写 `api.sqlite3`，此时删目录就是
        `PermissionError: [WinError 32]`。所以这里盯着它自己的活动连接计数等落零。
        `Store` 不用关：它的连接是 `_connect()` 里每次调用自开自关，没有常驻句柄。
        """
        httpd = getattr(self.server, "server", None)  # stop() 会把它置 None，先抓住
        self.server.stop()
        deadline = time.monotonic() + 5
        while httpd is not None and time.monotonic() < deadline:
            if not getattr(httpd, "_active_connections", 0):
                break
            time.sleep(0.05)

    def _remove_temp_dir(self) -> None:
        """删隔离目录；Windows 释放 sqlite 文件句柄有几十毫秒延迟，所以有限次重试。

        最多 5 次、每次 100ms；最后一次仍失败就照常抛出——不 ignore，句柄泄漏必须暴露。
        """
        last_error: PermissionError | None = None
        for _ in range(5):
            try:
                self.tmp.cleanup()
            except PermissionError as error:
                last_error = error
                time.sleep(0.1)
            else:
                return
        raise last_error

    def _wait_page_settled(self, page, frames: int = 5, budget: int = 10000) -> dict:
        """等整页排版稳定：连续 frames 帧里整页高度与体检面板的位置/高度都不变。

        只盯横幅自己不动是不够的：横幅**上方**的 `.summary`（`#headline` 从「加载中…」
        换成真标题、`#upcoming-carousel` 从 hidden 变可见）同样会异步长高，把整行推下去。
        CI 上就是它让 before 量到 322、展开后变成 463，看起来像「列表把横幅推走」。
        所以这里盯 `document.body.scrollHeight`，只要整页还在长就不算稳。
        超时返回最后一组值（不抛、不挂死），交给断言自己判断。
        """
        return page.evaluate(
            """({frames, budget}) => new Promise(resolve => {
                const deadline = performance.now() + budget;
                const snap = () => {
                    const panel = document.getElementById('platform-setup-panel');
                    return {
                        body: Math.round(document.body.scrollHeight),
                        panel_top: panel ? Math.round(panel.offsetTop) : -1,
                        panel_height: panel ? Math.round(panel.offsetHeight) : -1};
                };
                const key = (s) => s.body + '|' + s.panel_top + '|' + s.panel_height;
                let last = '', same = 0, current = snap();
                const tick = () => {
                    current = snap();
                    same = key(current) === last ? same + 1 : 0;
                    last = key(current);
                    if (same >= frames || performance.now() > deadline) return resolve(current);
                    requestAnimationFrame(tick);
                };
                tick();
            })""",
            {"frames": frames, "budget": budget})

    # —— 浏览器侧接口 stub（请求不落到服务端，CI runner 上没有 NapCat 也能跑） ——

    def _napcat_status_stub(self, route) -> None:
        running = self.napcat_running
        body = json.dumps({
            "ok": True,
            "online": False,
            "napcat_running": running,
            "napcat_installed": True,
            "napcat_root": "browser-test-fixture",
            "qr_stamp": "fixture-qr-running" if running else "fixture-qr-idle",
        })
        route.fulfill(status=200, content_type="application/json", body=body)

    def _napcat_launch_stub(self, route) -> None:
        # 启动引擎成功、正在等扫码登录 —— 页面随后会 checkSetup() + showQrAfterAction()。
        self.napcat_running = True
        body = json.dumps({"ok": True})
        route.fulfill(status=200, content_type="application/json", body=body)

    def _napcat_qrcode_stub(self, route) -> None:
        # /api/napcat/qrcode 正常由 napcat_admin 读登录二维码文件；冷装没有 NapCat，
        # 这里喂一张真 PNG（PIL 现生成），让页面的 img.onload 路径真实走通。
        from PIL import Image
        buffer = BytesIO()
        Image.new("RGB", (64, 64), "white").save(buffer, format="PNG")
        route.fulfill(status=200, content_type="image/png", body=buffer.getvalue())

    def test_qr_box_renders_inside_viewport(self) -> None:
        trace_path = os.path.join(self.artifact_dir, "trace.zip") if self.artifact_dir else ""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 800})
                context.tracing.start(screenshots=True, snapshots=True)
                page = context.new_page()
                page.route("**/api/napcat/status", self._napcat_status_stub)
                page.route("**/api/napcat/launch", self._napcat_launch_stub)
                page.route("**/api/napcat/qrcode**", self._napcat_qrcode_stub)
                try:
                    # nowiz=1：跳过「选择要接入的平台」首装向导（page.html:3496 openWizard
                    # 里 nowiz=1 直接 return），否则模态框会盖住整页拦截点击。
                    open_authed_page(context, page, self.base, TOKEN)
                    # 新 UI：QQ 接入在「设置」页签里，先切过去再找这些元素。
                    open_settings(page)
                    # ① 装了没启动：容器在、图片隐藏、主按钮是「启动引擎并显示二维码」（#go）。
                    page.wait_for_selector("#qrbox", state="visible", timeout=15000)
                    page.wait_for_selector("#go", state="visible", timeout=15000)
                    self.assertTrue(page.is_hidden("#qr"), "#qr 未启动时不应显示")
                    # 滚到容器再量命中：按钮不能只是「有尺寸」而实际被别的层盖住。
                    scroll_into_view(page, "#qrbox")
                    scroll_into_view(page, "#go")
                    hit = page.eval_on_selector(
                        "#go",
                        """el => {
                            const r = el.getBoundingClientRect();
                            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                            return {ok: !!hit && (hit === el || el.contains(hit)),
                                    hitTag: hit ? hit.tagName + '#' + hit.id : null,
                                    top: r.top, bottom: r.bottom, height: r.height};}""")
                    self.assertGreater(hit["height"], 0, hit)
                    self.assertTrue(hit["ok"], hit)

                    # ② 点启动按钮：走真实 run() → checkSetup() + showQrAfterAction()，
                    # 后者把 #qrbox scrollIntoView 进视口，refreshQr() 让真 PNG 走 img.onload。
                    page.click("#go")
                    page.wait_for_selector("#qr:not([hidden])", state="visible", timeout=15000)
                    page.wait_for_function(
                        "() => { const i = document.getElementById('qr');"
                        " return i && i.complete && i.naturalWidth > 0; }", timeout=15000)
                    self.assertTrue(page.is_hidden("#go"), "启动后启动按钮应隐藏")
                    # 页面自己的 scrollIntoView 可能是平滑滚动，等它停稳再量
                    page.wait_for_function(
                        "() => { const r = document.getElementById('qrbox').getBoundingClientRect();"
                        " return r.top >= 0 && r.bottom <= window.innerHeight; }", timeout=15000)
                    metrics = page.eval_on_selector(
                        "#qrbox",
                        """el => {
                            const r = el.getBoundingClientRect();
                            return {top: r.top, bottom: r.bottom, height: r.height,
                                    viewportHeight: window.innerHeight};}""")
                    self.assertGreater(metrics["height"], 0, metrics)
                    self.assertGreaterEqual(metrics["top"], 0, metrics)
                    self.assertLessEqual(metrics["bottom"], metrics["viewportHeight"], metrics)
                except Exception:
                    if self.artifact_dir:
                        os.makedirs(self.artifact_dir, exist_ok=True)
                        page.screenshot(path=os.path.join(self.artifact_dir, "qr-viewport-failure.png"),
                                        full_page=True)
                    raise
                finally:
                    if trace_path:
                        os.makedirs(self.artifact_dir, exist_ok=True)
                        context.tracing.stop(path=trace_path)
                    else:
                        context.tracing.stop()
                    safe_close(context)
            finally:
                browser.close()


    def _connect_status_stub(self, route) -> None:
        """「手动起的 NapCat 在跑、接口没通」：页面必须给出唯一可点的「帮我连上它」。"""
        body = json.dumps({
            "ok": False,
            "online": False,
            "napcat_running": False,
            "napcat_installed": True,
            "napcat_root": "browser-test-fixture",
            "stage": "running_no_api",
            "can_connect": True,
            "connect_url": "/api/napcat/connect",
            "napcat_api_url": "http://127.0.0.1:3001",
            "napcat_api_candidates": ["http://127.0.0.1:3001", "http://127.0.0.1:3000"],
            "error": "检测到这台机器上有 NapCat 在跑（像你手动启动的那份），但本程序连不上它的 OneBot 接口。"
                     "点「帮我连上它」：程序会去读 NapCat 自己的配置，按它实际开的端口接上，不用你自己找端口。",
        })
        route.fulfill(status=200, content_type="application/json", body=body)

    def test_running_no_api_offers_one_click_to_connect(self) -> None:
        """第五态：引擎在跑但接口没通。

        此前这个状态在 plans 里没有对应项，四个按钮全 hidden、提示停在「正在检查 NapCat 引擎…」，
        整张卡没有一个能点的东西。现在只露「帮我连上它」主按钮（+「重启引擎」次按钮）；
        点下去必须真的 POST /api/napcat/connect：成功报出新地址，失败把 WebUI 地址摆出来。
        """
        posts: list = []
        state = {"mode": "ok"}

        def connect_stub(route) -> None:
            posts.append(route.request.method)
            if state["mode"] == "ok":
                body = json.dumps({
                    "ok": True, "api_url": "http://127.0.0.1:3000",
                    "tried": ["http://127.0.0.1:3001", "http://127.0.0.1:3000"],
                    "persisted": True, "persist_error": "",
                })
            else:
                body = json.dumps({
                    "ok": False, "stage": "running_no_api",
                    "webui_url": "http://127.0.0.1:6099",
                    "tried": [{"url": "http://127.0.0.1:3001"}, {"url": "http://127.0.0.1:3000"}],
                    "error": "3001 和 3000 都没连上：NapCat 的 HTTP 服务可能没开。",
                })
            route.fulfill(status=200, content_type="application/json", body=body)

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                for width in (1280, 390):
                    # 每个宽度都从「成功」这一档重新走：state/posts 跨宽度共用，不清就会串档。
                    state["mode"] = "ok"
                    posts.clear()
                    context = browser.new_context(viewport={"width": width, "height": 900})
                    page = context.new_page()
                    page.route("**/api/napcat/status", self._connect_status_stub)
                    page.route("**/api/napcat/connect", connect_stub)
                    try:
                        open_authed_page(context, page, self.base, TOKEN)
                        open_settings(page)
                        page.wait_for_selector("#napcat-connect", state="visible", timeout=15000)
                        # 一个区域只留一个主行动：安装/启动/刷新全收起，重启留作次按钮。
                        for hidden_id in ("#auto-setup", "#go", "#refresh-qr"):
                            self.assertTrue(page.is_hidden(hidden_id), hidden_id)
                        self.assertFalse(page.is_hidden("#restart-napcat"), "重启引擎应作为次按钮留着")
                        self.assertIn("帮我连上它", page.inner_text("#napcat-connect"))
                        # 引擎行只留一个短状态词：整句「在跑但连不上接口」由上方的黄框说，别同一句说两遍。
                        self.assertIn("NapCat 进程在跑", page.inner_text("#napcat-engine"))
                        self.assertIn("接口未连", page.inner_text("#napcat-engine"))
                        # 二维码区不能自相矛盾（引擎明明在跑，却写「还没启动」），也不能指向本状态 hidden 的按钮。
                        qr_note = page.inner_text("#qr-note")
                        self.assertNotIn("还没启动", qr_note)
                        self.assertNotIn("启动引擎并显示二维码", qr_note)
                        self.assertIn("接口连上之后", qr_note)
                        # 有尺寸且不被挡住：中心点命中的必须是它自己。
                        scroll_into_view(page, "#napcat-connect")
                        hit = page.eval_on_selector("#napcat-connect", """el => {
                            const r = el.getBoundingClientRect();
                            const found = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                            return {ok: !!found && (found === el || el.contains(found)),
                                    tag: found ? found.tagName + '#' + found.id : null, height: r.height};}""")
                        self.assertGreater(hit["height"], 0, hit)
                        self.assertTrue(hit["ok"], hit)
                        # ① 成功：确实 POST 出去了，并把接上的地址说出来。
                        page.click("#napcat-connect")
                        page.wait_for_function(
                            "() => (document.getElementById('steps').textContent || '').indexOf('已连上 NapCat 的接口') >= 0",
                            timeout=15000)
                        self.assertEqual(posts, ["POST"], posts)
                        # ② 失败：状态里有原因和试过的地址，另有 WebUI 地址可点（不是一句报错就完事）。
                        state["mode"] = "fail"
                        page.wait_for_function(
                            "() => !document.getElementById('napcat-connect').disabled", timeout=15000)
                        page.click("#napcat-connect")
                        page.wait_for_selector("#napcat-connect-help", state="visible", timeout=15000)
                        status_text = page.inner_text("#status")
                        self.assertIn("3001 和 3000 都没连上", status_text)
                        self.assertIn("http://127.0.0.1:3001", status_text)
                        self.assertIn("6099", page.inner_text("#napcat-connect-help"))
                        href = page.eval_on_selector("#napcat-connect-help a", "el => el.href")
                        self.assertIn("6099", href)
                        # 同一件事不在两个位置说两遍：底部只留一句指路，不重复黄框的错误原文。
                        steps_text = page.inner_text("#steps")
                        self.assertNotIn("3001 和 3000 都没连上", steps_text)
                        self.assertIn("见上面的 WebUI 链接", steps_text)
                        self.assertEqual(posts, ["POST", "POST"], posts)
                    finally:
                        safe_close(context)
            finally:
                browser.close()

    def test_banner_stable(self) -> None:
        """QQ 接入卡顶部黄色提示：5 秒轮询会在 1–5 行之间换文案，容器高度必须恒定，
        否则下方按钮/二维码会被挤得上下跳（用户实测的复选框回归）。
        `.status-slot 里放了一条隐藏的「最长文案」占位，这里用真实几何断言。"""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                for width in (1280, 390):
                    context = browser.new_context(viewport={"width": width, "height": 900})
                    page = context.new_page()
                    page.route("**/api/napcat/status", self._napcat_status_stub)
                    try:
                        open_authed_page(context, page, self.base, TOKEN)
                        page.wait_for_selector("#status", state="attached", timeout=15000)
                        open_settings(page)
                        measured = page.evaluate("""() => {
                            const el = document.getElementById('status');
                            const slot = document.querySelector('.status-slot');
                            const below = document.querySelector('.connect-actions');
                            if (!el || !slot || !below) return null;
                            const texts = [
                              'QQ 未登录',
                              '还没装 NapCat：点上面的「下载安装并启动」；或把手头的 NapCat 放进程序数据目录下的 napcat\\\\ 后点「重新检测」。',
                              '等待 QQ 登录（已等 12 秒）：接口要等登录成功才会开，现在连不上是正常的。用手机 QQ 扫下面的二维码，扫完在手机上点「确认登录」。二维码一会就过期，图换了就扫最新的那张；等了 90 秒还没动静，点「重启引擎」再扫。',
                              'NapCat 的接口端口（127.0.0.1:3001）在监听，但接口调用失败：这是配置问题，不是没登录，继续扫码解决不了。请核对连接密码是否和 NapCat 里填的一致，以及 3001 端口是否被别的程序占用（换端口或关掉占用它的程序），改完点「重启引擎」。'
                            ];
                            const rows = [];
                            for (const t of texts) {
                              el.textContent = t;
                              rows.push({card: el.getBoundingClientRect().height,
                                         slot: slot.getBoundingClientRect().height,
                                         below: below.getBoundingClientRect().top});
                            }
                            return rows;
                        }""")
                        self.assertIsNotNone(measured, "没找到 #status / .status-slot / .connect-actions")
                        cards = [r["card"] for r in measured]
                        slots = [r["slot"] for r in measured]
                        tops = [r["below"] for r in measured]
                        self.assertLessEqual(max(cards) - min(cards), 1,
                                             "黄框高度随文案变化：%s" % measured)
                        self.assertLessEqual(max(slots) - min(slots), 1,
                                             "占位槽高度随文案变化：%s" % measured)
                        self.assertLessEqual(max(tops) - min(tops), 1,
                                             "下方按钮被挤动：%s" % measured)
                        # 占位那条必须是「最长文案」：换成它自己的文字时高度也不能变矮
                        self.assertGreater(min(cards), 0, measured)
                    finally:
                        safe_close(context)
            finally:
                browser.close()


    def test_workbench_reviews_a_local_result_and_queues_followup(self) -> None:
        ticket_id = self.server.store.upsert_task(task_key="review-fixture", summary="核对展示材料")
        with sync_playwright() as runner:
            browser = runner.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
            try:
                headers = {"X-Token": TOKEN}
                base = self.base + "/api/work-orders"
                for revision, action, note in ((0, "claim", ""), (1, "complete", "请查收材料 v1")):
                    response = page.request.post(base + "/worker", headers=headers, data={
                        "id": ticket_id, "revision": revision, "action": action, "note": note,
                    })
                    self.assertTrue(response.ok, response.text())
                open_authed_page(context, page, self.base, TOKEN)
                page.locator(".wb-filters").get_by_role("button", name="全部").click()
                page.locator(".wb-list").get_by_role("button", name="核对展示材料").click()
                detail = page.locator(".wb-detail")
                detail.get_by_role("button", name="确认完成").click()
                expect(detail.get_by_text("已确认", exact=True)).to_be_visible()
                page.reload()
                page.locator(".wb-filters").get_by_role("button", name="全部").click()
                expect(detail.get_by_text("已确认", exact=True)).to_be_visible()
                detail.get_by_role("button", name="还有问题").click()
                detail.get_by_label("追加提示词").fill("补上参考文献")
                detail.get_by_role("button", name="发送反馈").click()
                expect(detail.get_by_text("等待 Worker 接单", exact=True)).to_be_visible()
                expect(detail.get_by_text("补上参考文献", exact=True)).to_be_visible()
                expect(detail.get_by_text("请查收材料 v1", exact=True)).to_be_visible()
                orders = page.request.get(self.base + "/api/router/orders", headers=headers).json()
                saved = next(order for order in orders["orders"] if order["id"] == ticket_id)
                self.assertEqual(saved["latest_supplement"], "补上参考文献")
            finally:
                safe_close(context)
                browser.close()

    def test_workbench_toolbar_hides_and_merges_without_losing_the_source(self) -> None:
        store = self.server.store
        store.insert_message(msg_id="qq:origin", group_id="class", content="命中的完整原话", source="onebot")
        source_id = store.upsert_task(task_key="qq:origin", summary="来源工单")
        target_id = store.upsert_task(task_key="target", summary="目标工单")
        with sync_playwright() as runner:
            browser = runner.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
            try:
                open_authed_page(context, page, self.base, TOKEN)
                page.locator(".wb-filters").get_by_role("button", name="全部").click()
                queue = page.locator(".wb-list")
                detail = page.locator(".wb-detail")
                queue.get_by_role("button", name="来源工单").click()
                for action in ("补充工单", "合并工单至", "停止工单", "隐藏工单"):
                    expect(detail.get_by_role("button", name=action, exact=True)).to_be_visible()
                detail.get_by_role("button", name="更多操作").click()
                expect(detail.get_by_role("button", name="修改截止时间")).to_be_visible()
                detail.get_by_role("button", name="查看原始消息").click()
                detail.get_by_role("link", name="在收件箱查看原消息包").click()
                expect(page.locator("#inbox-items .inbox-original-body")).to_have_text("命中的完整原话")
                page.locator("#tab-tasks-button").click()
                queue.get_by_role("button", name="来源工单").click()
                detail.get_by_role("button", name="隐藏工单", exact=True).click()
                expect(queue.get_by_role("button", name="来源工单")).to_have_count(0)
                page.get_by_role("button", name="归档工单").click()
                queue.get_by_role("button", name="来源工单").click()
                detail.get_by_role("button", name="恢复显示").click()
                detail.get_by_role("button", name="合并工单至").click()
                page.get_by_label("目标工单").select_option(str(target_id))
                page.get_by_role("button", name="确认合并").click()
                expect(detail.get_by_role("button", name=f"查看关联工单 {source_id}")).to_be_visible()
                detail.get_by_role("button", name=f"查看关联工单 {source_id}").click()
                expect(detail.get_by_role("button", name=f"查看关联工单 {target_id}")).to_be_visible()
                expect(detail.get_by_text("工单资料", exact=True)).to_have_count(0)
            finally:
                safe_close(context)
                browser.close()

    def test_workbench_keeps_add_message_without_removed_shortcuts(self) -> None:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                try:
                    page.route("**/api/tasks", lambda route: route.fulfill(json={
                        "ok": True, "today": [], "week": [], "later": [],
                        "done": [], "candidates": [], "stats": {},
                    }))
                    open_authed_page(context, page, self.base, TOKEN)
                    page.locator("#tab-tasks #calendar-panel").wait_for()
                    for button in ("rail-copy-today", "rail-export-ics", "rail-show-qr", "tasks-clear-done", "rail-top"):
                        self.assertEqual(page.locator("#" + button).count(), 0, button)
                    for stat in ("stat-open", "stat-overdue", "stat-done"):
                        self.assertEqual(page.locator("#" + stat).count(), 0, stat)
                    self.assertEqual(page.get_by_text("今天没有需要处理的事项").count(), 0)
                    page.locator("#wb-new").click()
                    expect(page.locator("#inbox-add-form")).to_be_visible()
                finally:
                    safe_close(context)
            finally:
                browser.close()


    def test_onboarding_saves_inline_and_retries_only_failed_steps(self) -> None:
        with sync_playwright() as playwright:
            launch_options = {"channel": BROWSER_CHANNEL} if BROWSER_CHANNEL else {}
            browser = playwright.chromium.launch(headless=True, **launch_options)
            try:
                context = browser.new_context(viewport={"width": 390, "height": 720})
                page = context.new_page()
                writes = []

                def settings(route):
                    if route.request.method != "POST":
                        route.continue_()
                        return
                    body = route.request.post_data_json
                    writes.append(body)
                    if "dingtalk_enabled" in body and len(writes) == 2:
                        route.fulfill(status=500, json={"ok": False, "error": "暂时无法保存"})
                    else:
                        route.fulfill(json={"ok": True, "dingtalk_enabled": True})

                page.route("**/api/settings", settings)
                open_authed_page(context, page, self.base, TOKEN)
                page.evaluate("window.openSuperDotStartGuide()")
                guide = page.locator("#onboarding")
                expect(guide).to_be_visible()
                guide.locator("#guide-api-key").fill("test-deepseek-key")
                guide.get_by_role("button", name="配置钉钉").click()
                guide.get_by_label("启用钉钉").check()
                save = guide.get_by_role("button", name="保存并继续")
                save.click()
                expect(guide.get_by_role("status").filter(has_text="钉钉保存失败")).to_be_visible()
                expect(guide.locator("#guide-api-key")).to_have_value("")
                save.click()
                expect(guide).to_be_hidden()
                expect(page.locator("#tab-tasks")).to_be_visible()
                self.assertEqual(writes, [
                    {"llm_provider": "deepseek", "llm_api_key": "test-deepseek-key", "llm_model": "deepseek-flash"},
                    {"dingtalk_enabled": True},
                    {"dingtalk_enabled": True},
                ])
            finally:
                browser.close()

    def test_onboarding_wechat_detects_and_keeps_recovery_in_the_guide(self) -> None:
        with sync_playwright() as playwright:
            launch_options = {"channel": BROWSER_CHANNEL} if BROWSER_CHANNEL else {}
            browser = playwright.chromium.launch(headless=True, **launch_options)
            try:
                context = browser.new_context(viewport={"width": 390, "height": 720})
                page = context.new_page()
                detections = []
                writes = []
                fixture_key = "42" * 32

                def wechat(route):
                    detections.append(route.request.url)
                    if len(detections) == 1:
                        route.fulfill(json={
                            "ok": False, "groups": [], "category": "no_database",
                            "error": "请打开并登录桌面微信，再重新检测。",
                        })
                    elif len(detections) == 2:
                        route.fulfill(json={
                            "ok": False, "groups": [], "category": "missing_key",
                            "error": "已找到本机微信。请在「本机连接设置」填入已有的解密密钥，再重新检测。",
                        })
                    else:
                        route.fulfill(json={"ok": True, "groups": [{"id": "test-group", "name": "项目群"}]})

                def settings(route):
                    if route.request.method != "POST":
                        route.fulfill(json={"ok": True, "wechat_enabled": False, "wechat_group_whitelist": []})
                        return
                    writes.append(route.request.post_data_json)
                    route.fulfill(json={"ok": True, **writes[-1]})

                page.route("**/api/wechat/groups?setup=1", wechat)
                page.route("**/api/settings", settings)
                open_authed_page(context, page, self.base, TOKEN)
                page.evaluate("window.openSuperDotStartGuide()")
                guide = page.locator("#onboarding")
                guide.get_by_role("button", name="配置微信").click()
                expect(guide.get_by_text("请打开并登录桌面微信，再重新检测。")).to_be_visible()
                expect(guide.get_by_text("本机连接设置")).to_be_visible()
                guide.get_by_role("button", name="重新检测").click()
                expect(guide.get_by_text("待填密钥")).to_be_visible()
                key_input = guide.get_by_label("解密密钥")
                expect(key_input).to_be_visible()
                key_input.fill(fixture_key)
                guide.get_by_role("button", name="重新检测").click()
                guide.get_by_label("项目群").check()
                expect(key_input).to_have_value("")
                expect(guide.get_by_label("启用微信")).to_be_checked()
                guide.get_by_role("button", name="保存并继续").click()
                expect(guide).to_be_hidden()
                expect(page.locator("#tab-tasks")).to_be_visible()
                self.assertEqual(len(detections), 3)
                self.assertEqual(writes, [
                    {"wechat_key": fixture_key},
                    {"wechat_group_whitelist": ["test-group"], "wechat_enabled": True},
                ])
            finally:
                browser.close()

    def test_chaoxing_settings_connects_then_shows_courses(self) -> None:
        with sync_playwright() as playwright:
            launch_options = {"channel": BROWSER_CHANNEL} if BROWSER_CHANNEL else {}
            browser = playwright.chromium.launch(headless=True, **launch_options)
            try:
                for automatic in (False, True):
                    with self.subTest(automatic=automatic):
                        context = browser.new_context(viewport={"width": 390, "height": 720})
                        page = context.new_page()
                        writes = []
                        rows = [{"course_name": "测试课程", "course_id": "c1"}]

                        def settings(route):
                            if route.request.method == "GET":
                                route.fulfill(json={
                                    "ok": True, "chaoxing_enabled": False, "chaoxing_group_whitelist": ["old-course"],
                                    "chaoxing_status": {"auto_cookie_supported": automatic, "has_cookie": False,
                                                        "auto_cookie_reason": "" if automatic else "unsupported_platform"},
                                })
                                return
                            body = route.request.post_data_json
                            writes.append(body)
                            if body.get("chaoxing_cookie") == "sid=invalid-fixture":
                                route.fulfill(status=400, json={"ok": False, "error": "登录凭证已过期。"})
                                return
                            route.fulfill(json={"ok": True, "course_items": rows})

                        page.route("**/api/settings", settings)
                        attempts = []

                        def detect_login(route):
                            attempts.append(route.request.url)
                            if len(attempts) == 1:
                                route.fulfill(json={"ok": False, "category": "browser_locked"})
                            else:
                                route.fulfill(json={"ok": True, "course_items": rows})

                        page.route("**/api/chaoxing/auto_cookie", detect_login)
                        self._open_settings(context, page)
                        page.locator('.settings-group[data-group="channels"] > summary').click()
                        card = page.locator("#chaoxing-settings-card")
                        card.locator("details.settings-card > summary").click()
                        expect(card.get_by_role("button", name="保存课程订阅")).to_be_hidden()
                        detect = card.get_by_role("button", name="自动连接")
                        if automatic:
                            detect.click()
                            expect(card.get_by_text("浏览器的 Cookie 库正被占用", exact=False)).to_be_visible()
                            expect(detect).to_be_enabled()
                            detect.click()
                        else:
                            expect(detect).to_be_hidden()
                            expect(card.get_by_text("这台电脑不能自动读取浏览器登录凭证", exact=False)).to_be_visible()
                            card.locator("summary", has_text="其他接入方式").click()
                            credential = card.get_by_label("粘贴登录凭证（Cookie 或 cURL）")
                            import_button = card.get_by_role("button", name="验证并读取课程")
                            credential.fill("sid=invalid-fixture")
                            import_button.click()
                            expect(card.get_by_text("登录凭证已过期。")).to_be_visible()
                            expect(card.get_by_role("button", name="保存课程订阅")).to_be_hidden()
                            credential.fill("sid=valid-fixture")
                            import_button.click()
                            expect(credential).to_have_value("")
                            self.assertEqual(writes[-1], {
                                "chaoxing_cookie": "sid=valid-fixture", "chaoxing_verify_cookie": True,
                            })
                        expect(card.locator("#cx-status")).to_have_text("已连接")
                        card.get_by_label("测试课程").check()
                        card.get_by_role("button", name="保存课程订阅").click()
                        expect(card.get_by_text("课程订阅已保存。")).to_be_visible()
                        self.assertEqual(writes[-1], {"chaoxing_enabled": True, "chaoxing_group_whitelist": ["c1"]})
                        safe_close(context)
            finally:
                browser.close()

    def test_settings_run_info_shows_real_port_and_its_source(self) -> None:
        """运行信息里多一行「服务端口」：环境变量优先于 .env，启动器还可能在端口被占时往上找。

        用户写了 58066 却听在 58067、全程没提示，所以这一行显示的是**真正听在哪**。
        来源是环境变量时必须说清「已覆盖 .env」，不能只写「来源：环境变量」；
        字段缺失（老后端）整行不出现，不显示「未知」也不显示 0。
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                real = urllib.request.urlopen(urllib.request.Request(
                    self.base + "/api/meta", headers={"X-Token": TOKEN}), timeout=10
                ).read().decode("utf-8")
                for case in ("dotenv", "env", "missing"):
                    payload = json.loads(real)
                    if case == "missing":
                        payload.pop("web_port", None)
                        payload.pop("web_port_source", None)
                    else:
                        payload["web_port"] = 8766 if case == "dotenv" else 58067
                        payload["web_port_source"] = case
                    body = json.dumps(payload)
                    context = browser.new_context(viewport={"width": 1280, "height": 900})
                    page = context.new_page()

                    # Playwright 会把 (route, request) 一起传进来，handler 只能收 route，
                    # 所以体用闭包工厂绑住，别写成 lambda 默认参数（第二个参数会被 Request 顶掉）。
                    def make_meta_stub(payload):
                        def handler(route):
                            route.fulfill(status=200, content_type="application/json", body=payload)
                        return handler

                    try:
                        page.route("**/api/meta", make_meta_stub(body))
                        open_authed_page(context, page, self.base, TOKEN)
                        # 走公共的 open_settings：它用 DOM click 并按「页签真的不 hidden」重试，
                        # 而裸的 page.click 会被首启引导/通知浮层在命中判定与派发之间抢走
                        # （CI 上实测过一次设置页始终 hidden，同 commit 别的轮次全绿）。
                        open_settings(page)
                        if case == "missing":
                            # 老后端：这一行整行不出现（别的行照旧）。
                            page.wait_for_selector('[data-setting-anchor="runtime"] h2', timeout=15000)
                            page.wait_for_timeout(400)
                            self.assertEqual(
                                page.evaluate("() => document.querySelectorAll('.kv[data-row=\"web-port\"]').length"),
                                0, "字段缺失时不该显示这一行")
                        else:
                            page.wait_for_selector('.kv[data-row="web-port"]', state="visible", timeout=15000)
                            text = page.inner_text('.kv[data-row="web-port"]')
                            if case == "dotenv":
                                self.assertEqual(text.replace("\n", " ").strip(), "服务端口 8766", text)
                            else:
                                self.assertEqual(text.replace("\n", " ").strip(),
                                                 "服务端口 58067（来自环境变量，已覆盖 .env）", text)
                                self.assertIn("已覆盖 .env", text)
                    finally:
                        safe_close(context)
            finally:
                browser.close()


    def test_upcoming_cards_equal_and_hover_visible(self) -> None:
        """长短标题同排等高；悬停上移的顶边仍在滚动容器内且能命中。"""
        payload = self._upcoming_payload()
        rows = payload['later']
        rows[0]['summary'] = '把客户回访记录整理成表并逐项核对后发给运营和客服两个组确认'
        rows[1]['summary'] = '交周报'
        for row in rows:
            row['created_at'] = '2020-01-01 00:00'
        payload['today'] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                for width in (1280, 390):
                    for theme in ('light', 'dark'):
                        with self.subTest(width=width, theme=theme):
                            context = browser.new_context(
                                viewport={'width': width, 'height': 1000}, color_scheme=theme)
                            try:
                                page = context.new_page()
                                page.add_init_script(
                                    "localStorage.setItem('qq_digest_overview_mode','now');")
                                page.route('**/api/tasks', lambda route: route.fulfill(
                                    status=200, content_type='application/json', body=json.dumps(payload)))
                                open_authed_page(context, page, self.base, TOKEN)
                                page.wait_for_function(
                                    "document.querySelectorAll('#upcoming-tasks li').length === 3")
                                page.wait_for_timeout(800)
                                rects = page.eval_on_selector_all('#upcoming-tasks li',
                                    '(nodes)=>nodes.map(n=>{const r=n.getBoundingClientRect();'
                                    'return {top:r.top,bottom:r.bottom}})')
                                self.assertEqual(max(r['top'] for r in rects),
                                                 min(r['top'] for r in rects), rects)
                                self.assertEqual(max(r['bottom'] for r in rects),
                                                 min(r['bottom'] for r in rects), rects)
                                page.locator('#upcoming-tasks li').first.hover()
                                page.wait_for_timeout(400)
                                hover = page.evaluate("""() => {
                                    const card=document.querySelector('#upcoming-tasks li');
                                    const a=card.getBoundingClientRect();
                                    const b=document.querySelector('#upcoming-date').getBoundingClientRect();
                                    const list=card.parentElement.getBoundingClientRect();
                                    return {top:a.top, clipped:Math.max(0,list.top-a.top),
                                        intersection:Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)),
                                        hit:card.contains(document.elementFromPoint(a.left+12,a.top+0.5))};
                                }""")
                                self.assertAlmostEqual(hover['top'], rects[0]['top'] - 2, delta=0.1)
                                self.assertEqual(hover['clipped'], 0, hover)
                                self.assertEqual(hover['intersection'], 0, hover)
                                self.assertTrue(hover['hit'], hover)
                            finally:
                                safe_close(context)
            finally:
                browser.close()

    def test_upcoming_empty_state_shrinks_to_content(self) -> None:
        """今日概览的轮播：0 件时不能继续占着 200px 的固定轨道（那片白看着像没加载出来）。

        有数据时高度必须照旧（1280=200、390=220），否则等于把「切换顶动下方元素」的老坑挖回来。
        另外从空态填 1 条再清空，上方元素（标题/副标题）的 top 不能被这一来一回顶走。
        """
        def post(path: str, payload: dict) -> dict:
            data = json.dumps(payload).encode()
            request = urllib.request.Request(
                self.base + path, data=data, method="POST",
                headers={"X-Token": TOKEN, "Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode())

        def get(path: str) -> dict:
            request = urllib.request.Request(self.base + path, headers={"X-Token": TOKEN})
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode())

        def mark_all_done() -> None:
            for bucket in ("today", "later", "pinned"):
                for task in get("/api/tasks").get(bucket, []):
                    post("/api/tasks/" + str(task["id"]), {"action": "done"})

        measure = """() => {
            const box = document.getElementById('upcoming-carousel');
            const rect = box.getBoundingClientRect();
            const top = (sel) => { const el = document.querySelector(sel);
                return el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null; };
            return {height: Math.round(rect.height * 10) / 10,
                    cssHeight: parseFloat(getComputedStyle(box).height),
                    top: Math.round(rect.top * 10) / 10,
                    empty: box.classList.contains('is-empty'),
                    headline: top('#headline'), subline: top('#subline'),
                    card: top('.summary'),
                    bottom: top('.ov-foot'), bar: top('.ov-foot .bar')};}"""

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                for width, tall in ((1280, 200), (390, 220)):
                    mark_all_done()
                    context = browser.new_context(viewport={"width": width, "height": 900})
                    page = context.new_page()
                    try:
                        open_authed_page(context, page, self.base, TOKEN)
                        # 概览卡的呼吸动效会给祖先加缩放，量绝对 top 会飘 1–2px（transform 不改布局，
                        # 但会缩放 getBoundingClientRect）。所以位置断言一律容 2px，高度断言用计算值。
                        page.wait_for_selector("#upcoming-carousel", state="visible", timeout=15000)
                        page.wait_for_function(
                            "() => document.getElementById('upcoming-carousel').classList.contains('is-empty')",
                            timeout=15000)
                        empty = page.evaluate(measure)
                        self.assertTrue(empty["empty"], empty)
                        self.assertLess(empty["cssHeight"], tall - 40,
                                        "空态还撑着固定高度：%s" % empty)
                        self.assertGreater(empty["height"], 0, empty)
                        self.assertIn("0 件", page.inner_text("#upcoming-count"))
                        # 390 下按钮和进度条不能被挤到奇怪位置：紧跟在收缩后的轮播下面（间距 0–120px）。
                        gap = empty["bottom"] - (empty["top"] + empty["height"])
                        self.assertGreaterEqual(gap, 0, empty)
                        self.assertLess(gap, 120, empty)

                        # 填 1 条：回到固定轨道，字号/行距不变
                        # 截止时间取「今天 23:59」：写死日期会过期，过期后这条落到「已逾期」，
                        # 而轮播排的是今天及以后，空态就永远翻不成有数据。
                        deadline = datetime.date.today().strftime("%Y-%m-%d") + " 23:59"
                        post("/api/tasks/create", {"summary": "空态收缩测试",
                                                   "deadline": deadline})
                        page.evaluate("() => loadTasks()")
                        page.wait_for_function(
                            "() => !document.getElementById('upcoming-carousel').classList.contains('is-empty')",
                            timeout=15000)
                        filled = page.evaluate(measure)
                        # 新 UI 的轮播没有固定 200px 轨道，高度跟随内容（实测 1 条 ≈ +13px）：
                        # 契约改为「有数据时确实比空态撑开、清空后缩回空态高度」（见下面 cleared 断言）。
                        self.assertGreater(filled["cssHeight"], empty["cssHeight"], filled)
                        self.assertGreater(filled["height"], empty["height"], filled)
                        self.assertFalse(filled["empty"], filled)
                        # 「上方元素被顶走」要按卡片内相对位置量：概览卡在栅格里是垂直居中的，
                        # 卡片长高本身会让整卡上移半格，绝对 top 不可比（实测空的 191.6、有数据 179）。
                        self.assertLessEqual(abs((filled["headline"] - filled["card"])
                                                 - (empty["headline"] - empty["card"])), 2, (empty, filled))

                        mark_all_done()
                        page.evaluate("() => loadTasks()")
                        page.wait_for_function(
                            "() => document.getElementById('upcoming-carousel').classList.contains('is-empty')",
                            timeout=15000)
                        cleared = page.evaluate(measure)
                        # 清空后标题/副标题的文案本身会变（「今天 0 件」vs「今天 1 件」），绝对 top 不可比；
                        # 要比的是布局：轮播高度回到空态值，且按钮仍在轮播下面、不重叠。
                        self.assertEqual(cleared["cssHeight"], empty["cssHeight"],
                                         "清空后没有回到原来的空态高度：%s vs %s" % (cleared, empty))
                        # 副标题文案会随数据出现/消失，绝对间距会变；这里只保证按钮落在轮播下面、不重叠、不跑到屏外。
                        self.assertGreaterEqual(cleared["bottom"] - (cleared["top"] + cleared["height"]), 0, (empty, cleared))
                        self.assertLess(cleared["bottom"] - (cleared["top"] + cleared["height"]), 120, (empty, cleared))
                    finally:
                        safe_close(context)
            finally:
                browser.close()

    def test_upcoming_carousel_rotation_keeps_below_content_still(self) -> None:
        """轮播每 3 秒换页时，下方内容不许跟着上下抖。

        两页高度必须真的不同（一页 1 条短标题、一页 3 条长标题），否则「不抖」是空转，
        所以先断言两页实测高度差得出来、锁高等于最高那页；再跑满一整轮采样轮播下方
        .ov-foot 的 top，整轮里不许有超过 2px 的位移（呼吸动效的 transform 会飘 1–2px）；
        最后把数据清空，确认锁高被撤掉、卡片收成内容高度。
        """

        def task_row(task_id: int, summary: str, deadline: str) -> dict:
            return {
                "id": task_id, "summary": summary, "text": summary,
                "deadline": deadline, "deadline_text": deadline[-5:],
                "source": "dingtalk", "groups": [], "done": False,
                "overdue": False, "created_at": "",
            }

        def payload(with_pages: bool) -> dict:
            if not with_pages:
                return {"today": [], "week": [], "later": [], "pinned": [], "done": [],
                        "candidates": [], "stats": {"open": 0, "done": 0, "overdue": 0},
                        "headline": "今天没有待办", "subline": "", "progress": 0}
            today = datetime.date.today()
            tomorrow = today + datetime.timedelta(days=1)
            result = {
                "today": [task_row(1, "交周报", today.strftime("%Y-%m-%d") + " 23:59")],
                "week": [
                    task_row(2, "把第三季度的客户回访记录整理成表，发给运营和客服两个组",
                             tomorrow.strftime("%Y-%m-%d") + " 10:00"),
                    task_row(3, "确认新版安装包的签名证书有效期，并更新发版说明里的截图",
                             tomorrow.strftime("%Y-%m-%d") + " 14:00"),
                    task_row(4, "和供应商核对下月排产计划里的两处数量差异，回邮件确认",
                             tomorrow.strftime("%Y-%m-%d") + " 18:00"),
                ],
                "later": [], "pinned": [], "done": [], "candidates": [],
                "stats": {"open": 4, "done": 0, "overdue": 0},
                "headline": "今天 1 件", "subline": "还有 3 件在本周", "progress": 0,
            }
            future = result["week"] + [task_row(5, "确认", tomorrow.strftime("%Y-%m-%d") + " 20:00")]
            result["deadline_views"] = {"today": result["today"], "future": future}
            return result

        state = {"with_pages": True}

        def tasks_stub(route) -> None:
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps(payload(state["with_pages"])))

        # 逐页量「不锁高时的自然高度」：先撤掉锁，再按页 paint 一遍（animate=false 不走进过渡），
        # 最后调 syncUpcomingMinHeight 把锁还原，读回来的是产品自己算出来的那个值。
        measure_pages = """() => {
            const list = document.getElementById('upcoming-tasks');
            const keep = upcomingIndex;
            const cardHeights = () => Array.from(list.children).map(function (c) {
                return Math.round(c.getBoundingClientRect().height * 10) / 10;
            });
            list.style.minHeight = '';
            const heights = [];
            for (let i = 0; i < upcomingGroups.length; i++) {
                upcomingIndex = i;
                renderUpcomingSlide(false);
                list.style.minHeight = '';
                heights.push(Math.round(list.getBoundingClientRect().height * 10) / 10);
            }
            // 锁高不改卡片：同一页（第 1 页，最短那页）在锁高前后，每张卡片的自然高度必须一样。
            // 只跟锁高比大小是不够的——短页卡片本来就快追平锁高，差值会被误当拉伸。
            upcomingIndex = 1;
            renderUpcomingSlide(false);
            list.style.minHeight = '';
            const naturalCards = cardHeights();
            syncUpcomingMinHeight();
            const lockedCards = cardHeights();
            upcomingIndex = keep;
            renderUpcomingSlide(false);
            syncUpcomingMinHeight();
            return {heights: heights, pages: upcomingGroups.length,
                    locked: parseFloat(list.style.minHeight) || 0,
                    naturalCards: naturalCards, lockedCards: lockedCards};
        }"""
        start_sampling = """() => {
            window.__nhSamples = [];
            window.__nhSampler = window.setInterval(function () {
                const foot = document.querySelector('.ov-foot');
                const pageCount = document.getElementById('upcoming-count');
                if (!foot) return;
                window.__nhSamples.push({
                    top: Math.round(foot.getBoundingClientRect().top * 10) / 10,
                    page: pageCount ? pageCount.textContent : ''
                });
            }, 120);
            return true;
        }"""
        stop_sampling = """() => {
            window.clearInterval(window.__nhSampler);
            const samples = window.__nhSamples || [];
            window.__nhSamples = [];
            return {samples: samples};
        }"""
        measure_empty = """() => {
            const list = document.getElementById('upcoming-tasks');
            const box = document.getElementById('upcoming-carousel');
            const date = document.getElementById('upcoming-date');
            return {locked: list.style.minHeight,
                    dateLocked: date ? date.style.minHeight : '',
                    cssHeight: parseFloat(getComputedStyle(box).height),
                    empty: box.classList.contains('is-empty')};
        }"""

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                for width in (1280, 390):
                    state["with_pages"] = True
                    context = browser.new_context(viewport={"width": width, "height": 900})
                    page = context.new_page()
                    try:
                        page.add_init_script("localStorage.setItem('qq_digest_overview_mode','now');")
                        page.route("**/api/tasks", tasks_stub)
                        open_authed_page(context, page, self.base, TOKEN)
                        page.wait_for_selector("#upcoming-carousel", state="visible", timeout=15000)
                        page.evaluate("() => loadTasks()")
                        page.wait_for_function(
                            "() => upcomingGroups.length >= 2", timeout=15000)
                        # summary-enter 是一次性入场动画（translateY 8px、420ms）：它还在跑的时候，
                        # 下面所有元素整体低 8px，采样窗口撞上它会把「入场」误判成「轮播顶动」
                        # （这条用例曾因此在第二轮偶发 8.0px 假红）。先等有限动画全部结束，
                        # 再等轮播真翻过一页才开始采样——那时入场早已结束，窗口里只剩轮播。
                        page.wait_for_function(
                            "() => document.getAnimations().every(a => {"
                            " const t = a.effect && a.effect.getTiming();"
                            " return !t || t.iterations === Infinity || a.playState === 'finished'"
                            " || a.playState === 'idle'; })", timeout=15000)
                        page.evaluate("() => { window.__nhFirstIndex = upcomingIndex; }")
                        page.wait_for_function("() => upcomingIndex !== window.__nhFirstIndex",
                                               timeout=15000)
                        page.wait_for_timeout(600)

                        pages = page.evaluate(measure_pages)
                        self.assertEqual(pages["pages"], 2, pages)
                        self.assertEqual(len(pages["heights"]), 2, pages)
                        shortest, tallest = min(pages["heights"]), max(pages["heights"])
                        self.assertGreater(tallest, shortest + 2,
                                           "两页高度没差出来，这条用例就没造出条件：%s" % (pages,))
                        self.assertLessEqual(abs(pages["locked"] - tallest), 1.5,
                                             "锁高不是最高那页：%s" % (pages,))
                        # 锁高只撑容器：第 1 页（最短那页）的卡片在锁高前后高度必须一致，
                        # 一旦被 flex 拉伸，锁完就会变成锁高。
                        self.assertEqual(pages["heights"].index(shortest), 1, pages)
                        self.assertEqual(len(pages["naturalCards"]), len(pages["lockedCards"]), pages)
                        for natural, locked in zip(pages["naturalCards"], pages["lockedCards"]):
                            self.assertAlmostEqual(
                                locked, natural, delta=0.5,
                                msg="锁高把短页卡片从 %s 拉到 %s 了：%s" % (
                                    pages["naturalCards"], pages["lockedCards"], pages))
                            self.assertLess(locked, pages["locked"] - 4,
                                            "短页卡片贴到锁高了，说明被拉伸：%s vs %s" % (
                                                pages["lockedCards"], pages["locked"]))

                        filled = page.evaluate(measure_empty)
                        self.assertGreaterEqual(filled["cssHeight"], pages["locked"] - 1,
                                                "轮播没撑到锁高：%s vs %s" % (filled, pages))

                        page.evaluate(start_sampling)
                        page.wait_for_timeout(6800)  # 2 页 × 3000ms，跑满一整轮
                        samples = page.evaluate(stop_sampling)["samples"]
                        self.assertGreater(len(samples), 10, "采样点太少：%s" % (samples,))
                        tops = [s["top"] for s in samples]
                        spread = max(tops) - min(tops)
                        self.assertLessEqual(spread, 2,
                                             "轮播换页把下方内容顶动了 %spx：%s" % (spread, samples))
                        page_labels = {s["page"] for s in samples if s["page"]}
                        self.assertGreaterEqual(len(page_labels), 2,
                                                "整轮只看到一页，轮播没真跑：%s" % (samples,))

                        state["with_pages"] = False
                        page.evaluate("() => loadTasks()")
                        page.wait_for_function(
                            "() => document.getElementById('upcoming-carousel').classList.contains('is-empty')",
                            timeout=15000)
                        empty = page.evaluate(measure_empty)
                        self.assertTrue(empty["empty"], empty)
                        self.assertEqual(empty["locked"], "", "空态还留着列表锁高：%s" % (empty,))
                        self.assertEqual(empty["dateLocked"], "", "空态还留着日期行锁高：%s" % (empty,))
                        # 空态必须比有数据时矮一大截（不留白框）；基准用本次实测的有数据高度，别写死像素。
                        self.assertLess(empty["cssHeight"], filled["cssHeight"] - 40,
                                        "空态还撑着高度：%s vs %s" % (empty, filled))
                    finally:
                        safe_close(context)
            finally:
                browser.close()

    # —— 轮播锁高：日期行也要锁、横滑位置不能被重置、短页卡片不能被拉伸 ——

    def _upcoming_row(self, task_id: int, summary: str, deadline: str) -> dict:
        return {
            "id": task_id, "summary": summary, "text": summary,
            "deadline": deadline, "deadline_text": deadline[-5:],
            "source": "dingtalk", "groups": [], "done": False,
            "overdue": False, "created_at": "",
        }

    def _upcoming_payload(self, today: bool = True, far: bool = False) -> dict:
        """生成今天和未来两组工单。"""
        date = datetime.date.today()
        second = date + datetime.timedelta(days=60 if far else 1)
        payload = {
            "today": [self._upcoming_row(1, "交周报", date.strftime("%Y-%m-%d") + " 23:59")],
            "week": [],
            "later": [
                self._upcoming_row(2, "把第三季度的客户回访记录整理成表，发给运营和客服两个组",
                                   second.strftime("%Y-%m-%d") + " 10:00"),
                self._upcoming_row(3, "确认新版安装包的签名证书有效期，并更新发版说明里的截图",
                                   second.strftime("%Y-%m-%d") + " 14:00"),
                self._upcoming_row(4, "和供应商核对下月排产计划里的两处数量差异，回邮件确认",
                                   second.strftime("%Y-%m-%d") + " 18:00"),
            ],
            "pinned": [], "done": [], "candidates": [],
            "stats": {"open": 4, "done": 0, "overdue": 0},
            "headline": "今天 1 件", "subline": "", "progress": 0,
        }
        payload["deadline_views"] = {"today": payload["today"] if today else [], "future": payload["later"]}
        return payload

    def test_upcoming_heading_stays_stable_between_future_pages(self) -> None:
        """窄屏大字下，正在进行的各页保持统一标题，轮播切换不推移下方控件。"""
        payload = self._upcoming_payload(far=True)
        payload["deadline_views"]["future"] += [dict(payload["later"][0], id=20)]

        measure = """() => {
            const date = document.getElementById('upcoming-date');
            const list = document.getElementById('upcoming-tasks');
            const keep = upcomingIndex;
            const savedDate = date.style.minHeight, savedList = list.style.minHeight;
            date.style.minHeight = ''; list.style.minHeight = '';
            const out = [];
            for (let i = 0; i < upcomingGroups.length; i++) {
                upcomingIndex = i;
                renderUpcomingSlide(false);
                date.style.minHeight = ''; list.style.minHeight = '';
                out.push({text: date.textContent,
                          dateH: Math.round(date.getBoundingClientRect().height * 10) / 10});
            }
            upcomingIndex = keep;
            renderUpcomingSlide(false);
            date.style.minHeight = savedDate; list.style.minHeight = savedList;
            syncUpcomingMinHeight();
            return {pages: out, dateLocked: parseFloat(date.style.minHeight) || 0,
                    listLocked: parseFloat(list.style.minHeight) || 0};
        }"""
        start_sampling = """() => {
            window.__nhSamples = [];
            window.__nhSampler = window.setInterval(function () {
                const foot = document.querySelector('.ov-foot');
                if (!foot) return;
                window.__nhSamples.push(Math.round(foot.getBoundingClientRect().top * 10) / 10);
            }, 120);
            return true;
        }"""
        stop_sampling = """() => {
            window.clearInterval(window.__nhSampler);
            const samples = window.__nhSamples || [];
            window.__nhSamples = [];
            return samples;
        }"""

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 390, "height": 900})
                page = context.new_page()
                try:
                    page.add_init_script(
                        "localStorage.setItem('qq_digest_overview_mode','now');"
                        "localStorage.setItem('nh_font_scale','xlarge');"
                        "localStorage.setItem('nh_setup_wizard_seen','1');"
                        "localStorage.setItem('nh_update_guide_version','9.9.9');")
                    page.route("**/api/tasks", lambda route: route.fulfill(
                        status=200, content_type="application/json", body=json.dumps(payload)))
                    open_authed_page(context, page, self.base, TOKEN)
                    page.wait_for_selector("#upcoming-carousel", state="visible", timeout=15000)
                    page.evaluate("() => loadTasks()")
                    page.wait_for_function("() => upcomingGroups.length >= 2", timeout=15000)
                    page.wait_for_timeout(700)
                    self.assertEqual(
                        page.evaluate("() => document.documentElement.dataset.fontScale"), "xlarge")

                    info = page.evaluate(measure)
                    heights = [p["dateH"] for p in info["pages"]]
                    self.assertEqual(len(heights), 2, info)
                    self.assertLessEqual(max(heights) - min(heights), 1.5,
                                       "各页标题高度应相同：%s" % (info,))
                    self.assertLessEqual(abs(info["dateLocked"] - max(heights)), 1.5,
                                         "日期行锁高不是最高的那页：%s" % (info,))

                    page.evaluate("() => { upcomingIndex = 0; renderUpcomingSlide(false); refreshUpcomingRotation(); }")
                    # 同上：入场动画（translateY 8px）还在跑时它会压低整整 8px，等它跑完再采样，
                    # 采集窗口里只剩轮播换页这一件事。
                    page.wait_for_function(
                        "() => document.getAnimations().every(a => {"
                        " const t = a.effect && a.effect.getTiming();"
                        " return !t || t.iterations === Infinity || a.playState === 'finished'"
                        " || a.playState === 'idle'; })", timeout=15000)
                    page.evaluate("() => { window.__nhFirstIndex = upcomingIndex; }")
                    page.wait_for_function("() => upcomingIndex !== window.__nhFirstIndex",
                                           timeout=15000)
                    page.evaluate(start_sampling)
                    page.wait_for_timeout(6800)
                    tops = page.evaluate(stop_sampling)
                    self.assertGreater(len(tops), 10, "采样点太少：%s" % (tops,))
                    spread = max(tops) - min(tops)
                    self.assertLessEqual(spread, 2,
                                         "日期行折行把下方内容顶动了 %spx：%s" % (spread, tops))
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_upcoming_scroll_position_survives_font_scale_change(self) -> None:
        """390 宽下横滑到中间再换字号：syncUpcomingMinHeight 清空重建节点会把 scrollLeft 打到 0。"""
        payload = self._upcoming_payload()
        payload["deadline_views"]["future"] += [
            dict(row, id=row["id"] + 20) for row in payload["later"]
        ]

        probe = """() => {
            const list = document.getElementById('upcoming-tasks');
            upcomingIndex = 1;
            renderUpcomingSlide(false);
            syncUpcomingMinHeight();
            const max = Math.max(0, list.scrollWidth - list.clientWidth);
            list.scrollLeft = Math.min(225, max);
            const before = list.scrollLeft;
            setFontScale('large');
            const after = list.scrollLeft;
            setFontScale('default');
            return {max: max, before: before, after: after};
        }"""

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 390, "height": 900})
                page = context.new_page()
                try:
                    page.add_init_script("localStorage.setItem('qq_digest_overview_mode','now');")
                    page.route("**/api/tasks", lambda route: route.fulfill(
                        status=200, content_type="application/json", body=json.dumps(payload)))
                    open_authed_page(context, page, self.base, TOKEN)
                    page.wait_for_selector("#upcoming-carousel", state="visible", timeout=15000)
                    page.evaluate("() => loadTasks()")
                    page.wait_for_function("() => upcomingGroups.length >= 2", timeout=15000)
                    page.wait_for_timeout(700)
                    got = page.evaluate(probe)
                    self.assertGreater(got["max"], 100, "这条用例没造出可横滑的宽度：%s" % (got,))
                    self.assertGreater(got["before"], 0, "没滚起来，断言就是空转：%s" % (got,))
                    self.assertGreater(got["after"], 0,
                                       "换字号把横滑位置清掉了：%s" % (got,))
                finally:
                    safe_close(context)
            finally:
                browser.close()


    # —— 配置体检：通知点开弹窗，行内动作（panel/api/manual）可用 ——

    CHECKUP_HINT = "在钉钉开放平台 → 应用开发 → 企业内应用，复制 AppKey 和 AppSecret 填到设置页。"

    def _checkup_payload(self, done: bool = False) -> dict:
        if done:
            platforms = {key: {"configured": True, "status": "ok", "headline": "", "action": None}
                         for key in ("qq", "wechat", "dingtalk", "chaoxing", "push", "llm")}
            return {"ok": True, "platforms": platforms}
        return {"ok": True, "platforms": {
            "qq": {"configured": False, "status": "ok", "engine_state": "running",
                   "headline": "NapCat 在跑，但它的 OneBot 接口没连上",
                   "action": {"kind": "api", "label": "帮我连上它",
                              "target": "/api/napcat/connect", "hint": ""}},
            "wechat": {"configured": False, "status": "ok",
                       "headline": "微信接入还没打开",
                       "action": {"kind": "panel", "label": "去打开微信接入",
                                  "target": "wechat-settings-card", "hint": ""}},
            "dingtalk": {"configured": False, "status": "ok",
                         "headline": "钉钉还没填 AppKey",
                         "action": {"kind": "manual", "label": "看怎么填",
                                    "target": "", "hint": self.CHECKUP_HINT}},
            "chaoxing": {"configured": True, "status": "ok", "headline": "", "action": None},
            "push": {"configured": True, "status": "ok", "headline": "", "action": None},
            "llm": {"configured": False, "status": "pending", "headline": "", "action": None},
        }}

    def test_setup_checkup_opens_in_notice_modal(self) -> None:
        """「还有 N 项没配好」不再占页头横幅：通知卡点开体检弹窗。

        每行 = 平台名 + 后端给的 headline + 一个动作按钮：panel 跳对卡片、api 真发 POST、
        manual 原文展开可选中复制；全部配好时连通知卡都不出现，不留空壳。
        """
        posts: list = []
        state = {"connect": "ok"}

        def connect_stub(route) -> None:
            posts.append(route.request.method + " " + route.request.url.split("?")[0])
            if state["connect"] == "ok":
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"ok": True, "api_url": "http://127.0.0.1:3000",
                                               "tried": [], "persisted": True}))
            else:
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"ok": False, "stage": "running_no_api",
                                               "error": "3001 和 3000 都没连上"}))

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                for width in (1280, 390):
                    state["connect"] = "ok"
                    posts.clear()
                    context = browser.new_context(viewport={"width": width, "height": 900})
                    page = context.new_page()
                    page.route("**/api/setup/status",
                               lambda route: route.fulfill(status=200, content_type="application/json",
                                                           body=json.dumps(self._checkup_payload(False))))
                    page.route("**/api/napcat/connect", connect_stub)
                    try:
                        open_authed_page(context, page, self.base, TOKEN)
                        # 先开铃铛面板，再查看本机通知。
                        page.click("#announce-bell")
                        page.wait_for_selector("#announce-panel", state="visible", timeout=15000)
                        # 通知卡由页面尾部的 refreshBanner() 拉体检数据后创建（sticky，不自动消失）。
                        page.wait_for_selector(
                            '#notice-stack [data-notice-id="setup-checkup"]',
                            state="visible", timeout=20000)
                        self.assertIn("还有 3 项没配好",
                                      page.inner_text('#notice-stack [data-notice-id="setup-checkup"]'))
                        # 点卡开体检弹窗（与「查看」按钮等价）。
                        page.click('#notice-stack [data-notice-id="setup-checkup"]')
                        page.wait_for_selector("#notice-modal .setup-checkup-row",
                                               state="visible", timeout=15000)
                        # 行数与文案：只列未配好且后端给了 headline 的（pending 和已配好的都不进）
                        rows = page.eval_on_selector_all(
                            "#notice-modal .setup-checkup-row",
                            """els => els.map(e => ({
                                   key: e.dataset.platform,
                                   name: (e.querySelector('strong') || {}).textContent || '',
                                   headline: (e.querySelector('.setup-checkup-headline') || {}).textContent || '',
                                   kind: (e.querySelector('.setup-checkup-act') || {dataset: {}}).dataset.kind || '',
                                   label: (e.querySelector('.setup-checkup-act') || {}).textContent || ''}))""")
                        self.assertEqual([r["key"] for r in rows], ["qq", "wechat", "dingtalk"], rows)
                        self.assertEqual([r["kind"] for r in rows], ["api", "panel", "manual"], rows)
                        self.assertEqual(rows[0]["headline"], "NapCat 在跑，但它的 OneBot 接口没连上")
                        self.assertEqual(rows[2]["label"], "看怎么填")
                        if width == 1280:
                            # manual：原文展开（hidden 翻转），再点收起
                            dingtalk_act = '.setup-checkup-row[data-platform="dingtalk"] .setup-checkup-act'
                            dingtalk_hint = '.setup-checkup-row[data-platform="dingtalk"] .setup-checkup-hint'
                            page.click(dingtalk_act)
                            page.wait_for_selector(dingtalk_hint, state="visible", timeout=15000)
                            self.assertEqual(page.get_attribute(dingtalk_act, "aria-expanded"), "true")
                            self.assertIn(self.CHECKUP_HINT, page.inner_text(dingtalk_hint))
                            page.click(dingtalk_act)
                            page.wait_for_selector(dingtalk_hint, state="hidden", timeout=15000)
                            # panel：切到设置页签，焦点落在微信卡上
                            page.click('.setup-checkup-row[data-platform="wechat"] .setup-checkup-act')
                            page.wait_for_function(
                                "() => document.activeElement && document.activeElement.id === 'wechat-settings-card'",
                                timeout=15000)
                            self.assertFalse(page.is_hidden("#tab-settings"), "panel 动作应已切到设置页签")
                            # api：真发 POST；成功后按钮恢复可点
                            page.click('.setup-checkup-row[data-platform="qq"] .setup-checkup-act')
                            page.wait_for_function(
                                "() => document.querySelector('.setup-checkup-row[data-platform=\"qq\"] .setup-checkup-act').disabled === false",
                                timeout=15000)
                            # 计数器是 Python 侧的，wait_for_function 看不到它：
                            # 按钮恢复可点 != 请求已经发出去，轮询到计数涨了再断言。
                            deadline = time.monotonic() + 10
                            while not posts and time.monotonic() < deadline:
                                page.wait_for_timeout(50)
                            self.assertEqual(posts, ["POST " + self.base + "/api/napcat/connect"], posts)
                    finally:
                        safe_close(context)

                # 全部配好：refreshBanner 不再推体检通知，弹窗也不许挂着旧内容。
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                page.route("**/api/setup/status",
                           lambda route: route.fulfill(status=200, content_type="application/json",
                                                       body=json.dumps(self._checkup_payload(True))))
                page.route("**/api/napcat/connect", connect_stub)
                try:
                    open_authed_page(context, page, self.base, TOKEN)
                    # 面板关着时卡片本来就不显示，得开面板才谈得上「有没有这张卡」。
                    page.click("#announce-bell")
                    page.wait_for_selector("#announce-panel", state="visible", timeout=15000)
                    page.wait_for_timeout(1500)
                    self.assertFalse(page.is_visible('#notice-stack [data-notice-id="setup-checkup"]'),
                                     "全部配好时不应再有体检通知卡")
                    self.assertTrue(page.is_hidden("#notice-modal"), "没有体检内容时弹窗不许开着")
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_inbox_unified_navigation_and_manual_work_order(self) -> None:
        self.server.store.insert_message(
            msg_id="wechat:sample", group_id="course", group_name="课程",
            source="wechat", content="微信课程通知",
            inbox_mark=("rule", "命中规则 课程", {}),
        )
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                try:
                    open_authed_page(context, page, self.base, TOKEN)
                    self.assertEqual(page.get_by_role("tablist", name="主导航").get_by_role("tab").all_text_contents(),
                                     ["工单", "收件箱", "设置"])
                    page.get_by_role("tab", name="收件箱").click()
                    page.locator("#inbox-items .inbox-title").get_by_text("微信课程通知").wait_for()
                    page.get_by_role("button", name="QQ", exact=True).click()
                    page.get_by_text("暂无符合条件的消息").wait_for()
                    self.assertFalse(page.locator("#inbox-history").evaluate("node => node.open"))
                    self.assertEqual(page.locator("#inbox-push-history").count(), 0)

                    page.get_by_role("button", name="添加消息", exact=True).click()
                    page.get_by_label("消息正文").fill("整理会议纪要")
                    page.get_by_role("button", name="保存消息").click()
                    item = page.locator("#inbox-items .inbox-item").filter(has_text="整理会议纪要")
                    item.get_by_text("查看原文", exact=True).click()
                    item.get_by_role("button", name="提交给 Router").click()
                    expect(item).to_contain_text("排队中")
                    queued = page.request.get(self.base + "/api/router/queue", headers={"X-Token": TOKEN}).json()
                    msg_id = next(record["msg_id"] for record in queued["items"] if record["content"] == "整理会议纪要")
                    response = page.request.post(
                        self.base + "/api/router/decide", headers={"X-Token": TOKEN},
                        data={"msg_id": msg_id, "decision": "create"},
                    )
                    self.assertTrue(response.ok, response.text())
                    page.reload()
                    page.get_by_role("tab", name="收件箱").click()
                    item.get_by_role("button", name="查看工单").click()
                    expect(page.locator("#tab-tasks")).to_contain_text("整理会议纪要")
                    self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 390)
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_inbox_renders_image_only_when_item_has_image(self) -> None:
        """收件箱图片：只有 `has_image` 为真的条目才渲染 `<img>`，其余一条 DOM 都不加。

        真实 bug：以前只认 `source === 'onebot-attachment'`，普通消息和回溯消息里的图片
        在收件箱永远是「[图片]」两个字；就算渲染了，塞进默认收起的 `<details>` 里也看不见。
        这里用真实 `renderInboxItem` 渲染三条并查 DOM：图片必须在折叠块外面、挂在卡片上。
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                try:
                    open_authed_page(context, page, self.base, TOKEN)
                    page.wait_for_selector("#inbox-items", state="attached", timeout=15000)
                    measured = page.evaluate("""() => {
                        const base = {title: '[图片]', started_at: '2026-10-31 01:00',
                                      group_name: '测试群', message_count: 1,
                                      messages: [{content: '[图片]'}], context: [], context_package_refs: []};
                        const render = (extra) => {
                          const box = document.createElement('div');
                          box.appendChild(renderInboxItem(Object.assign({}, base, extra)));
                          document.body.appendChild(box);
                          return box;
                        };
                        const has = render({msg_id: 'm-has', has_image: true});
                        const none = render({msg_id: 'm-none', has_image: false});
                        const missing = render({msg_id: 'm-missing'});
                        const read = (box) => {
                          const img = box.querySelector('img');
                          const link = box.querySelector('a.inbox-attachment-link');
                          return {imgs: box.querySelectorAll('img').length,
                                  links: box.querySelectorAll('a.inbox-attachment-link').length,
                                  src: img ? img.getAttribute('src') : null,
                                  alt: img ? img.getAttribute('alt') : null,
                                  loading: img ? img.getAttribute('loading') : null,
                                  href: link ? link.getAttribute('href') : null,
                                  target: link ? link.getAttribute('target') : null,
                                  rel: link ? link.getAttribute('rel') : null};
                        };
                        const img = has.querySelector('img');
                        const details = has.querySelector('details');
                        const out = {
                          has: read(has), none: read(none), missing: read(missing),
                          hasText: has.textContent.indexOf('[图片]') >= 0,
                          // 图片不能待在那个默认收起的折叠块里
                          inDetails: !!(img && img.closest('details')),
                          // 而且要排在 details 之后（DOM 顺序）
                          afterDetails: !!(img && details &&
                            (details.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING))
                        };
                        // 取不到图：外层 <a> 也要一起走，别留空占位
                        img.dispatchEvent(new Event('error'));
                        out.linksAfterError = has.querySelectorAll('a.inbox-attachment-link').length;
                        out.imgsAfterError = has.querySelectorAll('img').length;
                        has.remove(); none.remove(); missing.remove();
                        return out;
                    }""")
                    has, none, missing = measured["has"], measured["none"], measured["missing"]
                    self.assertEqual(has["imgs"], 1, measured)
                    self.assertTrue((has["src"] or "").startswith("/api/inbox/image"),
                                    "图片要指向 /api/inbox/image：%s" % measured)
                    self.assertEqual(has["loading"], "lazy", measured)
                    self.assertEqual(has["alt"], "测试群 的图片", measured)
                    self.assertEqual(has["target"], "_blank", measured)
                    self.assertTrue((has["href"] or "").startswith("/api/inbox/image"), measured)
                    # 不展开折叠块就得看得见图
                    self.assertFalse(measured["inDetails"], "图片不许塞进 <details>：%s" % measured)
                    self.assertTrue(measured["afterDetails"], "图片要排在 details 之后：%s" % measured)
                    # 没有图片的条目：既没有 img，也没有空链接
                    self.assertEqual(none["imgs"], 0, "has_image=false 不许渲染图片：%s" % measured)
                    self.assertEqual(none["links"], 0, "has_image=false 不许留空链接：%s" % measured)
                    self.assertEqual(missing["imgs"], 0, "has_image 缺失不许渲染图片：%s" % measured)
                    self.assertEqual(missing["links"], 0, "has_image 缺失不许留空链接：%s" % measured)
                    # onerror 一次带走 img + 外层 a
                    self.assertEqual(measured["imgsAfterError"], 0, measured)
                    self.assertEqual(measured["linksAfterError"], 0, measured)
                    self.assertTrue(measured["hasText"], "正文里的 [图片] 不能因此丢：%s" % measured)
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_inbox_source_chips_filter_packages(self) -> None:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
            try:
                open_authed_page(context, page, self.base, TOKEN)
                with page.expect_request("**/api/inbox?*") as first:
                    page.click("#tab-inbox-button")
                self.assertIn("feed=packages", first.value.url)
                self.assertNotIn("source=", first.value.url)
                expect(page.locator('[data-inbox-source=""]')).to_have_attribute("aria-pressed", "true")
                with page.expect_request("**/api/inbox?*") as filtered:
                    page.click('[data-inbox-source="qq"]')
                self.assertIn("source=qq", filtered.value.url)
                expect(page.locator('[data-inbox-source="qq"]')).to_have_attribute("aria-pressed", "true")
                expect(page.locator('[data-inbox-source=""]')).to_have_attribute("aria-pressed", "false")
            finally:
                safe_close(context)
                browser.close()

    # —— 推送设置：键名与元素 id 的对照表 ——

    def _open_settings(self, context, page) -> None:
        open_authed_page(context, page, self.base, TOKEN)
        # 公共 helper：DOM click + 「页签真的不 hidden」重试，裸点击会被首启浮层抢走（见其注释）。
        open_settings(page)
        try:
            page.wait_for_selector("#push-settings", state="attached", timeout=30000)
        except Exception as exc:                  # noqa: BLE001 - 带上页面报错再抛
            # settings.js 的 loadSettings() 是一整段同步构建：中途抛异常，它后面的面板
            # （推送通道排在很后面）就一个都不会出现。CI 上偶发过，把页面报错一起带出来。
            raise AssertionError(
                "设置面板没建出来（#push-settings 不在 DOM）；页面报错=%s；原始异常=%r"
                % (getattr(page, "_nh_js_errors", []), exc)) from exc

    def test_channel_subscriptions_are_visible_without_connecting_accounts(self) -> None:
        options = {"channel": BROWSER_CHANNEL} if BROWSER_CHANNEL else {}
        if os.environ.get("NH_BROWSER_EXECUTABLE"):
            options["executable_path"] = os.environ["NH_BROWSER_EXECUTABLE"]
        with sync_playwright() as runner:
            browser = runner.chromium.launch(**options)
            try:
                context = browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                self._open_settings(context, page)
                for anchor in ("groups", "wechat-subscriptions", "dingtalk-subscriptions",
                               "chaoxing-subscriptions", "rules"):
                    page.locator(f'[data-goto="{anchor}"]').evaluate("(button) => button.click()")
                    card = page.locator(f'[data-setting-anchor="{anchor}"]')
                    expect(card).to_be_visible()
                    if anchor in ("wechat-subscriptions", "dingtalk-subscriptions"):
                        card.locator(".scope-manual input").fill("test-conversation")
                        card.get_by_role("button", name="添加", exact=True).click()
                        expect(card.locator('input[value="test-conversation"]')).to_be_checked()
                    if anchor == "chaoxing-subscriptions":
                        expect(card.locator("#cx-subscriptions")).to_be_visible()
                self.assertEqual(page.locator("#guide-rule-list, #package-rule-groups").count(), 0)
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 390)
            finally:
                browser.close()

    def test_settings_cards_survive_rerender(self) -> None:
        # 重渲染设置时保留 QQ 接入和 QQ 订阅卡。
        anchors = ("setup", "qq", "groups", "dingtalk", "wechat", "chaoxing", "push")
        access = ("anchors => anchors.map(key => "
                  "document.querySelectorAll('#tab-settings [data-setting-anchor=' + key + ']').length)")
        expected = [1] * len(anchors)
        with sync_playwright() as runner:
            browser = runner.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            context = browser.new_context(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce')
            page = context.new_page()
            try:
                self._open_settings(context, page)
                self.assertEqual(page.evaluate(access, anchors), expected)
                # 切走再切回：settings.js 会清空 .settings-body 重建并换 render 号，applyGroups()
                # 于是删旧组。静态卡片（page.html 里写死的 #connect/#groupbox）必须被搬回顶层，
                # 否则跟着旧组一起 remove —— 右栏就少了 QQ 接入和 QQ 订阅群。
                for _ in range(2):
                    page.evaluate("document.getElementById('tab-tasks-button').click()")
                    page.wait_for_timeout(300)
                    page.evaluate("document.getElementById('tab-settings-button').click()")
                    page.wait_for_timeout(600)
                self.assertEqual(page.evaluate(access, anchors), expected,
                                 '切两次设置页之后 QQ 接入 / QQ 订阅群卡片被删了')
            finally:
                context.close()
                browser.close()

    # —— 微信群选择区：推荐区按类别分组 + 全部群默认收起（原型 A） ——

    def test_qq_setup_target_opens_visible_settings(self) -> None:
        with sync_playwright() as runner:
            browser = runner.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            context = browser.new_context(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce')
            page = context.new_page()
            platforms = {key: {'configured': True, 'status': 'ok', 'headline': '', 'action': None}
                         for key in ('wechat', 'dingtalk', 'chaoxing', 'push', 'llm')}
            platforms['qq'] = {
                'configured': False, 'status': 'ok', 'engine_state': 'installed_not_running',
                'headline': '引擎装好了，但没启动',
                'action': {'kind': 'panel', 'label': '去启动引擎', 'target': 'qq', 'hint': ''},
            }
            page.route('**/api/setup/status', lambda route: route.fulfill(
                status=200, content_type='application/json',
                body=json.dumps({'ok': True, 'platforms': platforms})))
            open_authed_page(context, page, self.base, TOKEN)
            page.click('#announce-bell')
            page.wait_for_selector('#announce-panel', state='visible', timeout=15000)
            page.click('#notice-stack [data-notice-id="setup-checkup"]')
            page.wait_for_selector('.setup-checkup-row[data-platform="qq"] .setup-checkup-act',
                                   state='visible', timeout=15000)
            page.click('.setup-checkup-row[data-platform="qq"] .setup-checkup-act')
            page.wait_for_function("""() => {
                const settings=document.getElementById('tab-settings');
                const target=document.getElementById('connect');
                const r=target.getBoundingClientRect();
                return !settings.hidden && target.offsetHeight>0 && r.top>=0 && r.top<innerHeight && r.bottom>0;
            }""", timeout=10000)
            self.assertTrue(page.locator('#tab-tasks').is_hidden())
            self.assertEqual(page.locator('#tab-settings-button').get_attribute('aria-selected'), 'true')
            self.assertEqual(page.locator('#tab-tasks-button').get_attribute('aria-selected'), 'false')
            context.close()
            browser.close()

    def test_settings_first_line_clear_of_fixed_elements(self) -> None:
        # 桌面导航随文档流滚走，切页签需回顶部；手机保留底部固定条及底部留白。
        measure = """() => {
            const root=document.querySelector('#tab-settings');
            const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
            let node,lines=[];
            while(node=walker.nextNode()){
                const e=node.parentElement;
                if(!node.textContent.trim()||e.closest('script,style,.settings-subnav')||!e.getClientRects().length)continue;
                const range=document.createRange();range.selectNodeContents(node);
                for(const r of range.getClientRects()){
                    if(!r.width||!r.height||r.top<0||r.bottom>innerHeight||r.left<0||r.right>innerWidth)continue;
                    let clipped=false;
                    for(let p=e;p;p=p.parentElement){
                        const s=getComputedStyle(p),q=p.getBoundingClientRect();
                        if(s.display==='none'||s.visibility==='hidden'||(p.tagName==='DETAILS'&&!p.open&&!p.querySelector('summary')?.contains(e))){clipped=true;break;}
                        if(/hidden|clip|auto|scroll/.test(s.overflowY)&&(r.bottom<=q.top||r.top>=q.bottom)){clipped=true;break;}
                    }
                    if(!clipped)lines.push({e,r});
                }
            }
            lines.sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left);
            if(!lines.length)throw Error('No rendered text line');
            const first=lines[0],r=first.r,hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
            const fixed=Array.from(document.querySelectorAll('*')).filter(e=>/^(fixed|sticky)$/.test(getComputedStyle(e).position)).map(e=>{
                const q=e.getBoundingClientRect(),s=getComputedStyle(e);
                return {id:e.id,classes:e.className,area:q.width&&q.height&&s.visibility!=='hidden'?Math.max(0,Math.min(q.right,r.right)-Math.max(q.left,r.left))*Math.max(0,Math.min(q.bottom,r.bottom)-Math.max(q.top,r.top)):0};
            });
            return {selfHit:!!hit&&(hit===first.e||first.e.contains(hit)),fixed,
                navPosition:getComputedStyle(document.querySelector('.masthead-row')).position,
                paddingBottom:parseFloat(getComputedStyle(document.body).paddingBottom),
                width:document.documentElement.scrollWidth,viewport:innerWidth};
        }"""
        with sync_playwright() as runner:
            browser = runner.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            for width in (1280, 390):
                for scale in ('default', 'large', 'xlarge'):
                    context = browser.new_context(viewport={'width': width, 'height': 900}, reduced_motion='reduce')
                    page = context.new_page()
                    self._open_settings(context, page)
                    page.evaluate('s=>document.documentElement.dataset.fontScale=s', scale)
                    for scene in ('default', 'rules', 'collapse', 'search', 'notify'):
                        with self.subTest(width=width, scale=scale, scene=scene):
                            if scene == 'default':
                                page.evaluate('scrollTo(0,0)')
                            elif scene == 'rules':
                                page.locator('[data-setting-anchor=rules]').evaluate('e=>{for(let p=e.parentElement;p;p=p.parentElement)if(p.tagName==="DETAILS")p.open=true;e.scrollIntoView({block:"start"})}')
                            elif scene == 'collapse':
                                page.locator('.settings-group summary').first.click()
                            elif scene == 'search':
                                page.locator('#settings-search').fill('规则')
                                page.locator('#settings-search').press('Enter')
                            else:
                                page.locator('#settings-search').fill('')
                                page.get_by_text('提醒与订阅', exact=True).last.click()
                            page.wait_for_timeout(700)
                            result = page.evaluate(measure)
                            self.assertTrue(result['selfHit'], result)
                            self.assertTrue(all(e['area'] == 0 for e in result['fixed']), result)
                            self.assertLessEqual(result['width'], result['viewport'], result)
                            self.assertEqual(result['navPosition'], 'relative' if width == 1280 else 'fixed')
                            if width == 390:
                                self.assertGreaterEqual(result['paddingBottom'], 72)
                    # 代表位置覆盖顶部和页尾；完整逐步扫描保留在临时探针。
                    for end in (False, True):
                        page.evaluate('end=>scrollTo(0,end?document.documentElement.scrollHeight:0)', end)
                        page.wait_for_timeout(100)
                        edge = page.evaluate(measure)
                        self.assertTrue(edge['selfHit'], edge)
                        self.assertTrue(all(e['area'] == 0 for e in edge['fixed']), edge)
                    if width == 390:
                        # 最后一行必须完整位于底部固定条上方，且中心可命中。
                        last = page.evaluate("""() => {
                            const root=document.querySelector('#tab-settings');
                            const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
                            let node,rows=[];
                            while(node=walker.nextNode()){
                                const e=node.parentElement;
                                if(!node.textContent.trim()||e.closest('script,style,.settings-subnav'))continue;
                                let hidden=false;
                                for(let p=e;p;p=p.parentElement){
                                    const s=getComputedStyle(p);
                                    if(s.display==='none'||s.visibility==='hidden'||(p.tagName==='DETAILS'&&!p.open&&!p.querySelector('summary')?.contains(e))){hidden=true;break;}
                                }
                                if(hidden)continue;
                                const range=document.createRange();range.selectNodeContents(node);
                                for(const r of range.getClientRects())if(r.width&&r.height)rows.push({e,r});
                            }
                            rows.sort((a,b)=>b.r.bottom-a.r.bottom);
                            if(!rows.length)throw Error('No final text line');
                            const {e,r}=rows[0],nav=document.querySelector('.masthead-row').getBoundingClientRect();
                            const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
                            return {top:r.top,bottom:r.bottom,navTop:nav.top,hit:!!hit&&(e===hit||e.contains(hit))};
                        }""")
                        self.assertGreaterEqual(last['top'], 0, last)
                        self.assertLessEqual(last['bottom'], last['navTop'], last)
                        self.assertTrue(last['hit'], last)
                    context.close()
            browser.close()

    def test_inbox_package_displays_context_with_originals_and_marks_trigger(self) -> None:
        stamp = datetime.datetime(2026, 11, 23, 10)
        long_followup = "模板稍后发送\n" + "后续补充\n" * 24 + "最后一行"
        self.server.store.insert_message(
            msg_id="manual:short", group_id="", source="manual", content="简短消息",
            received_at=stamp, inbox_mark=("manual", "手动添加", {}),
        )
        self.server.store.save_package_rule({"group_ids": ["12345"]})
        for index, (body, role) in enumerate([
            ("会议室已预订", "member"), ("请准备实验报告", "admin"), (long_followup, "member"),
        ]):
            received = stamp + datetime.timedelta(seconds=index)
            self.server.store.insert_message(
                msg_id=f"qq:test:{index}", group_id="12345", group_name="12345",
                source="onebot", event="GROUP_MESSAGE_CREATE", account_id="23456",
                sender_role=role, sender_id="24681" if role == "admin" else "24680",
                content=body, received_at=received, ts=received,
            )
        self.assertEqual(self.server.store.seal_message_packages(stamp + datetime.timedelta(minutes=6)), 1)
        self.server.store.remember_group_names({"12345": "课程群"})
        with sync_playwright() as runner:
            browser = runner.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            context = browser.new_context(viewport={"width": 390, "height": 900})
            page = context.new_page()
            try:
                open_authed_page(context, page, self.base, TOKEN)
                page.get_by_role("tab", name="收件箱").click()
                package = page.locator("#inbox-items .inbox-item").filter(has_text="请准备实验报告")
                expect(package.locator(".inbox-fields").first).to_contain_text("3 条")
                expect(package.get_by_text("课程群", exact=True)).to_be_visible()
                expect(page.locator(".inbox-item").filter(has_text="简短消息").get_by_text(
                    "未知", exact=True)).to_be_visible()
                package.get_by_text("查看原文", exact=True).click()
                expect(package.get_by_role("heading", name="本包消息")).to_be_visible()
                expect(package.get_by_role("heading", name="之前的消息")).to_have_count(0)
                expect(package.locator(".inbox-original-body")).to_have_text(
                    ["会议室已预订", "请准备实验报告", long_followup],
                )
                trigger = package.locator(".inbox-original.is-trigger")
                expect(trigger).to_have_count(1)
                expect(trigger).to_contain_text("触发封包")
                expect(trigger).to_contain_text("请准备实验报告")
                expect(package.get_by_text("关联消息包", exact=True)).to_be_visible()
                page.set_viewport_size({"width": 1280, "height": 900})
                short = page.locator("#inbox-items .inbox-item").filter(has_text="简短消息")
                short.get_by_text("查看原文", exact=True).click()
                self.assertAlmostEqual(package.bounding_box()["height"], short.bounding_box()["height"], delta=1)
                panel = package.locator(".inbox-card-panel")
                short_panel = short.locator(".inbox-card-panel")
                self.assertTrue(panel.evaluate("node => node.scrollHeight > node.clientHeight"))
                self.assertTrue(short_panel.evaluate("node => node.scrollHeight === node.clientHeight"))
                panel.focus()
                page.keyboard.press("End")
                page.wait_for_function(
                    "node => Math.abs(node.scrollTop + node.clientHeight - node.scrollHeight) <= 1",
                    arg=panel.element_handle(),
                )
                expect(package.get_by_text("查看原文", exact=True)).to_be_in_viewport()
                expect(package.locator(".inbox-original").last).to_contain_text("最后一行")
            finally:
                safe_close(context)
                browser.close()

    def test_inbox_date_filters_query_unloaded_records_and_keep_same_day_together(self) -> None:
        stamp = datetime.datetime(2026, 11, 23, 10)
        for index, received in enumerate([stamp] * 51 + [
            stamp + datetime.timedelta(days=1), datetime.datetime(2024, 2, 29, 10),
        ]):
            self.server.store.insert_message(
                msg_id=f"manual:test:{index}", group_id="", source="manual",
                content=f"测试消息 {index}", received_at=received, inbox_mark=("manual", "手动添加", {}),
            )
        with sync_playwright() as runner:
            browser = runner.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            context = browser.new_context(viewport={"width": 390, "height": 900}, timezone_id="Asia/Shanghai")
            page = context.new_page()
            try:
                page.clock.set_fixed_time(datetime.datetime.fromisoformat("2026-11-23T10:00:00+08:00"))
                open_authed_page(context, page, self.base, TOKEN)
                page.get_by_role("tab", name="收件箱").click()
                days = page.locator("#inbox-items .inbox-day")
                items = page.locator("#inbox-items .inbox-item")
                calendar = page.locator("#inbox-calendar > summary")
                all_dates = page.get_by_role("button", name="全部日期", exact=True)
                expect(items).to_have_count(50)
                expect(all_dates).to_be_visible()
                expect(all_dates).to_have_attribute("aria-pressed", "true")
                expect(page.locator("#inbox-date-links button")).to_have_count(6)
                page.locator("#inbox-date-links").get_by_role("button", name="2026-11-24 周二").click()
                expect(items).to_have_count(1)
                expect(items.first.locator(".inbox-title")).to_have_text("测试消息 51")
                calendar.click()
                page.get_by_role("spinbutton", name="年份").fill("2024")
                page.get_by_role("combobox", name="月份").select_option("1")
                page.get_by_role("button", name="2024-02-29").click()
                expect(items).to_have_count(1)
                expect(items.first.locator(".inbox-title")).to_have_text("测试消息 52")
                expect(calendar).to_have_text("2024-02-29")
                expect(calendar).to_be_focused()
                items.first.get_by_text("查看原文", exact=True).click()
                expect(items.first).to_contain_text("已收录")
                expect(items.first.locator(".inbox-original-body")).to_have_text("测试消息 52")
                expect(items.first.get_by_role("button", name="抽日程")).to_have_count(0)
                expect(items.first.get_by_role("button", name="删除")).to_have_count(0)
                page.locator("#inbox-date-links").get_by_role("button", name="2026-11-25 周三").click()
                expect(items).to_have_count(0)
                expect(page.locator("#inbox-message")).to_contain_text("当天暂无")
                all_dates.click()
                expect(items).to_have_count(50)
                page.get_by_role("button", name="加载更多", exact=True).click()
                expect(items).to_have_count(53)
                expect(days).to_have_count(3)
                expect(days.nth(1).locator(".inbox-item")).to_have_count(51)
                bad_date = page.request.get(self.base + "/api/inbox?feed=packages&day=2026-02-29", headers={"X-Token": TOKEN})
                self.assertEqual(bad_date.status, 400)
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 390)
            finally:
                safe_close(context)
                browser.close()

    def test_calendar_mobile_heading(self) -> None:
        with sync_playwright() as runner:
            browser = runner.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            context = browser.new_context(viewport={"width": 390, "height": 900}, reduced_motion="reduce")
            page = context.new_page()
            open_authed_page(context, page, self.base, TOKEN)
            for scale, size in (("default", 20), ("large", 25), ("xlarge", 30)):
                with self.subTest(scale=scale):
                    page.evaluate("scale => document.documentElement.dataset.fontScale=scale", scale)
                    page.locator('#calendar-panel').scroll_into_view_if_needed()
                    geometry = page.evaluate("""() => {
                        const title=document.getElementById('calendar-title');
                        const today=document.getElementById('cal-today');
                        const lines=e=>{const r=document.createRange();r.selectNodeContents(e);
                            return new Set(Array.from(r.getClientRects(), x=>Math.round(x.top))).size;};
                        return {titleLines:lines(title),todayLines:lines(today),
                            size:parseFloat(getComputedStyle(title).fontSize),
                            titleBottom:title.getBoundingClientRect().bottom,
                            controlsTop:today.parentElement.getBoundingClientRect().top,
                            width:document.documentElement.scrollWidth,viewport:innerWidth};
                    }""")
                    self.assertEqual(geometry['titleLines'], 1, geometry)
                    self.assertEqual(geometry['todayLines'], 1, geometry)
                    self.assertEqual(geometry['size'], size, geometry)
                    self.assertGreaterEqual(geometry['controlsTop'], geometry['titleBottom'], geometry)
                    self.assertLessEqual(geometry['width'], geometry['viewport'], geometry)
            context.close()
            browser.close()

    def test_journey_cta_pause(self) -> None:
        with sync_playwright() as runner:
            browser = runner.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            context = browser.new_context(viewport={"width": 390, "height": 900}, reduced_motion="reduce")
            page = context.new_page()
            context.route("**/api/hosting/status", lambda route: route.fulfill(
                json={"ok": True, "hosting_active": False, "napcat_running": False}))
            self._open_settings(context, page)
            for step, target in enumerate(("host-quick", "qrbox", "groupbox", "sync-url")):
                with self.subTest(step=step):
                    page.evaluate("""step => {
                        localStorage.removeItem('qq_digest_journey_hidden');
                        journeyPaused=false;
                        ['platform-setup-wizard','update-guide','onboarding'].forEach(id=>{
                            const e=document.getElementById(id); if(e)e.hidden=true;
                        });
                        document.getElementById('groupbox').hidden=false;
                        document.querySelectorAll('.settings-group').forEach(e=>e.open=false);
                        renderJourney({ok:true});
                        document.getElementById('journey-action').dataset.step=String(step);
                    }""", step)
                    page.locator('#journey-action').click()
                    page.wait_for_function("id=>document.activeElement.id===id", arg=target)
                    self.assertTrue(page.locator('#journey').is_hidden())
                    self.assertTrue(page.locator('#'+target).is_visible())
                    page.evaluate("renderJourney({ok:false})")
                    self.assertTrue(page.locator('#journey').is_hidden())
                    self.assertIsNone(page.evaluate("localStorage.getItem('qq_digest_journey_hidden')"))
                    page.evaluate("document.getElementById('host-state').click()")
                    page.wait_for_function("!document.getElementById('journey').hidden")
            page.evaluate("""() => {
                document.getElementById('journey-action').dataset.step='2';
                document.getElementById('groupbox').hidden=true;
            }""")
            page.locator('#journey-action').click()
            page.wait_for_function("document.body.textContent.includes('此设置项尚未就绪')")
            self.assertTrue(page.locator('#journey').is_hidden())
            context.close()
            browser.close()

    _GROUP_PICKER_GROUPS = [
        {"id": "wx-a", "name": "高等数学A(1) 2025级", "alias": "", "selected": False,
         "category": "course", "suggested": True, "reason": "课程通知：作业与考试安排", "source": "llm"},
        {"id": "wx-b", "name": "大学物理实验", "alias": "", "selected": False,
         "category": "course", "suggested": True, "reason": "课程通知：实验排期", "source": "llm"},
        {"id": "wx-c", "name": "校园马拉松志愿者", "alias": "", "selected": False,
         "category": "activity", "suggested": True, "reason": "活动通知：集合时间", "source": "llm"},
        {"id": "wx-d", "name": "计科2301班群", "alias": "", "selected": False,
         "category": "chat", "suggested": False, "reason": "", "source": "llm"},
        {"id": "wx-e", "name": "老乡群（山东）", "alias": "", "selected": False,
         "category": "other", "suggested": False, "reason": "", "source": "llm"},
    ]

    def _group_picker_stub(self):
        body = json.dumps(
            {"ok": True,
             "groups": [dict(row) for row in self._GROUP_PICKER_GROUPS],
             "suggest_source": "llm", "suggest_error": ""},
            ensure_ascii=False,
        )

        def stub(route) -> None:
            route.fulfill(status=200, content_type="application/json", body=body)

        return stub

    _GROUP_PICKER_STATE = """() => {
        const box = document.querySelector('#wx-groups');
        return {
            pills: [...box.querySelectorAll('.gsel-top span')].map((el) => el.textContent),
            picked: box.querySelector('[data-gsel-count]').textContent,
            recRows: box.querySelectorAll('[data-gsel-body="rec"] .wx-group-row').length,
            allRows: box.querySelectorAll('[data-gsel-list="all"] .wx-group-row').length,
            allHidden: box.querySelector('[data-gsel-body="all"]').hidden,
            categories: [...box.querySelectorAll('[data-gsel-body="rec"] .gsel-cat h3')]
                .map((el) => el.textContent),
            clipped: [...box.querySelectorAll('.group-name')]
                .filter((el) => el.scrollWidth > el.clientWidth + 1).length,
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            shown: !!box.querySelector('.gsel'),
        };
    }"""

    def _detect_wechat_in_settings(self, page) -> None:
        group = page.locator('.settings-group[data-group="rules"]')
        if group.get_attribute("open") is None:
            group.locator(":scope > summary").click()
        card = page.locator('[data-setting-anchor="wechat-subscriptions"] > details.settings-card')
        if card.get_attribute("open") is None:
            card.locator(":scope > summary").click()
        page.locator("#wx-load-groups").click()

    def test_wechat_group_picker_groups_suggestions_and_folds_all(self) -> None:
        """拉取成功后：概览三枚数字对、推荐区按类别分组、全部群默认收起、勾选联动已选数。

        全部群默认展开会把 26 个群一次摊满一屏，用户又看不出哪些是 AI 推荐的；
        收起后「全部群聊（N 个）」必须真的在 DOM 里（展开才有行），不能只是把字改小。
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                page.route("**/api/wechat/groups?setup=1", self._group_picker_stub())
                try:
                    self._open_settings(context, page)
                    self._detect_wechat_in_settings(page)
                    page.wait_for_selector("#wx-groups .gsel", timeout=20000)
                    state = page.evaluate(self._GROUP_PICKER_STATE)
                    self.assertTrue(state["shown"], "群选择区没有渲染出来")
                    self.assertEqual(state["pills"], ["共 5 个群", "AI 建议订阅 3 个", "已选 0 个"],
                                     "概览数字不对：%s" % state["pills"])
                    self.assertEqual(state["recRows"], 3, "推荐区行数应等于建议数：%s" % state)
                    self.assertEqual(state["categories"], ["课程通知（2）", "活动通知（1）"],
                                     "推荐区应按类别分组：%s" % state["categories"])
                    self.assertEqual(state["allRows"], 5, "全部群列表行数应等于群数：%s" % state)
                    self.assertTrue(state["allHidden"], "「全部群聊」默认必须收起：%s" % state)
                    self.assertEqual(state["clipped"], 0, "群名被截断了：%s" % state)

                    page.click('#wx-groups [data-gsel-fold="all"]')
                    opened = page.evaluate(self._GROUP_PICKER_STATE)
                    self.assertFalse(opened["allHidden"], "点「全部群聊」后没有展开：%s" % opened)
                    self.assertEqual(opened["allRows"], 5, "展开后行数应是全部群：%s" % opened)

                    page.click('#wx-groups [data-gsel-body="rec"] .wx-group-row input[type=checkbox]')
                    picked = page.evaluate(self._GROUP_PICKER_STATE)
                    self.assertEqual(picked["picked"], "已选 1 个",
                                     "勾选一个群后已选数没变：%s" % picked)

                    page.click("#wx-groups [data-gsel-pick-all]")
                    all_picked = page.evaluate(self._GROUP_PICKER_STATE)
                    self.assertEqual(all_picked["picked"], "已选 3 个",
                                     "「全选建议」应把已选数改成建议数：%s" % all_picked)
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_wechat_group_picker_fits_narrow_viewport(self) -> None:
        """390 宽下群选择区不横向滚动，群名完整折行（`scrollWidth` 不超容器）。"""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                page.route("**/api/wechat/groups?setup=1", self._group_picker_stub())
                try:
                    self._open_settings(context, page)
                    self._detect_wechat_in_settings(page)
                    page.wait_for_selector("#wx-groups .gsel", timeout=20000)
                    state = page.evaluate(self._GROUP_PICKER_STATE)
                    self.assertEqual(state["pills"], ["共 5 个群", "AI 建议订阅 3 个", "已选 0 个"],
                                     "390 下概览数字不对：%s" % state["pills"])
                    self.assertTrue(
                        state["scrollWidth"] <= state["innerWidth"],
                        "390 下出现横向滚动：scrollWidth=%s innerWidth=%s"
                        % (state["scrollWidth"], state["innerWidth"]),
                    )
                    self.assertEqual(state["clipped"], 0, "390 下群名被截断：%s" % state)
                finally:
                    safe_close(context)
            finally:
                browser.close()

    # —— 群选择区：整页单轴滚动（滚动条里不再嵌滚动条） ——

    _GSEL_SCROLL_STATE = """() => {
        const settings = document.getElementById('tab-settings');
        const scrollers = [];
        settings.querySelectorAll('*').forEach((el) => {
            const cs = getComputedStyle(el);
            if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1)
                scrollers.push(el.id || String(el.className || '').slice(0, 40));
        });
        // 「其它群」details 收起时里面的行不占位，展开后才是真实长列表。
        const other = document.querySelector('#groups details.other-groups');
        if (other) other.open = true;
        const save = document.getElementById('save');
        const rows = [...document.querySelectorAll('#groups .group-row')]
            .filter((r) => r.getBoundingClientRect().height > 0);
        const last = rows.length ? rows[rows.length - 1] : null;
        // 文档坐标，不受「点微信卡把页面滚下去」的当前 scrollY 影响。
        const docRect = (el) => { const r = el.getBoundingClientRect();
            return {top: r.top + window.scrollY, bottom: r.bottom + window.scrollY}; };
        const sr = save ? docRect(save) : null;
        const lr = last ? docRect(last) : null;
        const groups = document.getElementById('groups');
        const subnav = document.querySelector('.settings-subnav');
        return {
            scrollingInner: scrollers,
            groupsOverflowY: groups ? getComputedStyle(groups).overflowY : null,
            groupsSH: groups ? groups.scrollHeight : null,
            groupsCH: groups ? groups.clientHeight : null,
            subnavOverflowY: subnav ? getComputedStyle(subnav).overflowY : null,
            rowCount: rows.length,
            saveAfterRows: !!(sr && lr && sr.top >= lr.bottom - 1),
            saveOverlapsLastRow: !!(sr && lr && sr.top < lr.bottom - 1),
            docScrollW: document.documentElement.scrollWidth,
            winW: window.innerWidth,
        };
    }"""

    _GSEL_FOLDED_STATE = """() => {
        const box = document.querySelector('#wx-groups');
        const rec = box.querySelector('[data-gsel-body="rec"]');
        const inner = [];
        box.querySelectorAll('*').forEach((el) => {
            const cs = getComputedStyle(el);
            if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1)
                inner.push(el.id || String(el.className || '').slice(0, 40));
        });
        return {recHidden: rec.hidden, recH: Math.round(rec.getBoundingClientRect().height),
                innerScrollers: inner, boxSH: box.scrollHeight, boxCH: box.clientHeight};
    }"""

    def test_group_picker_has_single_page_scroll_axis(self) -> None:
        """群列表按内容自然增高：设置页内不得再有第二根垂直滚动轴，保存订阅不盖住群行。

        旧版 `.group-list{max-height:220px;overflow:auto}` 让 QQ 订阅群自带一根滚动条，
        嵌在整页滚动里；`.settings-subnav` 也自带一根。去掉后整页只剩一条轴，
        「保存订阅」跟随列表末尾，不再贴在 220px 滚动盒下沿像盖住最后几行。
        """
        qq_status = json.dumps({
            "ok": True, "online": True, "nickname": "验收账号",
            "napcat_installed": True, "napcat_running": True,
        }, ensure_ascii=False)
        qq_groups = [
            {"group_id": str(10000 + i), "name": "课程通知群 %02d（含实验、作业与考试安排）" % i,
             "member_count": 60 + i * 3, "selected": i < 3}
            for i in range(1, 27)
        ]
        qq_suggest = json.dumps({
            "ok": True, "source": "llm",
            "groups": [
                {"group_id": g["group_id"], "name": g["name"],
                 "category": "course" if i < 12 else "chat",
                 "suggested": i < 12, "reason": "AI 识别：课程通知" if i < 12 else ""}
                for i, g in enumerate(qq_groups)
            ],
        }, ensure_ascii=False)
        qq_groups_body = json.dumps({"ok": True, "groups": qq_groups}, ensure_ascii=False)

        def stub(body):
            return lambda route: route.fulfill(
                status=200, content_type="application/json", body=body)

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                for width, height in ((1280, 900), (390, 844)):
                    context = browser.new_context(viewport={"width": width, "height": height})
                    page = context.new_page()
                    page.route("**/api/napcat/status", stub(qq_status))
                    page.route("**/api/groups/suggest*", stub(qq_suggest))
                    page.route("**/api/napcat/groups*", stub(qq_groups_body))
                    page.route("**/api/wechat/groups?setup=1", self._group_picker_stub())
                    label = "%d 宽" % width
                    try:
                        self._open_settings(context, page)
                        page.wait_for_selector("#groups .group-row", timeout=20000)
                        page.wait_for_selector("#save", state="visible", timeout=20000)
                        self._detect_wechat_in_settings(page)
                        page.wait_for_selector("#wx-groups .gsel", timeout=20000)
                        state = page.evaluate(self._GSEL_SCROLL_STATE)
                        self.assertEqual(state["scrollingInner"], [],
                                         "%s 设置页内出现第二根滚动轴：%s" % (label, state))
                        self.assertEqual(state["groupsOverflowY"], "visible",
                                         "%s 群列表不该自带滚动：%s" % (label, state))
                        self.assertEqual(state["groupsSH"], state["groupsCH"],
                                         "%s 群列表内容溢出被裁：%s" % (label, state))
                        self.assertIn(state["subnavOverflowY"], ("visible", "hidden"),
                                      "%s 左导航不该自带竖向内滚：%s" % (label, state))
                        self.assertEqual(state["rowCount"], 26,
                                         "%s 群行数应等于接口条数：%s" % (label, state))
                        self.assertTrue(state["saveAfterRows"],
                                        "%s「保存订阅」没跟随列表末尾：%s" % (label, state))
                        self.assertFalse(state["saveOverlapsLastRow"],
                                         "%s「保存订阅」盖住了最后一行群：%s" % (label, state))
                        self.assertLessEqual(state["docScrollW"], state["winW"],
                                             "%s 出现横向滚动：%s" % (label, state))

                        # 推荐区收起后高度必须真的收掉，不能留一块空滚动区。
                        page.click('#wx-groups [data-gsel-fold="rec"]')
                        folded = page.evaluate(self._GSEL_FOLDED_STATE)
                        self.assertTrue(folded["recHidden"],
                                        "%s 推荐区没收起：%s" % (label, folded))
                        self.assertEqual(folded["recH"], 0,
                                         "%s 推荐区收起后仍占位：%s" % (label, folded))
                        self.assertEqual(folded["innerScrollers"], [],
                                         "%s 折叠态留下空滚动区：%s" % (label, folded))
                        self.assertEqual(folded["boxSH"], folded["boxCH"],
                                         "%s 折叠态容器内容溢出：%s" % (label, folded))
                    finally:
                        safe_close(context)
            finally:
                browser.close()

    def test_url_token_exchanges_for_cookie_and_reloads(self) -> None:
        """带 `?token=` 首次访问：地址栏抹掉 token → 换成会话 Cookie → 自动重载一次。

        全站只有这一条真的走「换页」那条路：其余用例都用 `open_authed_page()` 预置 Cookie
        直接进页面（不换页，也就没有读到 reload 前初始态的竞态）。所以这里必须真验一次，
        否则「URL token 换 Cookie」这条路径就没人看着了。
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                harden(page)
                harden(context.request)
                failed_requests: list[str] = []
                page.on("requestfailed",
                        lambda request: failed_requests.append(
                            "%s %s" % (request.url, (request.failure() or ""))))
                try:
                    page.goto(self.base + "/?token=" + TOKEN + "&nowiz=1",
                              wait_until="domcontentloaded", timeout=60000)
                    # 等它自己换完备页：只看地址栏里已经没有 token。
                    # 不跟着等 document.readyState === 'complete'：那要所有子资源（manifest/js/图片）
                    # 都收尾，是环境副作用，不是这条用例要验的产品行为；CI 上它曾把等待拖到超时。
                    try:
                        page.wait_for_function(
                            "() => !location.search.includes('token=')", timeout=60000)
                    except Exception as exc:
                        evidence = {"href": "", "ready_state": "", "pending": []}
                        try:
                            evidence = page.evaluate(
                                """() => ({
                                     href: location.href,
                                     ready_state: document.readyState,
                                     pending: performance.getEntriesByType('resource')
                                       .filter((e) => e.responseEnd === 0)
                                       .map((e) => e.name)
                                       .slice(0, 10),
                                   })""")
                        except Exception as probe_exc:
                            evidence = {"probe_error": repr(probe_exc)}
                        self.fail(
                            "60 秒内地址栏还带着 token（换 Cookie 那步没成）。"
                            "当前 href=%r readyState=%r 未完成资源=%r 失败请求=%r 原始异常=%r"
                            % (evidence.get("href"), evidence.get("ready_state"),
                               evidence.get("pending"), failed_requests[:10], exc))
                    self.assertNotIn("token=", page.url)
                    # 换 Cookie 成不成，看行为：地址栏已无 token，下面这次同源 fetch 不带任何
                    # token 也返回 200——那就是会话 Cookie 在生效。
                    # （不直接读 Cookie 对象：playwright 1.64 在当前 CI 镜像上
                    #  BrowserContext.cookies() 抛内部 TypeError，Set-Cookie 头也不稳定暴露，
                    #  这两个探针会把环境问题变成假红。）
                    # Cookie 真的能过鉴权：之后不再带任何 token 也读得到受保护接口。
                    # Cookie 契约用纯 Python 验证（不经 playwright）：
                    # 「带 ?token= 的一次请求 → 服务端下发会话 Cookie → 之后只带 Cookie、
                    # 不带任何 token 也能过鉴权」。这正是浏览器那次 reload 之后所依赖的机制，
                    # 而 playwright 在「刚自重载的页面」上的任何调用都可能撞环境的瞬态
                    # TypeError（实测 evaluate / context.request.get / page.request.get /
                    # context.close 全中过），把这一条契约绑在那里只会间歇假红。
                    request = urllib.request.Request(
                        "%s/api/setup/status?token=%s" % (self.base, TOKEN))
                    with urllib.request.urlopen(request, timeout=30) as response:
                        self.assertEqual(response.status, 200)
                        set_cookie = response.headers.get("Set-Cookie") or ""
                    self.assertIn(SESSION_COOKIE_NAME, set_cookie,
                                  "带 token 的请求没有下发会话 Cookie：%r" % (set_cookie,))
                    cookie = set_cookie.split(";", 1)[0]
                    again = urllib.request.Request(
                        self.base + "/api/setup/status", headers={"Cookie": cookie})
                    with urllib.request.urlopen(again, timeout=30) as response:
                        self.assertEqual(response.status, 200)
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_push_field_table_ids_all_exist(self) -> None:
        """对照表里每个元素 id 都必须在页面上真的存在。

        这里的 id 来自产品代码里的 `pushFields`（正则读出来的），所以只要有人改了输入框 id
        却没改表、或反过来，这条就会红。旧写法 `getElementById('push-'+name)` 让这种错配
        静默跳过，六格坏三格而 402 条测试全绿——这条就是补那个洞。
        """
        self.assertEqual(len(PUSH_FIELD_PAIRS), 6, "推送对照表应恰好六项：%r" % (PUSH_FIELD_PAIRS,))
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                try:
                    self._open_settings(context, page)
                    found = page.evaluate(
                        """(ids) => {
                             const out = {};
                             ids.forEach((id) => { out[id] = !!document.getElementById(id); });
                             return out;
                           }""",
                        [element_id for _key, element_id in PUSH_FIELD_PAIRS])
                    for key, element_id in PUSH_FIELD_PAIRS:
                        self.assertTrue(found.get(element_id),
                                        "对照表说 %r 对应 #%s，但页面上没有这个元素：%r"
                                        % (key, element_id, found))
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_push_settings_saves_all_six_fields_under_backend_keys(self) -> None:
        """六格各填一个值点保存：发给后端的必须是对照表的**键名**和输入框里的**值**。

        重点锁三个改过名的框（应用密钥 / 用户密钥 / 机器人地址）：改名后取值断了，
        用户填的东西发不出去，界面上还不报错。
        """
        posted: list = []
        real_settings = urllib.request.urlopen(urllib.request.Request(
            self.base + "/api/settings", headers={"X-Token": TOKEN}), timeout=10
        ).read().decode("utf-8")

        def settings_stub(route) -> None:
            if route.request.method == "POST":
                posted.append(route.request.post_data or "")
                body = json.dumps({"ok": True, "push": {}, "channels": ["wxpusher"]})
            else:
                body = real_settings
            route.fulfill(status=200, content_type="application/json", body=body)

        values = {
            "push-wxpusher_key": "wx-key-aaa",
            "push-wxpusher_uids": "UID_bbb",
            "push-wxpusher_topic_ids": "12345",
            "push-serverchan_keys": "SCT-ccc",
            "push-pushplus_key": "plus-key-ddd",
            "push-robot-urls": "https://example.com/robot?sign=eee",
        }
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                page.route("**/api/settings", settings_stub)
                try:
                    self._open_settings(context, page)
                    # 有的通道默认折叠着：先全部展开，让 fill 能点到真实可见的输入框。
                    page.evaluate(
                        "() => document.querySelectorAll('#push-settings details')"
                        ".forEach((box) => { box.open = true; })")
                    # 走真实输入路径（fill 会派发 input/change 事件、写进元素的 value），
                    # 不用 evaluate 直接赋 value：那样赋值后一旦发生一次重渲染，值会被清空，
                    # 点保存就走进 savePushSettings 的「没有要保存的内容」分支，压根不发请求。
                    for element_id, value in values.items():
                        page.fill("#" + element_id, value, timeout=15000)
                        # 填完立刻读回：CI 慢机上偶发某格 fill 落空（拿到的是重建前的旧节点，
                        # 值写进了已经脱离文档的那个节点）。落空就再填一次——被测的契约是
                        # 「点保存时输入框里的值」，不是「第一次 fill 一定命中」，所以重填不掩盖问题；
                        # 若真有一次重渲染抹掉了值，下面的六格检查和保存请求的断言照样会红。
                        for _ in range(3):
                            if page.input_value("#" + element_id, timeout=5000) == value:
                                break
                            page.fill("#" + element_id, value, timeout=15000)
                    # 点保存前先确认六格都还是非空——重渲染清空时这里就红，不是等到 posted 为空才猜。
                    try:
                        page.wait_for_function(
                            """(ids) => ids.every((id) => {
                                 const input = document.getElementById(id);
                                 return input && input.value.trim() !== '';
                               })""",
                            arg=list(values), timeout=10000)
                    except Exception as exc:
                        snapshot = page.evaluate(
                            """(ids) => ids.map((id) => {
                                 const input = document.getElementById(id);
                                 return [id, input ? input.value : null];
                               })""", list(values))
                        self.fail("点保存前六格没有全部保住值（重渲染把它清空了？）：%r 原始异常=%r"
                                  % (snapshot, exc))
                    page.click("#push-save")
                    # 请求是点完之后才发出的：先等它进来再断言，别拿点完那一刻的列表判生死。
                    # 满载时事件循环会慢，给 10 秒预算、50ms 一步，超时才算失败。
                    # 请求只会迟到、不会不来：预算收紧只会制造假红（实测满载时 1/4 轮误红）。
                    deadline = time.monotonic() + 10
                    while not posted and time.monotonic() < deadline:
                        page.wait_for_timeout(50)
                    self.assertTrue(posted, "点保存后没有发出 /api/settings 请求")
                    body = json.loads(posted[0])
                    self.assertEqual(body, {
                        "wxpusher_app_token": "wx-key-aaa",
                        "wxpusher_uids": "UID_bbb",
                        "wxpusher_topic_ids": "12345",
                        "serverchan_keys": "SCT-ccc",
                        "pushplus_tokens": "plus-key-ddd",
                        "webhook_urls": "https://example.com/robot?sign=eee",
                    }, "保存请求的键名/取值不对：%r" % (body,))
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_push_configured_placeholders_use_masked_state(self) -> None:
        """已配置的通道要显示「已配置：掩码（留空不修改）」，三个改过名的框同样要显示。"""
        meta_payload = json.loads(urllib.request.urlopen(urllib.request.Request(
            self.base + "/api/meta", headers={"X-Token": TOKEN}), timeout=10).read().decode("utf-8"))
        affirmed = {
            "wxpusher_app_token": "…aaaa",
            "pushplus_tokens": "…bbbb",
            "webhook_urls": "https://example.co…cccc",
        }
        meta_payload["push"] = {
            key: ({"set": True, "count": 1, "masked": [affirmed[key]]} if key in affirmed
                  else {"set": False, "count": 0, "masked": []})
            for key, _element_id in PUSH_FIELD_PAIRS
        }
        meta_payload["channels"] = ["wxpusher", "pushplus", "webhook"]
        body = json.dumps(meta_payload)

        def meta_stub(route) -> None:
            route.fulfill(status=200, content_type="application/json", body=body)

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                page.route("**/api/meta", meta_stub)
                try:
                    self._open_settings(context, page)
                    deadline = time.monotonic() + 10
                    placeholders = {}
                    while time.monotonic() < deadline:
                        placeholders = page.evaluate(
                            """(ids) => {
                                 const out = {};
                                 ids.forEach((id) => {
                                   const input = document.getElementById(id);
                                   out[id] = input ? input.placeholder : null;
                                 });
                                 return out;
                               }""",
                            ["push-wxpusher_key", "push-pushplus_key", "push-robot-urls"])
                        if all((value or "").startswith("已配置：") for value in placeholders.values()):
                            break
                        page.wait_for_timeout(100)
                    for key, element_id in (("wxpusher_app_token", "push-wxpusher_key"),
                                            ("pushplus_tokens", "push-pushplus_key"),
                                            ("webhook_urls", "push-robot-urls")):
                        text = placeholders.get(element_id) or ""
                        self.assertIn("已配置：", text, "#%s 没显示已配置状态：%r" % (element_id, placeholders))
                        self.assertIn(affirmed[key], text, "#%s 没显示掩码：%r" % (element_id, placeholders))
                        self.assertIn("（留空不修改）", text, "#%s 少了留空提示：%r" % (element_id, placeholders))
                finally:
                    safe_close(context)
            finally:
                browser.close()


    def test_page_navigation_survives_a_missing_script(self) -> None:
        """某个 js/*.js 没加载到时，页签也必须还能点（CI 上真发生过）。

        guide.js 一挂，内联脚本里那句 `…onclick=runAutoSetup` 就抛 ReferenceError，
        整段脚本停在那一行，后面绑页签的代码再也没执行——现场就是「按钮都在、点哪个都不动」，
        用户只能刷新。页签是唯一的导航入口，不能跟着一起废掉。
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                try:
                    page.route("**/js/guide.js", lambda route: route.abort())
                    open_authed_page(context, page, self.base, TOKEN)
                    page.wait_for_selector("#tab-tasks", state="attached", timeout=15000)
                    self.assertEqual(
                        page.evaluate(
                            "() => typeof document.getElementById('tab-settings-button').onclick"),
                        "function",
                        "页签没绑上 onclick，脚本在中途抛错后把导航一起带走了")
                    open_settings(page)             # 真点一次，确认页签能切过去
                finally:
                    context.close()
            finally:
                browser.close()

    def test_tab_switch_and_settings_rerender_keep_scroll_and_width(self) -> None:
        """切页/设置重渲染不能抖：视口宽度不变，滚动位置不被夹断。

        锁三件事（bug 1 + bug 10）：
        1. `loadSettings()` 会清空 `.settings-body`，而它是 `display:contents`（page.html:761），
           清空等于删掉设置页全部面板 —— 文档高度瞬间塌陷、浏览器把 scrollTop 夹成 0。
           用户看到的就是「正在看下面的设置，突然自己滑到最顶」。重渲染后必须还停在原位。
        2. `render()` 末尾按 `location.hash` 滚动；目标在隐藏页签里时 rect 全 0，
           `scrollIntoView` 会落到文档顶部。配合 60s 的 `loadTasks` 定时器就是「偶发回顶」。
        3. 主导航页签来回切，`documentElement.clientWidth` 必须不变：滚动条一出现一消失，
           整页内容就会左右跳一下（这就是「切页抖」的横向那一半）。
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                try:
                    open_authed_page(context, page, self.base, TOKEN)
                    page.wait_for_selector("#tab-tasks", state="visible", timeout=15000)

                    # —— 1. 设置页滚到中部，再重新 loadSettings() ——
                    page.click("#tab-settings-button")
                    page.wait_for_selector("#push-settings", state="attached", timeout=15000)
                    scrolled = page.evaluate(
                        """() => {
                             window.scrollTo({top: 1200, left: 0, behavior: 'instant'});
                             return {y: Math.round(window.scrollY),
                                     height: document.documentElement.scrollHeight,
                                     gutter: getComputedStyle(document.documentElement).scrollbarGutter};
                           }""")
                    self.assertGreaterEqual(
                        scrolled["y"], 1198,
                        "设置页不够长、滚不到 1200（scrollHeight=%s）" % scrolled["height"])
                    self.assertIn("stable", scrolled["gutter"] or "",
                                  "html 没开 scrollbar-gutter:stable：%r" % scrolled["gutter"])
                    rerender = page.evaluate(
                        """async () => {
                             const before = Math.round(window.scrollY);
                             loadSettings();
                             await Promise.resolve();
                             await Promise.resolve();
                             return {before, after: Math.round(window.scrollY),
                                     leftoverMinHeight: document.getElementById('tab-settings').style.minHeight};
                           }""")
                    self.assertGreaterEqual(
                        rerender["after"], rerender["before"] - 2,
                        "重渲染设置页后滚动位置被夹回顶部：%s" % rerender)
                    self.assertEqual(
                        rerender["leftoverMinHeight"], "",
                        "重渲染结束后没有放开占位 min-height：%s" % rerender)

                    # 反证：没有保护时，清空 `.settings-body` 会让文档高度塌掉、滚动位置被浏览器夹走。
                    # 这条让上面那条断言不是空转——机制在真实浏览器里就是这样发生的。
                    # 夹到哪取决于设置页左子导航剩下的高度（实测 1200 → 544），所以只断言「掉了很远」。
                    collapse = page.evaluate(
                        """() => {
                             window.scrollTo({top: 1200, left: 0, behavior: 'instant'});
                             const before = Math.round(window.scrollY);
                             // 面板现在收在同页的 <details class="settings-group"> 里，
                             // 只清 .settings-body 已经删不掉它们了，得连组一起摘掉。
                             document.querySelectorAll('#tab-settings .settings-group').forEach(
                                 (group) => group.remove());
                             document.querySelector('#tab-settings .settings-body').textContent = '';
                             return {before, after: Math.round(window.scrollY)};
                           }""")
                    self.assertGreaterEqual(collapse["before"], 1198, collapse)
                    self.assertLess(
                        collapse["after"], collapse["before"] - 200,
                        "清空 .settings-body 后滚动位置几乎没动，说明这台机器上的机制与预期不同：%s"
                        % collapse)
                    # 复原面板并回到原位，后面的断言接着用（重建是异步的，等面板回来再滚）
                    page.evaluate("() => { loadSettings(); }")
                    page.wait_for_selector("#push-settings", state="attached", timeout=15000)
                    page.wait_for_timeout(400)
                    page.evaluate(
                        "() => { window.scrollTo({top: 1200, left: 0, behavior: 'instant'}); }")
                    restored = page.evaluate("() => Math.round(window.scrollY)")
                    self.assertGreaterEqual(
                        restored, 1198, "复原设置面板后没能回到 1200：scrollY=%s" % restored)

                    # —— 2. 定位隐藏页签里的元素时，页面保持原位 ——
                    guard = page.evaluate(
                        """() => {
                             const host = document.getElementById('tab-tasks');
                             const probe = document.createElement('li');
                             probe.id = 'task-guard-probe';
                             host.appendChild(probe);
                             history.replaceState(null, '', '#task-guard-probe');
                             const before = Math.round(window.scrollY);
                             scrollTargetIntoView(probe, 'instant');
                             const after = Math.round(window.scrollY);
                             probe.remove();
                             history.replaceState(null, '', location.pathname + location.search);
                             return {before, after, hidden: host.hidden};
                           }""")
                    self.assertTrue(guard["hidden"], "探针必须放在隐藏的待办页签里：%s" % guard)
                    self.assertGreaterEqual(guard["before"], 1198,
                                            "前置条件不成立（第 1 步没停在原位）：%s" % guard)
                    self.assertGreaterEqual(
                        guard["after"], guard["before"] - 2,
                        "隐藏页签里的目标引起了滚动：%s" % guard)

                    # —— 3. 主导航页签来回切，视口宽度必须一致 ——
                    widths = []
                    for tab in ("tasks", "inbox", "settings"):
                        page.click("#tab-%s-button" % tab)
                        page.wait_for_timeout(120)
                        widths.append(page.evaluate(
                            "() => document.documentElement.clientWidth"))
                    self.assertEqual(
                        len(set(widths)), 1,
                        "切页时视口宽度变了（滚动条出现/消失），整页会左右跳：%s" % widths)
                finally:
                    safe_close(context)
            finally:
                browser.close()


    def _eval_alive(self, page, script: str, timeout_ms: int = 10000):
        """页面忙的时候 page.evaluate 没有超时可言，会一直等下去。

        先确认页面还能响应（wait_for_function 有硬超时），再求值：
        页面真卡住就 10 秒内报出来，而不是把整条用例吊到 job 超时被取消。
        """
        page.wait_for_function("() => true", timeout=timeout_ms, polling=100)
        return page.evaluate(script)

    def _stage(self, message: str) -> None:
        """在 CI 日志里打点：这条用例曾整段耗掉十几分钟且拿不到 traceback，
        有了打点就能一眼看出卡在哪一步。"""
        print("[ui-browser] %s" % message, flush=True)

    def _announce_state(self, page) -> dict:
        """铃铛面板的可交互性快照。

        CI 上出现过「元素在面板里却一直判定不可点」，本地永远复现不出，
        所以把判定依据一次取全，失败时直接打进报错里。
        """
        return page.evaluate(
            "() => { const p = document.getElementById('announce-panel');"
            " const b = document.getElementById('announce-bell');"
            " const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();"
            "   return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };"
            " const hit = (el) => { if (!el) return null; const r = el.getBoundingClientRect();"
            "   if (!r.width || !r.height) return null;"
            "   const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);"
            "   return t ? (t.id || t.className || t.tagName) : null; };"
            " return {panelHidden: !!(p && p.hidden), panel: box(p), bell: box(b), bellHit: hit(b),"
            "   scrollY: window.scrollY,"
            "   vw: window.innerWidth, vh: window.innerHeight}; }")

    def test_bell_panel_keeps_system_notices_inside(self) -> None:
        """铃铛面板在桌面和窄屏都能打开，通知卡留在面板内。"""
        probe = """() => {
            const box = (el) => { const r = el.getBoundingClientRect();
                return {left: r.left, top: r.top, right: r.right, bottom: r.bottom}; };
            const bell = document.getElementById('announce-bell');
            const panel = document.getElementById('announce-panel');
            const stack = document.getElementById('notice-stack');
            const main = panel ? panel.querySelector('.announce-panel-main') : null;
            const br = bell.getBoundingClientRect();
            const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
            return {
                bellHit: !!hit && (hit === bell || bell.contains(hit)),
                bellInsideViewport: br.left >= 0 && br.right <= window.innerWidth,
                panelHidden: panel.hidden,
                panel: panel.hidden ? null : box(panel),
                stackRects: stack.getClientRects().length,
                stack: stack.getClientRects().length ? box(stack) : null,
                main: !panel.hidden && main ? box(main) : null,
                stackPosition: getComputedStyle(stack).position,
                title: document.getElementById('announce-panel-title').textContent,
                noticeHidden: document.getElementById('announce-pane-notice').hidden,


                overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
        }"""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                for width in (1280, 390):
                    self._stage("width=%d start" % width)
                    context = browser.new_context(viewport={"width": width, "height": 800})
                    page = context.new_page()
                    try:
                        open_authed_page(context, page, self.base, TOKEN)
                        # 这一步之后全是同步的页面查询/点击。CI 上出现过切完页签后
                        # 某个调用一直不返回（24 分钟没动静），默认超时能把它逼出来，
                        # 报错里会写明挂的是 evaluate 还是 click。
                        page.set_default_timeout(15000)
                        self._stage("width=%d page opened" % width)
                        # 铃铛必须真的露出来并被点到：以前外层 div 带着 hidden，全仓没人去掉，
                        # 结果是右上角根本没有入口，通知面板打不开。
                        page.wait_for_selector("#announce-bell", state="visible", timeout=15000)
                        self._stage("width=%d bell visible" % width)
                        closed = self._eval_alive(page, probe)
                        self.assertTrue(closed["bellHit"], "铃铛被别的层盖住：%s" % closed)
                        self.assertTrue(closed["bellInsideViewport"],
                                        "%dpx 下铃铛超出视口：%s" % (width, closed))
                        self.assertLessEqual(closed["overflowX"], 0,
                                             "%dpx 下出现横向溢出（铃铛把底栏顶出去了）：%s"
                                             % (width, closed))
                        # 关着的时候通知栈零占位：以前 fixed 悬浮会压住右侧正文。
                        self.assertEqual(closed["stackRects"], 0,
                                         "面板关着时通知栈仍在页面上占位：%s" % closed)
                        self.assertNotEqual(closed["stackPosition"], "fixed",
                                            "通知栈不许再 fixed 悬浮：%s" % closed)

                        self.assertTrue(page.is_visible("#announce-bell"), "铃铛不在页面上")
                        page.click("#announce-bell", timeout=5000)
                        self._stage("width=%d bell clicked" % width)
                        try:
                            page.wait_for_selector("#announce-panel", state="visible", timeout=6000)
                        except Exception as exc:
                            self.fail("点铃铛后面板没开：%r / %r"
                                      % (self._announce_state(page), exc))
                        page.wait_for_timeout(300)
                        self._stage("width=%d panel visible" % width)
                        notice_tab = self._eval_alive(page, probe)
                        self.assertEqual(notice_tab["title"], "通知")
                        self.assertFalse(notice_tab["noticeHidden"])

                        # 塞一张卡：卡片必须整张落在面板内容区里，不许越界。
                        page.evaluate(
                            "() => window.NHNotify.push({id: 'tab-probe', title: '面板内通知',"
                            " body: '这条只该出现在面板里。', level: 'info', sticky: true})")
                        page.wait_for_timeout(300)
                        inside = self._eval_alive(page, probe)
                        self.assertGreaterEqual(inside["stackRects"], 1, inside)
                        self.assertLessEqual(inside["stack"]["top"], inside["main"]["bottom"] + 1, inside)
                        self.assertGreaterEqual(inside["stack"]["bottom"], inside["main"]["top"] - 1, inside)
                        self.assertTrue(
                            inside["panel"]["left"] <= inside["stack"]["left"]
                            and inside["stack"]["right"] <= inside["panel"]["right"] + 1, inside)

                        page.keyboard.press("Escape")
                        page.wait_for_selector("#announce-panel", state="hidden", timeout=6000)
                        expect(page.locator("#announce-bell")).to_be_focused()
                        self._stage("width=%d done" % width)
                    finally:
                        safe_close(context)
            finally:
                browser.close()


    def test_notice_stack_evicts_oldest_when_every_card_is_sticky(self) -> None:
        """栈里全是 sticky 时也必须挤掉最旧的，淘汰循环不许转死。

        以前淘汰逻辑只在非 sticky 里找最旧的；同时挂着多张 sticky 通知后再推一张，就找不到可淘汰项，`while (items.size >= MAX_VISIBLE)`
        永远成立，整个页面主线程被转死——用户看到的就是点一下之后页面彻底不响应。
        MAX_VISIBLE 为 12：这里推 15 张，栈里应剩 12 张。
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 800})
                page = context.new_page()
                try:
                    open_authed_page(context, page, self.base, TOKEN)
                    page.set_default_timeout(15000)
                    page.wait_for_selector("#announce-bell", state="visible", timeout=15000)
                    # 铃铛是 HTML 里自带的，元素可见不等于脚本已经跑完；CI 上偶发
                    # 「Cannot read properties of undefined (reading 'clear')」就是抢在 notice 脚本之前调。
                    page.wait_for_function("() => !!window.NHNotify", timeout=15000)
                    self._eval_alive(page, "() => { window.NHNotify.clear(); return true; }")
                    self._eval_alive(
                        page,
                        "() => { for (var i = 0; i < 15; i += 1) {"
                        " window.NHNotify.push({id: 'sticky-' + i, title: 'sticky ' + i,"
                        " level: 'info', sticky: true}); }"
                        " return true; }")
                    # 被挤掉的卡走 is-leaving 退场（最长 300ms 兜底移除），
                    # 推完立刻数 DOM 会连退场中的卡一起数到；等退场播完再断言。
                    page.wait_for_function(
                        "() => document.querySelectorAll('#notice-stack .notice-card')"
                        ".length === 12", timeout=3000)
                    state = self._eval_alive(
                        page,
                        "() => { var cards = document.querySelectorAll('#notice-stack .notice-card');"
                        " return {count: cards.length,"
                        " ids: Array.prototype.map.call(cards, function (el) {"
                        " return el.getAttribute('data-notice-id'); })}; }")
                    self.assertEqual(state["count"], 12,
                                     "十五张 sticky 推完应只剩 12 张（MAX_VISIBLE）：%s" % state)
                    self.assertIn("sticky-14", state["ids"],
                                  "最新推的那张必须还在栈里：%s" % state)
                    self.assertNotIn("sticky-0", state["ids"],
                                     "最旧的必须被挤掉：%s" % state)
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_bell_panel_position_follows_bell(self) -> None:
        """面板打开时钉在铃铛正下方右对齐，不是从视口顶掉下来。"""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                for width, height in ((1280, 900), (390, 844)):
                    context = browser.new_context(viewport={"width": width, "height": height})
                    page = context.new_page()
                    try:
                        open_authed_page(context, page, self.base, TOKEN)
                        page.set_default_timeout(15000)
                        page.wait_for_selector("#announce-bell", state="visible", timeout=15000)
                        page.click("#announce-bell", timeout=5000)
                        page.wait_for_selector("#announce-panel", state="visible", timeout=20000)
                        # 面板有 140ms 入场过渡（translateY 起步），等它播完再量矩形，
                        # 否则量到的是半空中的中间帧（实测 top 差 4–6px）。
                        page.wait_for_function(
                            "() => { const p = document.getElementById('announce-panel');"
                            " return getComputedStyle(p).transform === 'none'; }",
                            timeout=3000)
                        state = self._eval_alive(page, """() => {
                            const b = document.getElementById('announce-bell').getBoundingClientRect();
                            const p = document.getElementById('announce-panel').getBoundingClientRect();
                            return {bellBottom: b.bottom, bellTop: b.top, bellRight: b.right, vw: window.innerWidth,
                                    vh: window.innerHeight, top: p.top, right: p.right, left: p.left, bottom: p.bottom,
                                    inViewport: p.top >= 0 && p.right <= window.innerWidth + 1
                                        && p.left >= -1 && p.bottom <= window.innerHeight};
                        }""")
                        # 面板贴着铃铛开：默认在正下方 8px；铃铛贴底放不下时翻到铃铛上方 8px。
                        below = state["bellBottom"] + 8
                        above = state["bellTop"] - (state["bottom"] - state["top"]) - 8
                        fits_below = below + (state["bottom"] - state["top"]) <= state["vh"]
                        expected = below if fits_below else above
                        self.assertAlmostEqual(
                            state["top"], expected, delta=2,
                            msg="%dpx 下面板没贴着铃铛开（期望 %s）：%s" % (width, expected, state))
                        # 面板右缘贴铃铛右缘：允许 16px 内的差（滚动条、transform 收着量）。
                        self.assertAlmostEqual(
                            state["right"] + (state["vw"] - state["bellRight"]), state["vw"], delta=16,
                            msg="%dpx 下面板没跟铃铛右对齐：%s" % (width, state))
                        self.assertTrue(state["inViewport"],
                                        "%dpx 下面板出视口：%s" % (width, state))
                    finally:
                        safe_close(context)
            finally:
                browser.close()

    def test_bell_panel_repositions_when_content_rerenders(self) -> None:
        """面板开着时通知内容高度变化，仍要贴住铃铛并留在视口内。"""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                try:
                    open_authed_page(context, page, self.base, TOKEN)
                    page.set_default_timeout(15000)
                    page.wait_for_selector("#announce-bell", state="visible", timeout=15000)
                    page.click("#announce-bell", timeout=5000)
                    page.wait_for_selector("#announce-panel", state="visible", timeout=6000)
                    page.wait_for_function(
                        "() => { const p = document.getElementById('announce-panel');"
                        " return getComputedStyle(p).transform === 'none'; }",
                        timeout=3000)
                    # 把面板挪到明显错误的位置，再触发一次重画：重画后必须自己回到铃铛边上。
                    page.evaluate("() => { document.getElementById('announce-panel').style.top = '0px'; }")
                    state = self._eval_alive(page, """() => {
                        repositionOpenAnnouncePanel();
                        const b = document.getElementById('announce-bell').getBoundingClientRect();
                        const p = document.getElementById('announce-panel').getBoundingClientRect();
                        return {bellTop: b.top, bellBottom: b.bottom, top: p.top, bottom: p.bottom,
                                height: p.height, vh: window.innerHeight};
                    }""")
                    below = state["bellBottom"] + 8
                    above = state["bellTop"] - state["height"] - 8
                    fits_below = below + state["height"] <= state["vh"] - 8
                    expected = below if fits_below else max(8, above)
                    self.assertAlmostEqual(
                        state["top"], expected, delta=2,
                        msg="重画后面板没按新高度重定位（期望 %s）：%s" % (expected, state))
                    self.assertLessEqual(
                        state["bottom"], state["vh"] + 1,
                        "重画后面板掉出视口底部：%s" % (state,))
                    # 实际高度改变时，由浏览器的尺寸观察器触发重新定位。
                    page.evaluate("""() => {
                        const bell = document.getElementById('announce-bell');
                        document.body.appendChild(bell);
                        bell.style.cssText = 'position:fixed;top:795px;right:23px;z-index:2000';
                        const panel = document.getElementById('announce-panel');
                        const block = document.createElement('div');
                        block.id = 'bell-resize-test'; block.style.height = '100px';
                        panel.appendChild(block);
                        repositionOpenAnnouncePanel();
                    }""")
                    page.wait_for_timeout(200)
                    page.wait_for_selector("#bell-resize-test", state="attached", timeout=3000)
                    page.evaluate("document.getElementById('bell-resize-test').style.height = '120px'")
                    page.wait_for_function("""() => {
                        const p = document.getElementById('announce-panel').getBoundingClientRect();
                        const b = document.getElementById('announce-bell').getBoundingClientRect();
                        return Math.abs(p.top - (b.top - p.height - 8)) <= 2;
                    }""", timeout=3000)
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_tunnel_card_stop_button_requires_confirm_and_resets(self) -> None:
        """公网访问卡「关闭公网」：两段确认（没确认不发请求）、成功后卡片回未开通态。

        这是把手机上的公网入口切断的写操作：误点一次（单击）绝不能真关。
        关闭成功后页面立刻回到未开通态，不许还挂着旧公网地址。
        """
        ready_payload = {"ok": True, "provider": "cloudflare", "state": "ready",
                         "message": "公网入口已开通，手机用移动网络也能连。",
                         "url": "https://example-node.ts.net:8443/?token=t",
                         "auth_url": "", "retryable": False, "installed": True,
                         "providers": {
                             "cloudflare": {"installed": True, "state": "ready",
                                            "message": "公网入口已开通。",
                                            "url": "https://example-node.ts.net:8443/?token=t"},
                             "tailscale": {"installed": False, "state": "idle", "message": "", "url": ""},
                         },
                         "url_changes_on_restart": True}
        state = {"calls": 0, "stopped": False}

        def idle_payload():
            return {"ok": True, "provider": "cloudflare", "state": "idle", "message": "",
                    "url": "", "auth_url": "", "retryable": True, "installed": True,
                    "providers": {
                        "cloudflare": {"installed": True, "state": "idle", "message": "", "url": ""},
                        "tailscale": {"installed": False, "state": "idle", "message": "", "url": ""},
                    },
                    "url_changes_on_restart": True}

        def tunnel_stub(route):
            if route.request.method == "POST" and "/api/tunnel/stop" in route.request.url:
                state["calls"] += 1
                state["stopped"] = True
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"ok": True, "message": "公网入口已关闭。",
                                               "state": "idle", "url": ""}))
                return
            # 关闭之后再查状态就是未开通（后端真会这么回），别让页面被旧状态又拉回「已开通」。
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps(idle_payload() if state["stopped"] else ready_payload))

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                page.route("**/api/tunnel/*", tunnel_stub)
                try:
                    open_authed_page(context, page, self.base, TOKEN)
                    page.set_default_timeout(15000)
                    open_settings(page)
                    page.wait_for_selector("#tunnel-card", state="visible", timeout=15000)
                    page.wait_for_selector("#tunnel-close", state="visible", timeout=15000)
                    # Cloudflare 通道：地址每次重启都会变，必须是显眼的琥珀提醒。
                    self.assertEqual(page.locator("#tunnel-provider-cloudflare").get_attribute("aria-pressed"), "true")
                    self.assertIn("这个地址每次重启会变", page.locator("#tunnel-card").inner_text())
                    # 第一次单击只是进入确认态：不发请求、按钮变确认文案。
                    page.click("#tunnel-close")
                    self.assertEqual(page.locator("#tunnel-close").inner_text(), "确认关闭？（4 秒内再点一次）")
                    page.wait_for_timeout(300)
                    self.assertEqual(state["calls"], 0, "没确认就发了关闭请求")
                    # 第二次单击才是真关：请求发出、卡片回到未开通态。
                    page.click("#tunnel-close")
                    page.wait_for_function("() => !!document.getElementById('tunnel-start')",
                                           timeout=8000)
                    self.assertEqual(state["calls"], 1)
                    card_text = page.locator("#tunnel-card").inner_text()
                    self.assertIn("开通公网", card_text)
                    self.assertIn("第一次会下载约 19 MB", card_text)
                    self.assertNotIn("example-node.ts.net", card_text,
                                     "关闭后卡片还挂着旧公网地址")
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_tunnel_provider_switch_needs_second_click_when_live(self) -> None:
        """通道胶囊：已开通时切换要先讲后果，点第二次才存 tunnel_provider。

        地址正在手机上用着，静默切走会让用户以为服务坏了：第一下只提示，不发请求。
        """
        state = {"provider": "cloudflare", "posted": []}

        def tunnel_payload():
            live = state["provider"] == "cloudflare"
            return {
                "ok": True, "provider": state["provider"],
                "state": "ready" if live else "idle", "message": "",
                "url": "https://example-node.ts.net:8443/?token=t" if live else "",
                "auth_url": "", "retryable": False, "installed": True,
                "providers": {
                    "cloudflare": {"installed": True,
                                   "state": "ready" if live else "idle", "message": "",
                                   "url": "https://example-node.ts.net:8443/?token=t" if live else ""},
                    "tailscale": {"installed": False, "state": "idle", "message": "", "url": ""},
                },
                "url_changes_on_restart": live,
            }

        def tunnel_stub(route):
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps(tunnel_payload()))

        def settings_stub(route):
            if route.request.method == "POST":
                body = json.loads(route.request.post_data or "{}")
                state["posted"].append(body)
                if body.get("tunnel_provider"):
                    state["provider"] = body["tunnel_provider"]
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"ok": True, "tunnel_provider": state["provider"]}))
                return
            route.fallback()

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                page.route("**/api/tunnel/*", tunnel_stub)
                page.route("**/api/settings", settings_stub)
                try:
                    open_authed_page(context, page, self.base, TOKEN)
                    page.set_default_timeout(15000)
                    open_settings(page)
                    page.wait_for_selector("#tunnel-provider-tailscale", state="visible", timeout=15000)
                    # 第一下只提示后果：不存设置、高亮不动。
                    page.click("#tunnel-provider-tailscale")
                    page.wait_for_function(
                        "() => document.getElementById('tunnel-switch-note').textContent.includes('切换后当前公网地址会失效')",
                        timeout=5000)
                    self.assertEqual(state["posted"], [], "没确认就把通道切了")
                    self.assertEqual(
                        page.locator("#tunnel-provider-cloudflare").get_attribute("aria-pressed"), "true")
                    # 第二下才真切：只发 tunnel_provider 一个键，成功后高亮与卡片都按新通道重画。
                    page.click("#tunnel-provider-tailscale")
                    page.wait_for_function(
                        "() => document.getElementById('tunnel-provider-tailscale').getAttribute('aria-pressed') === 'true'",
                        timeout=8000)
                    self.assertEqual(state["posted"], [{"tunnel_provider": "tailscale"}])
                    card_text = page.locator("#tunnel-card").inner_text()
                    self.assertIn("用 Tailscale 开通", card_text)
                    self.assertIn("要登录一次账号", card_text)
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_cloudflare_downloading_is_busy_and_polls_until_ready(self) -> None:
        """Cloudflare 开通中：按钮不可点、每 2 秒自动再查一次，就绪后自己出地址。

        只有「开通中」才轮询：这里靠 GET 次数 >= 3 证明间隔轮询真的跑起来了
        （首次加载 1 次 + 点开通后立即 1 次，第 3 次只能来自定时器）。
        """
        state = {"gets": 0, "start": None}

        def tunnel_stub(route):
            if route.request.method == "POST" and "/api/tunnel/start" in route.request.url:
                state["start"] = json.loads(route.request.post_data or "{}")
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"ok": True, "provider": "cloudflare", "state": "downloading"}))
                return
            state["gets"] += 1
            ready = state["gets"] >= 3
            payload = {
                "ok": True, "provider": "cloudflare",
                "state": "ready" if ready else "downloading",
                "message": "" if ready else "正在下载通道程序…",
                "url": "https://abc-xyz.trycloudflare.com" if ready else "",
                "auth_url": "", "retryable": not ready, "installed": True,
                "providers": {
                    "cloudflare": {"installed": True,
                                   "state": "ready" if ready else "downloading",
                                   "message": "" if ready else "正在下载通道程序…",
                                   "url": "https://abc-xyz.trycloudflare.com" if ready else ""},
                    "tailscale": {"installed": False, "state": "idle", "message": "", "url": ""},
                },
                "url_changes_on_restart": True,
            }
            route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                page.route("**/api/tunnel/*", tunnel_stub)
                try:
                    open_authed_page(context, page, self.base, TOKEN)
                    page.set_default_timeout(15000)
                    open_settings(page)
                    page.wait_for_selector("#tunnel-start", state="visible", timeout=15000)
                    self.assertTrue(page.locator("#tunnel-start").is_disabled(),
                                    "开通中的按钮还能点")
                    self.assertIn("正在开通…", page.locator("#tunnel-start").inner_text())
                    self.assertIn("正在下载通道程序…", page.locator("#tunnel-card").inner_text())
                    # 不用点任何按钮：定时器自己查到 ready，卡片换成地址。
                    page.wait_for_selector("#tunnel-close", state="visible", timeout=15000)
                    self.assertGreaterEqual(state["gets"], 3, "没有按 2 秒间隔继续查状态")
                    self.assertIsNone(state["start"], "开通中不该再发开通请求")
                    self.assertIn("这个地址每次重启会变", page.locator("#tunnel-card").inner_text())
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_agent_hint_hierarchy_and_shared_dialog(self) -> None:
        """提示块的层级与「什么是 agent？」共用弹窗。

        用户口径：主句要大、要占主要位置，说明行更小更淡；三处共用一个原生 dialog，
        三个入口都能打开，Esc 能关。这里在真实浏览器里量计算样式，不看源码猜。
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                try:
                    self._open_settings(context, page)
                    page.wait_for_selector("#update-card", state="visible", timeout=20000)
                    page.wait_for_selector("#update-card .agent-hint", state="visible",
                                           timeout=20000)
                    data = page.evaluate(
                        "() => Array.prototype.map.call("
                        "document.querySelectorAll('.agent-hint'), function (block) {"
                        "  var lead = block.querySelector('.agent-hint-lead');"
                        "  var note = block.querySelector('.agent-hint-note');"
                        "  var ls = getComputedStyle(lead); var ns = getComputedStyle(note);"
                        "  var bs = getComputedStyle(block);"
                        "  return {leadText: lead.textContent.trim(), noteText: note.textContent,"
                        "    leadSize: parseFloat(ls.fontSize), noteSize: parseFloat(ns.fontSize),"
                        "    leadColor: ls.color, noteColor: ns.color, leadWeight: ls.fontWeight,"
                        "    leadLine: parseFloat(ls.lineHeight), noteLine: parseFloat(ns.lineHeight),"
                        "    bg: bs.backgroundColor, borderLeft: bs.borderLeftWidth,"
                        "    padTop: bs.paddingTop, padLeft: bs.paddingLeft,"
                        "    links: block.querySelectorAll('.agent-hint-note a').length,"
                        "    buttons: block.querySelectorAll('.agent-hint-open').length};"
                        "})")
                    self.assertEqual(len(data), 3, "全页应恰好三块提示")
                    for item in data:
                        self.assertGreater(item["leadSize"], item["noteSize"],
                                           "主句字号必须大于说明行：%r" % item)
                        self.assertGreaterEqual(item["leadSize"], 15.0,
                                                "主句是最大的一档，别退回小字：%r" % item)
                        self.assertGreaterEqual(item["noteSize"], 13.0,
                                                "说明行不再是小字：%r" % item)
                        self.assertEqual(item["leadWeight"], "500")
                        self.assertNotEqual(item["leadColor"], item["noteColor"],
                                            "主句要比说明行更实（颜色不同）")
                        self.assertEqual(item["bg"], "rgb(246, 236, 210)",
                                         "浅底提示块：%r" % item["bg"])
                        self.assertEqual(item["borderLeft"], "2px")
                        self.assertEqual(item["padTop"], "8px")
                        self.assertEqual(item["padLeft"], "10px")
                        self.assertEqual(item["links"], 1, "说明行要有「项目地址」入口")
                        self.assertEqual(item["buttons"], 1, "说明行要有「什么是 agent？」入口")
                    leads = [item["leadText"] for item in data]
                    self.assertEqual(leads.count("建议让 agent 来装"), 2)
                    self.assertEqual(leads.count("建议让 agent 来更新"), 1)
                    for item in data:
                        self.assertIn("项目地址", item["noteText"])
                        self.assertIn("什么是 agent？", item["noteText"])

                    # 三块内都是同一个 dialog，不是每处各弹一个。
                    self.assertEqual(page.evaluate(
                        "() => document.querySelectorAll('dialog#agent-help-dialog').length"), 1)
                    self.assertEqual(page.evaluate(
                        "() => document.querySelectorAll('.agent-hint-open').length"), 3)

                    # 每个入口都能打开；Esc 能关；焦点落在 dialog 里。
                    for index in range(3):
                        page.evaluate(
                            "(i) => document.querySelectorAll('.agent-hint-open')[i].click()",
                            index)
                        page.wait_for_selector("#agent-help-dialog[open]", timeout=10000)
                        dialog_text = page.eval_on_selector(
                            "#agent-help-dialog", "el => el.textContent || ''")
                        self.assertIn("agent 是什么", dialog_text)
                        self.assertIn("Trae", dialog_text)
                        self.assertIn("WorkBuddy", dialog_text)
                        self.assertTrue(page.evaluate(
                            "() => document.getElementById('agent-help-dialog')"
                            ".contains(document.activeElement)"),
                            "打开后焦点要落在 dialog 里")
                        page.keyboard.press("Escape")
                        page.wait_for_function("() => !document.getElementById('agent-help-dialog').open", timeout=10000)

                    # 「知道了」也能关。
                    page.evaluate(
                        "() => document.querySelector('.agent-hint-open').click()")
                    page.wait_for_selector("#agent-help-dialog[open]", timeout=10000)
                    page.click("#agent-help-dialog .agent-help-actions button")
                    page.wait_for_function("() => !document.getElementById('agent-help-dialog').open", timeout=10000)
                finally:
                    safe_close(context)
            finally:
                browser.close()

    def test_refresh_qr_restarts_engine_then_loads_new_code(self) -> None:
        """「刷新二维码」必须真换码：先 POST /api/napcat/restart，再取新图。

        后端只有重启 NapCat 才会生成新二维码（`/api/napcat/qrcode` 是纯读）。
        这里同时锁住三条：
        1. 用户点 #refresh-qr → 先发一次 restart（带 uin 字段），失败要写进 #qr-note 不许静默；
        2. 5 秒轮询走 refreshQrIfStale() 的**无参** refreshQr()，只重取同一张图，绝不许偷偷重启引擎；
        3. 换码之后图片要重新加载出来。
        """
        posts: list = []
        bodies: list = []
        state = {"fail": False}

        def restart_stub(route) -> None:
            posts.append(route.request.method)
            bodies.append(route.request.post_data or "")
            if state["fail"]:
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"ok": False, "error": "重启引擎失败：端口被占用"}))
            else:
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"ok": True, "waiting_for_login": True}))

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                page.route("**/api/napcat/status", self._napcat_status_stub)
                page.route("**/api/napcat/qrcode**", self._napcat_qrcode_stub)
                page.route("**/api/napcat/restart", restart_stub)
                try:
                    # 引擎在跑、QQ 未登录 → running_need_login → #refresh-qr 可见。
                    self.napcat_running = True
                    open_authed_page(context, page, self.base, TOKEN)
                    open_settings(page)
                    page.wait_for_selector("#refresh-qr", state="visible", timeout=20000)
                    # 初次 checkSetup() 已经跑过 refreshQrIfStale() → 无参 refreshQr()。
                    # 那时不该有 restart，否则就是每 5 秒自动重启引擎。
                    self.assertEqual(posts, [], "轮询路径不该发 restart：%r" % posts)

                    page.click("#refresh-qr")
                    deadline = time.time() + 20.0
                    while time.time() < deadline and not posts:
                        page.wait_for_timeout(50)
                    self.assertEqual(posts, ["POST"],
                                     "点「刷新二维码」应先发一次 /api/napcat/restart：%r" % posts)
                    payload = json.loads(bodies[0] or "{}")
                    self.assertIn("uin", payload, "restart 请求要带 uin 字段：%r" % bodies)

                    note = page.eval_on_selector(
                        "#qr-note", "el => el.textContent || ''")
                    self.assertIn("正在换一张新码", note,
                                  "换码期间 #qr-note 要说明正在换新码，实际：%r" % note)

                    # 换码成功后图片重新加载出来（证明取的是真 PNG，不是只换了文案）。
                    page.wait_for_function(
                        "() => { const i = document.getElementById('qr');"
                        " return i && !i.hidden && i.complete && i.naturalWidth > 0; }",
                        timeout=20000)

                    # —— 失败路径：restart 回 ok:false，必须把原因写进 #qr-note，不许假装成功 ——
                    state["fail"] = True
                    page.click("#refresh-qr")
                    deadline = time.time() + 20.0
                    while time.time() < deadline and len(posts) < 2:
                        page.wait_for_timeout(50)
                    self.assertEqual(posts, ["POST", "POST"], posts)
                    page.wait_for_function(
                        "() => (document.getElementById('qr-note').textContent || '').indexOf('换新码失败') === 0",
                        timeout=20000)
                    note = page.eval_on_selector(
                        "#qr-note", "el => el.textContent || ''")
                    self.assertIn("端口被占用", note, "失败原因要原样写进 #qr-note：%r" % note)
                    self.assertIn("再试一次", note, "失败文案要给出下一步：%r" % note)
                finally:
                    safe_close(context)
            finally:
                browser.close()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

