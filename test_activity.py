"""Exercise the activity log against real work-item updates and SQLite transactions."""
import sqlite3
import unittest

from app import EditConflict, dispatch, initialize


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        initialize(self.db)
        self.item = dispatch(self.db, "POST", "/work", {"title": "Publish export"}, "Mina")[1]["id"]
        self.path = "/work/" + self.item
        self.db.commit()

    def events(self):
        return dispatch(self.db, "GET", self.path + "/activity", {})[1]["events"]

    def test_attribution_and_rollback(self):
        dispatch(self.db, "PATCH", self.path, {"status": "active"}, "Lee")
        self.assertEqual(self.events()[0]["actor"], "Lee")
        self.assertIn("from open to active", self.events()[0]["body"])
        self.db.rollback()
        self.assertEqual([event["actor"] for event in self.events()], ["Mina"])

    def test_concurrent_edits_merge_and_conflicts_keep_server_value(self):
        dispatch(self.db, "PATCH", self.path, {"priority": "urgent", "expected": {"priority": "normal"}}, "Lee")
        body = {"title": "Ship export", "expected": {"title": "Publish export"}}
        dispatch(self.db, "PATCH", self.path, body, "Mina")
        dispatch(self.db, "PATCH", self.path, body, "Mina")
        with self.assertRaises(EditConflict) as conflict:
            dispatch(self.db, "PATCH", self.path, {"title": "Another title", "expected": {"title": "Publish export"}}, "Kai")
        self.assertEqual(conflict.exception.fields, {"title": "Ship export"})
        item = dispatch(self.db, "GET", "/graph", {})[1]["nodes"][0]
        self.assertEqual((item["title"], item["priority"]), ("Ship export", "urgent"))
        self.assertEqual(len(self.events()), 3)

    def test_comment_retry_and_conflict(self):
        note = {"body": "Found the requirement.", "token": "run-1"}
        for _ in range(2):
            dispatch(self.db, "POST", self.path + "/activity", note, "Kai")
        self.assertEqual(len(self.events()), 2)
        with self.assertRaises(ValueError):
            dispatch(self.db, "POST", self.path + "/activity", {**note, "body": "Different"}, "Kai")

    def test_missing_item_and_empty_comment(self):
        with self.assertRaises(LookupError):
            dispatch(self.db, "GET", "/work/missing/activity", {})
        with self.assertRaises(ValueError):
            dispatch(self.db, "POST", self.path + "/activity", {"body": " ", "token": "run-2"})
