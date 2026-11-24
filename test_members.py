"""User directory, role boundaries, account edits and revocation."""
import sqlite3
import unittest

from app import MANAGEMENT_SCHEMA, code_hash, management


class MemberTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(MANAGEMENT_SCHEMA)
        _, created = management(self.db, None, "POST", "/setup", {"name": "Owner"})
        self.owner = self.member(created["code"])

    def member(self, code):
        return self.db.execute("SELECT id,name,role FROM members WHERE code_hash=?", (code_hash(code),)).fetchone()

    def create(self, actor, name, role):
        _, result = management(self.db, actor, "POST", "/members", {"name": name, "role": role})
        return result["code"], self.member(result["code"])

    def test_admin_create_edit_remove_and_owner_boundary(self):
        _, admin = self.create(self.owner, "Admin", "admin")
        token, target = self.create(admin, "Editor", "editor")
        path = "/members/" + target["id"]
        management(self.db, admin, "PATCH", path, {"name": "Viewer", "role": "viewer"})
        self.assertEqual(dict(self.member(token)), {"id": target["id"], "name": "Viewer", "role": "viewer"})
        for endpoint in ("/members/"+self.owner["id"], "/members/"+admin["id"]):
            with self.assertRaises(PermissionError):
                management(self.db, admin, "DELETE", endpoint, {})
        with self.assertRaises(PermissionError):
            management(self.db, admin, "PATCH", path, {"name": "Viewer", "role":"admin"})
        management(self.db, admin, "DELETE", path, {})
        self.assertIsNone(self.member(token))

    def test_directory_visibility_and_read_only_roles(self):
        for role in ("editor", "viewer"):
            _, actor = self.create(self.owner, role, role)
            _, info = management(self.db, actor, "GET", "/settings", {})
            self.assertTrue(all(set(member)=={"id","name","role"} for member in info["members"]))
            self.assertTrue(any(member["id"]==self.owner["id"] for member in info["members"]))
            with self.assertRaises(PermissionError):
                self.create(actor, "Another", "editor")
        self.assertEqual(management(self.db,None,"GET","/settings",{})[1]["members"], [])


if __name__ == "__main__":
    unittest.main()
