"""Deliver one eligible package and record only matching execution-host receipts."""

from __future__ import annotations

import logging
import sqlite3
import threading

from noticehub.execution.client import ExecutionHost, REQUEST_TIMEOUT
from noticehub.platform.timeutil import now_local

LOGGER = logging.getLogger(__name__)
POLL_SECONDS = 5


def deliver_next_package(store, execution: ExecutionHost) -> str:
    """Send one eligible package, using the original ID on every attempt."""
    package_id = store.next_package_delivery(now_local())
    if package_id is None:
        return "NO_WORK"
    status, receipt = execution.request("/api/router/notify", {"package_ref": {"id": package_id}})
    stamp = now_local()
    if status == 200 and store.acknowledge_package_delivery(package_id, receipt, stamp):
        return "ACCEPTED"
    if status == 200:
        error = "ACK_MISMATCH"
    elif receipt.get("code") in ("EXECUTION_UNAVAILABLE", "INVALID_EXECUTION_RESPONSE"):
        error = receipt["code"]
    else:
        error = f"HTTP_{status}"
    store.record_package_delivery_failure(package_id, error, stamp)
    return "ACK_UNKNOWN"


class PackageWatchdog:
    def __init__(self, store, execution: ExecutionHost) -> None:
        self.store = store
        self.execution = execution
        self.stopped = threading.Event()
        self.worker: threading.Thread | None = None
        self.delivery_lock = threading.Lock()

    def start(self) -> None:
        if not self.execution.configured:
            return
        if self.worker and self.worker.is_alive() and not self.stopped.is_set():
            return
        self.stopped = threading.Event()
        self.worker = threading.Thread(
            target=self._run, args=(self.stopped,), name="package-watchdog", daemon=True,
        )
        self.worker.start()

    def stop(self) -> None:
        self.stopped.set()
        if self.worker is not None:
            self.worker.join(timeout=REQUEST_TIMEOUT + 1)

    def _run(self, stopped: threading.Event) -> None:
        unavailable = False
        while not stopped.is_set():
            try:
                with self.delivery_lock:
                    if stopped.is_set():
                        return
                    result = deliver_next_package(self.store, self.execution)
                if result == "ACK_UNKNOWN" and not unavailable:
                    LOGGER.warning("消息包接管回执未确认，将使用原包 ID 重试")
                if result == "ACCEPTED" and unavailable:
                    LOGGER.info("消息包接管已恢复")
                unavailable = result == "ACK_UNKNOWN"
                if result != "NO_WORK":
                    continue
            except sqlite3.Error:
                LOGGER.exception("读取或更新消息包队列失败")
            stopped.wait(POLL_SECONDS)
