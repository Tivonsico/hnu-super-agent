from __future__ import annotations

import argparse
import contextlib
import ctypes
import hashlib
import hmac
import logging
import os
import re
import shlex
import sqlite3
import string
import struct
import subprocess
import sys
import tempfile
import threading
import time
from ctypes import wintypes
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional

from noticehub.platform import ttl_cache
from noticehub.receivers.dingtalk_receiver import _BCryptAES, _read_shared
from noticehub.receivers.qq.messages import WECHAT_DIR_NOT_FOUND

LOGGER = logging.getLogger("noticehub.receivers.wechat_receiver")

PAGE_SIZE = 4096
RESERVE_SIZE = 80
SQLITE_HEADER = b"SQLite format 3\x00"
WAL_HEADER_SIZE = 32
WAL_FRAME_SIZE = 24 + PAGE_SIZE
WAL_MAGIC = (0x377F0682, 0x377F0683)

MSG_TYPE_TEXT = 1
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

DEFAULT_STORAGE_ROOT = Path(r"D:\Wechat files\xwechat_files")
# 手动指定微信数据目录（.env 里写 NOTICEHUB_WECHAT_DIR=...），优先级最高。
STORAGE_DIR_ENV = "NOTICEHUB_WECHAT_DIR"
LEGACY_STORAGE_DIR_ENV = "QQ_DIGEST_WECHAT_DIR"
WECHAT_KEY_ENV = "NOTICEHUB_WECHAT_KEY"
LEGACY_WECHAT_KEY_ENV = "QQ_DIGEST_WECHAT_KEY"
_REGISTRY_STORAGE_KEYS = (r"Software\Tencent\Weixin", r"Software\Tencent\WeChat", r"Software\Tencent\xwechat")
_STORAGE_ROOT_NAMES = ("xwechat_files", "WeChat Files")
_MESSAGE_DB_RE = re.compile(r"^message_\d+\.db$")
_MSG_TABLE_RE = re.compile(r"^Msg_[0-9a-f]{32}$")

# --------------------------------------------------------------------------
_KEY_HEX_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def parse_manual_key(value: Any) -> Optional[bytes]:
    """把 ``NOTICEHUB_WECHAT_KEY``（旧名 ``QQ_DIGEST_WECHAT_KEY`` 仍兼容）解析成 32 字节 raw key；空值返回 None。

    非法值抛 ValueError 并说清哪里不对——用户手改这一行时必须能自己看出来。
    """
    text = str(value or "").strip()
    if not text:
        return None
    if not _KEY_HEX_RE.match(text):
        # 不回显内容：用户贴进来的可能是接近正确的真 key，日志/页面里不该留半截。
        raise ValueError(
            "NOTICEHUB_WECHAT_KEY 必须是 64 位十六进制（32 字节 raw key），当前长度是 %d 个字符" % len(text)
        )
    return bytes.fromhex(text)


def manual_key(settings: Any = None) -> Optional[bytes]:
    """手填密钥：先看设置对象上的 ``wechat_key``，再看环境变量（.env 已被读进 os.environ）。"""
    value = getattr(settings, "wechat_key", "") if settings is not None else ""
    if value:
        return parse_manual_key(value)
    return parse_manual_key(os.environ.get(WECHAT_KEY_ENV, os.environ.get(LEGACY_WECHAT_KEY_ENV, "")))


