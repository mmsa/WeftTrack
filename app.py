"""Local-first work tracker and typed relationship graph."""
import json
import hashlib
import os
import re
import secrets
import sqlite3
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from http.cookies import SimpleCookie
from contextlib import closing
from uuid import uuid4

from example import seed_example
from receipts import requirement_receipts, weftgit_port

def repository_root(parent):
    configured = os.environ.get("WEFTGIT_REPOSITORIES") or os.environ.get("FREETHEGIT_REPOSITORIES")
    if configured:
        return Path(configured).expanduser().resolve()
    for name in ("WeftGit", "weftgit", "freethegit"):
        candidate = parent / name / ".repositories"
        if candidate.is_dir():
            return candidate.resolve()
    return (parent / "WeftGit" / ".repositories").resolve()


WEFTGIT_ROOT = repository_root(Path(__file__).resolve().parent.parent)
REPO_SLUG = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}")
COMMIT_ID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
PROJECT_PATH = re.compile(r"/projects/([0-9a-f]{32})(/.*)")
ROLES = {"owner", "admin", "editor", "viewer"}
MANAGEMENT_SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    role TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    archived INTEGER NOT NULL DEFAULT 0
);
"""


def code_hash(code):
    return hashlib.sha256(code.encode()).hexdigest()


def project_database(project):
    return f"wefttrack-project-{project}.sqlite3"


def unique_work_key(catalog, current_database, number):
    # All real workspaces use the same numbered keys, even archived projects.
    files = ["wefttrack.sqlite3", *(project_database(row[0]) for row in catalog.execute("SELECT id FROM projects"))]
    for filename in files:
        if filename == current_database:
            continue
        path = Path(filename)
        if not path.is_file():
            continue
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as other:
            if other.execute("SELECT 1 FROM nodes WHERE rowid=? AND kind='work'", (number,)).fetchone():
                return False
    return True


def search_workspaces(catalog, actor, query):
    if not isinstance(query, str) or len(query) > 160:
        raise ValueError("Search supports up to 160 characters")
    query = query.strip().casefold()
    if not query:
        return {"items": [], "more": False}
    spaces = [("example", "Example project", "wefttrack-example.sqlite3")]
    if actor:
        spaces.append(("local", "My workspace", "wefttrack.sqlite3"))
        for project in catalog.execute("SELECT id,name FROM projects WHERE NOT archived"):
            spaces.append((project["id"], project["name"], project_database(project["id"])))
    matches = []
    key = re.fullmatch(r"wt-0*([0-9]{1,18})", query)
    number = int(key[1]) if key else -1
    for space, name, filename in spaces:
        file = Path(filename)
        if not file.is_file():
            continue
        with closing(sqlite3.connect(file.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            db.create_function("casefold", 1, str.casefold, deterministic=True)
            rows = db.execute("""SELECT n.id,n.rowid AS number,n.title,n.status,
                coalesce(c.owner_name, nullif(n.assignee,''),'') AS owner,
                first_blocker.rowid AS blocker_number, first_blocker.title AS blocker_title,
                (SELECT count(*) FROM edges e JOIN nodes b ON e.source=b.id
                 WHERE e.target=n.id AND e.kind='blocks' AND b.status!='done') AS blockers,
                CASE WHEN n.rowid=:number THEN 0 WHEN casefold(n.title)=:q THEN 1
                     WHEN instr(casefold(n.title),:q)=1 THEN 2 ELSE 3 END AS rank
                FROM nodes n LEFT JOIN claims c ON c.item=n.id AND c.closed_at IS NULL
                LEFT JOIN nodes first_blocker ON first_blocker.rowid=(
                    SELECT min(b.rowid) FROM edges e JOIN nodes b ON e.source=b.id
                    WHERE e.target=n.id AND e.kind='blocks' AND b.status!='done')
                WHERE n.kind='work' AND (n.rowid=:number OR instr(casefold(n.title),:q)>0)
                ORDER BY rank,n.rowid LIMIT 41""", {"q": query, "number": number})
            matches.extend(dict(row, workspace=space, project=name) for row in rows)
    matches.sort(key=lambda row: (row["rank"], row["project"].casefold(), row["workspace"], row["number"]))
    items = matches[:40]
    for item in items:
        del item["rank"]
    return {"items": items, "more": len(matches) > len(items)}


def management(db, actor, method, path, data):
    if method == "GET" and path == "/search":
        return 200, search_workspaces(db, actor, data.get("q", ""))
    owner = db.execute("SELECT id FROM members WHERE role = 'owner'").fetchone()
    role = actor["role"] if actor else None
    if method == "GET" and path == "/settings":
        management_access = role in {"owner", "admin"}
        projects = db.execute("SELECT * FROM projects WHERE NOT archived OR ? ORDER BY name",
                              (management_access,)) if actor else []
        members = db.execute("SELECT id, name, role FROM members ORDER BY name") if actor else []
        return 200, {"actor": actor, "configured": bool(owner), "weftgit_port": weftgit_port(),
                     "projects": [dict(row) for row in projects], "members": [dict(row) for row in members]}
    if method == "POST" and path == "/access":
        code = required(data, "code")
        if not db.execute("SELECT 1 FROM members WHERE code_hash = ?", (code_hash(code),)).fetchone():
            raise PermissionError("Access code is invalid")
        return 200, {"cookie": code}
    if method == "DELETE" and path == "/access":
        return 200, {"cookie": ""}
    if method == "POST" and path == "/setup" and not owner:
        code = secrets.token_urlsafe(32)
        db.execute("INSERT INTO members VALUES (?, ?, 'owner', ?)",
                   (uuid4().hex, required(data, "name"), code_hash(code)))
        return 201, {"code": code, "cookie": code}
    if role not in {"owner", "admin"}:
        raise PermissionError("An administrator is required")
    if method == "POST" and path == "/projects":
        project = uuid4().hex
        db.execute("INSERT INTO projects(id, name) VALUES (?, ?)", (project, required(data, "name")))
        with closing(sqlite3.connect(project_database(project))) as board, board:
            initialize(board)
        return 201, {"id": project}
    if method == "PATCH" and path.startswith("/project-settings/"):
        project = path.removeprefix("/project-settings/")
        row = db.execute("SELECT * FROM projects WHERE id = ?", (project,)).fetchone()
        if row is None:
            raise LookupError("Project not found")
        name = required(data, "name") if "name" in data else row["name"]
        archived = data.get("archived", bool(row["archived"]))
        if not isinstance(archived, bool):
            raise ValueError("Archived must be true or false")
        db.execute("UPDATE projects SET name = ?, archived = ? WHERE id = ?", (name, archived, project))
        return 200, {"id": project}
    if path == "/members" and method == "POST":
        if not owner:
            raise PermissionError("Set up owner access first")
        member_role = required(data, "role")
        if member_role not in ROLES - {"owner"} or (member_role == "admin" and role != "owner"):
            raise PermissionError("Only the owner can grant administrator access")
        code = secrets.token_urlsafe(32)
        db.execute("INSERT INTO members VALUES (?, ?, ?, ?)",
                   (uuid4().hex, required(data, "name"), member_role, code_hash(code)))
        return 201, {"code": code}
    if path.startswith("/members/") and method in {"PATCH", "DELETE"}:
        member = path.removeprefix("/members/")
        row = db.execute("SELECT * FROM members WHERE id = ?", (member,)).fetchone()
        if row is None:
            raise LookupError("Team member not found")
        if row["role"] == "owner" or (row["role"] == "admin" and role != "owner"):
            raise PermissionError("This account cannot be managed by your role")
        if method == "DELETE":
            db.execute("DELETE FROM members WHERE id = ?", (member,))
            return 200, {}
        member_role = required(data, "role")
        if member_role not in ROLES - {"owner"} or (member_role == "admin" and role != "owner"):
            raise PermissionError("Only the owner can grant administrator access")
        db.execute("UPDATE members SET name = ?, role = ? WHERE id = ?",
                   (required(data, "name"), member_role, member))
        return 200, {}
    raise LookupError("Settings endpoint not found")


def hosted_repository(name):
    parts = name.split("/")
    if len(parts) != 2 or not all(REPO_SLUG.fullmatch(part) for part in parts):
        raise ValueError("Invalid WeftGit repository")
    repo = WEFTGIT_ROOT / parts[0] / (parts[1] + ".git")
    if repo.resolve() != repo or not (repo / "HEAD").is_file():
        raise LookupError("WeftGit repository not found")
    return repo


def git_commits(repo, *revisions):
    result = subprocess.run(
        ["git", "--no-replace-objects", "--git-dir", str(repo), "log", "--no-notes",
         "--no-show-signature", "--format=%H%x00%cI%x00%s", *revisions, "--"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5, check=True,
    )
    return [dict(zip(("sha", "date", "title"), line.split("\0", 2)))
            for line in result.stdout.split("\n") if line]


def hosted_changes():
    repositories = []
    for path in sorted(WEFTGIT_ROOT.glob("*/*.git")):
        name = path.parent.name + "/" + path.stem
        try:
            repo = hosted_repository(name)
        except (ValueError, LookupError):
            continue
        try:
            commits = git_commits(repo, "--max-count=20", "--all")
            repositories.append({"name": name, "commits": commits})
        except (OSError, subprocess.SubprocessError):
            repositories.append({"name": name, "error": "Commit history unavailable", "commits": []})
    return {"connected": WEFTGIT_ROOT.is_dir(), "repositories": repositories}

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
CREATE TABLE IF NOT EXISTS saved_filters (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
    query TEXT NOT NULL, scope TEXT NOT NULL, UNIQUE(owner,name)
);
CREATE TABLE IF NOT EXISTS change_aliases (
    old_id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES nodes(id)
);
CREATE TABLE IF NOT EXISTS captures (
    owner TEXT NOT NULL, token TEXT NOT NULL, item TEXT NOT NULL REFERENCES nodes(id),
    fingerprint TEXT, PRIMARY KEY(owner, token)
);
CREATE TABLE IF NOT EXISTS activity (
    seq INTEGER PRIMARY KEY, item TEXT NOT NULL REFERENCES nodes(id),
    actor TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, token TEXT,
    created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(item, token)
);
CREATE INDEX IF NOT EXISTS activity_item ON activity(item, seq);
CREATE TABLE IF NOT EXISTS edges (
    source TEXT NOT NULL REFERENCES nodes(id),
    target TEXT NOT NULL REFERENCES nodes(id),
    kind TEXT NOT NULL CHECK(kind IN ('blocks', 'parent_of', 'implements')),
    CHECK(source <> target),
    PRIMARY KEY(source, target, kind)
);
CREATE INDEX IF NOT EXISTS edges_target ON edges(target);
CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY, item TEXT NOT NULL REFERENCES nodes(id), owner_id TEXT NOT NULL,
    owner_name TEXT NOT NULL, source TEXT NOT NULL, claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT, outcome TEXT, result_change TEXT REFERENCES nodes(id), summary TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS claimed_item ON claims(item) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS claimed_owner ON claims(owner_id) WHERE closed_at IS NULL;
"""
TRANSITIONS = {
    "open": {"active"},
    "active": {"open", "review"},
    "review": {"active", "done"},
    "done": {"open"},
}
WORK_FIELDS = {
    "description": "",
    "assignee": "",
    "priority": "normal",
    "work_type": "task",
    "effort_band": "auto",
}


