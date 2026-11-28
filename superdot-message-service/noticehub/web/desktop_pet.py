"""Send SuperDot's current work order to a local dsh-pet instance."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import shutil
import subprocess
import sys
import uuid
import threading
import time
import webbrowser
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request

from noticehub.execution.client import ExecutionHost
from noticehub.platform.timeutil import now_local


LOGGER = logging.getLogger(__name__)
PREFIX = "/dsh-pet-7340"
MENU = "打开 SuperDot 工单"
PREFERENCE = "desktop_pet_enabled"
DEFAULTS = {"created": True, "action": True, "result": True, "problem": True, "speech": False}
ACTION_CODES = {"APPROVAL_REQUIRED", "APPROVAL_NEEDED", "INPUT_NEEDED", "ROUTE_REVIEW"}


def _notice_kind(notice: dict) -> str | None:
    code = str(notice.get("code") or "")
    if code == "RESULT_READY":
        return "result"
    if code in ACTION_CODES or notice.get("options"):
        return "action"
    if re.search(r"FAIL|ERROR|BLOCKED|INTERRUPTED|UNAVAILABLE|EXHAUSTED|TIMEOUT", code):
        return "problem"
    return None


BUBBLE_PRIORITY = {"action": 5, "problem": 4, "result": 3, "created": 2, "progress": 1}


def _bubble_group(item: dict) -> str:
    target = item.get("target", "")
    return target if target.startswith("ticket:") else item["id"]


def _ticket_bubbles(items: list[dict]) -> list[dict]:
    groups = {}
    for item in items:
        groups.setdefault(_bubble_group(item), []).append(item)
    bubbles = []
    for group, members in groups.items():
        selected = max(members, key=lambda item: (BUBBLE_PRIORITY[item["kind"]], item["id"]))
        ids = sorted({item["id"] for item in members if item["kind"] == selected["kind"]})
        if len(ids) > 1:
            # 同优先级的新提醒可重新出现；轮询顺序、较低优先级消息的变化不会打断暂时忽略。
            revision = hashlib.sha256(json.dumps(ids).encode()).hexdigest()[:24]
            selected = {**selected, "id": f"{group}:reminders:{revision}"}
        bubbles.append(selected)
    return bubbles


def _bubble_text(title: str, kind: str) -> str:
    title = " ".join(title.split()) or "未命名工单"
    if len(title) > 32:
        title = title[:31] + "…"
    endings = {"action": "遇到卡点，等待审批", "result": "已有结果，等待查看",
               "problem": "执行遇到问题，等待查看", "created": "已创建", "progress": "进度已更新"}
    return f"您有新的工单：《{title}》{endings[kind]}。"


def _ticket_status(ticket: dict, notice: dict | None, *, new: bool = False) -> tuple[str, str]:
    title = str(ticket.get("title") or "工单")
    if new and notice is None:
        return "working", f"已创建工单 · {title}"
    code = (notice or {}).get("code")
    nodes = ticket.get("nodes") or []
    if code == "RESULT_READY":
        latest_result = next((node for node in reversed(nodes) if node.get("kind") in {"confirm", "result"}), {})
        if latest_result.get("kind") == "confirm":
            return "success", f"已完成 · {title}"
        return "result", f"成果可查看 · {title}"
    if code in {"APPROVAL_REQUIRED", "APPROVAL_NEEDED", "INPUT_NEEDED", "ROUTE_REVIEW"} or (notice or {}).get("options"):
        label = {"INPUT_NEEDED": "需要你回复", "ROUTE_REVIEW": "请确认消息归属"}.get(code, "待你审批")
        return "waiting", f"{label} · {title}"
    for node in reversed(nodes):
        kind = node.get("kind")
        if kind == "confirm":
            return "success", f"已完成 · {title}"
        if kind == "result":
            return "result", f"成果可查看 · {title}"
        if kind == "interrupted":
            return "error", f"执行中断 · {title}"
        if kind == "note" and str(node.get("text") or "").strip():
            stage = " ".join(str(node["text"]).split())
            return "working", f"{title[:12]} · {stage}"
        if kind in {"input", "feedback", "resume", "recover", "requirement", "unblocked"}:
            break
    return "working", f"执行中 · {title}"


class DesktopPet:
    _pet_keys = {"size", "balanceEnabled", "fixedEnabled", "whisperEnabled", "workStatusEnabled"}
    _global_keys = {"notificationsEnabled", "notifyWhenFocused", "clickSoundEnabled", "whisperImageEnabled",
                    "chatImageEnabled", "chatAnimationEnabled", "confineToScreen", "trayEnabled", "voiceEnabled",
                    "voiceVolume", "voiceWhisperEnabled", "voiceTodoEnabled", "voiceNotifyEnabled"}

    def __init__(self, store, execution: ExecutionHost, web_port: int, address: str, runtime_file: str = "") -> None:
        self.store = store
        self.execution = execution
        self.web_port = web_port
        address = address.rstrip("/")
        self.address = address
        support = (Path.home() / "Library/Application Support" if sys.platform == "darwin" else
                   Path(os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share"))
        install = support / "SuperDot" / "desktop-pet"
        self.launch_entry = install / "node_modules/dsh-pet/lib/standalone.js"
        default_home = install / "runtime" if self.launch_entry.is_file() else Path.home() / ".dsh"
        dsh_home = Path(os.environ.get("DSH_HOME") or default_home)
        self.system_managed = False
        self.launch_process: subprocess.Popen | None = None
        self.runtime_file = Path(runtime_file).expanduser() if runtime_file else dsh_home / "dsh-pet" / "standalone-runtime.json"
        self.client = ExecutionHost("")
        self.headers: dict[str, str] = {}
        self.runtime_stamp: int | None = None
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.last: tuple[str, str | None, str | None, str] | None = None
        self.versions: set[str] | None = None
        self.pending_bubbles: list[dict] = []
        self.transient: dict[str, tuple[float, dict]] = {}
        self.targets: dict[str, str] = {}
        self.pending_count = 0
        self.pending_target = ""
        self.notice_unavailable = False
        self.visible: bool | None = None
        self.enhanced = False
        self.bridge_key = secrets.token_urlsafe(32)
        self.connected = False
        self.menu_ready = False
        self.message = ""

    def _connect(self) -> None:
        try:
            with self.runtime_file.open(encoding="utf-8") as runtime:
                details = json.loads(runtime.read(8192))
                stamp = os.fstat(runtime.fileno()).st_mtime_ns
            if not isinstance(details, dict) or details.get("name") != "dsh-pet-standalone":
                raise ValueError
            port = details.get("port")
            token = details.get("token")
            if type(port) is not int or not 1 <= port <= 65535 or not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
                raise ValueError
        except (OSError, ValueError) as error:
            raise OSError("无法读取桌宠运行状态，请先启动 dsh-pet 独立版") from error
        address = self.address or f"http://127.0.0.1:{port}"
        try:
            parts = urlsplit(address)
            if parts.scheme != "http" or parts.hostname not in {"127.0.0.1", "localhost"} or parts.port != port:
                raise ValueError
            client = ExecutionHost(address)
        except ValueError as error:
            raise OSError("桌宠地址与运行端口不一致，请检查 NOTICEHUB_DESKTOP_PET_URL") from error
        status, health = client.request("/health")
        if status != 200 or health.get("name") != details["name"] or health.get("pid") != details.get("pid"):
            raise OSError("未找到对应的桌宠进程，请重新启动 dsh-pet 独立版")
        self.client = client
        self.headers = {"X-DSH-Pet-Token": token}
        self.system_managed = bool(self._launch_agent())
        self.runtime_stamp = stamp
        self.menu_ready = False

    def _call(self, route: str, data: dict | None = None) -> dict:
        status, body = self.client.request(PREFIX + route, data, extra_headers=self.headers)
        if status != 200 or body.get("ok") is False:
            raise OSError("无法连接桌宠，请先启动 dsh-pet 并确认端口")
        return body

    def _clear_status(self) -> None:
        request = Request(self.client.base_url + PREFIX + "/work-status", method="DELETE", headers=self.headers)
        with self.client.opener.open(request, timeout=5) as response:
            if response.status != 204:
                raise OSError("桌宠未确认已清除工单状态")

    def enabled(self) -> bool:
        return self.store.meta_get(PREFERENCE) == "1"

    def preferences(self) -> dict:
        try:
            saved = json.loads(self.store.meta_get("desktop_pet_reminders", "{}"))
        except ValueError:
            saved = {}
        return {key: saved.get(key, default) if isinstance(saved, dict) else default
                for key, default in DEFAULTS.items()}

    def status(self) -> dict:
        return {"ok": True, "enabled": self.enabled(), "connected": self.connected,
                "visible": self.visible, "enhanced": self.enhanced, "system_managed": self.system_managed,
                "native": getattr(self, "_native", {}).copy() if self.connected else {},
                "preferences": self.preferences(), "message": self.message}

    def snapshot(self) -> dict:
        active = self.enabled()
        now = time.monotonic()
        bubbles = self.pending_bubbles + [item for expiry, item in self.transient.copy().values()
                                    if expiry > now and (not self.notice_unavailable or item["id"].startswith("preview:"))]
        return {"ok": True, "active": active or any(item["id"].startswith("preview:") for item in bubbles),
                "connected": self.connected, "pendingCount": self.pending_count,
                "bubbles": _ticket_bubbles(bubbles)}

    def active_notice_id(self) -> str:
        current = self.last
        if self.enhanced or not self.visible:
            return ""
        return current[3] if self.connected and current else ""

    def start(self) -> None:
        if self.thread is not None and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, name="superdot-desktop-pet", daemon=True)
        self.thread.start()

    def set_enabled(self, enabled: bool, preferences: dict | None = None) -> None:
        with self.lock:
            old_preferences = self.preferences()
            changed = enabled != self.enabled() or (
                preferences is not None and preferences != old_preferences
            )
            self.store.meta_set(PREFERENCE, "1" if enabled else "0")
            if preferences is not None:
                self.store.meta_set("desktop_pet_reminders", json.dumps(preferences))
            if changed:
                self.transient = {}
                self.pending_bubbles = [item for item in self.pending_bubbles
                                        if enabled and self.preferences().get(item["kind"])]
                self.versions = None
            if not enabled and self.last:
                try:
                    self._clear_status()
                except OSError:
                    self.message = "已关闭播报，原生状态将在桌宠重连后清除。"
                else:
                    self.last = None

    def _launch_agent(self) -> str | None:
        if sys.platform != "darwin":
            return None
        service = f"gui/{os.getuid()}/local.superdot.desktop-pet"
        try:
            result = subprocess.run(["/bin/launchctl", "print", service], capture_output=True, text=True, timeout=3)
        except subprocess.TimeoutExpired as error:
            raise OSError("系统桌宠服务未响应，请稍后重试。") from error
        if result.returncode:
            if "Could not find service" in (result.stderr + result.stdout):
                return None
            raise OSError("无法确认系统桌宠服务状态，请稍后重试。")
        home = str(self.runtime_file.parent.parent.resolve())
        # launchctl submit passes DSH_HOME as an env argument; plists use an environment entry.
        for line in result.stdout.splitlines():
            entry = line.strip()
            if entry in {f"DSH_HOME={home}", f"DSH_HOME => {home}"}:
                return service
        return None

    @contextmanager
    def _launch_lock(self):
        directory = self.runtime_file.parent
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "superdot-launch.lock").open("a+b") as lock:
            if os.name == "nt":
                import msvcrt
                if lock.tell() == 0:
                    lock.write(b"0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            # Closing the file releases the OS lock, including after process exit.
            yield

    def launch(self) -> None:
        """Reuse the authenticated host, or start the installed standalone runtime."""
        with self.lock, self._launch_lock():
            try:
                self._connect()
            except OSError:
                if self.runtime_file.name != "standalone-runtime.json" or self.runtime_file.parent.name != "dsh-pet":
                    raise OSError("请检查桌宠运行文件路径，再启动独立版。")
                service = self._launch_agent()
                if service:
                    # The service may already be starting. Never use -k or spawn a second host.
                    try:
                        result = subprocess.run(["/bin/launchctl", "kickstart", service], capture_output=True, timeout=5)
                    except subprocess.TimeoutExpired as error:
                        raise OSError("系统桌宠服务正在启动，请稍后重试。") from error
                    if result.returncode:
                        raise OSError("系统未能启动桌宠服务，请稍后重试。")
                elif self.launch_process is None or self.launch_process.poll() is not None:
                    node = shutil.which("node")
                    standalone = shutil.which("dsh-pet-standalone")
                    if node and self.launch_entry.is_file():
                        command = [node, str(self.launch_entry)]
                    elif standalone:
                        command = [standalone]
                    else:
                        raise OSError("未找到 dsh-pet 独立版，请先安装桌宠组件。")
                    if self.address:
                        parts = urlsplit(self.address)
                        if parts.scheme != "http" or parts.hostname not in {"localhost", "127.0.0.1"} or not parts.port:
                            raise ValueError("请检查桌宠本机地址和端口。")
                        command.extend(["--port", str(parts.port)])
                    self.launch_process = subprocess.Popen(
                        command, env={**os.environ, "DSH_HOME": str(self.runtime_file.parent.parent)},
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        start_new_session=os.name != "nt",
                    )
                deadline = time.monotonic() + 10
                while True:
                    try:
                        self._connect()
                        break
                    except OSError:
                        if not service and self.launch_process is not None and self.launch_process.poll() is not None:
                            raise OSError("桌宠进程已退出，请检查独立版运行环境。")
                        if time.monotonic() >= deadline:
                            raise OSError("桌宠仍在启动，请稍后查看连接状态。")
                        time.sleep(0.2)
            self._ready()
            if self.visible is False:
                config = self._call("/config")["main"]
                display = next(p.get("display") for p in config["pets"] if p.get("id") == "main")
                self._call("/pet-display", {"id": "main", "display": "both" if display == "web" else "desktop"})
                self._ready()
            self.message = ""

    def quit(self) -> None:
        with self.lock:
            self._ready()
            if self._launch_agent():
                raise ValueError("桌宠由系统服务保持运行，请使用「隐藏桌宠」。")
            self._call("/quit", {})
            self.connected = self.menu_ready = False
            self.visible = None
            self.message = "桌宠已退出。"

    def preview(self) -> None:
        with self.lock:
            self._ready()
            if not self.enhanced:
                raise OSError("当前桌宠需要更新后才能试播。")
            if self.visible is False:
                raise OSError("大肥鱼已隐藏，请先打开桌面显示。")
            self.transient = {key: value for key, value in self.transient.items()
                              if not key.startswith("preview:")}
            key = "preview:" + uuid.uuid4().hex
            self.transient[key] = (time.monotonic() + 8, {"id": key, "kind": "created",
                "text": _bubble_text("示例工单", "created"), "label": "前往查看", "target": "orders"})

    def open_settings(self) -> bool:
        with self.lock:
            self._ready()
            url = f"{self.client.base_url}/standalone-ai/#token={self.headers['X-DSH-Pet-Token']}"
        return webbrowser.open(url)

    def native_action(self, data: dict) -> tuple[int, dict]:
        kind = data.get("kind")
        if kind == "open":
            target = data.get("target")
            if not isinstance(target, str):
                return 400, {"ok": False, "message": "无效的工单入口。"}
            route = {"settings": "#settings?desktop-pet", "orders": "#tasks",
                     "pending": self.pending_target or "#tasks?pending=1"}.get(target) or self.targets.get(target)
            if not route:
                return 404, {"ok": False, "message": "这条提醒已更新，请到 SuperDot 查看。"}
            if not webbrowser.open(f"http://127.0.0.1:{self.web_port}/{route}"):
                return 503, {"ok": False, "message": "无法打开浏览器，请在 SuperDot 中查看。"}
            return 200, {"ok": True}
        if kind != "package-note":
            return 400, {"ok": False, "message": "无法识别桌宠操作。"}
        note_id = data.get("noteId")
        if not isinstance(note_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", note_id):
            return 400, {"ok": False, "message": "便签编号无效。"}
        try:
            notes = self._call("/todos").get("todos")
        except OSError:
            return 503, {"ok": False, "message": "读取便签失败，请稍后重试。"}
        note = next((item for item in notes if isinstance(item, dict) and item.get("id") == note_id), None) if isinstance(notes, list) else None
        if not note or not isinstance(note.get("text"), str) or not note["text"].strip():
            return 404, {"ok": False, "message": "便签不存在或内容为空，请检查后重试。"}
        text = note["text"].strip()
        due_at = note.get("dueAt")
        if type(due_at) in (int, float):
            try:
                due_time = datetime.fromtimestamp(due_at / 1000).astimezone()
                text += f"\n截止时间：{due_time.isoformat(timespec='minutes')}"
            except (ValueError, OverflowError, OSError):
                pass
        operation = "desktop-pet-note:" + note_id
        result = self.store.submit_frontend_package(
            {"kind": "new_task", "operation_id": operation, "text": text}, now_local())
        if result["code"] in {"QUEUED", "REPLAYED"}:
            return 200, {"ok": True, "packageId": result["package_ref"]["id"]}
        if result["code"] == "CONFLICT":
            return 409, {"ok": False, "message": "这张便签的旧内容已经转包。要提交新内容，请另建一张便签。"}
        return 503, {"ok": False, "message": "便签未进入消息包队列，请重试。"}

    def _ready(self) -> dict:
        if self.runtime_file.stat().st_mtime_ns != self.runtime_stamp or not self.menu_ready:
            self._connect()
            status, body = self.client.request(PREFIX + "/superdot/connect",
                {"port": self.web_port, "key": self.bridge_key}, extra_headers=self.headers)
            self.enhanced = status == 200 and body.get("ok") is True
            if not self.enhanced:
                self._call("/menu/item", {"owner": "SuperDot", "labels": [MENU], "target": "desktop"})
            self.menu_ready = True
            self.last = None
        config = self._call("/config")
        main = self._read_native(config)
        self.connected = True
        return main

    def _read_native(self, config: dict) -> dict:
        main = config.get("main")
        if not isinstance(main, dict) or not isinstance(main.get("pets"), list):
            raise OSError("桌宠未返回有效配置。")
        pet = next((item for item in main["pets"] if isinstance(item, dict) and item.get("id") == "main"), {})
        self.visible = pet.get("display") in {"desktop", "both"} if pet else None
        native = {key: main[key] for key in self._global_keys if key in main}
        native.update({key: pet[key] for key in self._pet_keys if key in pet})
        if pet:
            native["visible"] = self.visible
        self._native = native
        return main

    def set_native(self, key: str, value: object) -> None:
        if not isinstance(key, str) or key not in self._pet_keys | self._global_keys | {"visible"}:
            raise ValueError("未知的桌宠设置。")
        if key == "size":
            valid = type(value) is int and value >= 1
        elif key == "voiceVolume":
            valid = type(value) in (float, int) and 0 <= value <= 1
        else:
            valid = type(value) is bool
        if not valid:
            raise ValueError("桌宠设置值无效。")

        with self.lock:
            main = self._ready()
            pets = main["pets"]
            pet = next((item for item in pets if isinstance(item, dict) and item.get("id") == "main"), None)
            if not pet:
                raise OSError("桌宠未返回主宠物配置。")
            if key == "visible":
                web = pet.get("display") in {"web", "both"}
                display = ("both" if web else "desktop") if value else ("web" if web else "none")
                saved = self._call("/pet-display", {"id": "main", "display": display})
            else:
                # 上游 PUT 要求完整 pets 列表；省略的顶层字段由宿主保留磁盘原值。
                payload = {"pets": pets}
                if key in self._pet_keys:
                    updated = {**pet, key: value}
                    if key == "size":
                        updated.pop("sizePercent", None)
                    payload["pets"] = [updated if item is pet else item for item in pets]
                else:
                    payload[key] = value
                status, saved = self.client.request(PREFIX + "/config", payload, extra_headers=self.headers, method="PUT")
                if status != 200 or saved.get("ok") is False:
                    raise OSError("桌宠未能保存配置。")
            self._read_native(saved)
            if self._native.get(key) != value:
                raise OSError("桌宠未确认设置已生效。")

    def _loop(self) -> None:
        error_reported = False
        while not self.stop_event.is_set():
            target = ""
            with self.lock:
                try:
                    self._ready()
                    self.message = ""
                    self._update_work_order()
                    if not self.enhanced:
                        events = self._call("/menu/events?owner=SuperDot").get("events", {})
                        if events.get(MENU):
                            target = next(iter(self.targets.values()), "#tasks")
                    error_reported = False
                except (OSError, ValueError):
                    self.connected = False
                    self.visible = None
                    self.menu_ready = False
                    self.message = "桌宠未运行。"
                    self.notice_unavailable = True
                    if not error_reported:
                        LOGGER.warning("SuperDot 桌宠暂未连接")
                        error_reported = True
            if target:
                webbrowser.open(f"http://127.0.0.1:{self.web_port}/{target}")
            self.stop_event.wait(3)

    def _update_work_order(self) -> None:
        if self.execution.configured:
            ticket_status, ticket_data = self.execution.request("/api/tickets")
            notice_status, notice_data = self.execution.request("/api/notifications?state=pending")
        else:
            try:
                ticket_data, notice_data = self._local_work_orders()
            except sqlite3.Error:
                ticket_status, ticket_data, notice_status, notice_data = 503, {}, 503, {}
            else:
                ticket_status = notice_status = 200
        if (ticket_status != 200 or notice_status != 200 or not isinstance(ticket_data.get("items"), list)
                or not isinstance(notice_data.get("items"), list)):
            self.notice_unavailable = True
            self.message = "工单状态暂不可用，上次的待处理提醒仍保留。"
            return
        self.notice_unavailable = False
        tickets = {}
        for item in ticket_data["items"]:
            ticket = item.get("ticket") if isinstance(item, dict) else None
            if not isinstance(ticket, dict) or not isinstance(ticket.get("ticket_id"), str):
                continue
            description = ticket.get("description")
            if isinstance(description, dict) and description.get("visible") == 0:
                continue
            nodes = ticket.get("nodes")
            tickets[ticket["ticket_id"]] = {**ticket, "nodes": [node for node in nodes if isinstance(node, dict)]
                                           if isinstance(nodes, list) else []}
        active = self.enabled()
        prefs = self.preferences()
        old_versions = self.versions
        versions = set()
        pending_targets = {}
        pending_bubbles = []
        targets = {}
        status_candidates = []
        notice_priorities = {}
        now = time.monotonic()
        self.transient = {key: item for key, item in self.transient.items() if item[0] > now}
        for notice in notice_data["items"]:
            if not isinstance(notice, dict) or not notice.get("id"):
                continue
            ticket_id, notice_id = notice.get("ticket_id") or "", str(notice["id"])
            if not isinstance(ticket_id, str):
                continue
            if ticket_id and ticket_id not in tickets:
                continue
            kind = _notice_kind(notice)
            if not kind:
                continue
            version = "notice:" + notice_id
            if version in versions or notice.get("state") == "handled":
                continue
            versions.add(version)
            if ticket_id and prefs[kind]:
                notice_priorities["ticket:" + ticket_id] = max(notice_priorities.get("ticket:" + ticket_id, 0), BUBBLE_PRIORITY[kind])
            target = "ticket:" + ticket_id if ticket_id else "orders"
            targets[target] = "#tasks?" + urlencode({"ticket_id": ticket_id}) if ticket_id else "#tasks"
            title = str(tickets.get(ticket_id, {}).get("title") or "待分配工单")
            text = _bubble_text(title, kind)
            item = {"id": version, "kind": kind, "text": text, "label": "前往查看", "target": target,
                    "speak": bool(prefs["speech"] and kind in {"action", "result"})}
            pending_targets[_bubble_group(item)] = targets[target]
            if active and prefs[kind]:
                pending_bubbles.append(item)
                status_candidates.append(({"action": 5, "problem": 4, "result": 3}[kind], version,
                    ticket_id, {"action": "waiting", "problem": "error", "result": "result"}[kind], text[:40], notice_id))
        self.pending_count = len(pending_targets)
        self.pending_target = next(iter(pending_targets.values())) if self.pending_count == 1 else ""
        self.pending_bubbles = pending_bubbles
        for ticket_id, ticket in tickets.items():
            title = str(ticket.get("title") or "工单")
            nodes = ticket.get("nodes") or [{}]
            last = nodes[-1]
            version = "ticket:" + ticket_id + ":" + str(last.get("node_id") or last.get("created_at") or "")
            versions.add(version)
            created = "created:" + ticket_id
            versions.add(created)
            is_new = old_versions is not None and created not in old_versions
            state, _ = _ticket_status(ticket, None)
            kind = {"result": "result", "success": "result", "error": "problem"}.get(state, "progress")
            target = "ticket:" + ticket_id
            targets[target] = "#tasks?" + urlencode({"ticket_id": ticket_id})
            if active and state != "success" and BUBBLE_PRIORITY[kind] > notice_priorities.get(target, 0) and old_versions is not None and version not in old_versions:
                if is_new and state == "working":
                    kind = "created"
                if (kind == "progress" and last.get("kind") == "note") or prefs.get(kind, False):
                    key = "progress:" + ticket_id if kind == "progress" else version
                    self.transient[key] = (now + 8, {"id": version, "kind": kind, "text": _bubble_text(title, kind),
                        "label": "前往查看", "target": target,
                        "speak": bool(prefs["speech"] and kind == "result")})
            if state == "working" or version in self.transient:
                status_candidates.append((2 if version in self.transient else 1, version,
                                          ticket_id, state, _bubble_text(title, kind)[:40], ""))
        self.transient = {key: pair for key, pair in self.transient.items()
                          if key.startswith("preview:") or (pair[1]["target"] in targets
                          and BUBBLE_PRIORITY[pair[1]["kind"]] > notice_priorities.get(pair[1]["target"], 0))}
        self.targets = targets
        self.versions = versions
        selected = max(status_candidates, default=(0, "", "", None, "", ""))[2:]
        update = selected if active and selected[1] else None
        if update != self.last:
            if update:
                payload = {"state": update[1]}
                if not self.enhanced:
                    payload["task"] = update[2]
                else:
                    payload["task"] = None
                self._call("/work-status", payload)
            elif self.last:
                self._clear_status()
            self.last = update

    def _local_work_orders(self) -> tuple[dict, dict]:
        tickets = []
        notices = []
        for order in self.store.list_work_orders():
            state = order["state"]
            if state in {"ignored", "merged", "terminated"}:
                continue
            ticket_id = str(order["id"])
            revision = str(order["revision"])
            kind = state
            if state == "completed":
                kind = "confirm" if order["result_confirmed"] else "result"
            node = {"node_id": revision, "kind": kind, "created_at": order["updated_at"]}
            tickets.append({"ticket": {"ticket_id": ticket_id, "title": order["summary"], "nodes": [node]}})
            if state == "completed" and not order["result_confirmed"]:
                notices.append({"id": f"local-{ticket_id}-{revision}", "ticket_id": ticket_id, "code": "RESULT_READY"})
            if state == "blocked":
                notices.append({"id": f"local-{ticket_id}-{revision}", "ticket_id": ticket_id,
                                "code": "APPROVAL_REQUIRED", "content": order["checkpoint"]})
        return {"items": tickets}, {"items": notices}

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=6)
