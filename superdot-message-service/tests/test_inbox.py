import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace
from noticehub.storage.sqlite.store import Store
from noticehub.rules.import_screening import classify_messages
from noticehub.work_orders.from_message import promote
from noticehub.receivers.qq import group_suggest

class InboxTests(unittest.TestCase):
    def _setup(self):
        td=tempfile.TemporaryDirectory(); s=Store(Path(td.name)/"data.db"); settings=SimpleNamespace(dashscope_endpoint="",dashscope_model="",data_dir=Path(td.name),is_quiet_group=lambda group_id: False,is_quiet_group_name=lambda name: False)
        for i,text in enumerate(["周三3-4节交作业","明天开会","哈哈"]): s.insert_message(msg_id=str(i),group_id="g",content=text,group_name="G")
        return td,s,settings
    def test_existing_rule_task_is_linked_to_original_message_on_upgrade(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.sqlite3"
            store = Store(path)
            msg_id = "onebot:g:123"
            store.insert_message(msg_id=msg_id, group_id="g", content="课程改期")
            task_id = store.upsert_task(
                task_key=f"rule:课程:改期:{msg_id}", summary="课程改期",
                source="rule", status="candidate", classification_reason="规则 课程:改期 命中",
            )

            updated = Store(path)
            item, = updated.inbox_items()
            self.assertEqual(item["msg_id"], msg_id)
            self.assertEqual(item["task_id"], task_id)
            self.assertEqual(promote(None, updated, msg_id)["task_id"], task_id)

    def test_inbox_items_preserve_message_source(self):
        td, s, settings = self._setup()
        try:
            s.insert_message(
                msg_id="onebot:g:attach:0123456789abcdef",
                group_id="g",
                content="图片附件",
                source="onebot-attachment",
                event="GROUP_ATTACHMENT",
            )
            s.save_mark("onebot:g:attach:0123456789abcdef", "notice")
            item = s.inbox_items(limit=20)[0]
            self.assertEqual(item["source"], "onebot-attachment")
            self.assertEqual(item["event"], "GROUP_ATTACHMENT")
        finally:
            td.cleanup()

    def test_heuristic_has_all_three_verdicts(self):
        td,s,settings=self._setup()
        try:
            s.insert_message(msg_id="n",group_id="g",content="周三3-4节交作业，截止10月10日23:59前提交到学习通")
            s.insert_message(msg_id="q",group_id="g",content="那个事怎么样")
            s.insert_message(msg_id="z",group_id="g",content="哈哈哈")
            classify_messages(settings,s)
            got={x["msg_id"]:x["verdict"] for x in s.inbox_items(limit=20)}
            self.assertEqual(got["n"],"notice"); self.assertEqual(got["q"],"suspect"); self.assertEqual(got["z"],"noise")
        finally: td.cleanup()

    def test_heuristic_fallback_and_unmarked(self):
        td,s,settings=self._setup()
        try:
            r=classify_messages(settings,s); self.assertEqual(r["method"],"heuristic"); self.assertEqual(r["classified"],3); self.assertEqual(len(s.unmarked_messages()),0)
        finally: td.cleanup()
    def test_promoted_filter_and_counts(self):
        td,s,settings=self._setup()
        try:
            for msg_id in ("0", "1", "2"):
                s.save_mark(msg_id, "notice", method="heuristic")
            self.assertEqual(len(s.inbox_items(promoted=True)),0); self.assertEqual(len(s.inbox_items(promoted=False)),3)
            promote(settings,s,"0")
            self.assertEqual(len(s.inbox_items(promoted=True)),1); self.assertEqual(len(s.inbox_items(promoted=False)),2)
            counts=s.inbox_counts(); self.assertEqual(counts["promoted"],1)
            self.assertTrue({"notice","suspect","noise"}.issubset(counts))
        finally: td.cleanup()

    def test_promoted_filter_preserves_verdict_filter(self):
        td,s,settings=self._setup()
        try:
            for msg_id in ("0", "1", "2"):
                s.save_mark(msg_id, "notice", method="heuristic")
            promote(settings,s,"0")
            self.assertEqual({x["msg_id"] for x in s.inbox_items(verdict="notice")}, {"0","1","2"})
            self.assertEqual([x["msg_id"] for x in s.inbox_items(verdict="notice",promoted=True)], ["0"])
        finally: td.cleanup()

    def test_promote_idempotent(self):
        td,s,settings=self._setup()
        try:
            for msg_id in ("0", "1", "2"):
                s.save_mark(msg_id, "notice", method="heuristic")
            a=promote(settings,s,"0"); b=promote(settings,s,"0"); self.assertTrue(a["ok"]); self.assertEqual(a["task_id"],b["task_id"])
        finally: td.cleanup()
    def test_promote_reuses_task_auto_created_for_same_message(self):
        td,s,settings=self._setup()
        try:
            s.save_mark("0", "notice", method="heuristic")
            before=len(s.list_tasks())
            s.upsert_task(task_key="0",summary="自动建的任务",source="qq_message")
            self.assertEqual(len(s.list_tasks()),before+1)
            res=promote(settings,s,"0")
            self.assertTrue(res["ok"])
            self.assertEqual(len(s.list_tasks()),before+1)
        finally: td.cleanup()
    def test_old_db_upgrade(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"old.db"; Store(p); self.assertIn("notice",Store(p).inbox_counts())

    def test_cancel_stops_before_next_batch_and_keeps_saved_rows(self):
        """第 2 批前取消：已落库的保留，后续批一条不许再发。"""
        td,s,settings=self._setup()
        [s.insert_message(msg_id=f"x{i}",group_id="g",content="通知内容很长") for i in range(25)]
        calls=[]
        try:
            def progress(done, total):
                calls.append((done, total))

            r = classify_messages(settings, s, progress=progress, cancel=lambda: bool(calls))
            self.assertTrue(r["cancelled"])
            self.assertEqual(calls, [(20, 28)], "第 2 批不得写入判定")
            self.assertEqual(r["classified"],20)
            self.assertEqual(len(s.unmarked_messages()),8,"剩下的留给下一次判定")
        finally: td.cleanup()

    def test_cancelled_result_carries_counts_and_method(self):
        td,s,settings=self._setup()
        try:
            r=classify_messages(settings,s,cancel=lambda: True)
            self.assertTrue(r["cancelled"])
            self.assertEqual(r["classified"],0)
            self.assertEqual(r["method"],"heuristic")
        finally: td.cleanup()

if __name__ == "__main__": unittest.main()