def canonical_repository(value):
    if value.startswith("freethegit:"):
        return "weftgit:" + value.removeprefix("freethegit:")
    return value


def migrate_hosted_changes(db):
    legacy = db.execute("""SELECT rowid,id,repository,external_id FROM nodes
        WHERE kind='change' AND repository GLOB 'freethegit:*' ORDER BY rowid""").fetchall()
    for number, original, repository, external in legacy:
        name = canonical_repository(repository)
        duplicate = db.execute("SELECT rowid,id FROM nodes WHERE repository=? AND external_id=?", (name, external)).fetchone()
        if duplicate:
            # Retain the earlier work key and resolve links using either former UUID.
            keep, drop = (original, duplicate[1]) if number < duplicate[0] else (duplicate[1], original)
            db.execute("""INSERT OR IGNORE INTO edges(source,target,kind)
                SELECT ?,target,kind FROM edges WHERE source=?""", (keep, drop))
            db.execute("DELETE FROM edges WHERE source=?", (drop,))
            db.execute("UPDATE claims SET result_change=? WHERE result_change=?", (keep, drop))
            db.execute("UPDATE change_aliases SET change_id=? WHERE change_id=?", (keep, drop))
            db.execute("INSERT INTO change_aliases VALUES(?,?)", (drop, keep))
            db.execute("DELETE FROM nodes WHERE id=?", (drop,))
            original = keep
        db.execute("UPDATE nodes SET repository=? WHERE id=?", (name, original))


