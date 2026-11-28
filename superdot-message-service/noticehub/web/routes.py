"""HTTP 路由表：路径 → (处理方法名, 是否免鉴权)。

只放数据，不 import webapp（避免循环依赖）。webapp 的 do_GET / do_POST 查表后调用
``getattr(self, 方法名)(path)``；处理方法仍在 webapp.py 里，所以测试对 webapp 模块级
对象的 patch 依然有效。

表里每一条都对应改造前 do_GET / do_POST 里的一条 ``if path == ...`` 分支，
tests/test_routes.py 会核对两边一一对应。
"""

from __future__ import annotations

GET_ROUTES: dict[str, tuple[str, bool]] = {
    "/api/settings/reminders": ("_route_get_reminder_settings", False),
    "/api/settings/desktop-pet": ("_route_get_desktop_pet", False),
    "/api/desktop-pet/state": ("_route_get_desktop_pet_state", True),
    "/api/execution/status": ("_route_get_execution_status", False),
    "/api/tickets": ("_route_execution_proxy", False),
    "/api/notifications": ("_route_execution_proxy", False),
    '/': ('_route_get_', False),  # GET
    '/api/app/qr.png': ('_route_get_api_app_qr_png', False),  # GET
    '/api/backup': ('_route_get_api_backup', False),  # GET
    '/api/chaoxing/cookie/status': ('_route_get_api_chaoxing_cookie_status', False),  # GET
    '/api/chaoxing/courses': ('_route_get_api_chaoxing_courses', False),  # GET
    '/api/chaoxing/status': ('_route_get_api_chaoxing_status', False),  # GET
    '/api/config/audit': ('_route_get_api_config_audit', False),  # GET
    '/api/dingtalk/groups': ('_route_get_api_dingtalk_groups', False),  # GET
    '/api/dingtalk/status': ('_route_get_api_dingtalk_status', False),  # GET
    '/api/firewall/status': ('_route_get_api_firewall_status', False),  # GET
    '/api/groups/suggest': ('_route_get_api_groups_suggest', False),  # GET
    '/api/health': ('_route_get_health', True),  # GET
    '/api/history/fetch/status': ('_route_get_api_history_fetch_status', False),  # GET
    '/api/hosting/status': ('_route_get_api_hosting_status', False),  # GET
    '/api/qq/conversations': ('_route_get_api_qq_conversations', False),  # GET
    '/api/inbox': ('_route_get_api_inbox', False),  # GET
    '/api/inbox/image': ('_route_get_api_inbox_image', False),  # GET
    '/api/lab/rules': ('_route_get_api_lab_rules', False),  # GET
    '/api/meta': ('_route_get_api_meta', False),  # GET
    '/api/napcat/doctor': ('_route_get_api_napcat_doctor', False),  # GET
    '/api/napcat/groups': ('_route_get_api_napcat_groups', False),  # GET
    '/api/napcat/install/status': ('_route_get_api_napcat_install_status', False),  # GET
    '/api/napcat/qrcode': ('_route_get_api_napcat_qrcode', False),  # GET
    '/api/napcat/status': ('_route_get_api_napcat_status', False),  # GET
    '/api/notices': ('_route_get_api_notices', False),  # GET
    '/api/onboarding': ('_route_get_api_onboarding', True),  # GET
    '/api/overview': ('_route_get_api_overview', False),  # GET
    '/api/pair/info': ('_route_get_api_pair_info', False),  # GET
    '/api/pair/pending': ('_route_get_api_pair_pending', False),  # GET
    '/api/pair/status': ('_route_get_api_pair_status', True),  # GET
    '/api/ping': ('_route_get_api_ping', True),  # GET
    '/api/qq/groups/status': ('_route_get_api_qq_groups_status', False),  # GET
    '/api/selfcheck': ('_route_get_api_selfcheck', False),  # GET
    '/api/settings': ('_route_get_api_settings', False),  # GET
    '/api/setup/status': ('_route_get_api_setup_status', False),  # GET
    '/api/sync/info': ('_route_get_api_sync_info', False),  # GET
    '/api/sync/qr.png': ('_route_get_api_sync_qr_png', False),  # GET
    '/api/sync/test': ('_route_get_api_sync_test', False),  # GET
    '/workbench.css': ('_route_get_workbench_css', True),
    '/api/router/queue': ('_route_get_router_queue', False),
    '/api/settings/package-rule': ('_route_get_package_rule', False),
    '/api/settings/screening': ('_route_get_screening', False),
    '/api/router/orders': ('_route_get_router_orders', False),
    '/api/work-orders/events': ('_route_get_work_order_events', False),
    '/api/work-orders': ('_route_get_work_orders', False),
    '/api/tasks': ('_route_get_api_tasks', False),  # GET
    '/api/tunnel/status': ('_route_get_api_tunnel_status', False),  # GET
    '/api/wechat/groups': ('_route_get_api_wechat_groups', False),  # GET
    '/api/wechat/status': ('_route_get_api_wechat_status', False),  # GET
    '/calendar': ('_route_get_calendar', False),  # GET
    '/calendar.ics': ('_route_get_calendar_ics', False),  # GET
    '/floatball': ('_route_get_floatball', False),  # GET
    '/floatball.html': ('_route_get_floatball', False),  # GET
    '/health': ('_route_get_health', True),  # GET
    '/whale/hello.png': ('_route_get_whale_sticker', True),
    '/whale/done.png': ('_route_get_whale_sticker', True),
    '/whale/inbox.png': ('_route_get_whale_sticker', True),
    '/whale/settings.png': ('_route_get_whale_sticker', True),
    '/whale/pat.gif': ('_route_get_whale_sticker', True),
    '/whale/brand-still.png': ('_route_get_whale_sticker', True),
    '/whale/brand-react.gif': ('_route_get_whale_sticker', True),
    '/whale/key-token.png': ('_route_get_whale_sticker', True),
    '/whale/inbox-checklist.png': ('_route_get_whale_sticker', True),
    '/whale/guide-wave.png': ('_route_get_whale_sticker', True),
    '/icon.svg': ('_route_get_icon_svg', True),  # GET
    '/index.html': ('_route_get_', False),  # GET
    '/manifest.webmanifest': ('_route_get_manifest_webmanifest', True),  # GET
    '/setup': ('_route_get_setup', False),  # GET
    '/sw.js': ('_route_get_sw_js', True),  # GET
}

