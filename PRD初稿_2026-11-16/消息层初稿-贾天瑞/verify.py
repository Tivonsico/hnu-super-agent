"""Run the cross-module demo against a scratch database."""
import json
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent


@contextmanager
def running(db):
    with subprocess.Popen(
        [sys.executable, str(ROOT / "server.py"), "--port", "0", "--db", str(db)],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    ) as process:
        try:
            base = process.stdout.readline().removeprefix("SuperDot  ").strip()
            if not base.startswith("http://127.0.0.1:"):
                raise RuntimeError("本地演示服务未启动")

            def request(path, body=None, expected=200):
                req = Request(base + path,
                              data=None if body is None else json.dumps(body).encode(),
                              headers={"Content-Type": "application/json"})
                try:
                    response = urlopen(req, timeout=5)
                except HTTPError as error:
                    response = error
                with response:
                    raw = response.read().decode()
                    if response.status != expected:
                        raise RuntimeError(f"{path}: {response.status}, 预期 {expected}: {raw}")
                    return raw if path == "/" else json.loads(raw)

            yield request
        finally:
            process.terminate()
            process.wait(timeout=5)


def main():
    with TemporaryDirectory() as scratch:
        db = Path(scratch) / "demo.sqlite3"
        with running(db) as request:
            assert "消息交接" in request("/")
            qq = {"kind": "source_message", "account_id": "demo-qq",
                  "conversation_id": "demo-group", "message_id": "msg-017",
                  "text": "请按模板制作志愿活动 PPT。",
                  "attachment_refs": [{"id": "template-017"}]}
            ref = request("/api/packages", qq, 202)["package_ref"]
            path = "/api/packages/" + ref["id"]
            assert request("/api/packages", qq)["package"]["package_ref"] == ref
            assert request("/api/packages", dict(qq, text="重复身份"), 409)["code"] == "CONFLICT"
            assert request(path)["package"]["attachment_refs"] == qq["attachment_refs"]
            context = request("/api/context", {"account_id": "demo-qq", "conversation_id": "demo-group"})
            assert context["messages"][0]["package_ref"] == ref
            assert request("/api/health")["pending"] == 1
            assert request("/api/watchdog/tick", {"mode": "offline"}, 503)["code"] == "ROUTER_UNAVAILABLE"
            assert request("/api/watchdog/tick", {"mode": "lost_ack"}, 504)["code"] == "ACK_UNKNOWN"
            before = request("/api/state")
            assert before["packages"][0]["state"] == "RETRY_WAIT"
            assert len(before["router_acceptance"]) == 1
            receipt_id = before["router_acceptance"][0]["receipt_id"]

        with running(db) as request:
            receipt = request("/api/watchdog/tick", {})
            assert (receipt["code"], receipt["package_ref"], receipt["receipt_id"]) == ("REPLAYED", ref, receipt_id)
            assert request(path)["package"]["state"] == "ACCEPTED"
            assert request("/api/watchdog/tick", {})["code"] == "NO_WORK"
            assert request("/api/health")["pending"] == 0
            state = request("/api/state")
            assert len(state["router_acceptance"]) == 1
            print("存储与接管：按引用读包、去重、断线保留、重启复用原回执")

            config = request("/api/settings")
            changed = request("/api/settings", {"enabled": False, "expected_revision": config["saved_revision"]})
            assert changed["saved_revision"] == changed["effective_revision"]
            assert request("/api/packages", dict(qq, message_id="msg-018"))["code"] == "FILTERED"
            assert "C" not in request("/api/router/tickets")["tickets"]
            assert request("/api/tickets/restore", {"ticket_id": "C"})["visible"] == 1
            assert "C" in request("/api/router/tickets")["tickets"]
            restored = request("/api/state")
            assert restored["packages"] == state["packages"]
            assert restored["router_acceptance"] == state["router_acceptance"]
            for body in (
                {"kind": "new_task", "operation_id": "op-018", "text": "整理实验报告"},
                {"kind": "merge", "operation_id": "op-019", "source_ticket_id": "A",
                 "target_ticket_id": "B"},
            ):
                submitted = request("/api/packages", body, 202)["package_ref"]
                assert request("/api/watchdog/tick", {})["package_ref"] == submitted
                read = request("/api/packages/" + submitted["id"])["package"]
                assert all(read[key] == value for key, value in body.items())
            print("前端接口：监听开关、全局输入、指定合并、直接恢复工单可见性")


if __name__ == "__main__":
    main()
