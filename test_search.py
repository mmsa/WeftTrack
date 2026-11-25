"""Cross-project search scope, matching and result context."""
import os
import sqlite3
from contextlib import closing
import tempfile
import unittest

from app import MANAGEMENT_SCHEMA, dispatch, initialize, project_database, search_workspaces, unique_work_key


class SearchTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(directory.name)
        for path in ("wefttrack.sqlite3", "wefttrack-example.sqlite3", project_database("a"), project_database("b")):
            with closing(sqlite3.connect(path)) as db, db:
                db.row_factory = sqlite3.Row
                initialize(db)
                dispatch(db, "POST", "/work", {"title": "Shared Café", "assignee": "Alex"})
        self.catalog = sqlite3.connect("wefttrack.sqlite3")
        self.addCleanup(self.catalog.close)
        self.catalog.row_factory = sqlite3.Row
        self.catalog.executescript(MANAGEMENT_SCHEMA)
        self.catalog.executemany("INSERT INTO projects VALUES (?,?,?)", [("a", "Live", 0), ("b", "Archived", 1)])
        self.catalog.commit()

    def test_discovery_keys_include_archived_projects_and_exclude_the_sample(self):
        self.assertFalse(unique_work_key(self.catalog, project_database("a"), 1))
        def add_work(path):
            with closing(sqlite3.connect(path)) as db, db:
                db.row_factory = sqlite3.Row
                dispatch(db, "POST", "/work", {"title": "Second task"})
        add_work(project_database("a"))
        add_work("wefttrack-example.sqlite3")
        self.assertTrue(unique_work_key(self.catalog, project_database("a"), 2))
        add_work(project_database("b"))
        self.assertFalse(unique_work_key(self.catalog, project_database("a"), 2))

    def test_visibility_and_duplicate_keys(self):
        public = search_workspaces(self.catalog, None, "wt-1")
        self.assertEqual([r["workspace"] for r in public["items"]], ["example"])
        for role in ("owner", "viewer"):
            found = search_workspaces(self.catalog, {"role": role}, "WT-001")
            self.assertEqual({r["workspace"] for r in found["items"]}, {"example", "local", "a"})
            self.assertEqual(len({r["id"] for r in found["items"]}), 3)
            self.assertTrue(all(r["number"] == 1 for r in found["items"]))

    def test_context_and_matching(self):
        with closing(sqlite3.connect(project_database("a"))) as db, db:
            db.row_factory = sqlite3.Row
            target = db.execute("SELECT id FROM nodes").fetchone()[0]
            blocker = dispatch(db, "POST", "/work", {"title":"Handle 50% of tests"})[1]
            dispatch(db, "POST", "/links", {"source":blocker["id"], "target":target, "kind":"blocks"})
            second = dispatch(db, "POST", "/work", {"title":"Second blocker"})[1]
            dispatch(db, "POST", "/links", {"source":second["id"], "target":target, "kind":"blocks"})
            dispatch(db, "PUT", "/changes", {"repository":"example", "external_id":"pr:99","title":"Shared Café"})
        found = search_workspaces(self.catalog, {"role":"viewer"}, "CAFÉ")
        live = next(r for r in found["items"] if r["workspace"] == "a")
        self.assertEqual((live["blockers"], live["owner"], live["status"]), (2,"Alex","open"))
        self.assertEqual((live["blocker_number"], live["blocker_title"]), (2, "Handle 50% of tests"))
        self.assertEqual(len(found["items"]), 3)
        self.assertEqual(len(search_workspaces(self.catalog, {"role":"editor"}, "%")["items"]), 1)
        self.assertEqual(search_workspaces(self.catalog, None, "  ")["items"], [])
        with self.assertRaises(ValueError):
            search_workspaces(self.catalog, None, "x" * 161)

    def test_result_limit_preserves_best_matches(self):
        with closing(sqlite3.connect("wefttrack-example.sqlite3")) as db, db:
            db.row_factory = sqlite3.Row
            for i in range(46):
                dispatch(db, "POST", "/work", {"title":"Batch " + str(i)})
            dispatch(db, "POST", "/work", {"title":"Batch"})
        found = search_workspaces(self.catalog, None, "batch")
        self.assertTrue(found["more"])
        self.assertEqual(len(found["items"]), 40)
        self.assertEqual(found["items"][0]["title"], "Batch")


if __name__ == "__main__":
    unittest.main()
