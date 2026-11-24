"""Personal board filters are durable, private preferences scoped to one project database."""
import sqlite3
from contextlib import closing
import tempfile
import unittest
from pathlib import Path

from app import ClaimConflict, dispatch, initialize, personal_filter_request


class SavedFilterTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for project in ("alpha", "beta"):
            with closing(sqlite3.connect(self.root / project)) as db, db:
                initialize(db)
        self.filter = {"name": "My exports", "query": "  export ", "scope": "mine"}

    def call(self, method, path, data=None, member="m1", project="alpha"):
        with closing(sqlite3.connect(self.root / project)) as db, db:
            db.row_factory = sqlite3.Row
            return dispatch(db, method, path, data or {}, "Member", member, "browser", "viewer")[1]

    def test_scoped_persistence_and_safe_delete(self):
        saved = self.call("POST", "/saved-filters", self.filter)
        self.assertEqual(saved["query"], "export")
        self.assertEqual(self.call("POST", "/saved-filters", self.filter), saved)
        self.assertEqual(self.call("GET", "/graph")["saved_filters"], [saved])
        for identity in ({"member": "m2"}, {"member": ""}, {"project": "beta"}):
            self.assertEqual(self.call("GET", "/graph", **identity)["saved_filters"], [])
        path = "/saved-filters/" + saved["id"]
        self.call("DELETE", path, member="m2")
        self.assertEqual(self.call("GET", "/graph")["saved_filters"], [saved])
        self.call("DELETE", path)
        self.call("DELETE", path)
        self.assertEqual(self.call("GET", "/graph")["saved_filters"], [])

    def test_validation_and_viewer_route_boundary(self):
        saved = self.call("POST", "/saved-filters", self.filter)
        with self.assertRaises(ClaimConflict):
            self.call("POST", "/saved-filters", dict(self.filter, name="MY EXPORTS", scope="blocked"))
        for body in ({"name": " ", "scope":"mine"}, {"name":"Big", "query":"x"*501},
                     {"name":"Bad","scope":[]}, {"name":"Everything"}):
            with self.assertRaises(ValueError):
                self.call("POST", "/saved-filters", body)
        with self.assertRaises(PermissionError):
            self.call("POST", "/saved-filters", self.filter, member="")
        self.assertTrue(personal_filter_request("POST", "/saved-filters"))
        self.assertTrue(personal_filter_request("DELETE", "/saved-filters/"+saved["id"]))
        self.assertFalse(personal_filter_request("POST", "/claims/next"))
        self.assertFalse(personal_filter_request("POST", "/work"))


if __name__ == "__main__":
    unittest.main()
