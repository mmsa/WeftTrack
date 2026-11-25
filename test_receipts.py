"""Check release evidence at the boundary between a work item and its local Git host."""
import json
import os
import sqlite3
import unittest
from unittest.mock import patch

from app import dispatch, initialize
from receipts import fetch_evidence, verify_payload


SHA = "a" * 40
MERGE = "b" * 40
PUBLISHED = "c" * 40
ORIGIN = "http://127.0.0.1:9011"


def publication():
    return {"environment": "production", "published_sha": PUBLISHED, "published_at": "2026-11-25 12:30:00",
            "current": True, "archive_url": f"{ORIGIN}/artifacts/team/repo/production/{PUBLISHED}.zip",
            "site_url": f"{ORIGIN}/sites/team/repo/production/{PUBLISHED}/",
            "environment_url": f"{ORIGIN}/environments/team/repo/production/"}


def payload():
    return {"repository": "team/repo", "pull_request": 8, "reviewed_sha": SHA, "merge_sha": MERGE,
            "verified": True, "reason": "Published", "releases": [publication()]}


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        initialize(self.db)
        self.task = self.call("POST", "/work", title="Ship export")["id"]
        self.path = "/work/" + self.task + "/release-receipts"
        self.pr = {"repo": "team/repo", "pr": "8"}

    def call(self, method, path, **fields):
        return dispatch(self.db, method, path, fields)[1]

    def link(self, external, repo="weftgit:team/repo", target=None):
        change = self.call("PUT", "/changes", title=external, repository=repo, external_id=external)["id"]
        self.call("POST", "/links", source=change, target=target or self.task, kind="implements")

    def test_only_supported_implementing_changes_for_this_item_are_checked(self):
        other = self.call("POST", "/work", title="Second work")["id"]
        self.link("pr:1", target=other)
        self.link("pr:2", repo="elsewhere")
        self.link("commit:abc123")
        with patch("receipts.fetch_evidence") as lookup:
            self.assertEqual(self.call("GET", self.path), {"receipts": []})
            lookup.assert_not_called()
        with self.assertRaises(LookupError):
            self.call("GET", "/work/missing/release-receipts")

    def test_independent_failure_and_verified_commit_do_not_change_work(self):
        self.link("pr:8")
        self.link("commit:" + SHA)
        verified = verify_payload({"repo": "team/repo", "commit": SHA},
                                  dict(payload(), pull_request=None, reviewed_sha=None, merge_sha=None, commit_sha=SHA), 9011)
        before = self.db.total_changes
        with patch("receipts.fetch_evidence", side_effect=[ConnectionRefusedError(), verified]) as lookup:
            rows = self.call("GET", self.path)["receipts"]
        self.assertEqual([row["state"] for row in rows], ["unavailable", "verified"])
        self.assertEqual([call.args[0] for call in lookup.call_args_list], [self.pr, {"repo": "team/repo", "commit": SHA}])
        self.assertIsNone(rows[1]["reviewed_sha"])
        self.assertEqual(self.db.total_changes, before)

    def test_unverified_read_cannot_accidentally_show_links(self):
        data = dict(payload(), verified=False, reason="No verified merge")
        receipt = verify_payload(self.pr, data, 9011)
        self.assertEqual(receipt, {"state": "unverified", "reason": "No verified merge", "releases": []})

    def test_mismatched_provenance_and_bad_archive_are_unavailable(self):
        for override in ({"repository": "other/repo"}, {"reviewed_sha": "abc"}, {"merge_sha": None},
                         {"pull_request": 9}, {"releases": []},
                         {"releases": [dict(publication(), published_at=30)]},
                         {"releases": [dict(publication(), archive_url=ORIGIN + "/artifacts/wrong/repo/archive.zip")]},
                         {"releases": [dict(publication(), archive_url="http://elsewhere.org/archive.zip")]}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                verify_payload(self.pr, dict(payload(), **override), 9011)

    def test_historical_receipt_retains_archive_but_no_live_link(self):
        data = payload()
        data["releases"][0].update(current=False, site_url="https://example.org")
        receipt = verify_payload(self.pr, data, 9011)
        self.assertEqual((receipt["reviewed_sha"], receipt["merge_sha"]), (SHA, MERGE))
        self.assertTrue(receipt["releases"][0]["archive_url"].endswith(PUBLISHED + ".zip"))
        self.assertIsNone(receipt["releases"][0]["environment_url"])
        self.assertIsNone(receipt["releases"][0]["site_url"])

    def test_loopback_request_uses_configured_port_and_no_user_credentials(self):
        with patch.dict(os.environ, {"WEFTGIT_PORT": "9011"}), patch("receipts.HTTPConnection") as http:
            response = http.return_value.getresponse.return_value
            response.status = 200
            response.read.return_value = json.dumps(payload()).encode()
            actual = fetch_evidence(self.pr, 2)
        http.assert_called_once_with("127.0.0.1", 9011, timeout=2)
        http.return_value.request.assert_called_once_with("GET", "/api/release-receipt?repo=team%2Frepo&pr=8")
        self.assertEqual(actual["state"], "verified")
        http.return_value.close.assert_called_once()