def initialize(db):
    db.executescript(SCHEMA)
    db.execute("BEGIN IMMEDIATE")
    migrate_hosted_changes(db)
    if "fingerprint" not in {column[1] for column in db.execute("PRAGMA table_info(captures)")}:
        db.execute("ALTER TABLE captures ADD COLUMN fingerprint TEXT")
    columns = {column[1] for column in db.execute("PRAGMA table_info(nodes)")}
    for field, default in WORK_FIELDS.items():
        if field not in columns:
            db.execute(f"ALTER TABLE nodes ADD COLUMN {field} TEXT NOT NULL DEFAULT '{default}'")


def work_fields(data):
    fields = {}
    for name in WORK_FIELDS.keys() & data.keys():
        value = data[name]
        if not isinstance(value, str) or len(value) > (10000 if name == "description" else 120):
            raise ValueError(f"Invalid {name}")
        fields[name] = value.strip()
    if "priority" in fields and fields["priority"] not in {"low", "normal", "high", "urgent"}:
        raise ValueError("Invalid priority")
    if "work_type" in fields and fields["work_type"] not in {"task", "bug", "epic"}:
        raise ValueError("Invalid work type")
    if "effort_band" in fields and fields["effort_band"] not in {"auto", "small", "medium", "large", "epic"}:
        raise ValueError("Invalid effort band")
    if "title" in data:
        fields["title"] = required(data, "title")
    return fields


