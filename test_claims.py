"""Regression coverage for queue selection and concurrent ownership."""
import concurrent.futures
import sqlite3
from contextlib import closing
import tempfile
import threading
import unittest
from pathlib import Path

from app import ClaimConflict, dispatch, initialize


class ClaimTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "workspace.sqlite3"
        with closing(sqlite3.connect(self.database)) as db, db:
            initialize(db)

    def request(self, method, path, data, actor="Mina"):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("BEGIN IMMEDIATE")
            return dispatch(db, method, path, data, actor, actor, "agent API", "editor")[1]

    def test_quick_capture_retry_is_scoped_to_actor(self):
        body = {"title": "Capture a requirement", "capture_token": "capture-123"}
        first = self.request("POST", "/work", body)
        repeat = self.request("POST", "/work", body)
        with self.assertRaises(ClaimConflict):
            self.request("POST", "/work", {**body, "description": "Different requirement"})
        other = self.request("POST", "/work", body, "Another editor")
        self.assertEqual(first["id"], repeat["id"])
        self.assertNotEqual(first["id"], other["id"])
        self.assertEqual(len(self.request("GET", "/graph", {})["nodes"]), 2)

    def test_concurrent_claim_and_report(self):
        def item(name, **fields):
            return self.request("POST", "/work", {"title": name, **fields})["id"]

        blocked = item("Blocked", priority="urgent")
        blocker = item("Assigned elsewhere", assignee="Ola")
        ready = item("Ready")
        self.request("POST", "/links", {"source": blocker, "target": blocked, "kind": "blocks"})
        gate = threading.Barrier(2)

        def compete(actor):
            gate.wait()
            try:
                return self.request("POST", "/claims/next", {}, actor)["claim"]
            except ClaimConflict:
                return None

        with concurrent.futures.ThreadPoolExecutor(2) as workers:
            winners = [result for result in workers.map(compete, ["Mina", "Rowan"]) if result]
        self.assertEqual(len(winners), 1)
        claim = winners[0]
        self.assertEqual(claim["item"], ready)
        owner = claim["owner_name"]
        self.assertEqual(self.request("POST", "/claims/next", {}, owner)["claim"], claim)
        report = "/claims/" + claim["id"] + "/report"
        body = {"title": "Reviewed export", "summary": "Export verified", "repository": "weftgit:team/export", "external_id": "pr:1"}
        with self.assertRaises(PermissionError):
            self.request("POST", report, body, "Someone else")
        with self.assertRaises(ClaimConflict):
            self.request("PATCH", "/work/" + ready, {"status": "review"}, owner)
        result = self.request("POST", report, body, owner)
        self.assertEqual(self.request("POST", report, body, owner), result)
        for changed in ({"summary": "Another outcome"}, {"external_id": "pr:2"}):
            with self.assertRaises(ClaimConflict):
                self.request("POST", report, {**body, **changed}, owner)
        graph = self.request("GET", "/graph", {})
        self.assertIn({"source": result["result_change"], "target": ready, "kind": "implements"}, graph["edges"])
        self.assertEqual(next(n for n in graph["nodes"] if n["id"] == ready)["status"], "review")
        history = self.request("GET", "/work/" + ready + "/activity", {})["events"]
        self.assertEqual(history[0]["actor"], owner)
        self.assertIn("Export verified", history[0]["body"])


if __name__ == "__main__":
    unittest.main()
