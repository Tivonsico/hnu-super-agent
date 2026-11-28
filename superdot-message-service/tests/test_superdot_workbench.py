from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
import logging
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from noticehub.receivers.ingest import accept_message
from noticehub.domain.message import MessageEvent
from noticehub.work_orders.preview import WorkOrderConflict, change_work_order, list_work_orders
from noticehub.storage.sqlite.store import Store
from noticehub.receivers import wechat_receiver
from noticehub.work_orders.from_message import promote


class WorkbenchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "orders.sqlite3")
        self.now = datetime(2026, 11, 22, 14, 15)
        self.store.insert_message(
            msg_id="sample:qq", source="onebot", group_id="course", group_name="实验课",
            content="请提交报告。", inbox_mark=("rule", "实验提交", {}),
        )
        self.order_id = promote(None, self.store, "sample:qq", due="2026-11-22T16:30")["task_id"]

    def action(self, action, revision, *, worker=False, **fields):
        return change_work_order(
            self.store, dict(fields, action=action, id=self.order_id, revision=revision),
            self.now, worker=worker,
        )

    def test_inbox_promotion_uses_existing_order_and_original_message(self):
        self.assertEqual(promote(None, self.store, "sample:qq")["task_id"], self.order_id)
        board = list_work_orders(self.store, self.now)
        self.assertEqual(board["today"], "2026-11-22")
        self.assertEqual(len(board["orders"]), 1)
        order = board["orders"][0]
        self.assertEqual(order["source_text"], "请提交报告。")
        self.assertEqual(order["source"], "onebot")
        self.assertEqual(order["source_message_id"], "sample:qq")
        self.assertEqual(order["source_conversation_name"], "实验课")
        named = list_work_orders(self.store, self.now, {"course": "课程群"})
        self.assertEqual(named["orders"][0]["source_conversation_name"], "课程群")
        self.assertEqual(order["deadline"], "2026-11-22T16:30")
        self.assertEqual(order["state"], "queued")

    def test_worker_checkpoint_and_completion(self):
        started = self.action("claim", 0, worker=True)
        self.assertEqual(started["state"], "running")
        with self.assertRaises(ValueError):
            self.action("complete", 1)
        blocked = self.action("request_approval", 1, worker=True, note="确认收件人")
        self.assertEqual(blocked["checkpoint"], "确认收件人")
        with self.assertRaises(WorkOrderConflict):
            self.action("complete", 1, worker=True)
        with self.assertRaisesRegex(ValueError, "请输入审批提示词"):
            self.action("approve", 2)
        self.assertEqual(self.action("approve", 2, note="发给助教")["state"], "queued")
        self.action("claim", 3, worker=True)
        self.assertEqual(self.action("complete", 4, worker=True, note="草稿已保存")["result"], "草稿已保存")

    def test_worker_gets_the_freeform_instruction_after_claiming_again(self):
        self.action("claim", 0, worker=True)
        blocked = self.action("request_approval", 1, worker=True, note="确认收件人", options=["课程组", "实验助教"])
        self.assertEqual(blocked["approval_options"], ["课程组", "实验助教"])
        self.action("approve", 2, note="抄送实验助教，同时附清单")
        claimed = self.action("claim", 3, worker=True)
        self.assertEqual(claimed["approval_response"], "抄送实验助教，同时附清单")
        blocked_again = self.action("request_approval", 4, worker=True, note="补充附件要求")
        self.assertEqual(blocked_again["approval_options"], [])
        self.assertEqual(blocked_again["approval_response"], "")
        self.action("approve", 5, note="附上报告清单")
        self.assertEqual(self.store.list_work_orders()[0]["approval_response"], "附上报告清单")

    def test_archive_restore_requeues_for_worker_and_rejects_stale_completion(self):
        self.action("claim", 0, worker=True)
        self.action("terminate", 1, note="项目取消")
        with self.assertRaises(WorkOrderConflict):
            self.action("complete", 1, worker=True)
        restored = self.action("restore", 2)
        self.assertEqual((restored["state"], restored["executor"]), ("queued", "ai"))
        self.assertEqual(self.action("ignore", 3)["state"], "ignored")
        self.assertEqual(self.action("restore", 4)["state"], "queued")
        self.action("claim", 5, worker=True)
        self.assertEqual(self.action("complete", 6, worker=True)["state"], "completed")

    def test_only_one_concurrent_worker_can_claim(self):
        def claim():
            try:
                return self.action("claim", 0, worker=True)["state"]
            except WorkOrderConflict:
                return "conflict"

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(claim) for _ in range(2)]
            self.assertCountEqual([result.result() for result in futures], ["running", "conflict"])

    def test_incoming_subscription_routes_hits_once_and_keeps_unmatched_messages_out(self):
        settings = SimpleNamespace(accepts_group=lambda group: group == "course", group_name=lambda group: group)
        service = SimpleNamespace(store=self.store, settings=settings, logger=logging.getLogger("test"))

        def receive(msg_id, group, hit):
            record = {"msg_id": msg_id, "source": "onebot", "group_id": group, "content": "课堂安排"}
            match = ("rule", "实验提交", {}) if hit else None
            with patch("noticehub.receivers.ingest.rule_mark", return_value=match):
                return accept_message(MessageEvent.from_mapping(record), service=service, record=record, now=lambda: self.now)

        self.assertTrue(receive("hit", "course", True))
        self.assertFalse(receive("hit", "course", True))
        self.assertTrue(receive("plain", "course", False))
        self.assertFalse(receive("outside", "other", True))
        self.assertEqual([row["msg_id"] for row in self.store.list_router_inputs()], ["hit"])
        self.assertEqual(self.store.inbox_items(msg_id="hit")[0]["router_decision"], "pending")

        def create(connection):
            return promote(None, self.store, "hit", title="课堂安排", connection=connection)["task_id"]

        args = ("hit", "create", "新事项", None, create, self.now.isoformat())
        ticket = self.store.resolve_router_input(*args)
        self.assertEqual(self.store.resolve_router_input(*args), ticket)
        self.assertEqual(len(self.store.list_work_orders()), 2)
        self.assertEqual(self.store.list_task_events(ticket["task_id"])[0]["event"], "work_order_assign_ai")
        self.assertEqual(self.store.list_router_inputs(), [])

    def test_append_reuses_ticket_and_ignore_creates_no_order(self):
        self.action("claim", 0, worker=True)
        self.action("complete", 1, worker=True, note="已交付")
        for key in ("amend", "noise"):
            self.store.insert_message(
                msg_id=key, group_id="", content=key, source="manual",
                inbox_mark=("manual", "手动添加", {}),
            )
            self.assertEqual(self.store.queue_router_input(key)["decision"], "pending")
        timestamp = self.now.isoformat()
        resolved = self.store.resolve_router_input("amend", "append", "补充要求", self.order_id, None, timestamp)
        self.assertEqual(resolved["task_id"], self.order_id)
        self.assertEqual(self.store.list_work_orders()[0]["state"], "queued")
        self.assertEqual(self.store.list_router_inputs(task_id=self.order_id)[0]["msg_id"], "amend")
        self.store.resolve_router_input("noise", "ignore", "无需执行", None, None, timestamp)
        self.assertEqual(len(self.store.list_work_orders()), 1)
        self.assertEqual(self.store.inbox_items(msg_id="noise")[0]["router_decision"], "ignore")

    def test_new_template_adds_node_to_running_order(self):
        started = self.action("claim", 0, worker=True)
        self.store.insert_message(
            msg_id="template-v2", group_id="course", content="收到新版展示模板\n请按新版模板继续核对材料。",
            source="onebot", inbox_mark=("rule", "模板更新", {}), route_to_router=True,
        )
        args = ("template-v2", "append", "", self.order_id, None, self.now.isoformat())
        self.assertEqual(self.store.resolve_router_input(*args), self.store.resolve_router_input(*args))
        order, = self.store.list_work_orders()
        self.assertEqual(order["id"], self.order_id)
        self.assertEqual(order["state"], "running")
        self.assertEqual(order["revision"], started["revision"] + 1)
        with self.assertRaises(WorkOrderConflict):
            self.action("complete", started["revision"], worker=True)
        event = self.store.list_task_events(self.order_id)[0]
        self.assertEqual(event["event"], "work_order_router_append")
        self.assertEqual(event["detail"], "收到新版展示模板")
        self.assertIn("请按新版模板继续核对材料", self.store.list_router_inputs(task_id=self.order_id)[0]["content"])

    def test_deadline_update_is_persisted(self):
        changed = self.action("set_deadline", 0, deadline="2026-11-23T19:00")
        self.assertEqual(changed["deadline"], "2026-11-23T19:00:00")
        self.assertEqual(self.store.list_work_orders()[0]["deadline"], changed["deadline"])
        self.assertEqual(self.action("set_deadline", 1, deadline="")["deadline"], "")