def required(data, key):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a nonempty string")
    return value.strip()


def add_edge(db, data):
    source, target, kind = (required(data, key) for key in ("source", "target", "kind"))
    alias = db.execute("SELECT change_id FROM change_aliases WHERE old_id=?", (source,)).fetchone()
    if alias:
        source = alias[0]
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


class EditConflict(Exception):
    def __init__(self, fields):
        self.fields = fields
        super().__init__("This item changed while you were editing. Review the conflicting fields.")


class ClaimConflict(Exception):
    pass


def pull_work(db, path, data, name, member, source, role):
    if path == "/claims/next":
        claim = db.execute("SELECT * FROM claims WHERE owner_id=? AND closed_at IS NULL", (member,)).fetchone()
        if not claim:
            target = data.get("item")
            if target is not None and not isinstance(target, str):
                raise ValueError("Choose an item ID")
            item = db.execute("""SELECT n.id FROM nodes n WHERE n.kind='work' AND n.status='open'
                AND (n.assignee='' OR n.assignee=? COLLATE NOCASE) AND (? IS NULL OR n.id=?)
                AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.item=n.id AND c.closed_at IS NULL)
                AND NOT EXISTS (SELECT 1 FROM edges e JOIN nodes blocker ON blocker.id=e.source
                    WHERE e.target=n.id AND e.kind='blocks' AND blocker.status!='done')
                ORDER BY CASE n.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                    n.rowid LIMIT 1""", (name, target, target)).fetchone()
            if not item:
                raise ClaimConflict("No eligible work is available")
            claim_id = uuid4().hex
            db.execute("INSERT INTO claims(id,item,owner_id,owner_name,source) VALUES (?,?,?,?,?)",
                       (claim_id, item["id"], member, name, source))
            db.execute("UPDATE nodes SET status='active',assignee=? WHERE id=?", (name, item["id"]))
            db.execute("INSERT INTO activity(item,actor,kind,body) VALUES(?,?,'event',?)",
                       (item["id"], name, "Claimed this requirement via " + source))
            claim = db.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone()
        elif data.get("item") not in (None, claim["item"]):
            raise ClaimConflict("Finish or release your current claim first")
        item = db.execute("SELECT rowid AS number,* FROM nodes WHERE id=?", (claim["item"],)).fetchone()
        return 200, {"claim": dict(claim), "item": dict(item)}
    match = re.fullmatch(r"/claims/([0-9a-f]{32})/(release|report)", path)
    if not match:
        raise LookupError("Claim endpoint not found")
    claim_id, action = match.groups()
    claim = db.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone()
    if not claim:
        raise LookupError("Claim not found")
    if member != claim["owner_id"] and not (action == "release" and role in {"owner","admin"}):
        raise PermissionError("Only the claimant can submit this result")
    if action == "report":
        summary = required(data, "summary")
        evidence = {field: required(data, field) for field in ("repository", "external_id", "title")}
        evidence["repository"] = canonical_repository(evidence["repository"])
        if len(summary) > 4000:
            raise ValueError("Result summary exceeds 4000 characters")
    if claim["closed_at"]:
        if claim["outcome"] != action:
            raise ClaimConflict("This claim is already closed")
        if action == "report":
            linked = db.execute("SELECT repository,external_id FROM nodes WHERE id=?", (claim["result_change"],)).fetchone()
            if (claim["summary"] != summary or not linked or
                    tuple(linked) != (evidence["repository"], evidence["external_id"])):
                raise ClaimConflict("This claim already has a different submitted result. Open the item to review it.")
        return 200, dict(claim)
    item = claim["item"]
    change_id = None
    if action == "release":
        summary = None
        db.execute("UPDATE nodes SET status='open',assignee='' WHERE id=?", (item,))
        body = "Released the claim back to the queue"
    else:
        _, change = dispatch(db, "PUT", "/changes", evidence)
        change_id = change["id"]
        db.execute("INSERT OR IGNORE INTO edges VALUES (?,?,'implements')", (change_id,item))
        db.execute("UPDATE nodes SET status='review' WHERE id=?", (item,))
        body = "Submitted for review via " + source + ": " + summary
    db.execute("""UPDATE claims SET closed_at=CURRENT_TIMESTAMP,outcome=?,result_change=?,summary=?
        WHERE id=?""", (action, change_id, summary, claim_id))
    db.execute("INSERT INTO activity(item,actor,kind,body) VALUES(?,?,'event',?)", (item,name,body))
    return 200, dict(db.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone())


