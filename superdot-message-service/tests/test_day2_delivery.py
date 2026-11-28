import json
import sqlite3
import threading
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from noticehub.queue.watchdog import deliver_next_package
from noticehub.runtime.service import DigestService
from noticehub.storage.sqlite.store import Store
from noticehub.platform.config import Settings
from noticehub.web.webapp import TaskWebServer


class PackageDeliveryTest(TestCase):
    def test_frontend_packages_are_listed_and_show_retry_then_acceptance(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "messages.sqlite3"
            stamp = datetime(2026, 11, 23, tzinfo=timezone.utc)
            store = Store(path)
            package_id = store.submit_frontend_package(
                {"kind": "new_task", "operation_id": "manual-1", "text": "整理实验结果"}, stamp,
            )["package_ref"]["id"]
            pet_id = store.submit_frontend_package(
                {"kind": "new_task", "operation_id": "desktop-pet-note:2", "text": "整理便签"}, stamp,
            )["package_ref"]["id"]
            store.record_package_delivery_failure(package_id, "HTTP_503", stamp)
            store.record_package_delivery_failure(package_id, "ACK_MISMATCH", stamp)
            reopened = Store(path)
            queue = reopened.package_delivery_status()
            self.assertEqual(queue["pending_count"], 2)
            self.assertEqual(queue["head"]["package_id"], package_id)
            self.assertEqual(queue["head"]["attempts"], 2)
            self.assertEqual(queue["head"]["last_error"], "ACK_MISMATCH")
            feed = reopened.inbox_feed(source="manual", q="整理", limit=2, offset=0)
            self.assertEqual([(item["package_id"], item["delivery_state"]) for item in feed],
                             [(package_id, "retry_wait"), (pet_id, "queued")])
            self.assertEqual([item["submission_origin"] for item in feed], ["frontend", "pet_note"])
            self.assertEqual(feed[0]["delivery_attempts"], 2)
            self.assertEqual(feed[0]["messages"][0]["content"], "整理实验结果")
            self.assertTrue(reopened.acknowledge_package_delivery(
                package_id, {"code": "REPLAYED", "package_ref": {"id": package_id}}, stamp,
            ))
            self.assertEqual(reopened.package_delivery_status()["head"]["package_id"], pet_id)
            item = reopened.inbox_feed(source="", q="", limit=1, offset=0, package_id=package_id)[0]
            self.assertEqual(item["delivery_state"], "accepted")

    def test_failed_delivery_leaves_other_packages_ready_and_retries_after_reopen(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "messages.sqlite3"
            store = Store(path)
            stamp = datetime(2026, 11, 23, 9)
            first, second = [store.submit_frontend_package(
                {"kind": "new_task", "operation_id": key, "text": key}, stamp,
            )["package_ref"]["id"] for key in ("first", "second")]
            store.record_package_delivery_failure(first, "HTTP_500", stamp)
            reopened = Store(path)
            self.assertEqual(reopened.next_package_delivery(stamp), second)
            self.assertTrue(reopened.acknowledge_package_delivery(
                second, {"code": "OK", "package_ref": {"id": second}}, stamp,
            ))
            self.assertIsNone(reopened.next_package_delivery(stamp))
            self.assertEqual(reopened.next_package_delivery(stamp + timedelta(seconds=5)), first)

    def test_sealed_package_survives_reopen_and_requires_matching_receipt(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "messages.sqlite3"
            store = Store(path)
            stamp = datetime(2026, 11, 23, tzinfo=timezone.utc)
            store.save_package_rule({"group_ids": ["12345"]})
            store.insert_message(
                msg_id="trigger-1", group_id="12345", group_name="课程群", content="实验提交",
                source="onebot", event="GROUP_MESSAGE_CREATE", account_id="83001",
                sender_id="10000", sender_role="admin", received_at=stamp,
            )
            self.assertIsNone(store.next_package_delivery())
            store.seal_message_packages(stamp + timedelta(minutes=5))
            package_id = store.list_message_packages()[0]["package_id"]

            reopened = Store(path)
            self.assertEqual(reopened.next_package_delivery(), package_id)
            self.assertFalse(reopened.acknowledge_package_delivery(
                package_id, {"code": "OK", "package_ref": {"id": "different"}}, stamp,
            ))
            self.assertEqual(reopened.next_package_delivery(), package_id)
            self.assertTrue(reopened.acknowledge_package_delivery(
                package_id, {"code": "REPLAYED", "package_ref": {"id": package_id}}, stamp,
            ))
            self.assertIsNone(Store(path).next_package_delivery())


    def test_opening_an_older_database_does_not_create_a_delivery_for_an_archived_package(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "messages.sqlite3"
            stamp = datetime(2026, 11, 23, tzinfo=timezone.utc)
            store = Store(path)
            store.save_package_rule({"group_ids": ["12345"]})
            store.insert_message(
                msg_id="archived", group_id="12345", content="旧通知",
                source="onebot", event="GROUP_MESSAGE_CREATE", account_id="83001",
                sender_role="admin", received_at=stamp,
            )
            store.seal_message_packages(stamp + timedelta(minutes=5))
            package_id = store.next_package_delivery()
            with sqlite3.connect(path) as connection:
                connection.execute("DROP TABLE package_delivery")

            reopened = Store(path)
            self.assertIsNone(reopened.next_package_delivery())
            self.assertEqual(reopened.read_package(package_id)["records"][0]["content"], "旧通知")
            self.assertIsNone(reopened.inbox_feed(source="", q="", limit=1, offset=0)[0]["delivery_state"])


class Day2HttpTest(TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "digest.sqlite3")
        self.received = []
        self.replayed = threading.Event()
        self.tickets = {}
        test = self

        class ExecutionFixture(BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.assert_authorized()
                if self.path == "/api/router/notify":
                    ref = payload["package_ref"]
                    test.received.append(ref)
                    if ref["id"] not in test.tickets:
                        status, original = test.request("/api/packages/" + ref["id"])
                        test.assertEqual(status, 200)
                        ticket = {
                            "ticket_id": "B", "title": original["records"][0]["content"],
                            "description": {"text": "实验报告", "visible": 1},
                            "package_refs": [ref], "note_refs": [],
                            "nodes": [{"node_id": "B/1", "kind": "result", "text": "报告已生成",
                                       "refs": [{"kind": "package", "id": ref["id"]},
                                                {"kind": "artifact", "id": "B/报告.txt"}]}],
                        }
                        test.tickets[ref["id"]] = ticket
                        self.close_connection = True  # 已接管，但调用方没有收到回执
                        return
                    self.respond(200, {"code": "REPLAYED", "package_ref": ref})
                    test.replayed.set()
                else:
                    self.respond(202, {"code": "ACCEPTED", "operation_id": payload["operation_id"],
                                       "ticket_id": payload["ticket_id"]})

            def do_GET(self):
                self.assert_authorized()
                if self.path == "/api/notifications?state=pending":
                    self.respond(200, {"code": "OK", "items": [{"id": "notice-1"}]})
                else:
                    self.respond(200, {"code": "OK", "ticket": next(iter(test.tickets.values()))})

            def assert_authorized(self):
                test.assertEqual(self.headers.get("Authorization"), "Bearer execution-secret")
                test.assertIsNone(self.headers.get("X-Token"))

            def respond(self, status, payload):
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        host = ThreadingHTTPServer(("127.0.0.1", 0), ExecutionFixture)
        runner = threading.Thread(target=host.serve_forever, daemon=True)
        runner.start()
        self.addCleanup(host.server_close)
        self.addCleanup(host.shutdown)
        self.web = TaskWebServer(
            Settings(
                web_host="127.0.0.1", web_port=0, web_token="web-secret", data_dir=Path(directory.name),
                execution_url="http://127.0.0.1:" + str(host.server_address[1]),
                execution_token="execution-secret", execution_data_root=directory.name,
            ),
            self.store,
        )
        self.assertTrue(self.web.start())
        self.addCleanup(self.web.stop)
        self.base_url = "http://127.0.0.1:" + str(self.web.server.server_address[1])

    def request(self, path, payload=None, *, authenticated=True, extra_headers=None):
        headers = {"X-Token": "web-secret"} if authenticated else {}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        headers.update(extra_headers or {})
        data = None if payload is None else json.dumps(payload).encode()
        request = Request(self.base_url + path, data=data, headers=headers)
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_lost_ack_replays_then_published_ticket_points_to_the_same_package(self):
        task = {"kind": "new_task", "operation_id": "op-1", "text": " 请整理实验报告 "}
        self.assertEqual(self.request("/api/packages", task, extra_headers={"Content-Type": "text/plain"})[0], 400)
        self.assertEqual(self.request("/api/packages", task, extra_headers={"Origin": "https://example.test"})[0], 400)
        self.assertEqual(self.request("/api/raw/batch", {"raw_ids": [], "extra": True})[0], 400)
        status, first = self.request("/api/packages", task)
        self.assertEqual((status, first["code"]), (202, "QUEUED"))
        package_id = first["package_ref"]["id"]
        self.assertEqual(self.request("/api/packages", task), (200, {**first, "code": "REPLAYED"}))
        self.assertEqual(self.request("/api/packages", {**task, "text": "别的内容"})[0], 409)
        self.assertEqual(self.request("/api/packages/" + package_id, authenticated=False)[0], 401)

        self.assertEqual(deliver_next_package(self.store, self.web.execution), "ACK_UNKNOWN")
        later = datetime.now() + timedelta(seconds=10)
        with patch("noticehub.queue.watchdog.now_local", return_value=later):
            self.assertEqual(deliver_next_package(Store(self.store.path), self.web.execution), "ACCEPTED")
        self.assertIsNone(self.store.next_package_delivery())
        self.assertEqual(self.received, [first["package_ref"], first["package_ref"]])
        self.assertEqual(len(self.tickets), 1)

        status, detail = self.request("/api/tickets/B")
        self.assertEqual(status, 200)
        self.assertEqual(detail["source_conversation"], {"source": "frontend", "id": "", "name": ""})
        self.assertEqual(detail["available_package_ids"], [package_id])
        refs = detail["ticket"]["nodes"][0]["refs"]
        status, original = self.request("/api/packages/" + refs[0]["id"])
        self.assertEqual(status, 200)
        self.assertEqual(original["records"][0]["content"], task["text"])
        status, inbox = self.request("/api/inbox?feed=packages&package_id=" + quote(package_id))
        self.assertEqual(status, 200)
        self.assertEqual(len(inbox["items"]), 1)
        entry = inbox["items"][0]
        self.assertEqual(entry["package_id"], package_id)
        self.assertEqual([(message["msg_id"], message["content"]) for message in entry["messages"]],
                         [(entry["trigger_msg_id"], task["text"])])
        self.assertEqual(self.request("/api/notifications?state=pending")[1]["items"], [{"id": "notice-1"}])
        self.assertEqual(self.request("/api/tickets/actions", {
            "operation": "supplement", "operation_id": "keep-original", "ticket_id": "B", "text": "修改",
        }), (202, {"code": "ACCEPTED", "operation_id": "keep-original", "ticket_id": "B"}))

    def test_service_starts_its_watchdog_and_retries_without_a_manual_tick(self):
        task = {"kind": "new_task", "operation_id": "ll-1", "text": "自动交接任务"}
        status, submitted = self.request("/api/packages", task)
        self.assertEqual(status, 202)
        settings = replace(
            self.web.settings, web_enabled=False, onebot_enabled=False, attachments_enabled=False,
            catchup_enabled=False, wechat_enabled=False, chaoxing_enabled=False, dingtalk_enabled=False,
            log_dir=self.store.path.parent,
        )
        service = DigestService(settings, store=self.store, pushers=[])
        with patch("noticehub.queue.watchdog.POLL_SECONDS", 0.05):
            service.start(start_bot=False)
            try:
                self.assertTrue(self.replayed.wait(8))
            finally:
                service.stop()
        self.assertEqual(self.received, [submitted["package_ref"], submitted["package_ref"]])
        self.assertIsNone(self.store.next_package_delivery())

    def test_only_a_published_result_reference_can_open_the_shared_file(self):
        folder = self.store.path.parent / "artifacts" / "B"
        folder.mkdir(parents=True)
        (folder / "报告.txt").write_bytes(b"published")
        (folder / "other.txt").write_bytes(b"unpublished")
        self.tickets["pkg"] = {
            "ticket_id": "B", "nodes": [
                {"kind": "result", "refs": [{"kind": "artifact", "id": "B/报告.txt"}]},
            ],
        }
        path = "/api/artifacts/B/" + quote("报告.txt", safe="")
        with urlopen(Request(self.base_url + path, headers={"X-Token": "web-secret"}), timeout=3) as response:
            self.assertEqual(response.read(), b"published")
            self.assertIn("attachment", response.headers["Content-Disposition"])
        self.assertEqual(self.request(path, authenticated=False)[0], 401)
        self.assertEqual(self.request("/api/artifacts/B/other.txt")[0], 404)
        self.assertEqual(self.request("/api/artifacts/B/%2e%2e%2Fsecret")[0], 400)

    def test_tokenless_loopback_rejects_an_unrecognized_host_header(self):
        self.web.server.token = ""
        task = {"kind": "new_task", "operation_id": "local-op", "text": "实验任务"}
        self.assertEqual(self.request(
            "/api/packages", task, authenticated=False, extra_headers={"Host": "example.test"},
        ), (403, {"code": "INVALID_HOST"}))
        self.assertIsNone(self.store.next_package_delivery())
        self.assertEqual(self.request("/api/packages", task, authenticated=False)[0], 202)

    def test_reminder_preferences_are_authenticated_validated_and_persisted(self):
        path = "/api/settings/reminders"
        self.assertEqual(self.request(path, authenticated=False)[0], 401)
        self.assertEqual(self.request(path)[1]["preferences"],
                         {"action": True, "result": True, "problem": True})
        values = {"action": True, "result": False, "problem": False}
        self.assertEqual(self.request(path, values), (200, {"code": "OK", "preferences": values}))
        self.assertEqual(self.request(path, {**values, "action": "off"})[0], 400)
        self.assertEqual(self.request(path)[1]["preferences"], values)
        self.assertEqual(json.loads(Store(self.store.path).meta_get("web_reminder_preferences")), values)

    def test_attachment_reference_and_download_require_execution_identity(self):
        file = {"filename": "实验.txt", "operation_id": "up-1", "content_base64": "aGVsbG8="}
        status, result = self.request("/api/raw/attachments", file)
        self.assertEqual(status, 201)
        ref = result["ref"]
        self.assertEqual(self.request("/api/raw/attachments", file), (200, {"code": "REPLAYED", "ref": ref}))
        self.assertEqual(self.request("/api/raw/attachments", {**file, "filename": "../other"})[0], 400)
        self.assertEqual(self.request("/api/raw/attachments", {**file, "content_base64": "b3RoZXI="})[0], 409)
        request = {"raw_id": ref["id"], "authorized": True}
        self.assertEqual(self.request("/api/raw/download", request)[0], 403)
        status, downloaded = self.request(
            "/api/raw/download", request, extra_headers={"Authorization": "Bearer execution-secret"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(Path(downloaded["file_path"]).read_bytes(), b"hello")
        status, task = self.request("/api/packages", {
            "kind": "new_task", "operation_id": "task-1", "attachment_refs": [ref],
        })
        self.assertEqual(status, 202)
        status, original = self.request("/api/packages/" + task["package_ref"]["id"])
        self.assertEqual(status, 200)
        self.assertEqual(original["records"][0]["package_role"], "trigger")
        self.assertEqual((original["records"][0]["ref"], original["records"][0]["download_state"]),
                         (ref, "DOWNLOADED"))
