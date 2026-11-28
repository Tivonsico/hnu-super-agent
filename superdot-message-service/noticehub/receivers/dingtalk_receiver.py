"""Read-only DingTalk V3 database reader (Windows CNG / macOS CommonCrypto)."""

from __future__ import annotations

import base64
import ctypes
import datetime as dt
import hashlib
import json
import logging
import os
import re
import sqlite3
import struct
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Union

from noticehub.platform.config import Settings
from noticehub.platform.timeutil import iso, now_local

PAGE_SIZE = 4096
# The WAL file header is 32 bytes (magic, version, page size, checkpoint sequence,
# salt-1, salt-2, checksum-1, checksum-2); the 24-byte frame header starts after it.
WAL_HEADER_SIZE = 32
WAL_FRAME_SIZE = 24 + PAGE_SIZE
SQLITE_HEADER = b"SQLite format 3\x00"
_UID_PATTERN = re.compile(rb"(?<!\d)(\d{9,10})(?!\d)")

# Mac 版钉钉把 V3 库放在沙盒容器里；品牌容器名有 DingTalkMac / DingTalk 两种写法，
# 第三条是关掉沙盒或老安装的落点。按顺序试，命中即返回。
_MACOS_DINGTALK_ROOTS = (
    "Library/Containers/com.alibaba.DingTalkMac/Data/Library/Application Support/DingTalk",
    "Library/Containers/com.alibaba.DingTalk/Data/Library/Application Support/DingTalk",
    "Library/Application Support/DingTalk",
)
_NO_DB_DIR_MESSAGE_MACOS = "未找到钉钉本机数据目录（可能未安装 Mac 版钉钉，或从未登录）"
_NO_DB_DIR_MESSAGE_WINDOWS = "未找到钉钉本机数据目录（可能未安装 Windows 版钉钉，或从未登录）"


def _cipher_platform() -> str:
    """本机走哪套系统 AES：Windows CNG / macOS CommonCrypto / 都没有。"""
    if os.name == "nt":
        return "windows"
    return "macos" if sys.platform == "darwin" else "unsupported"


def _no_db_dir_message() -> str:
    """按平台给出「找不到本机库」的可读文案，带一句下一步。"""
    if _cipher_platform() == "macos":
        return _NO_DB_DIR_MESSAGE_MACOS
    return _NO_DB_DIR_MESSAGE_WINDOWS


def _is_dingtalk_db_dir(candidate: Path) -> bool:
    """一个 `*_v3` 目录算不算钉钉库：DBFiles/dingtalk.db 和 user_config 都得在。"""
    return (candidate / "DBFiles" / "dingtalk.db").is_file() and (
        candidate / "user_config"
    ).is_file()


def _macos_db_roots() -> list[Path]:
    if sys.platform != "darwin":
        return []
    try:
        home = Path.home()
    except (RuntimeError, OSError):
        return []
    return [home / suffix for suffix in _MACOS_DINGTALK_ROOTS]

# 「拉取我的群」要挡掉个人/临时会话，只按这两个本机库实测标记判定。
# 依据 2026-11-08 真机解密快照（nh-tmp/dtprobe/result4.txt）：cid=61632057492 的
# title/alias/originTitle/icon/members/extension/memberExtension/localExtension
# 8 个名字列全空、subType=1、visible_subdomains='personal'、memberCount=2、
# createAt≈2026-10-10 新建、FTS 未索引、tbmsg_* 0 条消息；ConvCidToUid 把它映射到
# 两个 personal uid 而非群。它是钉钉新建的双人/临时会话，群名还没从服务端同步落库。
# 绝不用「members<3」判：真有 1 人、2 人的群，会误杀。
_PERSONAL_CONVERSATION_SUBTYPE = 1
_PERSONAL_VISIBLE_DOMAIN = "personal"
_PRIVATE_CONVERSATION_TYPES = {"1", "single", "private"}


def _is_personal_conversation(row: sqlite3.Row) -> bool:
    """只按 subType / visible_subdomains 判个人会话；缺列（老库、精简表）当普通群。"""
    keys = row.keys()
    subtype = row["subType"] if "subType" in keys else None
    domain = row["visible_subdomains"] if "visible_subdomains" in keys else None
    if subtype is not None and str(subtype).strip() == str(_PERSONAL_CONVERSATION_SUBTYPE):
        return True
    if domain is not None and str(domain).strip() == _PERSONAL_VISIBLE_DOMAIN:
        return True
    return False


