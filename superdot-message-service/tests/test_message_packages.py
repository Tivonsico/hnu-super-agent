from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path

from noticehub.receivers.qq.onebot import onebot_record, parse_onebot_message
from noticehub.runtime.service import DigestService
from noticehub.storage.sqlite.store import Store
from noticehub.platform.config import Settings


class MessagePackageTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "messages.sqlite3"
        self.store = Store(self.path)
        self.start = dt.datetime(2026, 11, 22, 18, 0)

    def at(self, seconds):
        return self.start + dt.timedelta(seconds=seconds)

    def message(self, msg_id, seconds, role="member", kind="text", account="83001", text="实验安排"):
        return self.store.insert_message(
            msg_id=msg_id, group_id="12345", group_name="课程群", content=text,
            source="onebot", event="GROUP_MESSAGE_CREATE", received_at=self.at(seconds),
            sender_id="24680" if role == "member" else "24681", sender_role=role,
            message_kind=kind, account_id=account, route_to_router=True,
            inbox_mark=("rule", "实验", {}),
        )

    def test_qq_live_subscription_replaces_old_secondary_group_selection(self):
        settings = Settings(group_whitelist=("23456",), data_dir=self.path.parent)
        self.store.save_package_rule({"group_ids": ["12345"], "keywords": ["作业"]})
        service = DigestService(settings, store=self.store, pushers=[])
        message = dict(source="onebot", event="GROUP_MESSAGE_CREATE", account_id="83001",
                       sender_id="24681", sender_role="admin", content="作业", received_at=self.at(0))
        self.assertFalse(service.on_message(dict(message, group_id="12345", msg_id="unsubscribed")))
        self.assertTrue(service.on_message(dict(message, group_id="23456", msg_id="new-group")))
        settings.group_whitelist = ()
        self.assertFalse(service.on_message(dict(message, group_id="23456", msg_id="removed")))
        self.assertEqual(self.store.seal_message_packages(self.at(301)), 1)
        self.assertEqual(self.store.list_message_packages()[0]["messages"][0]["msg_id"], "new-group")

    def test_first_subscriptions_package_by_default_and_persist_pause(self):
        settings = Settings(data_dir=self.path.parent)
        service = DigestService(settings, store=self.store, pushers=[])
        sources = ("wechat", "dingtalk", "chaoxing")
        for source in sources:
            setattr(settings, source + "_enabled", True)
            setattr(settings, source + "_group_whitelist", ("course",))
            msg = dict(source=source, content="交作业", received_at=self.at(0))
            self.assertFalse(service.on_message(dict(msg, msg_id=source + "-other", group_id="other")))
            self.assertTrue(service.on_message(dict(msg, msg_id=source, group_id="course")))
        self.assertEqual(self.store.seal_message_packages(self.at(301)), 3)
        rules = self.store.get_screening()
        rules["channels"]["wechat"]["enabled"] = False
        self.store.save_screening(rules)
        self.assertFalse(Store(self.path).get_screening()["channels"]["wechat"]["enabled"])
        self.assertTrue(service.on_message(dict(source="wechat", content="交作业", msg_id="paused",
                                                group_id="course", received_at=self.at(302))))
        self.assertEqual(self.store.seal_message_packages(self.at(604)), 0)

    def test_default_values_are_adjustable_without_enabling_other_groups(self):
        defaults = self.store.get_package_rule()
        self.assertEqual(defaults["group_ids"], [])
        self.assertEqual([defaults[key] for key in (
            "lookback_minutes", "lookback_count", "collect_minutes", "quiet_minutes", "max_minutes"
        )], [120, 10, 5, 1, 20])
        self.store.save_package_rule({"quiet_minutes": 2, "group_ids": ["12345"]})
        reopened = Store(self.path)
        self.assertEqual(reopened.get_package_rule()["quiet_minutes"], 2)
        with self.assertRaises(ValueError):
            reopened.save_package_rule({"quiet_minutes": 6, "collect_minutes": 5})

    def test_channel_keywords_respect_inheritance_and_keep_same_id_conversations_separate(self):
        self.store.save_package_rule({"group_ids": ["12345"], "keywords": ["实验"]})
        self.store.save_screening({
            "keywords": ["作业"],
            "channels": {
                "qq": {"inherit": False},
                "wechat": {"enabled": True},
                "dingtalk": {"enabled": True, "inherit": False, "keywords": ["会议"], "senders": ["班长"]},
            },
        })
        self.message("qq", 2, "admin", text="实验通知")
        for source, msg_id, text, sender in (
            ("wechat", "wx-miss", "闲聊", "同学"), ("wechat", "wx-hit", "作业通知", "同学"),
            ("dingtalk", "dt-sender-miss", "会议通知", "同学"),
            ("dingtalk", "dt-keyword-miss", "作业通知", "班长"), ("dingtalk", "dt-hit", "会议通知", "班长"),
            ("chaoxing", "cx-disabled", "作业通知", "老师"),
        ):
            self.store.insert_message(
                msg_id=msg_id, source=source, group_id="12345", account_id="83001",
                content=text, sender_name=sender, received_at=self.at(2), route_to_router=True,
            )
        self.assertEqual(self.store.seal_message_packages(self.at(302)), 3)
        for source, message_id in (("qq", "qq"), ("wechat", "wx-hit"), ("dingtalk", "dt-hit")):
            entries = self.store.inbox_feed(source=source, q="", limit=10, offset=0)
            self.assertEqual([entry["trigger_msg_id"] for entry in entries], [message_id])
            package_id = entries[0]["package_id"]
            self.assertEqual({record["source"] for record in self.store.read_package(package_id)["records"]}, {source})
        self.assertEqual(self.store.inbox_feed(source="chaoxing", q="", limit=10, offset=0), [])

    def test_subscribed_private_qq_uses_the_common_rule_only_after_opt_in(self):
        self.store.insert_message(
            msg_id="private-legacy", source="onebot", event="PRIVATE_MESSAGE_CREATE",
            group_id="private:24680", account_id="83001", sender_id="24680", content="作业通知",
            received_at=self.at(0), route_to_router=True,
        )
        self.assertEqual(self.store.seal_message_packages(self.at(601)), 0)
        self.store.save_screening({"keywords": ["作业"], "channels": {"qq": {"inherit": True}}})
        self.store.insert_message(
            msg_id="private-new", source="onebot", event="PRIVATE_MESSAGE_CREATE",
            group_id="private:24680", account_id="83001", sender_id="24680", content="作业通知",
            received_at=self.at(602), route_to_router=True,
        )
        self.assertEqual(self.store.seal_message_packages(self.at(902)), 1)
        entries = self.store.inbox_feed(source="qq", q="", limit=10, offset=0)
        self.assertEqual([entry["trigger_msg_id"] for entry in entries], ["private-new"])

    def test_inbox_feed_paginates_packages_and_older_messages_together(self):
        self.store.save_package_rule({"group_ids": ["12345"]})
        self.message("before", 5, text="用 Python 写")
        self.message("trigger", 10, "admin", text="实验提交")
        self.message("background", 15)
        self.store.insert_message(msg_id="old", group_id="23456", content="历史原文",
                                  source="onebot-catchup", received_at=self.at(0),
                                  inbox_mark=("rule", "通知", {}))
        self.store.insert_message(msg_id="chat", group_id="chat", content="项目会议", source="wechat",
                                  received_at=self.at(20), inbox_mark=("rule", "通知", {}))
        self.store.seal_message_packages(self.at(310))
        items = self.store.inbox_feed(source="", q="", limit=2, offset=0)
        self.assertEqual(items[0]["msg_id"], "chat")
        self.assertEqual([m["msg_id"] for m in items[1]["messages"]], ["trigger", "background"])
        existing, package = items
        self.assertEqual([m["msg_id"] for m in package["context"]], ["before"])
        self.assertEqual(package["trigger_msg_id"], "trigger")
        records = self.store.read_package(package["package_id"])["records"]
        self.assertEqual([(r["message_id"], r["package_role"]) for r in records],
                         [("before", "history"), ("trigger", "trigger"), ("background", "followup")])
        self.assertIsNone(existing["trigger_msg_id"])
        self.assertEqual(existing.keys(), package.keys())
        self.assertEqual((package["title"], package["source"], package["group_name"], package["message_count"]),
                         ("实验提交", "qq", "课程群", 3))
        self.assertEqual(package["sealed_at"], self.at(310).isoformat())
        self.assertEqual(package["messages"][0].keys(), existing["messages"][0].keys())
        self.assertIsNone(existing["package_id"])
        self.assertIsNone(existing["sealed_at"])
        self.assertIsNone(package["task_id"])
        self.assertEqual((existing["state"], package["state"]), ("recorded", "sealed"))
        self.assertFalse(package["can_submit"])
        self.assertEqual(existing["context"], [])
        tail = self.store.inbox_feed(source="", q="", limit=2, offset=2)
        self.assertEqual([m["msg_id"] for m in tail], ["old"])
        matches = self.store.inbox_feed(source="qq", q="实验提交", limit=20, offset=0)
        self.assertEqual([m["package_id"] for m in matches], [items[1]["package_id"]])
        self.assertEqual(self.store.inbox_feed(source="wechat", q="实验提交", limit=20, offset=0), [])
        filtered = self.store.inbox_feed(source="qq", q="实验提交", limit=1, offset=0, day="2026-11-22")
        self.assertEqual([item["package_id"] for item in filtered], [package["package_id"]])
        self.assertEqual(self.store.inbox_feed(source="", q="", limit=1, offset=0, day="2026-11-21"), [])

    def test_inbox_state_tracks_the_saved_router_decision(self):
        self.store.insert_message(msg_id="manual", group_id="", content="测试", source="manual",
                                  inbox_mark=("manual", "手动添加", {}))

        def current():
            item, = self.store.inbox_feed(source="manual", q="", limit=1, offset=0)
            return item["state"], item["can_submit"]

        self.assertEqual(current(), ("recorded", True))
        self.store.queue_router_input("manual")
        self.assertEqual(current(), ("queued", False))
        self.store.resolve_router_input("manual", "ignore", "无需处理", None, None, self.at(0).isoformat())
        self.assertEqual(current(), ("ignored", False))

    def test_reopens_and_seals_after_tail_silence_without_routing_raw_messages(self):
        self.store.save_package_rule({"group_ids": ["12345"], "lookback_count": 2, "keywords": ["实验"]})
        self.message("too-old", -16000)
        self.message("background-one", -7201)
        self.message("earlier-admin", -7000, "admin", text="请留意群消息")
        self.message("background-two", -700)
        self.message("latest-admin", -300, "admin", "image")
        self.message("other-account", -100, account="83002")
        self.message("trigger", 0, "admin")
        self.message("member-after", 280)
        self.message("listener-tail", 290, "admin", text="说明补充")
        self.assertEqual(self.store.seal_message_packages(self.at(300)), 0)
        self.store = Store(self.path)
        self.assertFalse(self.message("listener-tail", 290, "admin"))
        self.assertEqual(self.store.seal_message_packages(self.at(350)), 1)
        self.assertEqual(self.store.seal_message_packages(self.at(380)), 0)
        package, = self.store.list_message_packages()
        self.assertEqual([row["msg_id"] for row in package["context"]], [
            "background-one", "earlier-admin", "background-two", "latest-admin",
        ])
        self.assertEqual([row["msg_id"] for row in package["messages"]], ["trigger", "member-after", "listener-tail"])
        self.assertEqual(self.store.list_router_inputs(), [])
        self.assertEqual(self.store.unprocessed_messages(), [])
        self.assertEqual(self.store.list_tasks(), [])

    def test_existing_package_is_referenced_and_duration_is_capped(self):
        self.store.save_package_rule({"group_ids": ["12345"], "collect_minutes": 1, "max_minutes": 2, "keywords": ["实验"]})
        self.message("picture", -10, "owner", "image")
        self.message("document", 0, "owner", "file", text="报名表.pdf")
        self.message("first-tail", 55, "admin", text="补充")
        self.message("last-tail", 110, "admin", text="请看附件")
        self.assertEqual(self.store.seal_message_packages(self.at(119)), 0)
        self.assertEqual(self.store.seal_message_packages(self.at(120)), 1)
        first, = self.store.list_message_packages()
        self.message("new-trigger", 130, "admin")
        self.assertEqual(self.store.seal_message_packages(self.at(190)), 1)
        second, _ = self.store.list_message_packages()
        self.assertEqual(second["context_package_refs"], [first["package_id"]])
        self.assertEqual(second["context"], [])
        self.assertEqual([row["msg_id"] for row in second["messages"]], ["new-trigger"])

    def test_live_group_event_uses_qq_author_role_and_tick_seals_the_package(self):
        settings = Settings(data_dir=self.path.parent, group_whitelist=("12345",))
        service = DigestService(settings, store=self.store, pushers=[])
        self.store.save_package_rule({"group_ids": ["12345"], "keywords": ["报名"]})
        payload = {
            "post_type": "message", "message_type": "group", "group_id": 12345,
            "self_id": 83001, "user_id": 24681, "message_id": 99,
            "sender": {"role": "owner", "nickname": "群主"},
            "message": [{"type": "text", "data": {"text": "报名周五结束"}}],
        }
        event = parse_onebot_message(payload, settings, now=lambda: self.start)
        self.assertTrue(service.on_message(onebot_record(event)))
        self.assertEqual(self.store.list_message_packages(), [])
        service.tick(self.at(300))
        package, = self.store.list_message_packages()
        self.assertEqual(package["messages"][0]["content"], "报名周五结束")
        self.assertEqual(self.store.list_router_inputs(), [])
        self.assertEqual(self.store.list_tasks(), [])

    def test_own_group_message_can_trigger_only_when_selected_for_that_group(self):
        settings = Settings(data_dir=self.path.parent, group_whitelist=("12345", "54321"))
        service = DigestService(settings, store=self.store, pushers=[])
        payload = {
            "post_type": "message_sent", "message_type": "group", "group_id": 12345,
            "self_id": 83001, "user_id": 83001, "message_id": 77,
            "message": [{"type": "text", "data": {"text": "组包测试"}}],
        }
        self.assertEqual(service.receiver.handle_payload(payload)[0], 204)
        self.store.save_package_rule({"group_ids": ["12345"], "roles": [], "include_self": True})
        self.assertEqual(service.receiver.handle_payload({**payload, "group_id": 54321})[0], 204)
        status, result = service.receiver.handle_payload(payload)
        self.assertEqual(status, 200)
        self.assertTrue(result["inserted"])
        self.store.seal_message_packages(service.now() + dt.timedelta(minutes=6))
        package, = self.store.list_message_packages()
        self.assertEqual(package["messages"][0]["content"], "组包测试")