def _check_page_key(page: bytes, key: bytes) -> bool:
    """SQLCipher v4 HMAC 复核：page[4096-64:] 是否等于 pbkdf2(key, mac_salt, 2) 的 HMAC。"""
    if len(page) < PAGE_SIZE or len(key) != 32:
        return False
    page = page[:PAGE_SIZE]
    salt = page[:16]
    mac_salt = bytes(b ^ 0x3A for b in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", key, mac_salt, 2, 32)
    mac_data = page[16:PAGE_SIZE - RESERVE_SIZE + 16]
    stored = page[PAGE_SIZE - 64:PAGE_SIZE]
    digest = hmac.new(mac_key, mac_data + struct.pack("<I", 1), hashlib.sha512).digest()
    return hmac.compare_digest(digest, stored)


_LAST_KEY_FAILURE: dict[str, str] = {}
_LAST_KEY_LOCK = threading.Lock()


def _record_key_failure(message: str, category: str) -> None:
    """记下「这次为什么没拿到密钥」，给接口/页面取用；成功则清空。"""
    with _LAST_KEY_LOCK:
        _LAST_KEY_FAILURE.clear()
        if message:
            _LAST_KEY_FAILURE.update({"message": message, "category": category})


def last_key_failure() -> dict[str, str]:
    """最近一次取密钥失败的原因（message/category）；没失败过就是空 dict。"""
    with _LAST_KEY_LOCK:
        return dict(_LAST_KEY_FAILURE)


def _derive_keys(candidate: bytes, salt: bytes) -> list[bytes]:
    """真机实测 raw key 直接命中；另两条 KDF 路线按 wechat_probe 顺序兜底。"""
    return [
        candidate,
        hashlib.pbkdf2_hmac("sha512", candidate, salt, 256000, 32),
        hashlib.pbkdf2_hmac("sha1", candidate, salt, 64000, 32),
    ]


# --------------------------------------------------------------------------
# 进程发现 / 只读内存扫描（移植自 tools/wechat_probe.py）
# --------------------------------------------------------------------------
def _tasklist_pids(image: str) -> list[int]:
    """按进程映像名查 PID；查不到返回空列表。"""
    try:
        output = subprocess.check_output(
            ["tasklist", "/FI", f"IMAGENAME eq {image}", "/FO", "CSV", "/NH"],
            text=True, errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return []
    pids: list[int] = []
    for line in output.splitlines():
        line = line.strip()
        if image.lower() not in line.lower():
            continue
        fields = re.findall(r'"([^"]*)"', line)
        if len(fields) >= 2 and fields[1].strip().isdigit():
            pids.append(int(fields[1]))
    return pids


def legacy_client_running() -> bool:
    """是否有微信 3.x（WeChat.exe）在跑——本功能只支持 4.0 的 Weixin.exe。"""
    if os.name != "nt":
        return False
    return bool(_tasklist_pids("WeChat.exe"))


def find_pids() -> list[int]:
    """返回所有 Weixin.exe PID；没有进程时抛 RuntimeError（含可读原因）。"""
    if os.name != "nt":
        raise RuntimeError("Weixin.exe 内存扫描仅支持 Windows")
    pids = _tasklist_pids("Weixin.exe")
    if not pids:
        if legacy_client_running():
            raise RuntimeError(
                "检测到的是 WeChat.exe（微信 3.x），本功能只支持微信 4.0（Weixin.exe）："
                "请升级到微信 4.x 后重试"
            )
        raise RuntimeError("没找到 Weixin.exe 进程：微信 4.x 可能没启动，或已退出登录")
    return pids


def _documents_dir() -> Optional[Path]:
    profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return Path(profile) / "Documents" if profile else None


def _looks_like_storage(path: Path) -> bool:
    """这个路径看起来像不像数据目录（而不是安装目录）。"""
    lowered = str(path).lower()
    return "xwechat_files" in lowered or "wechat files" in lowered or lowered.rstrip("\\").endswith("db_storage")


def _registry_storage_roots() -> list[Path]:
    """从注册表读微信数据目录（FileSavePath 等在 HKCU\\Software\\Tencent 下）；读不到返回空。"""
    if os.name != "nt":
        return []
    try:
        import winreg  # noqa: PLC0415 - 只有 Windows 才有
    except ImportError:
        return []
    docs = _documents_dir()
    roots: list[Path] = []
    for key_path in _REGISTRY_STORAGE_KEYS:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                count = winreg.QueryInfoKey(key)[1]
                for index in range(count):
                    try:
                        _name, value, _kind = winreg.EnumValue(key, index)
                    except OSError:
                        continue
                    if not isinstance(value, str) or not value.strip():
                        continue
                    text = os.path.expandvars(value.strip().strip('"'))  # %USERPROFILE% 这类占位符要展开
                    # 微信 3.x 写成 "MyDocument:\\..." 这种占位符
                    if text.lower().rstrip("\\") in ("mydocument:", "mydocument"):
                        if docs is not None:
                            roots.append(docs)
                        continue
                    roots.append(Path(text))
        except OSError:
            continue
    # 注册表里只有 InstallPath、没有 FileSavePath 时（issue #5 就是这种），按安装盘猜：
    # 微信默认把数据放在同盘的 xwechat_files 下，用户改盘时往往整盘一起搬。
    if roots and not any(_looks_like_storage(root) for root in roots):
        for install in list(roots):
            anchor = install.anchor
            if not anchor:
                continue
            for name in _STORAGE_ROOT_NAMES:
                roots.append(Path(anchor) / name)
    return roots


_DRIVE_ROOTS_CACHE_KEY = "wechat_receiver.drive_roots"
_DRIVE_ROOTS_TTL_SECONDS = 300.0


def _scan_drive_roots() -> list[Path]:
    """各盘符下的 xwechat_files / WeChat Files：盘根一层 + 名字像微信的一层子目录。

    issue #5 里用户把微信数据放到 ``E:\\xwechat_files``，默认候选只覆盖 C/D 盘，
    于是报「未找到微信数据目录」。只扫盘根和一层常见目录，不做全盘遍历。
    """
    if os.name != "nt":
        return []
    roots: list[Path] = []
    for letter in string.ascii_uppercase:
        base = Path("%s:\\" % letter)
        try:
            if not base.is_dir():
                continue
        except OSError:
            continue
        for name in _STORAGE_ROOT_NAMES:
            candidate = base / name
            try:
                if candidate.is_dir():
                    roots.append(candidate)
            except OSError:
                continue
        try:
            children = list(base.iterdir())
        except OSError:
            continue
        for child in children:
            try:
                if not child.is_dir():
                    continue
            except OSError:
                continue
            lowered = child.name.lower()
            if not any(token in lowered for token in ("wechat", "weixin", "tencent")):
                continue
            for name in _STORAGE_ROOT_NAMES:
                roots.append(child / name)
    return roots


def _drive_storage_roots() -> list[Path]:
    """盘符扫描结果缓存 5 分钟：每 1.5 秒的状态轮询不该反复列所有盘。"""
    if os.name != "nt":
        return []
    return list(
        ttl_cache.get(
            _DRIVE_ROOTS_CACHE_KEY,
            _DRIVE_ROOTS_TTL_SECONDS,
            _scan_drive_roots,
            cache_empty=False,
        )
    )


PROCESS_CACHE_TTL_SECONDS = 45.0
PROCESS_CACHE_KEY = "wechat_receiver.install_dirs"


def _query_wechat_install_dirs() -> list[Path]:
    """跑一次 PowerShell 取微信进程安装目录；任何失败（含输出解码失败）都返回空。"""
    script = (
        "Get-CimInstance Win32_Process -Filter \"Name='Weixin.exe' or Name='WeChat.exe'\" "
        "| ForEach-Object { $_.ExecutablePath }"
    )
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, errors="replace", timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        # ValueError 覆盖 UnicodeDecodeError：控制台代码页乱掉时不能把 500 冒给用户
        return []
    if completed.returncode != 0:
        return []
    dirs: list[Path] = []
    seen: set[str] = set()
    for line in str(completed.stdout or "").splitlines():
        text = line.strip().strip('"')
        if not text:
            continue
        executable = Path(text)
        if not executable.is_absolute():
            continue  # 裸文件名的 parent 是 "." / ".."，探下去就是当前工作目录
        install = executable.parent
        key = str(install).lower()
        if key and key not in seen:
            seen.add(key)
            dirs.append(install)
    return dirs


def _process_install_dirs() -> list[Path]:
    """从运行中的微信进程拿安装目录；结果（含失败）缓存 45 秒，避免轮询时反复起 PowerShell。"""
    if os.name != "nt":
        return []
    return list(
        ttl_cache.get(
            PROCESS_CACHE_KEY,
            PROCESS_CACHE_TTL_SECONDS,
            _query_wechat_install_dirs,
            # 失败的空结果不能缓存：否则用户点「重新检测」后 45 秒内看不到任何变化。
            cache_empty=False,
        )
    )


def _process_storage_roots() -> list[Path]:
    """由微信进程安装目录推导数据目录候选（同级 / 上级 / Documents 下同名目录）；拿不到返回空。"""
    docs = _documents_dir()
    roots: list[Path] = []
    for install in _process_install_dirs():
        roots.append(install)
        roots.append(install.parent)
        for name in _STORAGE_ROOT_NAMES:
            roots.append(install / name)
            roots.append(install.parent / name)
            if docs is not None:
                roots.append(docs / name)
    return roots


_CONFIG_ROOTS_CACHE_KEY = "wechat_receiver.config_roots"
_CONFIG_ROOTS_TTL_SECONDS = 300.0
# 定位结果（含逐层 stat）缓存：本机一次 3–4 秒，状态栏每次刷新都会问一遍。
_LOCATE_CACHE_KEY = "wechat_receiver.locate_storage"
LOCATE_CACHE_SECONDS = 45.0
# 微信 4.x 把「用户改过的存储位置」明文写在 <配置目录>/*.ini 里；两个根都试，
# %LOCALAPPDATA% 那个在多数机器上不存在，跳过即可。
_XWECHAT_CONFIG_ENVS = ("APPDATA", "LOCALAPPDATA")
_XWECHAT_CONFIG_PARTS = ("Tencent", "xwechat", "config")


def _default_config_dirs() -> list[Path]:
    dirs: list[Path] = []
    for name in _XWECHAT_CONFIG_ENVS:
        base = os.environ.get(name, "").strip()
        if base:
            dirs.append(Path(base).joinpath(*_XWECHAT_CONFIG_PARTS))
    return dirs


def _scan_wechat_config_roots(config_dirs: Iterable[Path]) -> list[Path]:
    """读微信 4.x 自己写的存储位置：config 目录下每个 ``*.ini`` 里就是一行路径文本。

    实测内容形如 ``D:\\Wechat files``（xwechat_files 的父目录）。中文路径可能是 GBK，
    所以先按 utf-8-sig 解、失败再按 gbk；解不出路径 / 不是绝对路径 / 目录不存在的一律丢。
    """
    roots: list[Path] = []
    seen: set[str] = set()
    for directory in config_dirs:
        try:
            if not directory.is_dir():
                continue
            entries = [entry for entry in sorted(directory.iterdir()) if entry.suffix.lower() == ".ini"]
        except OSError:
            LOGGER.warning("读取微信设置目录失败，跳过：%s", directory, exc_info=True)
            continue
        for entry in entries:
            try:
                raw = entry.read_bytes()
            except OSError:
                LOGGER.warning("读取微信存储位置配置失败，跳过：%s", entry, exc_info=True)
                continue
            text = ""
            for encoding in ("utf-8-sig", "gbk"):
                try:
                    text = raw.decode(encoding)
                    break
                except UnicodeDecodeError:
                    continue
            value = text.strip().strip("\"'").strip()
            if not value:
                continue
            candidate = Path(value)
            try:
                if not candidate.is_absolute() or not candidate.is_dir():
                    continue
            except OSError:
                continue
            key = str(candidate).replace("\\", "/").lower()
            if key in seen:
                continue
            seen.add(key)
            roots.append(candidate)
    return roots


def _wechat_config_roots(config_dirs: Any = None) -> list[Path]:
    """微信设置里记着的存储位置，缓存 5 分钟；空结果不缓存（改完点「重新检测」要立刻生效）。

    ponytail: 非空结果会缓存满 5 分钟，用户把位置从 A 改到 B 后这段时间仍先试 A；A 若还在就
    会先命中旧库。要更实时可改成每次探测都读 ini（代价是每次探测都扫一遍配置文件）。

    显式传 ``config_dirs`` 时只读这些目录、不走缓存（测试用）；任何读取失败只记 warning。
    """
    if config_dirs is not None:
        return _scan_wechat_config_roots(config_dirs)
    try:
        return list(
            ttl_cache.get(
                _CONFIG_ROOTS_CACHE_KEY,
                _CONFIG_ROOTS_TTL_SECONDS,
                lambda: _scan_wechat_config_roots(_default_config_dirs()),
                cache_empty=False,
            )
        )
    except OSError:
        LOGGER.warning("读取微信设置里的存储位置失败，跳过", exc_info=True)
        return []


READER_PLATFORMS = frozenset({"windows", "macos"})


def reader_platform() -> str:
    if os.name == "nt":
        return "windows"
    return "macos" if sys.platform == "darwin" else "unsupported"


def _macos_storage_root() -> Optional[Path]:
    if sys.platform != "darwin":
        return None
    try:
        return Path.home() / "Library/Containers/com.tencent.xinWeChat/Data/Documents"
    except RuntimeError:
        return None


def _storage_root_candidates() -> list[Path]:
    """候选根目录，按优先级：环境变量 → 微信 config ini → 微信进程 → 注册表 → 用户文档 → 盘根扫描 → 默认 D 盘。"""
    roots: list[Path] = []
    override = os.environ.get(STORAGE_DIR_ENV, os.environ.get(LEGACY_STORAGE_DIR_ENV, "")).strip().strip('"')
    if override:
        roots.append(Path(override))
    try:
        # 微信设置里记的是用户改过的位置，微信自己一改就更新，比注册表里的旧安装路径可靠。
        roots.extend(_wechat_config_roots())
    except Exception:  # noqa: BLE001 - 读配置失败不能拖累后面的候选
        LOGGER.warning("读取微信设置里的存储位置失败，继续尝试其它候选", exc_info=True)
    try:
        roots.extend(_process_storage_roots())
    except Exception:  # noqa: BLE001 - 发现层坏了也不能拖累后面的候选
        LOGGER.warning("从微信进程推导数据目录失败，继续尝试其它候选", exc_info=True)
    try:
        roots.extend(_registry_storage_roots())
    except Exception:  # noqa: BLE001
        LOGGER.warning("读取注册表里的微信目录失败，继续尝试其它候选", exc_info=True)
    docs = _documents_dir()
    if docs is not None:
        roots.extend(docs / name for name in _STORAGE_ROOT_NAMES)
    macos_root = _macos_storage_root()
    if macos_root is not None:
        roots.append(macos_root)
    try:
        roots.extend(_drive_storage_roots())
    except Exception:  # noqa: BLE001 - 盘符扫描失败不能拖累已有候选
        LOGGER.warning("扫描各盘符下的微信目录失败，继续尝试其它候选", exc_info=True)
    roots.append(DEFAULT_STORAGE_ROOT)
    ordered: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = str(root).lower()
        if key not in seen:
            seen.add(key)
            ordered.append(root)
    return ordered


def _storage_in(base: Path) -> Optional[Path]:
    """在 base 里找 db_storage：base 本身 / base 的账号子目录 / base 下再一层的 xwechat_files。"""
    if base.name.lower() == "db_storage":
        return base if base.is_dir() else None
    direct = base / "db_storage"
    if direct.is_dir():
        return direct
    try:
        children = sorted(base.iterdir())
    except OSError:
        return None
    for child in children:
        candidate = child / "db_storage"
        if candidate.is_dir():
            return candidate
    return None


def _probe_storage(roots: list[Path]) -> tuple[Optional[Path], list[str]]:
    tried: list[str] = []
    for root in roots:
        for base in (root, root / "xwechat_files", root / "WeChat Files"):
            text = str(base)
            if text in tried:
                continue
            tried.append(text)
            found = _storage_in(base)
            if found is not None:
                return found, tried
    return None, tried


_PROBED_LOG_KEY: tuple[str, ...] = ()


def _log_probe_once(tried: tuple[str, ...]) -> None:
    global _PROBED_LOG_KEY
    if _PROBED_LOG_KEY == tried:
        return
    _PROBED_LOG_KEY = tried
    logging.getLogger("noticehub.receivers.wechat_receiver").warning(
        "未找到微信数据目录，已尝试：%s。可用环境变量 %s 手动指定微信数据目录",
        "；".join(tried) or "（无候选）",
        STORAGE_DIR_ENV,
    )


def locate_storage(storage_dir: Any = None) -> Optional[Path]:
    """返回含 message/contact 的 db_storage 目录；找不到返回 None。

    查找顺序：显式 ``storage_dir`` → 环境变量 ``NOTICEHUB_WECHAT_DIR`` → 微信设置里记的存储位置
    （``%APPDATA%\\Tencent\\xwechat\\config\\*.ini``）→ **运行中的微信进程**推导出的安装目录 →
    注册表 → 用户「文档」目录 → macOS 微信应用目录 → **各盘根目录扫描** → 默认 D 盘。

    找不到时把试过的路径写进日志（同样的清单见 ``storage_unavailable_hint()``）。

    结果缓存 45 秒：这一步要真的去 stat 目录，本机一次 3–4 秒，而状态栏每次刷新都会问。
    ``cache_empty=False``：没找到不缓存，用户改完存储位置点「重新检测」能立刻重试。
    显式传了目录就不走缓存——那是设置页/引导的一次性解析，缓存反而会让用户点完看不到变化。
    """
    if storage_dir:
        return _locate_storage_uncached(storage_dir)
    return ttl_cache.get(
        _LOCATE_CACHE_KEY, LOCATE_CACHE_SECONDS, lambda: _locate_storage_uncached(None), cache_empty=False
    )


def _locate_storage_uncached(storage_dir: Any = None) -> Optional[Path]:
    if storage_dir:
        candidate = Path(storage_dir)
        try:
            if not candidate.is_dir():
                return None
        except OSError:
            return None
        # 用户照引导填的往往是「文件管理」里的父目录（…\Wechat files）或 …\xwechat_files，
        # 而消息库在 <账号>\db_storage 下：显式路径也解析一次，解析不到才退回原目录（兼容旧布局）。
        found, _tried = _probe_storage([candidate])
        return found if found is not None else candidate
    found, tried = _probe_storage(_storage_root_candidates())
    if found is not None:
        return found
    _log_probe_once(tuple(tried))
    return None


def clear_storage_cache() -> None:
    """丢掉「微信设置里的位置 / 微信进程 / 盘根扫描 / 定位结果」四份探测缓存。

    用户把微信存储位置从 A 改到 B 再来点按钮时，缓存里可能还留着 A；点一下就重读，
    比让他等满 TTL（300/45 秒）才生效靠谱。TTL 本身不动。
    """
    for key in (_CONFIG_ROOTS_CACHE_KEY, PROCESS_CACHE_KEY, _DRIVE_ROOTS_CACHE_KEY, _LOCATE_CACHE_KEY):
        ttl_cache.clear(key)


def _storage_diagnosis() -> str:
    """没找到数据目录时，说清是「哪一条线索断了」，而不是只丢一句「没找到」。

    只覆盖两种用户自己就能改的情况：设置里填的目录不对、微信设置里记的路径没有 db_storage。
    """
    override = os.environ.get(STORAGE_DIR_ENV, os.environ.get(LEGACY_STORAGE_DIR_ENV, "")).strip().strip('"')
    if override:
        path = Path(override)
        try:
            exists = path.is_dir()
        except OSError:
            exists = False
        if not exists:
            return f"你在设置页填的微信数据目录「{override}」不存在，请改成微信「设置 → 文件管理」里显示的存储位置目录。"
        if _probe_storage([path])[0] is None:
            return f"你在设置页填的微信数据目录「{override}」里没有 db_storage，请指向真正的微信存储位置目录。"
    try:
        config_roots = _wechat_config_roots()
    except Exception:  # noqa: BLE001 - 诊断失败不能把提示变成异常
        LOGGER.warning("诊断微信存储位置时读取配置失败", exc_info=True)
        config_roots = []
    for root in config_roots:
        if _probe_storage([root])[0] is None:
            return f"微信设置里记的是「{root}」，但那里没有 db_storage，请确认那个目录还在、微信是登录状态。"
    return ""


def storage_unavailable_hint() -> str:
    """给页面/接口用的排查文案：分步告诉用户怎么办，并点明具体卡在哪一步。"""
    found, _tried = _probe_storage(_storage_root_candidates())
    if found is not None:
        if _storage_busy_reason(_target_db(found)):
            # 目录找到了、但库被微信进程占着：这不是「找不到目录」，别让用户去找目录。
            return STORAGE_BUSY_MESSAGE
        return ""
    lines = [
        WECHAT_DIR_NOT_FOUND,
        "1. 先看微信里记的位置：微信 → 设置 → 文件管理，确认「存储位置」那个目录还在、微信是登录状态。",
        "2. 程序会自动读这个位置；仍找不到时，打开设置页 →「微信」→「微信数据目录（可选）」，"
        "填上面那个存储位置目录（例如 D:\\Wechat files，也可以填 …\\xwechat_files 或某个账号的 …\\db_storage），"
        "点「保存目录」立即生效，不用重启。",
        f"3. 也可以改程序目录 .env 里的 {STORAGE_DIR_ENV}（老办法，需要重启SuperDot）。",
    ]
    diagnosis = _storage_diagnosis()
    if diagnosis:
        lines.append("诊断：" + diagnosis)
    if legacy_client_running():
        lines.append("另外检测到 WeChat.exe（微信 3.x）：本功能只支持微信 4.0（Weixin.exe）。")
    return "\n".join(lines)


def _first_message_db(storage: Path) -> Optional[Path]:
    dbs = _message_dbs(storage)
    return dbs[0] if dbs else None


def _message_dbs(storage: Path) -> list[Path]:
    message_dir = storage / "message"
    if not message_dir.is_dir():
        return []
    return sorted(
        (p for p in message_dir.iterdir() if p.is_file() and _MESSAGE_DB_RE.match(p.name)),
        key=lambda p: p.name,
    )


class _CommonCryptoAES:
    """Use macOS CommonCrypto for the same page operation as Windows CNG."""

    def __init__(self, key: bytes) -> None:
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
        if status != 0 or moved.value != len(page):
            raise OSError(f"CommonCrypto could not decrypt the page (status {status})")
        return output.raw

    def close(self) -> None:
        self._key = b""


def _page_cipher(key: bytes) -> _BCryptAES | _CommonCryptoAES:
    if reader_platform() == "macos":
        return _CommonCryptoAES(key)
    return _BCryptAES(key)


def _cbc_decrypt_page(engine: Any, ciphertext: bytes, iv: bytes) -> bytes:
    """CBC 解密一个页内的密文区。

    ``_BCryptAES`` 只接受整 4096 字节 ECB 调用，所以先 0 填充到 4096 再裁回；
    ECB 逐块独立，尾部填充不影响前段。CBC 的 XOR 用大整数一次算完（比逐块快）。
    """
    if not ciphertext or len(ciphertext) % 16 or len(iv) != 16:
        raise ValueError("CBC 输入必须 16 字节对齐且 IV 为 16 字节")
    if len(ciphertext) > PAGE_SIZE:
        raise ValueError("单页密文不得超过 4096 字节")
    padded = ciphertext + bytes(PAGE_SIZE - len(ciphertext))
    decrypted = engine.decrypt(padded)[: len(ciphertext)]
    shifted = iv + ciphertext[:-16]
    return (
        int.from_bytes(decrypted, "big") ^ int.from_bytes(shifted, "big")
    ).to_bytes(len(ciphertext), "big")


def decrypt_page(engine: Any, page: bytes, page_no: int) -> bytes:
    """解密一个 4096 字节页（reserve=80）。page 1 前 16 字节是盐，保持明文。"""
    if len(page) != PAGE_SIZE:
        raise ValueError("页长度必须为 4096")
    iv = page[PAGE_SIZE - RESERVE_SIZE:PAGE_SIZE - RESERVE_SIZE + 16]
    if page_no == 1:
        body = _cbc_decrypt_page(engine, page[16:PAGE_SIZE - RESERVE_SIZE], iv)
        return SQLITE_HEADER + body + bytes(RESERVE_SIZE)
    body = _cbc_decrypt_page(engine, page[:PAGE_SIZE - RESERVE_SIZE], iv)
    return body + bytes(RESERVE_SIZE)


def _wal_frames(data: bytes) -> list[tuple[int, int, bytes]]:
    """解析 WAL 中当前 salt 的已提交帧：[(page_no, db_size, 4096 字节页), ...]。"""
    if len(data) < WAL_HEADER_SIZE:
        return []
    magic, _version, _page_size, _checkpoint, salt1, salt2 = struct.unpack(">6I", data[:24])
    if magic not in WAL_MAGIC:
        return []
    frames: list[tuple[int, int, bytes]] = []
    offset = WAL_HEADER_SIZE
    while offset + WAL_FRAME_SIZE <= len(data):
        page_no, db_size, fsalt1, fsalt2 = struct.unpack(">4I", data[offset:offset + 16])
        if (fsalt1, fsalt2) != (salt1, salt2):
            break
        frames.append((page_no, db_size, data[offset + 24:offset + WAL_FRAME_SIZE]))
        offset += WAL_FRAME_SIZE
    return frames


def decrypt_database(
    db_path: Any, wal_path: Any = None, key: bytes = None,
    progress: Optional[Callable[[str], None]] = None,
) -> bytes:
    """解密整库为明的 SQLite 字节串（含 WAL 增量），供只读打开。

    ponytail: 整库解密到内存（真机 message_0.db 约 56MB），未按需只解页；
    若日后成为瓶颈，可先只解 sqlite 主表页 / 增量多页。
    """
    if key is None:
        raise ValueError("必须提供密钥")
    db_file = Path(db_path)
    raw = _read_shared(db_file)
    engine = _page_cipher(key)
    try:
        pages: dict[int, bytes] = {}
        total = len(raw) // PAGE_SIZE
        for index in range(total):
            if progress and (index == 0 or (index + 1) % 512 == 0):
                progress(f"解密 {db_file.name}：{index + 1}/{total} 页")
            page_no = index + 1
            pages[page_no] = decrypt_page(engine, raw[index * PAGE_SIZE:(index + 1) * PAGE_SIZE], page_no)
        db_size = total
        wal_file = Path(wal_path) if wal_path else Path(str(db_file) + "-wal")
        if wal_file.exists():
            try:
                wal_data = _read_shared(wal_file)
            except OSError:
                wal_data = b""
            for page_no, size, page in _wal_frames(wal_data):
                pages[page_no] = decrypt_page(engine, page, page_no)
                if size:
                    db_size = size
        highest = max(pages) if pages else 0
        db_size = max(db_size, highest)
        output = bytearray()
        for page_no in range(1, db_size + 1):
            output += pages.get(page_no, bytes(PAGE_SIZE))
        return bytes(output)
    finally:
        engine.close()


# --------------------------------------------------------------------------
# 密钥发现（带进程内缓存，避免 group_names + reader 重复扫 186~239 秒）
# --------------------------------------------------------------------------
_KEY_CACHE: dict[tuple[str, str], bytes] = {}
_KEY_CACHE_LOCK = threading.Lock()


def _target_db(storage: Path, target_db: Any = None) -> Optional[Path]:
    if target_db is None:
        return _first_message_db(storage)
    path = Path(target_db)
    return path if path.is_absolute() else storage / path


def _page_key_valid(page: bytes, key: bytes) -> bool:
    """要求页 1 解出 SQLite magic，并通过 SQLCipher HMAC 复核。"""
    if len(page) < PAGE_SIZE or len(key) != 32:
        return False
    try:
        engine = _page_cipher(key)
        try:
            if not decrypt_page(engine, page[:PAGE_SIZE], 1).startswith(SQLITE_HEADER):
                return False
        finally:
            engine.close()
    except Exception:
        return False
    return _check_page_key(page, key)


def _key_cache_id(storage: Path, target_db: Any = None) -> tuple[str, str]:
    target = _target_db(storage, target_db)
    if target is None:
        return (str(storage), "")
    try:
        relative = str(target.relative_to(storage))
    except ValueError:
        relative = str(target)
    return (str(storage), relative)


class WechatScanError(RuntimeError):
    """扫描失败，并且知道属于哪一类：调用方据此给下一步动作，而不是让用户干等。"""

    def __init__(self, message: str, category: str = "other") -> None:
        super().__init__(message)
        self.category = category


# 「文件被别的进程占着」的几种 errno：EACCES(13)、WinError 32、个别环境的 EIO(5)。
_SHARING_ERRORNOS = (5, 13, 32)
STORAGE_BUSY_MESSAGE = (
    "微信数据库可能被占用，请稍等几秒，或退出微信后重新检测。"
)


def _is_sharing_error(error: BaseException) -> bool:
    """这个异常是「文件被占用/没权限」，不是密钥不对、也不是库结构不认识。"""
    if isinstance(error, PermissionError):
        return True
    if isinstance(error, OSError):
        if getattr(error, "winerror", None) == 32:
            return True
        return getattr(error, "errno", None) in _SHARING_ERRORNOS
    return False


def _storage_busy_reason(db_path: Optional[Path]) -> str:
    """探一下目标库能不能读；被占用时返回原因，能读就返回空串。"""
    if db_path is None or not db_path.exists():
        return ""
    try:
        _read_shared(db_path)[:PAGE_SIZE]
    except OSError as error:
        if _is_sharing_error(error):
            return str(error) or error.__class__.__name__
    return ""


def _cache_key(storage: Path, key: bytes, target_db: Any = None) -> None:
    with _KEY_CACHE_LOCK:
        _KEY_CACHE[_key_cache_id(storage, target_db)] = key


def _key_still_valid(storage: Path, key: bytes, target_db: Any = None) -> bool:
    db_path = _target_db(storage, target_db)
    if db_path is None:
        return False
    if not db_path.exists():
        # 目标库都不存在：不是「密钥解不开」，别把手填 key 说成错的（issue 自查发现）。
        return False
    try:
        if reader_platform() == "macos":
            with db_path.open("rb") as handle:
                page = handle.read(PAGE_SIZE)
        else:
            page = _read_shared(db_path)[:PAGE_SIZE]
    except OSError:
        return False
    return _page_key_valid(page, key)


def _match_configured_key(storage: Path, candidate: bytes, target_db: Any) -> Optional[bytes]:
    if _key_still_valid(storage, candidate, target_db):
        return candidate
    # macOS WCDB can use an account-level key with a different salt per file.
    db_path = _target_db(storage, target_db)
    if reader_platform() != "macos" or db_path is None:
        return None
    try:
        with db_path.open("rb") as handle:
            page = handle.read(PAGE_SIZE)
    except OSError:
        return None
    if len(page) != PAGE_SIZE:
        return None
    derived = hashlib.pbkdf2_hmac("sha512", candidate, page[:16], 256_000, 32)
    return derived if _page_key_valid(page, derived) else None


def resolve_key(
    storage: Path, key: Any = None, logger: Any = None, target_db: Any = None,
    progress: Optional[Callable[[str], None]] = None,
) -> Optional[bytes]:
    """Use the supplied or configured key for the local database."""
    log = _logger(logger)
    if key:
        matched = _match_configured_key(storage, bytes(key), target_db)
        if matched is not None:
            _record_key_failure("", "")
            return matched
        db_path = _target_db(storage, target_db)
        if db_path is not None and _storage_busy_reason(db_path):
            _record_key_failure(STORAGE_BUSY_MESSAGE, "storage_busy")
        else:
            _record_key_failure("当前授权密钥无法读取微信数据库。", "bad_manual_key")
        return None
    manual = manual_key()
    if manual is not None:
        matched = _match_configured_key(storage, manual, target_db)
        if matched is not None:
            _record_key_failure("", "")
            _cache_key(storage, matched, target_db)
            log.info("使用已配置的微信解密密钥")
            return matched
        db_path = _target_db(storage, target_db)
        if db_path is None or not db_path.exists():
            # 数据目录/目标库还没找到：这不是密钥的错，报目录问题，别误导用户换密钥。
            message = (
                "还没找到微信数据目录或目标数据库：先确认微信已登录、数据目录能探测到"
                "（可用 NOTICEHUB_WECHAT_DIR 手动指定），目录就位后手填密钥才会生效"
            )
            _record_key_failure(message, "no_database")
            raise WechatScanError(message, "no_database")
        if _storage_busy_reason(db_path):
            # 库被微信自己占着时读不到首页，看起来像「密钥不对」，其实用户什么都不用改。
            _record_key_failure(STORAGE_BUSY_MESSAGE, "storage_busy")
            raise WechatScanError(STORAGE_BUSY_MESSAGE, "storage_busy")
        message = "NOTICEHUB_WECHAT_KEY 填的密钥解不开当前微信数据库：确认它是这台机器上当前登录账号的 32 字节 raw key"
        _record_key_failure(message, "bad_manual_key")
        raise ValueError(message)
    raise WechatScanError("请在设置里填写已授权的微信密钥。", "missing_key")


def verify_message_store(storage: Path, key: bytes) -> None:
    """Confirm that the configured key can open the first message database."""
    target = _first_message_db(storage)
    if target is None:
        raise WechatScanError("还没找到微信消息数据库。请打开并登录桌面微信后重试。", "no_database")
    if _match_configured_key(storage, key, target) is not None:
        return
    if _storage_busy_reason(target):
        raise WechatScanError(STORAGE_BUSY_MESSAGE, "storage_busy")
    raise WechatScanError("当前密钥无法解开消息数据库。请检查密钥后重新检测。", "bad_manual_key")


# --------------------------------------------------------------------------
# 解密后库的读取
# --------------------------------------------------------------------------
@contextlib.contextmanager
def _temp_db(db_bytes: bytes):
    handle, path = tempfile.mkstemp(suffix=".db", prefix="wechat-dec-")
    os.close(handle)
    try:
        with open(path, "wb") as fh:
            fh.write(db_bytes)
        connection = sqlite3.connect(path)
        connection.execute("PRAGMA query_only = ON")  # 只读，杜绝任何写入
        # text_factory=bytes：消息内容可能是二进制/压缩帧，交给调用方自己判定。
        connection.text_factory = bytes
        try:
            yield connection
        finally:
            connection.close()
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (bytes, bytearray, memoryview)):
        blob = bytes(value)
        if blob[:4] == ZSTD_MAGIC:
            return ""
        try:
            return blob.decode("utf-8")
        except UnicodeDecodeError:
            return ""
    return str(value)


def parse_wechat_text(content: Any) -> str:
    """把 message_content 归一成文本；非文本（二进制/zstd 压缩帧/非法 UTF-8）返回 ""。"""
    text = _as_text(content)
    if "\x01" in text:  # WeChat 长文本填充
        text = text.split("\x01", 1)[0]
    return text.replace("\x00", "").strip()


def _md5_suffix(group_id: str) -> str:
    return hashlib.md5(group_id.encode("utf-8")).hexdigest()


def message_table_name(group_id: str) -> str:
    """群 id → 消息分片表名 ``Msg_<md5(group_id)>``。"""
    return "Msg_" + _md5_suffix(group_id)


def parse_contact_names(db_bytes: bytes, *, include_direct: bool = False) -> dict[str, str]:
    """读取群名和可选的本机联系人显示名。"""
    names: dict[str, str] = {}
    try:
        with _temp_db(db_bytes) as connection:
            sql = "SELECT username, nick_name FROM contact"
            if not include_direct:
                sql += " WHERE username LIKE '%@chatroom'"
            rows = connection.execute(sql).fetchall()
    except sqlite3.Error:
        return {}
    for username, nickname in rows:
        group_id = _as_text(username).strip()
        name = _as_text(nickname).strip()
        if group_id and name and (include_direct or group_id.endswith("@chatroom")):
            names[group_id] = name
    return names


def _name2id(connection: sqlite3.Connection) -> dict[int, str]:
    mapping: dict[int, str] = {}
    try:
        rows = connection.execute("SELECT rowid, user_name FROM Name2Id").fetchall()
    except sqlite3.Error:
        return mapping
    for rowid, user_name in rows:
        mapping[int(rowid)] = _as_text(user_name)
    return mapping


def read_messages_from_db(
    db_bytes: bytes,
    groups: Iterable[str],
    names: Optional[dict[str, str]] = None,
    since_ts: int = 0,
    since_rowids: Optional[Mapping[str, int]] = None,
    rowid_updates: Optional[dict[str, int]] = None,
    progress: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """从一个已解密的消息分片库字节里读出白名单群的文本消息。

    fail-closed：``groups`` 为空 → 空列表。
    """
    whitelist = {g for g in (groups or ()) if g}
    if not whitelist:
        return []
    names = names or {}
    targets = {message_table_name(g): g for g in whitelist}
    records: list[dict] = []
    with _temp_db(db_bytes) as connection:
        try:
            present = {_as_text(row[0]) for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        except sqlite3.Error:
            return []
        senders = _name2id(connection)
        for table, group_id in targets.items():
            if table not in present:
                continue
            cursor = int((since_rowids or {}).get(group_id) or 0)
            try:
                if cursor:
                    rows = connection.execute(
                        "SELECT rowid, local_id, local_type, real_sender_id, create_time, message_content "
                        "FROM %s WHERE rowid > ? ORDER BY rowid" % table,
                        (cursor,),
                    ).fetchall()
                else:
                    rows = connection.execute(
                        "SELECT rowid, local_id, local_type, real_sender_id, create_time, message_content "
                        "FROM %s ORDER BY rowid" % table
                    ).fetchall()
                has_rowid = True
            except sqlite3.Error:
                try:
                    rows = connection.execute(
                        "SELECT local_id, local_type, real_sender_id, create_time, message_content "
                        "FROM %s" % table
                    ).fetchall()
                except sqlite3.Error:
                    continue
                has_rowid = False
                cursor = 0
                if progress:
                    progress("无法按 rowid 增量定位，回退全量扫描")
                if rowid_updates is not None:
                    rowid_updates[group_id] = 0
            for row in rows:
                if has_rowid:
                    rowid, local_id, local_type, real_sender_id, create_time, content = row
                    if rowid_updates is not None:
                        rowid_updates[group_id] = max(rowid_updates.get(group_id, 0), int(rowid))
                else:
                    local_id, local_type, real_sender_id, create_time, content = row
                if int(local_type or 0) != MSG_TYPE_TEXT:
                    continue
                ts = int(create_time or 0)
                if has_rowid and not cursor and since_ts and ts < int(since_ts):
                    continue
                text = parse_wechat_text(content)
                if not text:
                    continue
                sender = senders.get(int(real_sender_id)) if real_sender_id is not None else None
                records.append({
                    "msg_id": f"wechat:{group_id}:{local_id}",
                    "source": "wechat",
                    "event": "GROUP_MESSAGE_CREATE" if group_id.endswith("@chatroom") else "C2C_MESSAGE_CREATE",
                    "group_id": group_id,
                    "group_name": names.get(group_id),
                    "sender_id": sender or ("" if real_sender_id is None else str(real_sender_id)),
                    "ts": ts,
                    "content": text,
                })
    records.sort(key=lambda record: (record["ts"], record["msg_id"]))
    return records


def group_names(storage_dir: Any = None, key: Any = None, *, include_direct: bool = False) -> dict[str, str]:
    """解密 contact/contact.db，返回 ``{群id: 真实群名}``（取 contact.nick_name）。

    失败（无库 / 无密钥 / 库损坏）一律返回 ``{}`` 并打日志，绝不抛到外面。
    """
    log = _logger(None)
    storage = locate_storage(storage_dir)
    if storage is None:
        log.warning("未找到微信 db_storage 目录（storage_dir=%s）", storage_dir)
        return {}
    contact = storage / "contact" / "contact.db"
    if not contact.exists():
        log.warning("未找到 contact/contact.db（%s）", contact)
        return {}
    try:
        resolved = resolve_key(storage, key, log, target_db=contact)
        if not resolved:
            log.warning("未取得密钥，无法读取 %s", contact.name)
            return {}
        return parse_contact_names(decrypt_database(contact, None, resolved), include_direct=include_direct)
    except Exception as exc:
        log.warning("读取微信会话失败（%s）：%s", contact.name, exc)
        return {}


def fetch_messages(
    storage_dir: Any = None,
    groups: Iterable[str] = None,
    key: Any = None,
    since_ts: int = 0,
    logger: Any = None,
    db_paths: Optional[Iterable[Path]] = None,
    since_rowids: Optional[Mapping[str, Mapping[str, int]]] = None,
    rowid_updates: Optional[dict[str, dict[str, int]]] = None,
    progress: Optional[Callable[[str], None]] = None,
    names: Optional[dict[str, str]] = None,
    failed_shards: Optional[list[str]] = None,
) -> list[dict]:
    """解密 message/message_*.db（含 WAL 增量）→ 白名单群的文本 record 列表。

    ``failed_shards``：取密钥失败或解密失败的分片名会被追加进来。调用方靠它把这些
    分片的签名留在原地，下一轮仍判为「有变化」再试——否则签名一推进，这些消息
    就永远读不到了。
    """
    log = _logger(logger)
    whitelist = {g for g in (groups or ()) if g}
    if not whitelist:
        return []
    storage = locate_storage(storage_dir)
    if storage is None:
        log.warning("未找到微信 db_storage 目录（storage_dir=%s）", storage_dir)
        return []
    records: list[dict] = []
    selected_paths = list(db_paths) if db_paths is not None else _message_dbs(storage)
    for index, db_path in enumerate(selected_paths, 1):
        if progress:
            progress(f"打开微信分片 {index}/{len(selected_paths)}：{db_path.name}")
        resolved = resolve_key(storage, key, log, target_db=db_path)
        if not resolved:
            if failed_shards is not None:
                failed_shards.append(db_path.name)
            continue
        db_names = names if names is not None else _safe_group_names(storage, resolved, log)
        try:
            blob = decrypt_database(db_path, None, resolved, progress=progress)
        except Exception as exc:
            log.warning("解密 %s 失败：%s", db_path.name, exc)
            if failed_shards is not None:
                failed_shards.append(db_path.name)
            continue
        cursor_by_db = (since_rowids or {}).get(db_path.name, {})
        updates_by_db = rowid_updates.setdefault(db_path.name, {}) if rowid_updates is not None else None
        records.extend(read_messages_from_db(
            blob, whitelist, db_names, since_ts, cursor_by_db, updates_by_db, progress
        ))
    records.sort(key=lambda record: (record["ts"], record["msg_id"]))
    return records


def _safe_group_names(storage: Path, key: bytes, logger: Any) -> dict[str, str]:
    try:
        return group_names(storage, key=key, include_direct=True)
    except Exception as exc:  # group_names 自身已兜底，这里再保一层
        _logger(logger).warning("读取微信会话名失败：%s", exc)
        return {}


def _logger(logger: Any) -> Any:
    return logger if logger is not None else LOGGER


SCAN_ERROR_HINTS = {
    "missing_key": "请在本机连接设置中填写数据库解密密钥。",
    "bad_manual_key": "当前密钥无法解密数据库，请检查后重新检测。",
    "storage_busy": STORAGE_BUSY_MESSAGE,
    "no_database": "请确认微信已登录，或在本机连接设置中指定微信数据目录。",
    "not_logged_in": "没找到运行中的微信：请先登录微信桌面版，再点「检测本机微信」。",
    "no_candidates": "扫完微信进程内存没找到候选密钥：微信可能刚启动、还没写库。别关微信，等 3–6 分钟再点「立即扫描一次」。",
    "candidates_unmatched": "扫到了候选密钥但都解不开当前数据库：当前微信版本可能未适配，或密钥属于别的账号。",
    "needs_admin": "读取微信进程内存要一次管理员授权：点「立即扫描一次」，在系统弹窗里输入本机管理员密码；"
                   "不想授权就在本机连接设置里手填 32 字节 raw key。",
    "version_unsupported": "当前微信数据库格式暂不支持：请升级微信到 4.x 后再试。",
    "other": "请重新读取会话；仍失败时在服务自检里查看日志原文。",
}


def clear_elevation_cooldown() -> None:
    pass


def elevation_command(pid: Any = None) -> str:
    return ""


def scan_error_hint(category: Any) -> str:
    """几类扫描失败各给一句下一步动作，未知类别返回空串（调用方回退旧文案）。"""
    return SCAN_ERROR_HINTS.get(str(category or ""), "")


def classify_scan_error(exc: BaseException) -> str:
    """把扫描异常归到某一类。只看异常类型与已有报错文案，不重跑扫描。"""
    if isinstance(exc, WechatScanError):
        return exc.category
    if isinstance(exc, sqlite3.Error):
        return "version_unsupported"
    if _is_sharing_error(exc):
        # 文件被占用：绝不能归到 bad_manual_key，否则用户会去改一个本来没问题的密钥。
        return "storage_busy"
    text = str(exc) or exc.__class__.__name__
    if "被占用" in text:
        return "storage_busy"
    if "NOTICEHUB_WECHAT_KEY" in text or "QQ_DIGEST_WECHAT_KEY" in text:
        return "bad_manual_key"
    if "微信 3.x" in text or "只支持微信 4.0" in text or "数据库分片" in text:
        return "version_unsupported"
    if "密钥" in text or "Weixin.exe" in text or "内存扫描" in text:
        return "no_candidates"
    if "未找到微信" in text or "登录" in text:
        return "not_logged_in"
    return "other"


# --------------------------------------------------------------------------
# 后台读取器（与 DingTalkLocalReader 同形：is_alive / start / stop）
# --------------------------------------------------------------------------
class WeChatLocalReader:
    """按 ``interval_seconds`` 轮询微信本地库，把新消息交给 ``on_message``。"""

    def __init__(
        self,
        groups: Iterable[str],
        interval_seconds: int = 60,
        on_message: Any = None,
        storage_dir: Any = None,
        logger: Any = None,
        status: Optional[dict[str, Any]] = None,
    ) -> None:
        self.groups = {g for g in (groups or ()) if g}
        self.interval_seconds = max(5, int(interval_seconds or 60))
        self.on_message = on_message
        self.storage_dir = str(storage_dir) if storage_dir else None
        self.logger = _logger(logger)
        self.status = status if status is not None else {}
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._scan_thread: Optional[threading.Thread] = None
        self._scan_lock = threading.Lock()
        self._status_lock = threading.Lock()
        self._closing = False
        self._key: Optional[bytes] = None
        self._since = int(time.time())
        self._scan_baseline: Optional[int] = None
        self._signatures: dict[str, tuple[int, int, int, int, int, int]] = {}
        self._rowids: dict[str, dict[str, int]] = {}
        enabled = bool(self.groups)
        defaults = {
            "scan_state": "idle" if enabled else "disabled",
            "scan_stage": "等待扫描" if enabled else "未启用",
            "scan_started_monotonic": 0.0,
            "scan_started_at": "",
            "last_read_at": "",
            "last_read_seconds": 0.0,
            "last_error": "",
            "error_category": "",
        }
        for name, value in defaults.items():
            self.status.setdefault(name, value)
        if self.status.get("scan_state") != "running":
            self.status["scan_state"] = defaults["scan_state"]
            self.status["scan_stage"] = defaults["scan_stage"]

    def _set_scan_stage(self, stage: str) -> None:
        with self._status_lock:
            if not self._closing and self.status.get("scan_state") == "running":
                self.status["scan_stage"] = stage

    def _finish_scan(self, error: str = "", error_category: str = "") -> None:
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
                "last_read_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
                "last_read_seconds": max(0.0, time.monotonic() - started) if started else 0.0,
                "last_error": error,
                "error_category": (error_category or "other") if error else "",
            })

    def _run_scan_worker(self) -> None:
        error = ""
        error_category = ""
        try:
            self.scan_once()
        except Exception as exc:
            error = str(exc) or exc.__class__.__name__
            error_category = classify_scan_error(exc)
            self.logger.exception("微信本地库读取异常：%s", exc)
        finally:
            self._finish_scan(error, error_category)
            self._scan_lock.release()

    @property
    def is_alive(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start_scan(self) -> bool:
        if self._stop.is_set() or not self.is_alive or not self.groups:
            return False
        if not self._scan_lock.acquire(blocking=False):
            return False
        with self._status_lock:
            self.status.update({
                "scan_state": "running",
                "scan_stage": "查找微信本地数据库",
                "scan_started_monotonic": time.monotonic(),
                "scan_started_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
                "last_error": "",
                "error_category": "",
            })
        worker = threading.Thread(target=self._run_scan_worker, name="wechat-scan", daemon=True)
        self._scan_thread = worker
        try:
            worker.start()
        except Exception:
            self._finish_scan("无法启动扫描线程")
            self._scan_lock.release()
            raise
        return True

    def start(self) -> bool:
        if reader_platform() not in READER_PLATFORMS:
            self.logger.warning("微信本地库读取仅支持 Windows 和 macOS，未启动")
            return False
        if self.is_alive:
            return True
        self._stop.clear()
        self._closing = False
        self._thread = threading.Thread(target=self._run, name="wechat-local-reader", daemon=True)
        self._thread.start()
        return True

    def stop(self, timeout: float = 5) -> None:
        self._stop.set()
        self._closing = True
        with self._status_lock:
            self.status.update({
                "scan_state": "idle" if self.groups else "disabled",
                "scan_stage": "等待扫描" if self.groups else "未启用",
                "scan_started_at": "",
                "scan_started_monotonic": 0.0,
            })
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout)
        scan = self._scan_thread
        if scan is not None and scan.is_alive():
            scan.join(timeout)
        self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            self.start_scan()
            self._stop.wait(self.interval_seconds)

    def _file_signatures(self, storage: Path) -> dict[str, tuple[int, ...]]:
        signatures = {}
        for path in _message_dbs(storage):
            try:
                db_stat = path.stat()
            except OSError:
                continue
            sidecars = []
            for suffix in ("-wal", "-shm"):
                try:
                    sidecar_stat = Path(str(path) + suffix).stat()
                except OSError:
                    sidecar_stat = None
                sidecars.extend((
                    sidecar_stat.st_mtime_ns if sidecar_stat else 0,
                    sidecar_stat.st_size if sidecar_stat else 0,
                    getattr(sidecar_stat, "st_ino", 0) if sidecar_stat else 0,
                ))
            signatures[path.name] = (
                db_stat.st_mtime_ns, db_stat.st_size, getattr(db_stat, "st_ino", 0),
                *sidecars,
            )
        return signatures

    def scan_once(self) -> int:
        storage = locate_storage(self.storage_dir)
        if storage is None:
            detail = "" if self.storage_dir else "\n" + storage_unavailable_hint()
            raise RuntimeError("未找到微信本地数据库目录" + detail)
        started = time.monotonic()
        current_signatures = self._file_signatures(storage)
        if not current_signatures:
            raise RuntimeError("未找到微信消息数据库分片")
        changed = [storage / "message" / name for name, signature in current_signatures.items()
                   if self._signatures.get(name) != signature]
        removed = set(self._signatures) - set(current_signatures)
        for name in removed:
            self._rowids.pop(name, None)
        if not changed:
            self._set_scan_stage("数据库未变化，跳过")
            self.logger.info("微信本地库无变化，跳过解密和消息扫描。")
            return 0
        for path in changed:
            previous, current = self._signatures.get(path.name), current_signatures[path.name]
            if previous and (current[1] < previous[1] or current[2] != previous[2]):
                self._rowids.pop(path.name, None)
                self.logger.info("微信消息分片已重置，回退为时间范围扫描：%s", path.name)
        if self._key is None:
            self._set_scan_stage("正在连接本机微信数据库")
            checked_key = resolve_key(storage, None, self.logger, progress=self._set_scan_stage)
            if checked_key is not None:
                # Preserve the configured account key for databases with different salts.
                self._key = (manual_key() if reader_platform() == "macos" else None) or checked_key
        if self._key is None:
            raise RuntimeError("无法读取微信数据库，请检查授权配置")
        self._set_scan_stage("读取微信会话名")
        names = _safe_group_names(storage, self._key, self.logger)
        rowid_updates: dict[str, dict[str, int]] = {}
        since_by_db = {path.name: self._rowids.get(path.name, {}) for path in changed}
        rowid_fallback = False

        def report_progress(stage: str) -> None:
            nonlocal rowid_fallback
            if "无法按 rowid 增量定位" in stage:
                rowid_fallback = True
            self._set_scan_stage(stage)

        self._set_scan_stage(f"解密微信消息分片（{len(changed)} 个有变化）")
        failed_shards: list[str] = []
        if self._scan_baseline is None:
            self._scan_baseline = self._since
        # 新分片和新会话没有 rowid 游标，重扫本次运行以来的消息由入库去重兜底。
        # 已读分片的最新时间不能截断其他分片在故障期间积累的消息。
        records = fetch_messages(
            storage, self.groups, key=self._key, since_ts=self._scan_baseline, logger=self.logger,
            db_paths=changed, since_rowids=since_by_db, rowid_updates=rowid_updates,
            progress=report_progress, names=names, failed_shards=failed_shards,
        )
        if self._file_signatures(storage) != current_signatures:
            raise RuntimeError("微信数据库扫描期间发生变化，将在下轮重新读取")
        delivered = 0
        newest = self._since
        delivery_failed = False
        for record in records:
            if self.on_message is not None:
                try:
                    self.on_message(record)
                except Exception as exc:
                    delivery_failed = True
                    self.logger.error("on_message 回调异常：%s", exc)
            delivered += 1
            newest = max(newest, int(record.get("ts") or 0))
        if delivery_failed:
            raise RuntimeError("微信消息交付失败，将在下轮重试")
        self._rowids.update(rowid_updates)
        if not rowid_fallback:
            # 失败分片的签名留在原地，下一轮仍判为「有变化」，重试同一批分片。
            merged = dict(self._signatures)
            for name, signature in current_signatures.items():
                if name not in failed_shards:
                    merged[name] = signature
            self._signatures = merged
            if failed_shards:
                self.logger.warning(
                    "微信分片解密失败，签名不推进、下轮重试：%s", "、".join(failed_shards)
                )
        else:
            self.logger.warning("微信消息表无法按 rowid 增量定位，保留全量扫描以避免漏消息。")
        if records:
            self._since = newest
        self.logger.info("微信本地库扫描结束：%d 条消息，耗时 %.1f 秒", delivered, time.monotonic() - started)
        return delivered


# --------------------------------------------------------------------------