def parse_dingtalk_content(content: Any, content_type: Any = 1) -> str:
    """Return plain-text body for text messages; M1 intentionally skips rich cards."""
    if str(content_type) != "1":
        return ""
    try:
        data = json.loads(str(content or ""))
    except (json.JSONDecodeError, TypeError):
        return ""
    if not isinstance(data, dict):
        return ""
    return str(data.get("text") or "").strip()


def wal_generation(data: bytes) -> tuple[tuple[int, int], list[tuple[int, int, bytes]]]:
    """Return only the contiguous frame prefix belonging to the current WAL salt."""
    if len(data) < WAL_HEADER_SIZE:
        return (0, 0), []
    current = struct.unpack(">II", data[16:24])
    frames: list[tuple[int, int, bytes]] = []
    offset = WAL_HEADER_SIZE
    while offset + WAL_FRAME_SIZE <= len(data):
        header = data[offset : offset + 24]
        page_no, db_size = struct.unpack(">II", header[:8])
        if struct.unpack(">II", header[8:16]) != current:
            break
        frames.append((page_no, db_size, data[offset + 24 : offset + WAL_FRAME_SIZE]))
        offset += WAL_FRAME_SIZE
    return current, frames


def resume_frame_index(state: dict[str, Any], current_salt: tuple[int, int]) -> int:
    """A checkpoint/WAL restart invalidates offsets from the previous salt generation."""
    try:
        saved = (int(state.get("salt_1") or 0), int(state.get("salt_2") or 0))
        index = max(0, int(state.get("frame_index") or 0))
    except (TypeError, ValueError):
        return 0
    return index if saved == current_salt else 0


def can_increment_snapshot(
    snapshot_ready: bool,
    previous_main_signature: tuple[int, int] | None,
    current_main_signature: tuple[int, int],
    previous_salt: tuple[int, int] | None,
    current_salt: tuple[int, int],
    previous_frame_index: int,
    start_frame: int,
    frame_count: int,
    stored_salt: tuple[int, int],
) -> bool:
    return (
        snapshot_ready
        and previous_main_signature == current_main_signature
        and previous_salt == current_salt == stored_salt
        and previous_frame_index == start_frame
        and start_frame <= frame_count
    )


