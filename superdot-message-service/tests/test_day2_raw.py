from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from noticehub.storage.raw_downloads import ask_download_file
from noticehub.runtime.service import DigestService
from noticehub.storage.attachment_files import AttachmentHTTPError
from noticehub.storage.sqlite.store import Store
from noticehub.platform.config import Settings


class RawRecordsTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.store = Store(self.directory / "messages.sqlite3")
        self.settings = Settings(data_dir=self.directory, group_whitelist=("12345",))

    def test_package_read_returns_source_text_and_attachment_after_prune(self):
        self.store.save_package_rule({"group_ids": ["12345"]})
        service = DigestService(self.settings, store=self.store, pushers=[])
        payload = {
            "post_type": "message", "message_type": "group", "group_id": 12345,
            "self_id": 83001, "user_id": 24681, "message_id": 99,
            "sender": {"role": "owner", "nickname": "群主"},
            "message": [
                {"type": "reply", "data": {"id": "98"}},
                {"type": "text", "data": {"text": " 按模板填写  "}},
                {"type": "file", "data": {"file_name": "报名表.xlsx", "file_id": "upload-1", "busid": "4"}},
            ],
        }
        with patch.object(service.receiver, "on_attachment") as auto_download:
            status, body = service.receiver.handle_payload(payload)
        self.assertEqual((status, body["inserted"]), (200, True))
        auto_download.assert_not_called()
        self.store.seal_message_packages(dt.datetime.now() + dt.timedelta(minutes=10))
        package, = self.store.list_message_packages()
        package_id = package["package_id"]
        before = self.store.read_package(package_id)
        self.assertEqual(before["code"], "OK")
        text, file = before["records"]
        self.assertIsNotNone(dt.datetime.fromisoformat(text["sent_at"]).utcoffset())
        self.assertEqual(
            (text["source"], text["account_id"], text["conversation_id"], text["message_id"],
             text["reply_to_message_id"], text["content"]),
            ("qq", "83001", "12345", "99", "98", " 按模板填写  "),
        )
        self.assertEqual((file["type"], file["content"], file["download_state"]),
                         ("file", "报名表.xlsx", "NOT_DOWNLOADED"))
        self.assertNotEqual(file["ref"], text["ref"])
        self.assertEqual(self.store.prune(retention_days=-1), 1)
        reopened = Store(self.store.path)
        self.assertEqual(reopened.read_package(package_id), before)
        ids = [text["ref"]["id"], "missing", file["ref"]["id"], text["ref"]["id"]]
        self.assertEqual([record["package_role"] for record in before["records"]], ["trigger", "trigger"])
        raw_records = [{k: v for k, v in record.items() if k != "package_role"} for record in before["records"]]
        self.assertEqual(reopened.read_raw_in_batch(ids),
                         {"code": "OK", "records": raw_records, "missing_refs": [{"id": "missing"}]})
        self.assertEqual(reopened.read_package("unknown"), {"code": "REF_NOT_FOUND"})
        self.assertEqual(reopened.read_raw_in_batch([" "]), {"code": "INVALID_INPUT"})

    def test_download_requires_permission_and_reuses_committed_copy(self):
        self._source_file("file")
        client = Mock(return_value={"data": {"url": "https://example.test/file"}})
        with patch("noticehub.storage.raw_downloads.download", side_effect=self._write_copy) as fetch:
            self.assertEqual(self._download("file", False, client), {"code": "AUTHORIZATION_REQUIRED"})
            client.assert_not_called()
            fetch.assert_not_called()
            path = self._download("file", True, client)
            duplicate = self._download("file", False, client)
        client.assert_called_once_with("get_group_file_url", {"group_id": "12345", "file_id": "qq-1", "busid": 4})
        fetch.assert_called_once()
        self.assertEqual(path, duplicate)
        self.assertEqual(Path(path).read_bytes(), b"example file")
        self.assertEqual(self.store.read_raw_in_batch(["file"])["records"][0]["download_state"], "DOWNLOADED")

    def test_downloader_keeps_temporary_failures_retryable_and_records_expired_file(self):
        self._source_file("file")
        client = Mock(return_value={"data": {"url": "https://example.test/file"}})
        with patch("noticehub.storage.raw_downloads.download",
                   side_effect=[AttachmentHTTPError(502), AttachmentHTTPError(410)]) as fetch:
            self.assertEqual(self._download("file", True, client), {"code": "STORE_UNAVAILABLE"})
            self.assertEqual(self.store.read_raw_in_batch(["file"])["records"][0]["download_state"], "NOT_DOWNLOADED")
            self.assertEqual(self._download("file", True, client), {"code": "CONFLICT"})
            self.assertEqual(self._download("file", True, client), {"code": "CONFLICT"})
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(self.store.read_raw_in_batch(["file"])["records"][0]["download_state"], "UNAVAILABLE")

    def _source_file(self, key):
        self.store.insert_message(
            msg_id=key, group_id="12345", account_id="83001", sender_id="24681",
            content="[文件]名单.xlsx", source="onebot", message_kind="file",
            raw_metadata={"text": "", "files": [
                {"name": "名单.xlsx", "kind": "file", "file_id": "qq-1", "busid": "4"},
            ]},
        )

    def _download(self, raw_id, authorized, client):
        return ask_download_file(
            self.store, raw_id, authorized=authorized, settings=self.settings, napcat_call=client,
        )

    @staticmethod
    def _write_copy(url, path, max_bytes, timeout):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"example file")
        return path