def personal_filter_request(method, path):
    return ((method == "POST" and path == "/saved-filters") or
            (method == "DELETE" and re.fullmatch(r"/saved-filters/[0-9a-f]{32}", path) is not None))


def save_personal_filter(db, member, data):
    name = required(data, "name")
    query = data.get("query", "")
    scope = data.get("scope", "all")
    if len(name) > 80 or not isinstance(query, str) or len(query) > 500:
        raise ValueError("Use up to 80 characters for the name and 500 for the search")
    if scope not in ("all", "attention", "blocked", "unassigned", "linked", "unlinked", "mine"):
        raise ValueError("Choose a supported board filter")
    query = query.strip()
    if not query and scope == "all":
        raise ValueError("Choose a filter or enter a search first")
    record = db.execute("SELECT id,name,query,scope FROM saved_filters WHERE owner=? AND name=?", (member, name)).fetchone()
    if record:
        if (record["query"], record["scope"]) == (query, scope):
            return 200, dict(record)
        raise ClaimConflict("A saved filter already uses this name. Choose a different name.")
    record = {"id": uuid4().hex, "name": name, "query": query, "scope": scope}
    db.execute("INSERT INTO saved_filters VALUES(:id,:owner,:name,:query,:scope)", dict(record, owner=member))
    return 201, record