class _BCryptAES:
    """A single Windows CNG AES-ECB key handle, kept only in process memory."""

    def __init__(self, key: bytes) -> None:
        if os.name != "nt":
            raise OSError("钉钉本地库解密仅支持 Windows")
        self._bcrypt = ctypes.WinDLL("bcrypt", use_last_error=True)
        self._alg = ctypes.c_void_p()
        self._key = ctypes.c_void_p()
        self._key_object: ctypes.Array[ctypes.c_char] | None = None
        self._bind()
        status = self._bcrypt.BCryptOpenAlgorithmProvider(
            ctypes.byref(self._alg), "AES", None, 0
        )
        self._check(status, "open AES provider")
        try:
            mode = "ChainingModeECB"
            status = self._bcrypt.BCryptSetProperty(
                self._alg, "ChainingMode", mode, len(mode) * 2, 0
            )
            self._check(status, "set ECB mode")
            object_length = ctypes.c_ulong()
            result_length = ctypes.c_ulong()
            status = self._bcrypt.BCryptGetProperty(
                self._alg,
                "ObjectLength",
                ctypes.byref(object_length),
                ctypes.sizeof(object_length),
                ctypes.byref(result_length),
                0,
            )
            self._check(status, "get key object length")
            self._key_object = ctypes.create_string_buffer(object_length.value)
            secret = ctypes.create_string_buffer(key, len(key))
            status = self._bcrypt.BCryptGenerateSymmetricKey(
                self._alg,
                ctypes.byref(self._key),
                self._key_object,
                object_length.value,
                secret,
                len(key),
                0,
            )
            self._check(status, "generate AES key")
        except Exception:
            self.close()
            raise

    def _bind(self) -> None:
        handle = ctypes.c_void_p
        byte_ptr = ctypes.c_void_p
        ulong = ctypes.c_ulong
        self._bcrypt.BCryptOpenAlgorithmProvider.argtypes = [ctypes.POINTER(handle), ctypes.c_wchar_p, ctypes.c_wchar_p, ulong]
        self._bcrypt.BCryptOpenAlgorithmProvider.restype = ctypes.c_long
        self._bcrypt.BCryptSetProperty.argtypes = [handle, ctypes.c_wchar_p, byte_ptr, ulong, ulong]
        self._bcrypt.BCryptSetProperty.restype = ctypes.c_long
        self._bcrypt.BCryptGetProperty.argtypes = [handle, ctypes.c_wchar_p, byte_ptr, ulong, ctypes.POINTER(ulong), ulong]
        self._bcrypt.BCryptGetProperty.restype = ctypes.c_long
        self._bcrypt.BCryptGenerateSymmetricKey.argtypes = [handle, ctypes.POINTER(handle), byte_ptr, ulong, byte_ptr, ulong, ulong]
        self._bcrypt.BCryptGenerateSymmetricKey.restype = ctypes.c_long
        self._bcrypt.BCryptDecrypt.argtypes = [handle, byte_ptr, ulong, byte_ptr, byte_ptr, ulong, byte_ptr, ulong, ctypes.POINTER(ulong), ulong]
        self._bcrypt.BCryptDecrypt.restype = ctypes.c_long
        self._bcrypt.BCryptDestroyKey.argtypes = [handle]
        self._bcrypt.BCryptDestroyKey.restype = ctypes.c_long
        self._bcrypt.BCryptCloseAlgorithmProvider.argtypes = [handle, ulong]
        self._bcrypt.BCryptCloseAlgorithmProvider.restype = ctypes.c_long

    @staticmethod
    def _check(status: int, operation: str) -> None:
        if status < 0:
            raise OSError(f"BCrypt operation failed: {operation} ({status:#x})")

    def decrypt(self, page: bytes) -> bytes:
        if len(page) != PAGE_SIZE:
            raise ValueError("AES input must be one full page")
        source = ctypes.create_string_buffer(page, len(page))
        output = ctypes.create_string_buffer(len(page))
        output_length = ctypes.c_ulong()
        status = self._bcrypt.BCryptDecrypt(
            self._key,
            source,
            len(page),
            None,
            None,
            0,
            output,
            len(page),
            ctypes.byref(output_length),
            0,
        )
        self._check(status, "decrypt page")
        if output_length.value != PAGE_SIZE:
            raise OSError("BCrypt returned an incomplete page")
        return output.raw[:PAGE_SIZE]

    def close(self) -> None:
        if getattr(self, "_key", None) and self._key.value:
            self._bcrypt.BCryptDestroyKey(self._key)
            self._key = ctypes.c_void_p()
        if getattr(self, "_alg", None) and self._alg.value:
            self._bcrypt.BCryptCloseAlgorithmProvider(self._alg, 0)
            self._alg = ctypes.c_void_p()
        self._key_object = None


class _CommonCryptoAES:
    """A single macOS CommonCrypto AES-128-ECB key, kept only in process memory.

    与 Windows 那份同一口径：只接受整 4096 字节页，一次 CCCrypt 解完，
    密钥留在本进程内存里，close() 之后不再可用。
    """

    def __init__(self, key: bytes) -> None:
        if sys.platform != "darwin":
            raise OSError("钉钉本地库解密在 macOS 上走 CommonCrypto")
        self._key = key
        self._crypt = ctypes.CDLL("/usr/lib/libSystem.B.dylib").CCCrypt
        self._crypt.argtypes = (
            ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32,
            ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        )
        self._crypt.restype = ctypes.c_int

    def decrypt(self, page: bytes) -> bytes:
        if len(page) != PAGE_SIZE:
            raise ValueError("AES input must be one full page")
        kCCDecrypt, kCCAlgorithmAES, kCCOptionECBMode = 1, 0, 2
        output = ctypes.create_string_buffer(PAGE_SIZE)
        moved = ctypes.c_size_t()
        status = self._crypt(
            kCCDecrypt, kCCAlgorithmAES, kCCOptionECBMode,
            self._key, len(self._key), None,
            page, len(page), output, len(output), ctypes.byref(moved),
        )
        if status != 0 or moved.value != PAGE_SIZE:
            raise OSError(f"CommonCrypto could not decrypt the page (status {status})")
        return output.raw[:PAGE_SIZE]

    def close(self) -> None:
        self._key = b""


