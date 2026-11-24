"""First-run data for the separate example workspace."""
from uuid import NAMESPACE_URL, uuid5


def seed_example(db):
    """Create the example project once, including its directed relationships."""
    if db.execute("SELECT 1 FROM nodes LIMIT 1").fetchone():
        return
    items = [
        ("Ship the export workspace", "active"),
        ("Design the export settings panel", "open"),
        ("Document CSV column mapping", "open"),
        ("Add export progress feedback", "open"),
        ("Stream large CSV downloads", "active"),
        ("Implement export permissions", "active"),
        ("Review empty export states", "review"),
        ("Validate UTF-8 encoding", "review"),
        ("Define the export schema", "done"),
        ("Add the export entry point", "done"),
    ]
    changes = [
        ("Stream results in batches", "exports/api", "PR-48"),
        ("Enforce export access rules", "exports/api", "PR-51"),
        ("Add download action to reports", "reports/web", "PR-43"),
    ]
    ids = [str(uuid5(NAMESPACE_URL, f"wefttrack/example/{i}")) for i in range(13)]
    for i, (title, status) in enumerate(items):
        db.execute("INSERT INTO nodes(id, kind, title, status) VALUES (?, 'work', ?, ?)",
                   (ids[i], title, status))
    for i, (title, repo, change) in enumerate(changes, len(items)):
        db.execute("INSERT INTO nodes(id, kind, title, repository, external_id) VALUES (?, 'change', ?, ?, ?)",
                   (ids[i], title, repo, change))
    for source, target, kind in [
        (0, 1, "parent_of"), (0, 4, "parent_of"), (0, 5, "parent_of"),
        (0, 6, "parent_of"), (0, 9, "parent_of"), (4, 3, "blocks"),
        (5, 1, "blocks"), (8, 2, "blocks"), (10, 4, "implements"),
        (11, 5, "implements"), (12, 9, "implements"),
    ]:
        db.execute("INSERT INTO edges VALUES (?, ?, ?)", (ids[source], ids[target], kind))
