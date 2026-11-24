"""Narrow API reads expose the requested requirement's context without mutating it."""
import sqlite3
import unittest

from app import dispatch, initialize


class TaskBriefTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        initialize(self.db)

    def call(self, method, path, **fields):
        return dispatch(self.db, method, path, fields)[1]

    def test_task_context_preserves_relationship_direction_and_claim(self):
        task = self.call("POST", "/work", title="Ship search", description="Match issue keys")["id"]
        downstream = self.call("POST", "/work", title="Publish docs")["id"]
        change = self.call("PUT", "/changes", title="Wire search", repository="freethegit:team/repo", external_id="pr:5")["id"]
        unrelated = self.call("POST", "/work", title="Unrelated")["id"]
        self.call("POST", "/links", source=task, target=downstream, kind="blocks")
        self.call("POST", "/links", source=change, target=task, kind="implements")
        self.call("POST", "/claims/next", item=task)
        count = self.db.total_changes
        result = self.call("GET", "/work/" + task)
        self.assertEqual(self.db.total_changes, count)
        self.assertEqual(result["item"]["description"], "Match issue keys")
        self.assertEqual(set(result["claim"]), {"owner_name", "source", "claimed_at"})
        related = {row["id"]: row for row in result["related"]}
        self.assertNotIn(unrelated, related)
        self.assertEqual((related[downstream]["source"], related[downstream]["relationship"]), (task, "blocks"))
        self.assertEqual((related[change]["target"], related[change]["external_id"]), (task, "pr:5"))
        for invalid in (change, "missing"):
            with self.assertRaises(LookupError):
                self.call("GET", "/work/"+invalid)


if __name__ == "__main__":
    unittest.main()