# 两个平台的页解密器接口一致（decrypt / close）；注解用同一个名字，
# 免得 self._cipher 的类型随平台漂移。
_PageCipher = Union[_BCryptAES, _CommonCryptoAES]


def _page_cipher(key: bytes) -> _PageCipher:
    """按平台造页解密器：Windows 走 CNG，macOS 走 CommonCrypto。"""
    if _cipher_platform() == "macos":
        return _CommonCryptoAES(key)
    return _BCryptAES(key)


def _read_shared(path: Path) -> bytes:
    """Open a live DingTalk file allowing its process to keep writing it."""
    if os.name != "nt":
        return path.read_bytes()
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p]
    create_file.restype = ctypes.c_void_p
    read_file = kernel32.ReadFile
    read_file.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.c_void_p]
    read_file.restype = ctypes.c_int
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [ctypes.c_void_p]
    close_handle.restype = ctypes.c_int
    handle = create_file(str(path), 0x80000000, 0x1 | 0x2 | 0x4, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    chunks: list[bytes] = []
    try:
        buffer = ctypes.create_string_buffer(1024 * 1024)
        count = ctypes.c_ulong()
        while True:
            if not read_file(handle, buffer, len(buffer), ctypes.byref(count), None):
                raise ctypes.WinError(ctypes.get_last_error())
            if not count.value:
                break
            chunks.append(buffer.raw[: count.value])
    finally:
        close_handle(handle)
    return b"".join(chunks)


class DingTalkLocalReader:
    """Read a user's allowlisted DingTalk text messages from a local read-only snapshot."""

    def __init__(
        self,
        settings: Settings,
        on_message: Callable[[dict[str, Any]], bool],
        logger: logging.Logger | None = None,
        store: Any = None,
    ) -> None:
        self.settings = settings
        self.on_message = on_message
        self.logger = logger or logging.getLogger(__name__)
        self.store = store
        self.thread: threading.Thread | None = None
        self.stopped = threading.Event()
        self._cipher: _PageCipher | None = None
        self._salt: bytes | None = None
        self._db_dir: Path | None = None
        self.status = getattr(settings, "dingtalk_status", None)
        if not isinstance(self.status, dict):
            self.status = {}
            settings.dingtalk_status = self.status
        self._status_lock = threading.Lock()
        self._scan_lock = threading.Lock()
        self._scan_thread: threading.Thread | None = None
        self._closing = False
        self._snapshot_db: bytes | None = None
        self._snapshot_main_signature: tuple[int, int] | None = None
        self._snapshot_salt: tuple[int, int] | None = None
        self._snapshot_frame_index = 0
        self._set_status_defaults()

    def _set_status_defaults(self) -> None:
        enabled = bool(self.settings.dingtalk_enabled and self.settings.dingtalk_group_whitelist)
        defaults = {
            "scan_state": "idle" if enabled else "disabled",
            "scan_stage": "等待扫描" if enabled else "未启用",
            "scan_started_monotonic": 0.0,
            "scan_started_at": "",
            "last_read_at": "",
            "last_read_seconds": 0.0,
            "last_error": "",
        }
        with self._status_lock:
            for key, value in defaults.items():
                self.status.setdefault(key, value)
            if self.status.get("scan_state") != "running":
                self.status["scan_state"] = defaults["scan_state"]
                self.status["scan_stage"] = defaults["scan_stage"]

    def _set_scan_stage(self, stage: str) -> None:
        with self._status_lock:
            if not self._closing and self.status.get("scan_state") == "running":
                self.status["scan_stage"] = stage

    def _finish_scan(self, error: str = "") -> None:
        with self._status_lock:
            if self._closing:
                return
            started = float(self.status.get("scan_started_monotonic") or 0.0)
            stage = self.status.get("scan_stage")
            self.status.update({
                "scan_state": "error" if error else "idle",
                "scan_stage": f"失败：{error}" if error else (stage if stage == "数据库未变化，跳过" else "完成"),
                "scan_started_monotonic": 0.0,
                "scan_started_at": "",
                "last_read_at": dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S"),
                "last_read_seconds": max(0.0, time.monotonic() - started) if started else 0.0,
                "last_error": error,
            })

    def _run_scan_worker(self) -> None:
        error = ""
        try:
            self.scan_once()
        except Exception as exc:
            error = str(exc) or exc.__class__.__name__
            self.logger.exception("钉钉本地库读取失败。")
        finally:
            self._finish_scan(error)
            if self._closing and self._cipher is not None:
                self._cipher.close()
                self._cipher = None
                self._salt = None
            self._scan_lock.release()

    @property
    def is_alive(self) -> bool:
        return bool(self.thread and self.thread.is_alive())

    def start_scan(self) -> bool:
        if self.stopped.is_set() or not self.is_alive or not self.settings.dingtalk_enabled or not self.settings.dingtalk_group_whitelist:
            return False
        if not self._scan_lock.acquire(blocking=False):
            return False
        started = time.monotonic()
        with self._status_lock:
            self.status.update({
                "scan_state": "running",
                "scan_stage": "正在打开钉钉本地库",
                "scan_started_monotonic": started,
                "scan_started_at": dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S"),
                "last_error": "",
            })
        worker = threading.Thread(target=self._run_scan_worker, name="dingtalk-scan", daemon=True)
        self._scan_thread = worker
        try:
            worker.start()
        except Exception:
            self._finish_scan("无法启动扫描线程")
            self._scan_lock.release()
            raise
        return True

    def start(self) -> bool:
        if self.is_alive:
            return True
        if _cipher_platform() == "unsupported":
            self.logger.warning("钉钉本地库读取器仅支持 Windows 和 macOS。")
            return False
        # 本机没装/没登录钉钉时，状态里要立刻有一条能读的文案，别等用户自己去猜。
        if self._locate_db_dir() is None:
            self._note_missing_db_dir()
        self.stopped.clear()
        self._closing = False
        self.thread = threading.Thread(target=self._run_loop, name="dingtalk-reader", daemon=True)
        self.thread.start()
        return True

    def _note_missing_db_dir(self) -> str:
        """把「没有钉钉本机数据目录」写进状态，并返回同一句文案给调用方抛出。"""
        message = _no_db_dir_message()
        with self._status_lock:
            self.status["last_error"] = message
            if self.status.get("scan_state") != "running":
                self.status["scan_state"] = "error"
                self.status["scan_stage"] = f"失败：{message}"
        return message

    def stop(self, timeout: float = 5) -> None:
        self.stopped.set()
        self._closing = True
        with self._status_lock:
            self.status.update({
                "scan_state": "idle" if self.settings.dingtalk_enabled and self.settings.dingtalk_group_whitelist else "disabled",
                "scan_stage": "等待扫描" if self.settings.dingtalk_enabled and self.settings.dingtalk_group_whitelist else "未启用",
                "scan_started_at": "",
                "scan_started_monotonic": 0.0,
            })
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=max(0.0, timeout))
        if self._scan_thread and self._scan_thread.is_alive():
            self._scan_thread.join(timeout=max(0.0, timeout))
        if not (self._scan_thread and self._scan_thread.is_alive()) and self._cipher is not None:
            self._cipher.close()
            self._cipher = None
        if not (self._scan_thread and self._scan_thread.is_alive()):
            self._salt = None

    def _locate_db_dir(self) -> Path | None:
        if _cipher_platform() == "macos":
            located = self._locate_macos_db_dir()
            if located is not None:
                self._db_dir = located
            return located
        root = Path(os.environ.get("APPDATA", "")) / "DingTalk"
        if not root.is_dir():
            return None
        for candidate in root.glob("*_v3"):
            if _is_dingtalk_db_dir(candidate):
                self._db_dir = candidate
                return candidate
        return None

    def _locate_macos_db_dir(self) -> Path | None:
        """沙盒容器/普通目录里找 `*_v3`：先看单层，没有再下探一层。"""
        for root in _macos_db_roots():
            if not root.is_dir():
                continue
            for pattern in ("*_v3", "*/*_v3"):
                for candidate in sorted(root.glob(pattern)):
                    if _is_dingtalk_db_dir(candidate):
                        return candidate
        return None

    def _ensure_cipher(self, db_dir: Path) -> None:
        if self._cipher is not None:
            return
        key = bytes.fromhex(os.environ.get("NOTICEHUB_DINGTALK_DB_KEY", ""))
        if len(key) != 32:
            raise ValueError("请配置已授权的钉钉数据库密钥 NOTICEHUB_DINGTALK_DB_KEY")
        self._cipher = _page_cipher(key)

    def _copy_db_files(self, db_dir: Path, temp_dir: Path) -> tuple[Path, Path]:
        source = db_dir / "DBFiles"
        db_copy = temp_dir / "dingtalk.db"
        wal_copy = temp_dir / "dingtalk.db-wal"
        for name in ("dingtalk.db", "dingtalk.db-wal", "dingtalk.db-shm"):
            src = source / name
            if src.is_file():
                data = _read_shared(src)
                if name == "dingtalk.db":
                    db_copy.write_bytes(data)
                elif name == "dingtalk.db-wal":
                    wal_copy.write_bytes(data)
                else:
                    (temp_dir / name).write_bytes(data)
        return db_copy, wal_copy

    def _rebuild_db(self, main_db: bytes, wal_data: bytes) -> tuple[bytes, tuple[int, int], int]:
        if len(main_db) < PAGE_SIZE or self._cipher is None:
            raise ValueError("钉钉数据库或解密器不可用")
        pages: dict[int, bytes] = {}
        for offset in range(0, len(main_db), PAGE_SIZE):
            page = main_db[offset : offset + PAGE_SIZE]
            page_number = offset // PAGE_SIZE
            pages[page_number] = self._cipher.decrypt(page) if len(page) == PAGE_SIZE else page
        if not pages.get(0, b"").startswith(SQLITE_HEADER):
            raise ValueError("钉钉数据库密钥校验失败")
        salt, frames = wal_generation(wal_data)
        committed_count = max((index + 1 for index, frame in enumerate(frames) if frame[1]), default=0)
        for page_number, db_size, encrypted_page in frames[:committed_count]:
            if page_number == 0:
                continue
            pages[page_number - 1] = self._cipher.decrypt(encrypted_page)
            if db_size:
                pages = {number: data for number, data in pages.items() if number < db_size}
        if not pages:
            raise ValueError("钉钉数据库页为空")
        page_count = max(pages) + 1
        rebuilt = b"".join(pages.get(number, b"\x00" * PAGE_SIZE) for number in range(page_count))
        return rebuilt, salt, committed_count

    def _apply_wal_frames(
        self, snapshot: bytes, frames: list[tuple[int, int, bytes]]
    ) -> tuple[bytes, int]:
        """Apply only complete committed WAL transactions to our in-memory snapshot."""
        commit_end = max((index + 1 for index, frame in enumerate(frames) if frame[1]), default=0)
        if not commit_end:
            return snapshot, 0
        pages = {offset // PAGE_SIZE: snapshot[offset : offset + PAGE_SIZE]
                 for offset in range(0, len(snapshot), PAGE_SIZE)}
        assert self._cipher is not None
        for page_number, db_size, encrypted_page in frames[:commit_end]:
            if page_number:
                pages[page_number - 1] = self._cipher.decrypt(encrypted_page)
                if db_size:
                    pages = {number: data for number, data in pages.items() if number < db_size}
        page_count = max(pages) + 1
        rebuilt = b"".join(pages.get(number, b"\x00" * PAGE_SIZE) for number in range(page_count))
        return rebuilt, commit_end

    @staticmethod
    def parse_groups(db_bytes: bytes) -> list[dict[str, Any]]:
        fd, name = tempfile.mkstemp(prefix="qq-digest-dt-groups-", suffix=".db")
        path = Path(name)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(db_bytes)
            # immutable=1：这是我们自己刚写的私有快照，不会有别的连接同时改它。
            # 少了它，WAL 模式的库以 mode=ro 打开时会因为建不了 -shm 直接报
            # 「unable to open database file」——macOS 上必现。
            connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro&immutable=1", uri=True)
            connection.row_factory = sqlite3.Row
            try:
                # SELECT * 兼容精简表（老用例只有 4 列、没有 subType/visible_subdomains）：
                # 个人会话判定按列名取值，缺列就当普通群，绝不硬 SELECT 不存在的列。
                rows = connection.execute("SELECT * FROM tbconversation").fetchall()
            finally:
                connection.close()
            result = []
            for row in rows:
                keys = row.keys()
                kind = row["type"] if "type" in keys else ""
                if str(kind or "") in _PRIVATE_CONVERSATION_TYPES:
                    continue
                if _is_personal_conversation(row):
                    continue
                cid = row["cid"] if "cid" in keys else ""
                title = row["title"] if "title" in keys else ""
                members = row["memberCount"] if "memberCount" in keys else 0
                # title 为空就照实返回空串，不编名字（展示层负责「未命名会话（cid）」）。
                result.append({"cid": str(cid or ""), "title": str(title or ""), "members": int(members or 0)})
            return [row for row in result if row["cid"]]
        finally:
            path.unlink(missing_ok=True)

    def list_groups(self) -> list[dict[str, Any]]:
        """Read group metadata from a temporary read-only decrypted snapshot."""
        db_dir = self._locate_db_dir()
        if db_dir is None:
            raise RuntimeError(self._note_missing_db_dir())
        try:
            self._ensure_cipher(db_dir)
            with tempfile.TemporaryDirectory(prefix="qq-digest-dt-groups-snapshot-") as temp:
                db_copy, wal_copy = self._copy_db_files(db_dir, Path(temp))
                rebuilt, _salt, _frames = self._rebuild_db(db_copy.read_bytes(), wal_copy.read_bytes() if wal_copy.exists() else b"")
                return self.parse_groups(rebuilt)
        except Exception as exc:
            raise RuntimeError("钉钉本地数据库解密或读取失败") from exc

    def _read_messages(
        self, db_bytes: bytes, since_ms: int, progress: Callable[[str], None] | None = None
    ) -> tuple[list[dict[str, Any]], int]:
        fd, name = tempfile.mkstemp(prefix="qq-digest-dt-", suffix=".db")
        db_path = Path(name)
        records: list[dict[str, Any]] = []
        max_created = 0
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(db_bytes)
            # 同上：私有快照按 immutable 打开，否则 WAL 模式的库在 macOS 上打不开。
            connection = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro&immutable=1", uri=True)
            connection.row_factory = sqlite3.Row
            try:
                conversations = {
                    str(row["cid"]): str(row["title"] or "")
                    for row in connection.execute("SELECT cid,title FROM tbconversation")
                }
                names: dict[str, str] = {}
                for shard in range(128):
                    if progress and shard % 8 == 0:
                        progress(f"读取消息表 {shard + 1}/128")
                    table = f"tbmsg_{shard:03d}"
                    try:
                        rows = connection.execute(
                            f"SELECT cid,mid,senderId,createdAt,contentType,content FROM {table} WHERE createdAt >= ? ORDER BY createdAt,mid",
                            (max(0, int(since_ms)),),
                        ).fetchall()
                    except sqlite3.OperationalError as error:
                        if "no such table" in str(error).lower():
                            continue
                        raise
                    for row in rows:
                        created = int(row["createdAt"] or 0)
                        names[str(row["cid"])] = conversations.get(str(row["cid"]), "")
                        text = parse_dingtalk_content(row["content"], row["contentType"])
                        if not text:
                            continue
                        cid, mid = str(row["cid"] or ""), str(row["mid"] or "")
                        if not cid or not mid:
                            continue
                        records.append({
                            "msg_id": f"dingtalk:{cid}:{mid}",
                            "source": "dingtalk",
                            "event": "GROUP_MESSAGE_CREATE",
                            "group_id": cid,
                            "group_name": conversations.get(cid) or cid,
                            "sender_id": str(row["senderId"] or ""),
                            "sender_name": str(row["senderId"] or ""),
                            "ts": iso(dt.datetime.fromtimestamp(created / 1000, tz=dt.timezone.utc)),
                            "received_at": now_local(),
                            "content": text,
                        })
                        max_created = max(max_created, created)
            finally:
                connection.close()
            return records, max_created
        finally:
            try:
                db_path.unlink()
            except FileNotFoundError:
                pass

    def scan_once(self) -> int:
        db_dir = self._locate_db_dir()
        if db_dir is None:
            raise RuntimeError(self._note_missing_db_dir())
        self._set_scan_stage("查找钉钉本地库密钥")
        self._ensure_cipher(db_dir)
        source = db_dir / "DBFiles"
        main_path = source / "dingtalk.db"
        wal_path = source / "dingtalk.db-wal"
        stat = main_path.stat()
        main_signature = (stat.st_mtime_ns, stat.st_size)
        wal_stat = wal_path.stat() if wal_path.is_file() else None
        wal_signature = (
            wal_stat.st_mtime_ns if wal_stat else 0,
            wal_stat.st_size if wal_stat else 0,
            getattr(wal_stat, "st_ino", 0) if wal_stat else 0,
        )
        wal_data = _read_shared(wal_path) if wal_stat else b""
        salt, frames = wal_generation(wal_data)
        state = self.store.dingtalk_sync_state() if self.store is not None else {
            "salt_1": 0, "salt_2": 0, "frame_index": 0, "last_created_at": 0
        }
        try:
            offset_state = json.loads(self.store.meta_get("dingtalk_wal_offset", "{}")) if self.store is not None else {}
        except (TypeError, ValueError):
            offset_state = {}
        offset = int(offset_state.get("offset") or 0)
        start_frame = max(0, (offset - WAL_HEADER_SIZE) // WAL_FRAME_SIZE) if offset >= WAL_HEADER_SIZE else 0
        stored_salt = (int(state.get("salt_1") or 0), int(state.get("salt_2") or 0))
        can_increment = can_increment_snapshot(
            self._snapshot_db is not None,
            self._snapshot_main_signature,
            main_signature,
            self._snapshot_salt,
            salt,
            self._snapshot_frame_index,
            start_frame,
            len(frames),
            stored_salt,
        )
        self._set_scan_stage("回放钉钉 WAL 新帧")
        replay_count = 0
        if can_increment:
            committed_end = max((index + 1 for index, frame in enumerate(frames) if frame[1]), default=0)
            new_frames = frames[start_frame:committed_end] if committed_end > start_frame else []
            candidate_snapshot, applied = self._apply_wal_frames(self._snapshot_db, new_frames)
            next_frame = start_frame + applied
            replay_count = applied
            if applied:
                snapshot = candidate_snapshot
            else:
                snapshot = self._snapshot_db
        else:
            self._set_scan_stage("重建钉钉数据库快照（状态重置或 checkpoint）")
            main_db = _read_shared(main_path)
            rebuilt, salt, replay_count = self._rebuild_db(main_db, wal_data)
            next_frame = replay_count
            snapshot = rebuilt
        self.logger.info("钉钉本次 WAL 回放 %d 帧。", replay_count)
        if can_increment and replay_count == 0:
            self._set_scan_stage("数据库未变化，跳过")
            records, newest = [], int(state.get("last_created_at") or 0)
        else:
            since = int(state.get("last_created_at") or 0)
            if not since:
                since = int((now_local() - dt.timedelta(minutes=2)).timestamp() * 1000)
            records, newest = self._read_messages(
                snapshot, max(0, since - 1000), progress=self._set_scan_stage
            )
        current_stat = main_path.stat()
        current_main_signature = (current_stat.st_mtime_ns, current_stat.st_size)
        current_wal_stat = wal_path.stat() if wal_path.is_file() else None
        current_wal_signature = (
            current_wal_stat.st_mtime_ns if current_wal_stat else 0,
            current_wal_stat.st_size if current_wal_stat else 0,
            getattr(current_wal_stat, "st_ino", 0) if current_wal_stat else 0,
        )
        if current_main_signature != main_signature or current_wal_signature != wal_signature:
            raise RuntimeError("钉钉本地数据库扫描期间发生变化，将在下轮重读")
        emitted_count = sum(1 for record in records if self.on_message(record))
        if emitted_count:
            self.logger.info("钉钉本地库新增推送 %d 条文本消息。", emitted_count)
        state = {
            "salt_1": salt[0],
            "salt_2": salt[1],
            "frame_index": next_frame,
            "last_created_at": max(int(state.get("last_created_at") or 0), newest),
        }
        if self.store is not None:
            self.store.save_dingtalk_sync_state(state)
            self.store.meta_set("dingtalk_wal_offset", json.dumps({
                "salt_1": salt[0], "salt_2": salt[1],
                "offset": WAL_HEADER_SIZE + next_frame * WAL_FRAME_SIZE,
                "main_mtime_ns": main_signature[0], "main_size": main_signature[1],
            }, separators=(",", ":")))
        self._snapshot_db = snapshot
        self._snapshot_main_signature = main_signature
        self._snapshot_salt = salt
        self._snapshot_frame_index = next_frame
        # 返回「真正入库的条数」，不是「读到的条数」：日志和统计用的是 emitted_count，
        # 两处口径必须一致，调用方按返回值得出的结论才不会和日志打架。
        return emitted_count

    def _run_loop(self) -> None:
        while not self.stopped.is_set():
            self.start_scan()
            self.stopped.wait(max(5, int(self.settings.dingtalk_scan_interval_seconds)))
