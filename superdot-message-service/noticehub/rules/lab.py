"""旧规则文件接口，供当前粗筛设置读取和保存。"""

from __future__ import annotations

import importlib
import importlib.util
import logging
from typing import Any

LOGGER = logging.getLogger(__name__)

__all__ = [
    "list_rules",
    "save_rules",
]

# 功能名 -> 模块全名。三个模块都已定稿落地（rules.py 自 beta.13 起接线，
# load_rules/save_rules 负责 data/rules.json 的读写）。
_LAB_MODULES: dict[str, str] = {
    "rules": "noticehub.rules.user_rules",
}


def _module_ready(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False



def _run(settings: Any, name: str, func_name: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
    if name not in _LAB_MODULES:
        return {"ok": False, "error": "未知实验功能"}
    # 只在启用粗筛规则时允许读取或编辑旧规则。
    if name == "rules" and not settings.lab_rules:
        return {"ok": False, "error": "自动整理规则已关闭"}
    module_name = _LAB_MODULES[name]
    if not _module_ready(module_name):
        return {"ok": False, "error": "该实验功能尚未就绪"}
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:  # noqa: BLE001 - 模块没落地就是「尚未就绪」
        return {"ok": False, "error": f"该实验功能尚未就绪：{type(exc).__name__}: {exc}"}
    func = getattr(module, func_name, None)
    if not callable(func):
        return {"ok": False, "error": f"该实验功能尚未就绪：模块里没有 {func_name}"}
    try:
        return {"ok": True, "result": func(*args, **kwargs)}
    except Exception as exc:  # noqa: BLE001 - 门面兜底，任何底层异常都不外抛
        # 模块在、函数在，失败就是这次调用真出错：原样带上异常类型，别把真实原因
        # 抹成「尚未就绪」，否则用户和日志都查不出到底哪一步坏了。
        LOGGER.exception("实验功能 %s 执行失败", name)
        return {"ok": False, "error": f"实验功能 {name} 执行失败：{type(exc).__name__}: {exc}"}




def list_rules(settings: Any) -> dict[str, Any]:
    return _run(settings, "rules", "load_rules", settings)


def save_rules(settings: Any, rules: Any) -> dict[str, Any]:
    return _run(settings, "rules", "save_rules", settings, rules)
