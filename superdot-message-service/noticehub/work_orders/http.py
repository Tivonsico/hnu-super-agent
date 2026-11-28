"""SuperDot HTTP handlers for work_orders."""

from __future__ import annotations

import urllib.parse

from noticehub.platform.timeutil import iso, now_local, parse_iso
from noticehub.work_orders.from_message import promote


class WorkOrderRoutes:
    def _route_get_work_orders(self, path: str) -> None:
        from noticehub.work_orders.preview import list_work_orders

        self._json(200, list_work_orders(self.store, now_local(), self.server.settings.group_aliases))

    def _route_get_router_queue(self, path: str) -> None:
        self._json(200, {"items": self.store.list_router_inputs()})

    def _route_get_router_orders(self, path: str) -> None:
        orders = self.store.list_work_orders()
        self._json(200, {"orders": [
            order for order in orders if order["state"] not in {"ignored", "terminated", "merged"}
        ]})

    def _route_post_router_decision(self, path: str) -> None:
        try:
            payload = self._json_body()
            msg_id = payload.get("msg_id")
            decision = payload.get("decision")
            reason = payload.get("reason", "")
            target = payload.get("task_id")
            title = payload.get("title")
            due = payload.get("due")
            if not isinstance(msg_id, str) or not msg_id.strip() or len(msg_id) > 256:
                raise ValueError("消息编号无效")
            if decision not in ("create", "append", "ignore"):
                raise ValueError("Router 决定无效")
            if not isinstance(reason, str) or len(reason) > 8000:
                raise ValueError("Router 理由最多 8000 个字符")
            if decision == "append":
                if type(target) is not int or not 0 < target < 2**63:
                    raise ValueError("追加目标工单编号无效")
            else:
                target = None
            if title is not None and (not isinstance(title, str) or len(title) > 500):
                raise ValueError("工单标题最多 500 个字符")
            if due is not None and (not isinstance(due, str) or (due and parse_iso(due) is None)):
                raise ValueError("截止时间格式无效")

            def create(connection):
                result = promote(
                    self.server.settings, self.store, msg_id, title=title, due=due, connection=connection,
                )
                if not result.get("task_id"):
                    raise LookupError("没有找到原始消息")
                return result["task_id"]

            result = self.store.resolve_router_input(msg_id, decision, reason, target, create, iso(now_local()))
        except LookupError as error:
            self._json(404, {"error": str(error)})
        except ValueError as error:
            self._json(400, {"error": str(error)})
        else:
            self._json(200, {"ok": True, **result})

    def _route_get_work_order_events(self, path: str) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query, max_num_fields=8)
        raw = (query.get("id") or [""])[0]
        if not raw.isascii() or not raw.isdecimal() or len(raw) > 18 or int(raw) < 1:
            self._json(400, {"error": "工单编号无效"})
            return
        self._json(200, {"events": self.store.list_task_events(int(raw))})

    def _route_post_work_order_action(self, path: str) -> None:
        self._change_work_order(worker=False)

    def _route_post_work_order_worker(self, path: str) -> None:
        self._change_work_order(worker=True)

    def _change_work_order(self, *, worker: bool) -> None:
        from noticehub.work_orders.preview import WorkOrderConflict, change_work_order

        try:
            order = change_work_order(self.store, self._json_body(), now_local(), worker=worker)
        except LookupError as error:
            self._json(404, {"error": str(error)})
        except WorkOrderConflict as error:
            self._json(409, {"error": str(error)})
        except ValueError as error:
            self._json(400, {"error": str(error)})
        else:
            self._json(200, {"order": order})

    def _route_post_api_inbox_promote(self, path: str) -> None:  # noqa: N802 - 路由处理
        try:
            msg_id = self._json_body().get("msg_id")
            if not isinstance(msg_id, str) or not msg_id.strip() or len(msg_id) > 256:
                raise ValueError("消息编号无效")
            result = self.store.queue_router_input(msg_id)
        except ValueError as error:
            self._json(400, {"ok": False, "error": str(error)})
        except LookupError as error:
            self._json(404, {"ok": False, "error": str(error)})
        else:
            self._json(200, {"ok": True, **result})
