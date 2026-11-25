"""Check the host rename against persisted links, reporting retries, and real Git refs."""
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from app import dispatch, initialize, repository_root


class WeftGitTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        initialize(self.db)

    def call(self, method, path, **body):
        return dispatch(self.db, method, path, body)[1]

    def test_existing_report_and_both_change_ids_remain_usable(self):
        task = self.call("POST", "/work", title="Build report")["id"]
        other = self.call("POST", "/work", title="Document report")["id"]
        third = self.call("POST", "/work", title="Verify report")["id"]
        self.db.execute("""INSERT INTO nodes(id,kind,title,repository,external_id)
            VALUES ('older','change','First title','freethegit:team/repo','pr:7')""")
        self.call("POST", "/links", source="older", target=other, kind="implements")
        claim = self.call("POST", "/claims/next", item=task)["claim"]["id"]
        body = dict(title="Review report", repository="weftgit:team/repo", external_id="pr:7", summary="Reviewed output")
        newer = self.call("POST", "/claims/"+claim+"/report", **body)["result_change"]
        self.db.commit()
        initialize(self.db)
        initialize(self.db)
        graph = self.call("GET", "/graph")
        changes = [n for n in graph["nodes"] if n["kind"] == "change"]
        self.assertEqual([(n["id"],n["repository"]) for n in changes], [("older","weftgit:team/repo")])
        self.assertEqual(graph["change_aliases"], {newer: "older"})
        self.assertEqual({(e["source"],e["target"]) for e in graph["edges"]}, {("older",task),("older",other)})
        self.assertEqual(self.call("POST","/links",source=newer,target=third,kind="implements")["source"], "older")
        for prefix in ("freethegit:", "weftgit:"):
            same = dict(body, repository=prefix+"team/repo")
            self.assertEqual(self.call("POST", "/claims/"+claim+"/report", **same)["result_change"], "older")
            self.assertEqual(self.call("PUT", "/changes", **same)["id"], "older")
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_repository_root_precedence(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            parent = Path(directory).resolve()
            old = parent/"freethegit"/".repositories"
            new = parent/"WeftGit"/".repositories"
            self.assertEqual(repository_root(parent), new)
            old.mkdir(parents=True)
            self.assertEqual(repository_root(parent), old)
            new.mkdir(parents=True)
            self.assertEqual(repository_root(parent), new)
            os.environ["FREETHEGIT_REPOSITORIES"] = str(old)
            self.assertEqual(repository_root(parent), old)
            os.environ["WEFTGIT_REPOSITORIES"] = str(new)
            self.assertEqual(repository_root(parent), new)

    def test_old_and_new_routes_link_same_git_commit(self):
        if not shutil.which("git"):
            self.skipTest("Git is required for the companion integration")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            repo = root/"team"/"demo.git"
            repo.parent.mkdir()
            subprocess.run(["git","init","--bare","--quiet",str(repo)], check=True)
            git = ["git","--git-dir",str(repo),"-c","user.name=Test","-c","user.email=test@example.invalid"]
            tree = subprocess.check_output([*git,"mktree"], input=b"").decode().strip()
            sha = subprocess.check_output([*git,"commit-tree",tree,"-m","Implement export"]).decode().strip()
            subprocess.run([*git,"update-ref","refs/heads/main",sha], check=True)
            target = self.call("POST", "/work", title="Ship export")["id"]
            with patch("app.WEFTGIT_ROOT",root):
                changes = []
                for route in ("/freethegit", "/weftgit"):
                    feed = self.call("GET",route)
                    self.assertEqual(feed["repositories"][0]["commits"][0]["sha"],sha)
                    changes.append(self.call("POST",route+"/links",repository="team/demo",sha=sha,target=target))
            self.assertEqual(changes[0]["id"],changes[1]["id"])
            self.assertEqual(changes[0]["repository"],"weftgit:team/demo")
            self.assertEqual(len(self.call("GET","/graph")["edges"]),1)


if __name__ == "__main__":
    unittest.main()