POST_ROUTES: dict[str, tuple[str, bool]] = {
    "/api/settings/reminders": ("_route_post_reminder_settings", False),
    "/api/settings/desktop-pet": ("_route_post_desktop_pet", False),
    "/api/desktop-pet/action": ("_route_post_desktop_pet_action", True),
    "/api/packages": ("_route_post_frontend_package", False),
    "/api/raw/batch": ("_route_post_raw_batch", False),
    "/api/raw/attachments": ("_route_post_raw_attachment", False),
    "/api/raw/download": ("_route_post_raw_download", False),
    "/api/dsh/session": ("_route_open_worker", False),
    "/api/tickets/actions": ("_route_execution_proxy", False),
    '/api/chaoxing/auto_cookie': ('_route_post_api_chaoxing_auto_cookie', False),  # POST
    '/api/chaoxing/cookie/validate': ('_route_post_api_chaoxing_cookie_validate', False),  # POST
    '/api/dingtalk/scan': ('_route_post_api_dingtalk_scan', False),  # POST
    '/api/firewall/allow': ('_route_post_api_firewall_allow', False),  # POST
    '/api/history/fetch': ('_route_post_api_history_fetch', False),  # POST
    '/api/history/fetch/cancel': ('_route_post_api_history_fetch_cancel', False),  # POST
    '/api/hosting/start': ('_route_post_api_hosting_start', False),  # POST
    '/api/hosting/stop': ('_route_post_api_hosting_start', False),  # POST
    '/api/inbox/manual': ('_route_post_api_inbox_manual', False),  # POST
    '/api/inbox/promote': ('_route_post_api_inbox_promote', False),  # POST
    '/api/lab/rules': ('_route_post_api_lab_rules', False),  # POST
    '/api/settings/package-rule': ('_route_post_package_rule', False),
    '/api/settings/screening': ('_route_post_screening', False),
    '/api/napcat/autosetup': ('_route_post_api_napcat_autosetup', False),  # POST
    '/api/napcat/connect': ('_route_post_api_napcat_connect', False),  # POST
    '/api/napcat/install': ('_route_post_api_napcat_install', False),  # POST
    '/api/napcat/launch': ('_route_post_api_napcat_launch', False),  # POST
    '/api/napcat/restart': ('_route_post_api_napcat_restart', False),  # POST
    '/api/onboarding/accept': ('_route_post_api_onboarding_accept', True),  # POST
    '/api/pair/approve': ('_route_post_api_pair_approve', False),  # POST
    '/api/pair/deny': ('_route_post_api_pair_deny', False),  # POST
    '/api/pair/pending/clear': ('_route_post_api_pair_pending_clear', False),  # POST
    '/api/pair/public': ('_route_post_api_tunnel_start', False),  # POST
    '/api/pair/start': ('_route_post_api_pair_start', True),  # POST
    '/api/session/exchange': ('_route_post_api_session_exchange', True),  # POST
    '/api/settings': ('_route_post_api_settings', False),  # POST
    '/api/settings/test-push': ('_route_post_api_settings_test_push', False),  # POST
    '/api/subscriptions': ('_route_post_api_subscriptions', False),  # POST
    '/api/router/decide': ('_route_post_router_decision', False),
    '/api/work-orders/action': ('_route_post_work_order_action', False),
    '/api/work-orders/worker': ('_route_post_work_order_worker', False),
    '/api/tasks/create': ('_route_post_api_tasks_create', False),  # POST
    '/api/tasks/pin': ('_route_post_api_tasks_pin', False),  # POST
    '/api/tasks/urgent': ('_route_post_api_tasks_urgent', False),  # POST
    '/api/tunnel/start': ('_route_post_api_tunnel_start', False),  # POST
    '/api/tunnel/stop': ('_route_post_api_tunnel_stop', False),  # POST
    '/api/wechat/scan': ('_route_post_api_dingtalk_scan', False),  # POST
}

# 前缀/模式路由：path 不是字面量，按前缀匹配。这些也必须登记在表里，别偷偷写回 if。
# (前缀, 处理方法名, 是否免鉴权, 基线里登记的名字)
GET_PATTERN_ROUTES: tuple[tuple[str, str, bool, str], ...] = (
    ("/js/", "_route_get_js", True, "/js/*"),
    ("/api/packages/", "_route_get_package", False, "/api/packages/<id>"),
    ("/api/tickets/", "_route_execution_proxy", False, "/api/tickets/<id>"),
    ("/api/artifacts/", "_route_get_artifact", False, "/api/artifacts/<id>"),
)

POST_PATTERN_ROUTES: tuple[tuple[str, str, bool, str], ...] = (
    ("/api/tasks/", "_route_post_tasks", False, "/api/tasks/<id>"),
    ("/api/notifications/", "_route_execution_proxy", False, "/api/notifications/<id>/handle"),
)


def match_pattern(method: str, path: str) -> tuple[str, bool] | None:
    """按前缀找模式路由；找不到返回 None。"""
    table = GET_PATTERN_ROUTES if method == "GET" else POST_PATTERN_ROUTES
    for prefix, handler, public, _label in table:
        if path.startswith(prefix):
            return handler, public
    return None
