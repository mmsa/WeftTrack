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


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        initialize(self.db)
        self.task = dispatch(self.db, "POST", "/work", {"title": "Export changes"})[1]["id"]
        self.path = f"/work/{self.task}/release-receipts"
        self.pr = dict(repository="test/export", pull_request=3, state="open",
                       source_branch="feature/wt-001-export", title="Review export")
        self.branch = dict(repository="test/export", head=SHA, source_branch="feature/WT-001-logging")

    def read(self, matches=(), branches=(), unique=True):
        with patch("receipts.fetch_json", return_value={"key":"WT-001", "matches":list(matches), "branches":list(branches)}) as discover:
            with patch("receipts.fetch_evidence", return_value={"state":"unverified","releases":[]}) as evidence:
                result = dispatch(self.db, "GET", self.path, {}, discover_key=lambda number: unique)[1]
                return result, discover, evidence

    def test_branch_pr_and_title_matches_are_read_only(self):
        before = self.db.total_changes
        for candidate, field in [(self.pr, "source branch"), (dict(self.pr, source_branch="feature/export",title="[WT-001] Export"), "PR title")]:
            result, discover, evidence = self.read(matches=[candidate])
            discover.assert_called_once_with("/api/task-reviews", {"key":"WT-001","details":"identity"}, 2)
            self.assertEqual(result["discovery"]["state"], "matched")
            row = result["receipts"][0]
            self.assertEqual((row["repo"],row["pr"],row["matched_in"]), ("test/export","3",[field]))
            self.assertTrue(row["discovered"])
            self.assertEqual(evidence.call_args.args[0], {"repo":"test/export","pr":"3"})
        result, _, evidence = self.read(branches=[self.branch])
        self.assertEqual(result["discovery"]["state"], "branch")
        self.assertTrue(result["discovery"]["matches"][0]["branch_url"].endswith("repo=test%2Fexport&ref=feature%2FWT-001-logging"))
        evidence.assert_not_called()
        self.assertEqual(self.db.total_changes, before)

    def test_matches_with_conflicting_keys_or_multiple_candidates_do_not_gain_receipts(self):
        for reviews, branches in [([self.pr], [self.branch]), ([self.pr,dict(self.pr,repository="other/repo")], []),
                                  ([dict(self.pr,title="Ship WT-002")], []),
                                  ([], [dict(self.branch,source_branch="feat/WT-001/WT-002")])]:
            result, _, evidence = self.read(reviews, branches)
            self.assertEqual(result["discovery"]["state"], "ambiguous")
            self.assertEqual(result["receipts"], [])
            evidence.assert_not_called()
        for branch in ("feature/XWT-001", "feature/WT-0012", "feature/WT-001A", "feature/WT-1"):
            result, _, evidence = self.read([dict(self.pr,source_branch=branch)])
            self.assertEqual(result["discovery"]["state"], "no_match")
            evidence.assert_not_called()

    def test_collision_blocks_lookup_and_explicit_pr_wins(self):
        result, discover, _ = self.read([self.pr], unique=False)
        self.assertEqual(result["discovery"]["state"], "workspace_collision")
        discover.assert_not_called()
        change = dispatch(self.db,"PUT","/changes",dict(repository="weftgit:manual/repo",external_id="pr:9",title="Explicit"))[1]
        dispatch(self.db,"POST","/links",dict(source=change["id"],target=self.task,kind="implements"))
        result, discover, evidence = self.read([self.pr], unique=False)
        discover.assert_not_called()
        self.assertNotIn("discovery", result)
        self.assertEqual(evidence.call_args.args[0], {"repo":"manual/repo","pr":"9"})

    def test_unavailable_distinguished_from_no_match_or_unmerged(self):
        with patch("receipts.fetch_json", side_effect=ConnectionRefusedError()):
            result = dispatch(self.db, "GET", self.path, {}, discover_key=lambda number: True)[1]
        self.assertEqual(result, {"discovery":{"key":"WT-001","state":"unavailable"},"receipts":[]})
        ref = {"repo":"team/repo","pr":"8"}
        merged = dict(payload(), verified=False, merge_verified=True, staging_status="awaiting_staging", releases=[])
        self.assertEqual(verify_payload(ref, merged, 9011)["staging_status"], "awaiting_staging")
        for broken in [dict(merged,merge_verified=False),dict(merged,merge_sha=None)]:
            self.assertNotIn("staging_status", verify_payload(ref, broken, 9011))
