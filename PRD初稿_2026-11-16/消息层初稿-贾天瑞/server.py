import argparse
import json
import sqlite3
from contextlib import closing
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
SCHEMA = """
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'QUEUED', code TEXT NOT NULL DEFAULT 'QUEUED',
  receipt_id TEXT
);
CREATE TABLE IF NOT EXISTS router_acceptance (
  package_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, visible INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL, revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO settings VALUES (1, 1, 0);
INSERT OR IGNORE INTO tickets VALUES ('A', 1), ('B', 1), ('C', 0);
"""


class Error(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def unpack(row):
    return {
        "package_ref": {"id": row["id"]}, "state": row["state"],
        "code": row["code"], "receipt_id": row["receipt_id"],
        **json.loads(row["body"]),
    }


def submit(db, data):
    keys = {
        "source_message": ("account_id", "conversation_id", "message_id", "text"),
        "new_task": ("operation_id", "text"),
        "merge": ("operation_id", "source_ticket_id", "target_ticket_id"),
    }
    kind = data.get("kind")
    if not isinstance(kind, str) or kind not in keys:
        raise Error(400, "INVALID_INPUT")
    required = keys[kind]
    if any(not isinstance(data.get(k), str) or not data[k].strip() for k in required):
        raise Error(400, "INVALID_INPUT")
    if kind == "merge" and data["source_ticket_id"] == data["target_ticket_id"]:
        raise Error(400, "INVALID_INPUT")
    refs = data.get("attachment_refs", [])
    if not isinstance(refs, list) or any(
        not isinstance(ref, dict) or not isinstance(ref.get("id"), str)
        or not ref["id"].strip() for ref in refs
    ):
        raise Error(400, "INVALID_INPUT")
    if kind == "merge" and refs:
        raise Error(400, "INVALID_INPUT")
    identity = [data[k] for k in (required[:3] if kind == "source_message" else required[:1])]
    request_id = json.dumps(["qq" if kind == "source_message" else "frontend", *identity])
    body = {k: data[k] for k in ("kind", *required)}
    if kind != "merge":
        body["attachment_refs"] = refs
    encoded = json.dumps(body, ensure_ascii=False, sort_keys=True)
    row = db.execute("SELECT * FROM inbox WHERE request_id = ?", (request_id,)).fetchone()
    if row:
        if row["body"] != encoded:
            raise Error(409, "CONFLICT")
        return 200, {"code": "REPLAYED", "package": unpack(row)}
    package_id = "pkg-" + uuid4().hex[:12]
    with db:
        db.execute("INSERT INTO inbox (id, request_id, body) VALUES (?, ?, ?)",
                   (package_id, request_id, encoded))
    return 202, {"code": "QUEUED", "package_ref": {"id": package_id}}


def package(db, package_id):
    row = db.execute("SELECT * FROM inbox WHERE id = ?", (package_id,)).fetchone()
    if row is None:
        raise Error(404, "REF_NOT_FOUND")
    return unpack(row)


def notify_router(db, signal):
    """Fake execution-side adapter. Its transaction commits before replying."""
    package_id = signal["package_ref"]["id"]
    package(db, package_id)
    existing = db.execute(
        "SELECT receipt_id FROM router_acceptance WHERE package_id = ?", (package_id,)
    ).fetchone()
    if existing:
        return {"code": "REPLAYED", **signal, "receipt_id": existing["receipt_id"]}
    receipt_id = "ack-" + uuid4().hex[:12]
    with db:
        db.execute("INSERT INTO router_acceptance VALUES (?, ?)", (package_id, receipt_id))
    return {"code": "OK", **signal, "receipt_id": receipt_id}


def dispatch(db, mode):
    if mode not in ("normal", "offline", "lost_ack"):
        raise Error(400, "INVALID_INPUT")
    row = db.execute("SELECT id FROM inbox WHERE state != 'ACCEPTED' ORDER BY rowid LIMIT 1").fetchone()
    if row is None:
        return 200, {"code": "NO_WORK"}
    package_id = row["id"]
    with db:
        db.execute("UPDATE inbox SET state = 'AWAITING_ACK', code = 'OK' WHERE id = ?", (package_id,))
    signal = {"package_ref": {"id": package_id}}
    receipt = None if mode == "offline" else notify_router(db, signal)
    if mode != "normal":
        status, code = (503, "ROUTER_UNAVAILABLE") if mode == "offline" else (504, "ACK_UNKNOWN")
        with db:
            db.execute("UPDATE inbox SET state = 'RETRY_WAIT', code = ? WHERE id = ?", (code, package_id))
        return status, {"code": code, **signal}
    with db:
        db.execute("UPDATE inbox SET state = 'ACCEPTED', code = ?, receipt_id = ? WHERE id = ?",
                   (receipt["code"], receipt["receipt_id"], package_id))
    return 200, receipt


def settings(db):
    row = db.execute("SELECT enabled, revision FROM settings").fetchone()
    return {"code": "OK", "enabled": bool(row["enabled"]),
            "saved_revision": row["revision"], "effective_revision": row["revision"]}


def context(db, account_id, conversation_id, before, limit):
    rows = db.execute(
        """SELECT * FROM inbox
           WHERE rowid < ? AND json_extract(body, '$.kind') = 'source_message'
             AND json_extract(body, '$.account_id') = ?
             AND json_extract(body, '$.conversation_id') = ?
           ORDER BY rowid DESC LIMIT ?""", (before, account_id, conversation_id, limit + 1)
    ).fetchall()
    items = [unpack(row) for row in rows[:limit]]
    cursor = None
    if len(rows) > limit:
        cursor = db.execute("SELECT rowid FROM inbox WHERE id = ?", (rows[limit - 1]["id"],)).fetchone()[0]
    return {"code": "OK", "messages": items, "next_cursor": cursor, "gaps": []}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        payload = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/":
            html = (ROOT / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html)
            return
        self.handle_api()

    def do_POST(self):
        self.handle_api()

    def handle_api(self):
        try:
            body = {}
            if self.command == "POST":
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 65536:
                    raise Error(400, "INVALID_INPUT")
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise Error(400, "INVALID_INPUT")
            with closing(sqlite3.connect(self.server.db_path)) as db:
                db.row_factory = sqlite3.Row
                status, result = self.route(db, body)
            self.reply(status, result)
        except Error as exc:
            self.reply(exc.status, {"code": exc.code})
        except (ValueError, UnicodeError):
            self.reply(400, {"code": "INVALID_INPUT"})
        except sqlite3.Error:
            self.reply(503, {"code": "STORE_UNAVAILABLE"})

    def route(self, db, body):
        path = self.path
        if self.command == "GET":
            if path == "/api/settings":
                return 200, settings(db)
            if path == "/api/health":
                pending = db.execute("SELECT count(*) FROM inbox WHERE state != 'ACCEPTED'").fetchone()[0]
                return 200, {"code": "OK", "source": "SIMULATED", "pending": pending, "gaps": []}
            if path == "/api/state":
                return 200, {
                    "code": "OK",
                    "packages": [unpack(row) for row in db.execute("SELECT * FROM inbox ORDER BY rowid DESC")],
                    "router_acceptance": [dict(row) for row in db.execute("SELECT * FROM router_acceptance")],
                    "tickets": [dict(row) for row in db.execute("SELECT * FROM tickets ORDER BY id")],
                }
            if path == "/api/router/tickets":
                return 200, {"code": "OK", "tickets": [
                    row["id"] for row in db.execute("SELECT id FROM tickets WHERE visible = 1 ORDER BY id")
                ]}
            if path.startswith("/api/packages/"):
                return 200, {"code": "OK", "package": package(db, path.split("/")[-1])}
        else:
            if path == "/api/settings":
                enabled = body.get("enabled")
                revision = body.get("expected_revision")
                if type(enabled) is not bool or type(revision) is not int or revision < 0:
                    raise Error(400, "INVALID_INPUT")
                with db:
                    changed = db.execute(
                        "UPDATE settings SET enabled = ?, revision = revision + 1 WHERE revision = ?",
                        (enabled, revision)
                    )
                    if not changed.rowcount:
                        raise Error(409, "CONFLICT")
                return 200, settings(db)
            if path == "/api/context":
                account = body.get("account_id")
                conversation = body.get("conversation_id")
                before = body.get("before_cursor", 2**63 - 1)
                limit = body.get("limit", 10)
                if (not all(isinstance(value, str) and value.strip() for value in (account, conversation))
                    or type(before) is not int or not 0 < before < 2**63
                    or type(limit) is not int or not 1 <= limit <= 50):
                    raise Error(400, "INVALID_INPUT")
                return 200, context(db, account, conversation, before, limit)
            if path == "/api/packages":
                if body.get("kind") == "source_message" and not settings(db)["enabled"]:
                    return 200, {"code": "FILTERED"}
                return submit(db, body)
            if path == "/api/watchdog/tick":
                return dispatch(db, body.get("mode", "normal"))
            if path == "/api/router/notify":
                ref = body.get("package_ref")
                if not isinstance(ref, dict) or not isinstance(ref.get("id"), str):
                    raise Error(400, "INVALID_INPUT")
                return 200, notify_router(db, {"package_ref": ref})
            if path == "/api/tickets/restore":
                ticket_id = body.get("ticket_id")
                if not isinstance(ticket_id, str) or not ticket_id.strip():
                    raise Error(400, "INVALID_INPUT")
                with db:
                    row = db.execute("SELECT visible FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
                    if row is None:
                        raise Error(404, "REF_NOT_FOUND")
                    db.execute("UPDATE tickets SET visible = 1 WHERE id = ?", (ticket_id,))
                return 200, {"code": "REPLAYED" if row["visible"] else "OK",
                             "ticket_id": ticket_id, "visible": 1}
        raise Error(404, "REF_NOT_FOUND")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--db", type=Path, default=ROOT / "demo.sqlite3")
    args = parser.parse_args()
    with closing(sqlite3.connect(args.db)) as db:
        db.executescript(SCHEMA)
    with HTTPServer(("127.0.0.1", args.port), Handler) as server:
        server.db_path = args.db
        print(f"SuperDot  http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