def dispatch(db, method, path, data, actor="Local owner", member="local-owner", source="browser", role="owner", discover_key=None):
    if personal_filter_request(method, path):
        if not member:
            raise PermissionError("Sign in to manage saved filters")
        if method == "POST":
            return save_personal_filter(db, member, data)
        db.execute("DELETE FROM saved_filters WHERE id=? AND owner=?", (path.rsplit("/", 1)[1], member))
        return 200, {}
    if method == "POST" and path.startswith("/claims/"):
        return pull_work(db, path, data, actor, member, source, role)
    receipt = re.fullmatch(r"/work/([^/]+)/release-receipts", path)
    if method == "GET" and receipt:
        return 200, requirement_receipts(db, receipt[1], discover_key)
    work_read = re.fullmatch(r"/work/([^/]+)", path)
    if method == "GET" and work_read:
        item = db.execute("SELECT rowid AS number,* FROM nodes WHERE id=? AND kind='work'", (work_read[1],)).fetchone()
        if not item:
            raise LookupError("Work item not found")
        claim = db.execute("SELECT owner_name,source,claimed_at FROM claims WHERE item=? AND closed_at IS NULL",
                           (item["id"],)).fetchone()
        links = db.execute("""SELECT e.kind AS relationship,e.source,e.target,n.id,n.kind,n.rowid AS number,
                   n.title,n.status,n.repository,n.external_id FROM edges e JOIN nodes n ON n.id=
                   CASE WHEN e.source=:id THEN e.target ELSE e.source END
                   WHERE e.source=:id OR e.target=:id ORDER BY n.rowid,e.kind""", {"id": item["id"]})
        return 200, {"item": dict(item), "claim": dict(claim) if claim else None,
                     "related": [dict(link) for link in links]}
    timeline = re.fullmatch(r"/work/([^/]+)/activity", path)
    if timeline and method in {"GET", "POST"}:
        item = timeline[1]
        if not db.execute("SELECT 1 FROM nodes WHERE id=? AND kind='work'", (item,)).fetchone():
            raise LookupError("Work item not found")
        if method == "POST":
            note, token = required(data, "body"), required(data, "token")
            if len(note) > 4000 or len(token) > 80:
                raise ValueError("Comment or request identifier is too long")
            previous = db.execute("SELECT actor,body FROM activity WHERE item=? AND token=?", (item, token)).fetchone()
            if previous and (previous["actor"], previous["body"]) != (actor, note):
                raise ValueError("This comment identifier already belongs to another submission")
            db.execute("""INSERT INTO activity(item,actor,kind,body,token) VALUES(?,?,'comment',?,?)
                       ON CONFLICT(item,token) DO NOTHING""", (item, actor, note, token))
        return 200, {"events": [dict(row) for row in db.execute(
            "SELECT seq,actor,kind,body,created FROM activity WHERE item=? ORDER BY seq DESC", (item,))]}

    if method == "GET" and path in {"/weftgit", "/freethegit"}:
        return 200, hosted_changes()
    if method == "POST" and path in {"/weftgit/links", "/freethegit/links"}:
        repository, sha, target = (required(data, key) for key in ("repository", "sha", "target"))
        if not COMMIT_ID.fullmatch(sha):
            raise ValueError("Invalid commit ID")
        repo = hosted_repository(repository)
        try:
            commits = git_commits(repo, "--max-count=1", sha)
        except (OSError, subprocess.SubprocessError):
            raise LookupError("Commit unavailable in WeftGit")
        if not commits or commits[0]["sha"] != sha:
            raise LookupError("Commit not found")
        _, change = dispatch(db, "PUT", "/changes", {
            "repository": "weftgit:" + repository, "external_id": "commit:" + sha,
            "title": commits[0]["title"].strip() or "Commit " + sha[:8],
        })
        source = change["id"]
        if not db.execute("SELECT 1 FROM edges WHERE source = ? AND target = ? AND kind = 'implements'",
                          (source, target)).fetchone():
            add_edge(db, {"source": source, "target": target, "kind": "implements"})
        return 200, change
    if method == "GET" and path == "/graph":
        return 200, {
            "transitions": {status: sorted(targets) for status, targets in TRANSITIONS.items()},
            "nodes": [dict(row) for row in db.execute("SELECT rowid AS number,* FROM nodes ORDER BY rowid")],
            "change_aliases": dict(db.execute("SELECT old_id,change_id FROM change_aliases")),
            "saved_filters": [dict(row) for row in db.execute(
                "SELECT id,name,query,scope FROM saved_filters WHERE owner=? ORDER BY name", (member,))] if member else [],
            "claims": [dict(row) for row in db.execute("SELECT * FROM claims ORDER BY rowid")],
            "edges": [dict(row) for row in db.execute("SELECT * FROM edges ORDER BY source, target, kind")],
        }
    if method == "POST" and path == "/work":
        fields = {**WORK_FIELDS, **work_fields(data), "title": required(data, "title")}
        token = data.get("capture_token")
        if token is not None:
            if not isinstance(token, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", token):
                raise ValueError("Invalid capture identifier")
            fingerprint = hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()
            existing = db.execute("SELECT item,fingerprint FROM captures WHERE owner=? AND token=?", (member, token)).fetchone()
            if existing:
                if existing["fingerprint"] and existing["fingerprint"] != fingerprint:
                    raise ClaimConflict("The earlier version of this requirement was saved. Open it in the log to edit it.")
                return 200, dict(db.execute("SELECT * FROM nodes WHERE id=?", (existing["item"],)).fetchone())
        item = {**fields, "id": str(uuid4()), "kind": "work", "status": "open"}
        db.execute("""INSERT INTO nodes(id, kind, title, status, description, assignee, priority, work_type, effort_band)
                      VALUES (:id, :kind, :title, :status, :description, :assignee, :priority, :work_type, :effort_band)""", item)
        db.execute("INSERT INTO activity(item,actor,kind,body) VALUES(?,?,'event','Created this item')", (item["id"], actor))
        if token:
            db.execute("INSERT INTO captures(owner,token,item,fingerprint) VALUES(?,?,?,?)", (member, token, item["id"], fingerprint))
        return 201, item
    if method == "PUT" and path == "/changes":
        repository = canonical_repository(required(data, "repository"))
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
        claim = db.execute("SELECT id FROM claims WHERE item=? AND closed_at IS NULL", (item_id,)).fetchone()
        if claim and (("assignee" in data and data["assignee"] != row["assignee"]) or "status" in data):
            raise ClaimConflict("Report a result or release the claim in Requirements first")
        changes = work_fields(data)
        if "status" in data:
            status = required(data, "status")
            if status not in TRANSITIONS[row["status"]]:
                raise ValueError("Invalid workflow transition")
            changes["status"] = status
        if not changes:
            raise ValueError("Provide a work item field to update")
        expected = data.get("expected", {})
        if not isinstance(expected, dict) or any(field not in changes for field in expected):
            raise ValueError("Expected values must refer to fields being updated")
        conflicts = {field: row[field] for field, previous in expected.items()
                     if row[field] != previous and row[field] != changes[field]}
        if conflicts:
            raise EditConflict(conflicts)
        assignments = ", ".join(f"{field} = ?" for field in changes)
        db.execute(f"UPDATE nodes SET {assignments} WHERE id = ?", (*changes.values(), item_id))
        labels = {"work_type": "type", "effort_band": "effort"}
        for field, value in sorted(changes.items()):
            if value == row[field]:
                continue
            label = labels.get(field, field)
            if field in {"description", "title"}:
                summary = f"Updated the {label}"
            else:
                previous = row[field] or "unassigned"
                summary = f"Changed {label} from {previous} to {value or 'unassigned'}"
            db.execute("INSERT INTO activity(item,actor,kind,body) VALUES(?,?,'event',?)", (item_id, actor, summary))
        return 200, {**dict(row), **changes}
    raise LookupError("Endpoint does not exist")


STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/ui.js": ("ui.js", "text/javascript; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Host") not in {"127.0.0.1:8090", "localhost:8090"}:
            self.send_error(403)
            return
        static_path = urlsplit(self.path).path
        if static_path not in STATIC_FILES:
            self.handle_request()
            return
        filename, content_type = STATIC_FILES[static_path]
        payload = Path(__file__).with_name(filename).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_request(self):
        host = self.headers.get("Host")
        origin = self.headers.get("Origin")
        if host not in {"127.0.0.1:8090", "localhost:8090"} or (origin and origin != "http://" + host):
            self.send_error(403)
            return
        example = self.path.startswith("/example/")
        path = self.path.removeprefix("/example") if example else self.path
        search = urlsplit(self.path)
        if self.command == "GET" and search.path == "/search":
            path = "/search"
        catalog = not example and (path in {"/search", "/settings", "/setup", "/access", "/members", "/projects"} or
                                   path.startswith(("/members/", "/project-settings/")))
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 <= size <= 65536:
                raise ValueError("Request body exceeds 64 KiB")
            data = json.loads(self.rfile.read(size)) if size else {}
            if self.command == "GET" and path == "/search":
                data = {"q": parse_qs(search.query).get("q", [""])[0]}
            if not isinstance(data, dict):
                raise ValueError("Expected a JSON object")
            with closing(sqlite3.connect("wefttrack.sqlite3")) as settings:
                settings.row_factory = sqlite3.Row
                cookie = SimpleCookie(self.headers.get("Cookie", "")).get("wefttrack_access")
                authorization = self.headers.get("Authorization")
                token = cookie.value if cookie else ""
                if authorization:
                    scheme, _, token = authorization.partition(" ")
                    if scheme.lower() != "bearer" or not token:
                        raise PermissionError("Provide a member access code as a bearer token")
                member = settings.execute("SELECT id, name, role FROM members WHERE code_hash = ?",
                                          (code_hash(token),)).fetchone() if token else None
                if authorization and not member:
                    raise PermissionError("Agent access code is invalid")
                configured = settings.execute("SELECT 1 FROM members WHERE role = 'owner'").fetchone()
                actor = dict(member) if member else None
                if not configured:
                    actor = {"id": "local-owner", "name": "Local owner", "role": "owner"}
                if catalog:
                    with settings:
                        settings.execute("BEGIN" if self.command == "GET" else "BEGIN IMMEDIATE")
                        status, result = management(settings, actor, self.command, path, data)
                else:
                    public_example_read = example and self.command == "GET" and (path == "/graph" or re.fullmatch(r"/work/[^/]+(?:/release-receipts)?", path))
                    if not actor and not public_example_read:
                        raise PermissionError("Sign in to access this workspace")
                    database = "wefttrack-example.sqlite3" if example else "wefttrack.sqlite3"
                    project = PROJECT_PATH.fullmatch(path) if not example else None
                    if project:
                        project_id, path = project.groups()
                        if not settings.execute("SELECT 1 FROM projects WHERE id = ? AND NOT archived",
                                                (project_id,)).fetchone():
                            raise LookupError("Project not found or archived")
                        database = project_database(project_id)
                    if actor and actor["role"] == "viewer" and self.command != "GET" and not personal_filter_request(self.command, path):
                        raise PermissionError("Viewers have read-only access")
                    with closing(sqlite3.connect(database)) as db, db:
                        db.row_factory = sqlite3.Row
                        db.execute("PRAGMA foreign_keys = ON")
                        db.execute("BEGIN" if self.command == "GET" else "BEGIN IMMEDIATE")
                        status, result = dispatch(db, self.command, path, data, actor["name"] if actor else "",
                            actor["id"] if actor else "", "agent API" if authorization else "browser", actor["role"] if actor else "",
                            discover_key=None if example else lambda number: unique_work_key(settings, database, number))
                        if self.command == "POST" and path == "/claims/next":
                            workspace = project_id if project else "example" if example else "local"
                            result["url"] = f"http://{host}/?workspace={workspace}&item={result['item']['id']}#board"
        except EditConflict as error:
            status, result = 409, {"error": str(error), "conflicts": error.fields}
        except ClaimConflict as error:
            status, result = 409, {"error": str(error)}
        except ValueError as error:
            status, result = 400, {"error": str(error)}
        except LookupError as error:
            status, result = 404, {"error": str(error)}
        except PermissionError as error:
            status, result = 403, {"error": str(error)}
        except sqlite3.IntegrityError:
            status, result = 409, {"error": "That name is already in use" if catalog else "Relationship already exists"}
        access_code = result.pop("cookie", None)
        payload = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        if access_code is not None:
            lifetime = "" if access_code else "; Max-Age=0"
            self.send_header("Set-Cookie", f"wefttrack_access={access_code}; Path=/; HttpOnly; SameSite=Strict{lifetime}")
        self.end_headers()
        self.wfile.write(payload)

    do_POST = do_PUT = do_PATCH = do_DELETE = handle_request


if __name__ == "__main__":
    with closing(sqlite3.connect("wefttrack.sqlite3")) as db, db:
        initialize(db)
        db.commit()
        db.executescript(MANAGEMENT_SCHEMA)
        for (project,) in db.execute("SELECT id FROM projects"):
            project_file = Path(project_database(project))
            if project_file.is_file():
                with closing(sqlite3.connect(project_file)) as board, board:
                    initialize(board)
    with closing(sqlite3.connect("wefttrack-example.sqlite3")) as db, db:
        initialize(db)
        seed_example(db)
    HTTPServer(("127.0.0.1", 8090), Handler).serve_forever()
