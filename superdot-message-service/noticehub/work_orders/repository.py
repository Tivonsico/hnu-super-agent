"""SQLite access for the local work-order preview."""

from __future__ import annotations

import sqlite3
from typing import Any

from noticehub.platform.timeutil import iso, now_local
from noticehub.storage.sqlite.json_values import _json_list, _json_object, _json_text


class WorkOrderRepository:
    def queue_router_input(self, msg_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO router_inbox (msg_id,enqueued_at)"
                " SELECT m.msg_id, ? FROM messages AS m JOIN inbox_marks AS k ON k.msg_id=m.msg_id"
                " WHERE m.msg_id=? AND k.task_id IS NULL",
                (iso(now_local()), msg_id),
            )
            row = connection.execute(
                "SELECT COALESCE(r.decision, 'create') AS decision, k.task_id"
                " FROM inbox_marks AS k LEFT JOIN router_inbox AS r ON r.msg_id=k.msg_id"
                " WHERE k.msg_id=? AND (r.msg_id IS NOT NULL OR k.task_id IS NOT NULL)",
                (msg_id,),
            ).fetchone()
            if row is None:
                raise LookupError("没有找到收件箱消息")
            return dict(row)

    def list_router_inputs(self, *, task_id: int | None = None, limit: int = 50) -> list[dict[str, Any]]:
        where, key = ("r.decision = ?", "pending") if task_id is None else ("r.task_id = ?", task_id)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT m.*, k.reason AS rule_reason, k.task_defaults, r.decision, r.reason, r.enqueued_at"
                " FROM router_inbox AS r JOIN messages AS m ON m.msg_id=r.msg_id"
                " JOIN inbox_marks AS k ON k.msg_id=m.msg_id"
                " WHERE " + where + " ORDER BY r.enqueued_at, r.rowid LIMIT ?",
                (key, limit),
            )
            return [{**dict(row), "task_defaults": _json_object(row["task_defaults"])} for row in rows]

    def resolve_router_input(self, msg_id, decision, reason, target, create, now):
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT decision, task_id FROM router_inbox WHERE msg_id=?", (msg_id,)
            ).fetchone()
            if row is None:
                raise LookupError("没有找到 Router 队列项")
            if row["decision"] != "pending":
                if row["decision"] == decision and (decision != "append" or row["task_id"] == target):
                    return dict(row)
                raise ValueError("这条消息已有 Router 决定")
            if decision == "create":
                target = create(connection)
                self._add_event(connection, target, "work_order_assign_ai", "", now)
            elif decision == "append":
                order = connection.execute(
                    self._WORK_ORDER_SELECT + " WHERE t.id=? AND t.status IN ('open','done')", (target,),
                ).fetchone()
                if order is None or order["state"] in {"ignored", "terminated", "merged"}:
                    raise ValueError("目标工单无法追加")
                if order["state"] == "completed":
                    connection.execute(
                        "INSERT INTO work_order_runs (task_id,state,executor,revision) VALUES (?,'queued','ai',1)"
                        " ON CONFLICT(task_id) DO UPDATE SET state='queued',executor='ai',revision=revision+1,"
                        " checkpoint='',approval_options='[]',approval_response='',result=''", (target,),
                    )
                    self._write_task(connection, target, status="open", done_at="", updated_at=now)
                else:
                    connection.execute(
                        "UPDATE work_order_runs SET revision=revision+1 WHERE task_id=?", (target,),
                    )
                    self._write_task(connection, target, updated_at=now)
                if not reason.strip():
                    message = connection.execute(
                        "SELECT content FROM messages WHERE msg_id=?", (msg_id,),
                    ).fetchone()
                    headline = str(message["content"] or "").strip().splitlines()
                    event_detail = headline[0][:500] if headline else ""
                else:
                    event_detail = reason
                self._add_event(connection, target, "work_order_router_append", event_detail, now)
            if target is not None:
                connection.execute("UPDATE inbox_marks SET task_id=? WHERE msg_id=?", (target, msg_id))
            connection.execute(
                "UPDATE router_inbox SET decision=?,task_id=?,reason=? WHERE msg_id=?",
                (decision, target, reason, msg_id),
            )
            return {"decision": decision, "task_id": target}

    _WORK_ORDER_SELECT = """
        SELECT t.id, t.summary, t.action, t.deadline, t.created_at, t.updated_at,
               t.groups, t.sender, t.evidence, t.details,
               COALESCE(m.msg_id, '') AS source_message_id,
               COALESCE((SELECT p.package_id FROM message_packages AS p
                           WHERE p.trigger_msg_id=m.msg_id AND p.sealed_at IS NOT NULL),
                        (SELECT c.package_id FROM message_package_coverage AS c
                           JOIN message_packages AS p ON p.package_id=c.package_id
                           WHERE c.msg_id=m.msg_id AND p.sealed_at IS NOT NULL), '') AS source_package_id,
               COALESCE(NULLIF(m.source, ''), t.source) AS source,
               COALESCE(m.event, '') AS source_event,
               COALESCE(m.group_id, '') AS source_conversation_id,
               COALESCE(NULLIF(g.name, ''), NULLIF(m.group_name, ''),
                        CASE WHEN m.group_id LIKE 'private:%' THEN m.sender_name END, '') AS source_conversation_name,
               CASE WHEN w.state = 'unassigned' OR (w.executor = 'manual' AND w.state = 'running')
                         THEN 'queued'
                    ELSE COALESCE(w.state, CASE t.status
                        WHEN 'done' THEN 'completed' WHEN 'dismissed' THEN 'ignored' ELSE 'queued' END)
               END AS state,
               CASE WHEN w.executor = 'manual' OR w.state = 'unassigned' THEN 'ai'
                    ELSE COALESCE(w.executor, 'ai') END AS executor,
               COALESCE(w.revision, 0) AS revision,
               COALESCE(w.checkpoint, '') AS checkpoint,
               COALESCE(w.approval_options, '[]') AS approval_options,
               COALESCE(w.approval_response, '') AS approval_response,
               COALESCE(w.result, '') AS result,
               COALESCE((SELECT e.event = 'work_order_confirm_result'
                           FROM task_events AS e WHERE e.task_id = t.id
                            AND e.event IN ('work_order_complete', 'work_order_confirm_result')
                           ORDER BY e.id DESC LIMIT 1), 0) AS result_confirmed,
               COALESCE((SELECT e.detail FROM task_events AS e WHERE e.task_id = t.id
                            AND e.event = 'work_order_supplement'
                           ORDER BY e.id DESC LIMIT 1), '') AS latest_supplement,
               COALESCE(NULLIF(m.source_text, ''), m.content, t.evidence) AS source_text
          FROM tasks AS t
          LEFT JOIN work_order_runs AS w ON w.task_id = t.id
          LEFT JOIN messages AS m ON m.msg_id = t.task_key
          LEFT JOIN group_names AS g ON g.group_id = m.group_id
    """

    @staticmethod
    def _work_order_row(row: sqlite3.Row) -> dict[str, Any]:
        order = dict(row)
        order["groups"] = _json_list(order["groups"])
        order["details"] = _json_list(order["details"])
        order["approval_options"] = _json_list(order["approval_options"])
        order["result_confirmed"] = bool(order["result"] and order["result_confirmed"])
        return order

    def list_work_orders(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                self._WORK_ORDER_SELECT
                + " WHERE w.task_id IS NOT NULL OR t.status IN ('open', 'done', 'dismissed')"
                + " ORDER BY (t.deadline = ''), t.deadline, t.id DESC"
            )
            return [self._work_order_row(row) for row in rows]

    def change_work_order(self, order_id, action, note, now, apply, *, target_id=None):
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                self._WORK_ORDER_SELECT
                + " WHERE t.id = ? AND (w.task_id IS NOT NULL OR t.status IN ('open', 'done', 'dismissed'))",
                (order_id,),
            ).fetchone()
            if row is None:
                raise LookupError("没有找到工单")
            order = self._work_order_row(row)
            order.update(apply(order))
            if target_id is not None:
                target = connection.execute(self._WORK_ORDER_SELECT + " WHERE t.id=? AND t.status='open'", (target_id,)).fetchone()
                if target is None or target["state"] in {"merged", "ignored", "terminated"}:
                    raise ValueError("目标工单当前无法接收合并")
                connection.execute(
                    "INSERT INTO work_order_runs (task_id,state,executor,revision) VALUES (?,?,?,1)"
                    " ON CONFLICT(task_id) DO UPDATE SET revision=revision+1",
                    (target_id, target["state"], target["executor"]),
                )
                self._write_task(connection, target_id, updated_at=now)
                self._add_event(connection, target_id, "work_order_merge_in", str(order_id), now)
            order["revision"] += 1
            order["updated_at"] = now
            connection.execute(
                """INSERT INTO work_order_runs
                       (task_id, state, executor, revision, checkpoint, result, approval_options, approval_response)
                   VALUES (:id, :state, :executor, :revision, :checkpoint, :result, :approval_options, :approval_response)
                   ON CONFLICT(task_id) DO UPDATE SET state=excluded.state, executor=excluded.executor,
                       revision=excluded.revision, checkpoint=excluded.checkpoint, result=excluded.result,
                       approval_options=excluded.approval_options, approval_response=excluded.approval_response""",
                {**order, "approval_options": _json_text(order["approval_options"])},
            )
            order["legacy_status"] = {
                "completed": "done", "ignored": "dismissed", "terminated": "dismissed", "merged": "dismissed",
            }.get(order["state"], "open")
            connection.execute(
                """UPDATE tasks SET status=:legacy_status, deadline=:deadline, updated_at=:updated_at,
                       done_at=CASE WHEN :legacy_status='done' THEN :updated_at ELSE '' END,
                       dismissed_at=CASE WHEN :legacy_status='dismissed' THEN :updated_at ELSE '' END
                   WHERE id=:id""",
                order,
            )
            connection.execute(
                "INSERT INTO task_events (task_id,event,detail,created_at) VALUES (?,?,?,?)",
                (order_id, "work_order_" + action, note, now),
            )
            del order["legacy_status"]
            return order
