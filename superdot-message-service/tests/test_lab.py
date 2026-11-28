from __future__ import annotations

import importlib.machinery
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from noticehub.rules import lab# noqa: E402
from noticehub.platform.config import Settings  # noqa: E402

def _settings() -> Settings:
    return Settings()


def _inject_module(full_name: str, **attrs: object) -> None:
    """用假模块占住 sys.modules，验证门面正常转发（mock.patch.dict 保证还原）。

    必须带 ``__spec__``：find_spec 对 sys.modules 里没有 __spec__ 的模块
    会抛 ValueError，门面会把它误判成「模块尚未就绪」。
    """
    module = types.ModuleType(full_name)
    module.__spec__ = importlib.machinery.ModuleSpec(full_name, None)
    for key, value in attrs.items():
        setattr(module, key, value)
    # 不在这里 start()：调用方一律 ``with _inject_module(...)`` 使用，
    # with 的 __enter__ 会再 start 一次，二次 start 会把假模块当成「原始值」
    # 快照，stop() 恢复出来的就是假模块而不是真模块（全量跑时污染 sys.modules）。
    return mock.patch.dict(sys.modules, {full_name: module})



class LabEntryTest(unittest.TestCase):
    def test_rules_switch_off_is_rejected(self) -> None:
        # 只剩自动整理规则一个开关：关着时读写入口都拒绝，文案对齐「已关闭」。
        settings = Settings(lab_rules=False)
        for call in (
            lambda: lab.list_rules(settings),
            lambda: lab.save_rules(settings, []),
        ):
            self.assertEqual(call(), {"ok": False, "error": "自动整理规则已关闭"})

    def test_module_missing_degrades_gracefully(self) -> None:
        # 不依赖外部文件状态：mock find_spec 为 None 模拟模块缺失。
        with mock.patch.object(lab.importlib.util, "find_spec", return_value=None):
            result = lab.list_rules(_settings())
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "该实验功能尚未就绪")

    def test_list_rules_forwards_settings_and_returns_result(self) -> None:
        sentinel = {"rules": [{"id": "a"}], "count": 1, "path": "/tmp/rules.json"}
        captured: dict[str, object] = {}

        def fake_load(settings: object) -> dict:
            captured["settings"] = settings
            return sentinel

        settings = _settings()
        with _inject_module("noticehub.rules.user_rules", load_rules=fake_load):
            result = lab.list_rules(settings)
        self.assertEqual(result, {"ok": True, "result": sentinel})
        self.assertIs(captured["settings"], settings)

    def test_save_rules_forwards_items_and_returns_result(self) -> None:
        sentinel = {"ok": True, "count": 2, "path": "/tmp/rules.json"}
        captured: dict[str, object] = {}

        def fake_save(settings: object, items: object) -> dict:
            captured["settings"] = settings
            captured["items"] = items
            return sentinel

        items = [{"id": "a"}, {"id": "b"}]
        with _inject_module("noticehub.rules.user_rules", save_rules=fake_save):
            result = lab.save_rules(_settings(), items)
        self.assertEqual(result, {"ok": True, "result": sentinel})
        self.assertEqual(captured["items"], items)

    def test_real_rules_module_is_ready(self) -> None:
        # rules.py 已定稿：实际规则模块可以读取。
        self.assertTrue(lab.list_rules(_settings())["ok"])

    def test_broken_module_import_is_wrapped(self) -> None:
        # 模块 find_spec 认为存在，但 import 时抛错（比如语法坏了）。
        with mock.patch.object(
            lab.importlib.util, "find_spec", return_value=object()
        ), mock.patch.object(
            lab.importlib,
            "import_module",
            side_effect=SyntaxError("坏模块"),
        ):
            result = lab.list_rules(_settings())
        self.assertFalse(result["ok"])
        self.assertIn("尚未就绪", result["error"])

    def test_missing_attribute_degrades_gracefully(self) -> None:
        # 真名但模块里没有这个函数也走优雅降级而不是 AttributeError。
        with _inject_module("noticehub.rules.user_rules"):
            result = lab.list_rules(_settings())
        self.assertFalse(result["ok"])
        self.assertIn("尚未就绪", result["error"])
        self.assertIn("模块里没有 load_rules", result["error"])


class LabPurityTest(unittest.TestCase):
    def test_no_io_no_global_state_in_source(self) -> None:
        source = Path(lab.__file__).read_text(encoding="utf-8")
        for banned in ("open(", "requests.", "urllib", "socket", "sqlite3"):
            self.assertNotIn(banned, source)
        self.assertNotIn("LAB_STATE", source)  # 没有模块级可变状态


if __name__ == "__main__":
    unittest.main()
