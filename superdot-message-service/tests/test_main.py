"""SuperDot 命令行入口与诊断包测试。"""

from __future__ import annotations

import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import main as cli


class ProductCommandsTest(unittest.TestCase):
    def test_the_cli_lists_the_superdot_operations(self) -> None:
        help_text = cli.build_parser().format_help()
        self.assertIn("{run,tick,stats,catchup,doctor,send-test,attach-test}", help_text)
        self.assertNotIn("import-existing", help_text)


class DoctorBundleCliTest(unittest.TestCase):
    def test_plain_doctor_does_not_bundle(self) -> None:
        args = cli.build_parser().parse_args(["doctor"])
        self.assertIsNone(args.bundle)
        self.assertIs(cli.build_parser().parse_args(["doctor", "--bundle"]).bundle, "")

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="nh-main-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        (self.root / "data").mkdir()
        (self.root / "logs").mkdir()
        self.env_file = self.root / ".env"
        self.env_file.write_text(
            f"QQ_DIGEST_DATA_DIR={self.root / 'data'}\n"
            f"QQ_DIGEST_LOG_DIR={self.root / 'logs'}\n"
            "QQ_BOT_SECRET=supersecretvalue\n",
            encoding="utf-8",
        )

    def test_doctor_bundle_writes_zip_and_prints_absolute_path(self) -> None:
        out = self.root / "out"
        # 不碰真实进程/端口：托管探测在测试里打桩。
        patches = (
            mock.patch("noticehub.remote.hosting.user_qq_pids", return_value=[]),
            mock.patch("noticehub.remote.hosting.user_qq_path", return_value=None),
            mock.patch("noticehub.remote.hosting._port_open", return_value=False),
        )
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

        with mock.patch("builtins.print") as printed:
            code = cli.main(["--env", str(self.env_file), "doctor", "--bundle", str(out)])

        self.assertEqual(code, 0)
        text = "\n".join(str(call.args[0]) for call in printed.call_args_list if call.args)
        bundles = list(out.glob("*.zip"))
        self.assertEqual(len(bundles), 1, text)
        self.assertIn(str(bundles[0].resolve()), text)
        with zipfile.ZipFile(bundles[0]) as archive:
            names = archive.namelist()
            self.assertIn("napcat.txt", names)
            self.assertNotIn("supersecretvalue", archive.read("env.sanitized.txt").decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