class BuiltInWeChatTest(unittest.TestCase):
    def test_missing_key_stops_at_configuration(self):
        with patch.object(wechat_receiver, "manual_key", return_value=None):
            with self.assertRaisesRegex(wechat_receiver.WechatScanError, "授权密钥"):
                wechat_receiver.resolve_key(Path("/unused"))

    def test_uses_the_configured_key_for_the_local_database(self):
        key = b"x" * 32
        with (
            patch.object(wechat_receiver, "manual_key", return_value=key),
            patch.object(wechat_receiver, "_key_still_valid", return_value=True),
            patch.object(wechat_receiver, "_cache_key"),
        ):
            self.assertEqual(wechat_receiver.resolve_key(Path("/unused")), key)

    def test_contact_picker_and_reader_accept_direct_conversations(self):
        with tempfile.TemporaryDirectory() as temp:
            db = Path(temp) / "contacts.db"
            with sqlite3.connect(db) as connection:
                connection.execute("CREATE TABLE contact (username TEXT, nick_name TEXT)")
                connection.executemany("INSERT INTO contact VALUES (?,?)", [("friends@chatroom", "朋友群"), ("wxid_demo", "好友")])
                table = wechat_receiver.message_table_name("wxid_demo")
                connection.execute(
                    f"CREATE TABLE {table} (local_id, local_type, real_sender_id, create_time, message_content)"
                )
                connection.execute(f"INSERT INTO {table} VALUES (1,1,1,1700000000,?)", ("确认展示材料",))
            blob = db.read_bytes()
            contacts = wechat_receiver.parse_contact_names(blob, include_direct=True)
            self.assertEqual(contacts, {"friends@chatroom": "朋友群", "wxid_demo": "好友"})
            records = wechat_receiver.read_messages_from_db(blob, ["wxid_demo"], contacts)
            self.assertEqual(records[0]["event"], "C2C_MESSAGE_CREATE")
            self.assertEqual(records[0]["content"], "确认展示材料")
            self.assertEqual(wechat_receiver.read_messages_from_db(blob, ["friends@chatroom"], contacts), [])
