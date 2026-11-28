from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from noticehub.execution.client import ExecutionHost
from noticehub.storage.sqlite.store import Store
from noticehub.web.desktop_pet import DesktopPet


class DesktopPetTest(TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "messages.sqlite3")
        self.pet = DesktopPet(self.store, None, 54851, "")
        self.pet.enhanced = True

    def test_launch_reuses_running_pet_and_restores_desktop_display(self):
        self.pet.visible = False
        config = {"main": {"pets": [{"id": "main", "display": "web"}]}}
        with patch.object(self.pet, "_connect"), patch.object(self.pet, "_ready"), \
                patch.object(self.pet, "_call", return_value=config) as call, \
                patch("noticehub.web.desktop_pet.subprocess.Popen") as spawn:
            self.pet.launch()
            spawn.assert_not_called()
            call.assert_any_call("/pet-display", {"id": "main", "display": "both"})

    def test_launch_during_system_restart_uses_supervisor(self):
        self.pet.runtime_file = self.store.path.parent / "dsh-pet/standalone-runtime.json"
        with patch.object(self.pet, "_connect", side_effect=[OSError("still starting"), None]), \
                patch.object(self.pet, "_ready"), patch.object(self.pet, "_launch_agent", return_value="gui/501/test"), \
                patch("noticehub.web.desktop_pet.subprocess.run") as supervisor, \
                patch("noticehub.web.desktop_pet.subprocess.Popen") as spawn:
            supervisor.return_value.returncode = 0
            self.pet.launch()
            self.assertEqual(supervisor.call_args.args[0], ["/bin/launchctl", "kickstart", "gui/501/test"])
            spawn.assert_not_called()

    def test_separate_launchers_share_runtime_lock_and_start_only_once(self):
        import threading
        import time
        from concurrent.futures import ThreadPoolExecutor

        runtime = str(self.store.path.parent / "dsh-pet/standalone-runtime.json")
        pets = [DesktopPet(self.store, None, 8766, "", runtime) for _ in range(2)]
        barrier = threading.Barrier(2)
        ready = threading.Event()

        def connect():
            if not ready.is_set():
                raise OSError("not ready")

        def spawn(*args, **kwargs):
            time.sleep(0.05)
            ready.set()
            return object()

        def launch(pet):
            with patch.object(pet, "_connect", side_effect=connect), patch.object(pet, "_ready"), \
                    patch.object(pet, "_launch_agent", return_value=None):
                barrier.wait(timeout=3)
                pet.launch()

        with patch("noticehub.web.desktop_pet.subprocess.Popen", side_effect=spawn) as process, \
                patch("noticehub.web.desktop_pet.shutil.which", return_value="/test/executable"), \
                ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(launch, pets))
            process.assert_called_once()

    def test_note_uses_existing_message_queue_and_can_be_retried(self):
        with patch.object(self.pet, "_call", return_value={"todos": [{"id": "note-1", "text": "整理实验报告"}]}):
            action = {"kind": "package-note", "noteId": "note-1"}
            status, first = self.pet.native_action(action)
            self.assertEqual(status, 200)
            self.assertTrue(first["ok"])
            self.assertEqual(self.pet.native_action(action), (200, first))
            self.assertEqual(self.store.next_package_delivery(), first["packageId"])
            self.assertIn("整理实验报告", str(self.store.read_package(first["packageId"])))

    def test_missing_note_has_no_message_package(self):
        with patch.object(self.pet, "_call", return_value={"todos": []}):
            status, result = self.pet.native_action({"kind": "package-note", "noteId": "gone"})
        self.assertEqual(status, 404)
        self.assertFalse(result["ok"])
        self.assertIsNone(self.store.next_package_delivery())

    def test_local_approvals_update_menu_when_broadcast_is_disabled(self):
        self.pet.execution = ExecutionHost("")
        pending = {"id": 42, "summary": "提交实验报告", "state": "blocked", "revision": 2,
                   "updated_at": "2026-11-24T20:00:00+08:00", "checkpoint": "确认附件"}
        with patch.object(self.store, "list_work_orders", return_value=[pending]) as source:
            self.pet._update_work_order()
            self.assertEqual(self.pet.snapshot()["pendingCount"], 1)
            self.assertEqual(self.pet.snapshot()["bubbles"], [])
            with patch("noticehub.web.desktop_pet.webbrowser.open", return_value=True) as open_page:
                self.assertEqual(self.pet.native_action({"kind": "open", "target": "pending"})[0], 200)
                self.assertTrue(open_page.call_args.args[0].endswith("ticket_id=42"))
            source.return_value = []
            self.pet._update_work_order()
            self.assertEqual(self.pet.snapshot()["pendingCount"], 0)

    def test_approval_stack_survives_read_failure_and_only_closes_after_acknowledgement(self):
        class Execution:
            configured = True
            notices = [
                {"id": "approve", "code": "APPROVAL_REQUIRED", "content": "请选择一个报告版本", "ticket_id": "lab"},
                {"id": "input", "code": "INPUT_NEEDED", "content": "请补交实验数据", "ticket_id": "lab"},
            ]

            def request(self, path):
                if path == "/api/tickets":
                    return 200, {"items": [{"ticket": {"ticket_id": "lab", "title": "实验报告"}}]}
                if self.notices is None:
                    return 503, {}
                return 200, {"items": self.notices}

        execution = Execution()
        self.pet.execution = execution
        self.pet.set_enabled(True)
        with patch.object(self.pet, "_call"), patch.object(self.pet, "_clear_status"):
            self.pet._update_work_order()
            snapshot = self.pet.snapshot()
            self.assertEqual(snapshot["pendingCount"], 1)
            self.assertEqual([item["label"] for item in snapshot["bubbles"]], ["前往查看"])
            execution.notices.reverse()
            self.pet._update_work_order()
            self.assertEqual(self.pet.snapshot()["bubbles"], snapshot["bubbles"])
            execution.notices = None
            self.pet._update_work_order()
            self.assertEqual(self.pet.snapshot()["bubbles"], snapshot["bubbles"])
            with patch("noticehub.web.desktop_pet.webbrowser.open", return_value=True) as open_page:
                self.assertEqual(self.pet.native_action({"kind": "open", "target": "ticket:lab"}), (200, {"ok": True}))
                self.assertTrue(open_page.call_args.args[0].endswith("#tasks?ticket_id=lab"))
            self.assertEqual(self.pet.snapshot()["pendingCount"], 1)
            execution.notices = [{"id": "input", "code": "INPUT_NEEDED", "ticket_id": "lab"}]
            self.pet._update_work_order()
            self.assertEqual([item["id"] for item in self.pet.snapshot()["bubbles"]], ["notice:input"])
            self.pet.set_enabled(False)
            self.assertFalse(self.pet.snapshot()["active"])
            self.assertEqual(self.pet.snapshot()["bubbles"], [])

    def test_first_poll_shows_pending_results_once_and_drops_handled(self):
        self.pet.execution = ExecutionHost("")
        self.pet.set_enabled(True)
        order = {"id": 12, "summary": "周报", "state": "completed", "result_confirmed": False,
                 "revision": 2, "updated_at": "2026-11-24T20:00:00+08:00"}
        with patch.object(self.store, "list_work_orders", return_value=[order, order]), patch.object(self.pet, "_call"), patch.object(self.pet, "_clear_status"):
            for _ in range(2):
                self.pet._update_work_order()
                bubbles = self.pet.snapshot()["bubbles"]
                self.assertEqual([item["text"] for item in bubbles], ["您有新的工单：《周报》已有结果，等待查看。"])
                self.assertEqual(bubbles[0]["target"], "ticket:12")
            order.update(result_confirmed=True, revision=3)
            self.pet._update_work_order()
            self.assertEqual(self.pet.snapshot()["bubbles"], [])

    def test_group_priority_and_unassigned_notifications(self):
        self.pet.execution = ExecutionHost("")
        self.pet.set_enabled(True)
        tickets = {"items": [{"ticket": {"ticket_id": "t", "title": "报告"}}]}
        notices = [{"id": "r", "ticket_id": "t", "code": "RESULT_READY"},
                   {"id": "b", "ticket_id": "t", "code": "BLOCKED"},
                   {"id": "a", "ticket_id": "t", "code": "INPUT_NEEDED"},
                   {"id": "u1", "code": "ROUTE_REVIEW"}, {"id": "u2", "code": "ROUTE_REVIEW"}]
        with patch.object(self.pet, "_local_work_orders", return_value=(tickets, {"items": notices})), patch.object(self.pet, "_call"):
            for expected in ["notice:a", "notice:b", "notice:r"]:
                self.pet._update_work_order()
                snapshot = self.pet.snapshot()
                self.assertEqual([b["id"] for b in snapshot["bubbles"]], [expected, "notice:u1", "notice:u2"])
                self.assertEqual(snapshot["pendingCount"], 3)
                notices.remove(next(n for n in notices if n["id"] == expected.split(":")[1]))

    def test_snapshot_combines_multiple_transients_and_pending_for_same_ticket(self):
        self.pet.set_enabled(True)
        self.pet.transient = {kind: (float("inf"), {"id": kind, "kind": kind, "target": "ticket:7"})
                              for kind in ("created", "result", "progress")}
        self.assertEqual([b["id"] for b in self.pet.snapshot()["bubbles"]], ["result"])
        self.pet.pending_bubbles = [{"id": "blocked", "kind": "problem", "target": "ticket:7"}]
        self.assertEqual([b["id"] for b in self.pet.snapshot()["bubbles"]], ["blocked"])
