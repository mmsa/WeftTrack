"""Local-first work tracker and typed relationship graph."""
import json
import sqlite3
from http.server import BaseHTTPRequestHandler, HTTPServer
from uuid import uuid4

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('work', 'change')),
    title TEXT NOT NULL,
    status TEXT,
    repository TEXT,
    external_id TEXT,
    UNIQUE(repository, external_id)
);
CREATE TABLE IF NOT EXISTS edges (
    source TEXT NOT NULL REFERENCES nodes(id),
    target TEXT NOT NULL REFERENCES nodes(id),
    kind TEXT NOT NULL CHECK(kind IN ('blocks', 'parent_of', 'implements')),
    CHECK(source <> target),
    PRIMARY KEY(source, target, kind)
);
CREATE INDEX IF NOT EXISTS edges_target ON edges(target);
"""
TRANSITIONS = {
    "open": {"active"},
    "active": {"open", "review"},
    "review": {"active", "done"},
    "done": {"open"},
}


def required(data, key):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a nonempty string")
    return value.strip()


def add_edge(db, data):
    source, target, kind = (required(data, key) for key in ("source", "target", "kind"))
    expected = {"blocks": ("work", "work"), "parent_of": ("work", "work"),
                "implements": ("change", "work")}.get(kind)
    nodes = [db.execute("SELECT kind FROM nodes WHERE id = ?", (node,)).fetchone()
             for node in (source, target)]
    if not all(nodes):
        raise LookupError("Both endpoints must exist")
    if tuple(node[0] for node in nodes) != expected or source == target:
        raise ValueError("Invalid edge type or endpoints")
    if kind == "parent_of" and db.execute(
        "SELECT 1 FROM edges WHERE target = ? AND kind = ?", (target, kind)
    ).fetchone():
        raise ValueError("The work item already has a parent")
    if kind in {"parent_of", "blocks"} and db.execute("""
        WITH RECURSIVE reachable(id) AS (
            SELECT ?
            UNION
            SELECT edges.target FROM edges JOIN reachable ON edges.source = reachable.id
            WHERE edges.kind = ?
        ) SELECT 1 FROM reachable WHERE id = ?
    """, (target, kind, source)).fetchone():
        raise ValueError("This relationship would create a cycle")
    db.execute("INSERT INTO edges VALUES (?, ?, ?)", (source, target, kind))
    return {"source": source, "target": target, "kind": kind}


def dispatch(db, method, path, data):
    if method == "GET" and path == "/graph":
        return 200, {
            "nodes": [dict(row) for row in db.execute("SELECT * FROM nodes ORDER BY id")],
            "edges": [dict(row) for row in db.execute("SELECT * FROM edges ORDER BY source, target, kind")],
        }
    if method == "POST" and path == "/work":
        item = {"id": str(uuid4()), "kind": "work", "title": required(data, "title"), "status": "open"}
        db.execute("INSERT INTO nodes(id, kind, title, status) VALUES (:id, :kind, :title, :status)", item)
        return 201, item
    if method == "PUT" and path == "/changes":
        repository = required(data, "repository")
        external_id = required(data, "external_id")
        db.execute("""
            INSERT INTO nodes(id, kind, title, repository, external_id) VALUES (?, 'change', ?, ?, ?)
            ON CONFLICT(repository, external_id) DO UPDATE SET title = excluded.title
        """, (str(uuid4()), required(data, "title"), repository, external_id))
        return 200, dict(db.execute(
            "SELECT * FROM nodes WHERE repository = ? AND external_id = ?", (repository, external_id)
        ).fetchone())
    if method == "POST" and path == "/links":
        return 201, add_edge(db, data)
    if method == "PATCH" and path.startswith("/work/"):
        item_id = path.removeprefix("/work/")
        row = db.execute("SELECT * FROM nodes WHERE id = ? AND kind = 'work'", (item_id,)).fetchone()
        if row is None:
            raise LookupError("Work item does not exist")
        status = required(data, "status")
        if status not in TRANSITIONS[row["status"]]:
            raise ValueError("Invalid workflow transition")
        db.execute("UPDATE nodes SET status = ? WHERE id = ?", (status, item_id))
        return 200, {**dict(row), "status": status}
    raise LookupError("Endpoint does not exist")


class Handler(BaseHTTPRequestHandler):
    def handle_request(self):
        db = sqlite3.connect("wefttrack.sqlite3")
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 <= size <= 65536:
                raise ValueError("Request body exceeds 64 KiB")
            data = json.loads(self.rfile.read(size)) if size else {}
            if not isinstance(data, dict):
                raise ValueError("Expected a JSON object")
            with db:
                db.execute("BEGIN" if self.command == "GET" else "BEGIN IMMEDIATE")
                status, result = dispatch(db, self.command, self.path, data)
        except ValueError as error:
            status, result = 400, {"error": str(error)}
        except LookupError as error:
            status, result = 404, {"error": str(error)}
        except sqlite3.IntegrityError:
            status, result = 409, {"error": "Relationship already exists"}
        finally:
            db.close()
        payload = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = do_PUT = do_PATCH = handle_request


if __name__ == "__main__":
    with sqlite3.connect("wefttrack.sqlite3") as db:
        db.executescript(SCHEMA)
    HTTPServer(("127.0.0.1", 8090), Handler).serve_forever()
