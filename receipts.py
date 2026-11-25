"""Read WeftGit publication evidence for the changes implementing a requirement."""
import json
import os
import re
import time
from contextlib import closing
from http.client import HTTPConnection, HTTPException
from urllib.parse import urlencode, urlsplit


FULL_SHA = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
REPOSITORY = re.compile(r"(?:weftgit|freethegit):([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})")


def receipt_ref(change):
    repo = REPOSITORY.fullmatch(change["repository"] or "")
    external = change["external_id"] or ""
    prefix, _, value = external.partition(":")
    if not repo:
        return None
    if prefix == "pr" and re.fullmatch(r"[1-9][0-9]{0,17}", value):
        return {"repo": repo[1], "pr": value}
    if prefix == "commit" and FULL_SHA.fullmatch(value):
        return {"repo": repo[1], "commit": value}
    return None


def release_url(value, port, path):
    if not isinstance(value, str):
        return None
    url = urlsplit(value)
    if (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost") and url.port == port
            and not url.username and not url.password and url.path == path and not url.query and not url.fragment):
        return value
    return None


def weftgit_port():
    return int(os.environ.get("WEFTGIT_PORT", "8091"))


def fetch_json(path, params, timeout):
    port = weftgit_port()
    with closing(HTTPConnection("127.0.0.1", port, timeout=timeout)) as connection:
        connection.request("GET", path + "?" + urlencode(params))
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError("WeftGit receipt service unavailable")
        payload = response.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            raise ValueError("Receipt response too large")
    return json.loads(payload)


def fetch_evidence(ref, timeout):
    return verify_payload(ref, fetch_json("/api/release-receipt", ref, timeout), weftgit_port())


def verify_payload(ref, data, port):
    if not isinstance(data, dict) or data.get("repository") != ref["repo"] or type(data.get("verified")) is not bool:
        raise ValueError("Invalid receipt response")
    is_pr = "pr" in ref
    if is_pr:
        if str(data.get("pull_request")) != ref["pr"]:
            raise ValueError("Mismatched pull request")
    elif data.get("commit_sha") != ref["commit"]:
        raise ValueError("Mismatched commit")
    proof = {}
    if is_pr:
        merge = data.get("merge_sha")
        reviewed = data.get("reviewed_sha")
        merged = data.get("merge_verified") is True and all(isinstance(sha, str) and FULL_SHA.fullmatch(sha) for sha in (merge, reviewed))
        stage = data.get("staging_status")
        if merged:
            proof = {"merge_verified": True, "merge_sha": merge, "reviewed_sha": reviewed,
                     "staging_status": stage if stage in {"awaiting_staging", "staged", "previously_staged"} else "unverified"}
        elif stage == "unmerged":
            proof = {"merge_verified": False, "staging_status": "unmerged"}
    if not data["verified"]:
        reason = data.get("reason")
        return {**proof, "state": "unverified", "reason": reason if isinstance(reason, str) and reason else "No verified publication.", "releases": []}
    if is_pr and not all(isinstance(data.get(k), str) and FULL_SHA.fullmatch(data[k]) for k in ("reviewed_sha", "merge_sha")):
        raise ValueError("Missing merge provenance")
    releases = []
    if not isinstance(data.get("releases"), list) or not data["releases"]:
        raise ValueError("Missing publication evidence")
    for release in data["releases"]:
        if not isinstance(release, dict):
            raise ValueError("Invalid release")
        sha = release.get("published_sha")
        environment = release.get("environment")
        when = release.get("published_at")
        revision = f"{ref['repo']}/{environment}/{sha}"
        archive = release_url(release.get("archive_url"), port, f"/artifacts/{revision}.zip")
        if (not isinstance(sha, str) or not FULL_SHA.fullmatch(sha) or not isinstance(environment, str)
                or not re.fullmatch(r"[A-Za-z0-9_-]+", environment) or not isinstance(when, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", when) or not archive or type(release.get("current")) is not bool):
            raise ValueError("Incomplete publication evidence")
        releases.append({"environment": environment, "published_sha": sha, "published_at": when, "current": release["current"],
                         "archive_url": archive, "site_url": release_url(release.get("site_url"), port, f"/sites/{revision}/"),
                         "environment_url": release_url(release.get("environment_url"), port, f"/environments/{ref['repo']}/{environment}/") if release["current"] else None})
    return {**proof, "state": "verified", "reviewed_sha": data.get("reviewed_sha") if is_pr else None,
            "merge_sha": data.get("merge_sha") if is_pr else None, "releases": releases}


def discover_reviews(key, timeout):
    data = fetch_json("/api/task-reviews", {"key": key, "details": "identity"}, timeout)
    if not isinstance(data, dict) or data.get("key") != key or not isinstance(data.get("matches"), list):
        raise ValueError("Invalid discovery response")
    token = re.compile(r"(?<!\w)" + re.escape(key) + r"(?!\w)", re.IGNORECASE)
    keys = re.compile(r"(?<!\w)WT-(?:[0-9]{3}|[1-9][0-9]{3,17})(?!\w)", re.IGNORECASE)
    def conflicts(text):
        return sorted({m.upper() for m in keys.findall(text)} - {key, "WT-000"})
    candidates = []
    for match in data["matches"]:
        if not isinstance(match, dict):
            raise ValueError("Invalid review")
        repo, pr = match.get("repository"), match.get("pull_request")
        branch, title = match.get("source_branch"), match.get("title")
        if (not isinstance(repo, str) or not REPOSITORY.fullmatch("weftgit:" + repo) or type(pr) is not int
                or not re.fullmatch(r"[1-9][0-9]{0,17}", str(pr)) or not isinstance(title, str) or not isinstance(branch, str)):
            raise ValueError("Invalid review reference")
        state = match.get("state")
        if state not in {"open", "merged", "declined"} or not (token.search(branch) or token.search(title)):
            continue
        matched_in = [field for field, value in (("source branch", branch), ("PR title", title)) if token.search(value)]
        candidates.append({"repo": repo, "pr": str(pr), "title": title, "review_state": state, "source_branch": branch,
                           "matched_in": matched_in, "conflicting_keys": conflicts(branch + " " + title),
                           "review_url": f"http://127.0.0.1:{weftgit_port()}/hosted?" + urlencode({"repo": repo, "pr": pr})})
    branches = data.get("branches", [])
    if not isinstance(branches, list):
        raise ValueError("Invalid branches")
    for match in branches:
        if not isinstance(match, dict):
            raise ValueError("Invalid branch")
        repo, branch, head = match.get("repository"), match.get("source_branch"), match.get("head")
        if (not isinstance(repo, str) or not REPOSITORY.fullmatch("weftgit:" + repo) or not isinstance(branch, str)
                or not isinstance(head, str) or not FULL_SHA.fullmatch(head)):
            raise ValueError("Invalid branch identity")
        if token.search(branch):
            candidates.append({"repo": repo, "source_branch": branch, "head": head, "conflicting_keys": conflicts(branch),
                               "branch_url": f"http://127.0.0.1:{weftgit_port()}/hosted?" + urlencode({"repo": repo, "ref": branch})})
    return candidates


def requirement_receipts(db, item, discover_key=None):
    work = db.execute("SELECT rowid FROM nodes WHERE id=? AND kind='work'", (item,)).fetchone()
    if not work:
        raise LookupError("Work item not found")
    changes = db.execute("""SELECT n.id,n.title,n.repository,n.external_id FROM edges e JOIN nodes n ON n.id=e.source
        WHERE e.target=? AND e.kind='implements' AND n.kind='change' ORDER BY n.rowid""", (item,)).fetchall()
    refs = []
    for change in changes:
        ref = receipt_ref(change)
        if ref:
            refs.append((ref, {"change_id": change["id"], "title": change["title"]}))
    deadline = time.monotonic() + 5
    result = {}
    if discover_key and not any("pr" in ref for ref, _ in refs):
        number = work[0]
        key = f"WT-{number:03d}"
        discovery = {"key": key}
        if not discover_key(number):
            discovery["state"] = "workspace_collision"
        else:
            try:
                matches = discover_reviews(key, 2)
                if len(matches) == 1 and not matches[0]["conflicting_keys"]:
                    candidate = matches[0]
                    if "pr" in candidate:
                        ref = {"repo": candidate["repo"], "pr": candidate["pr"]}
                        refs.insert(0, (ref, {**candidate, "discovered": True}))
                        discovery["state"] = "matched"
                    else:
                        discovery.update(state="branch", matches=matches)
                elif matches:
                    discovery.update(state="ambiguous", matches=matches)
                else:
                    discovery["state"] = "no_match"
            except (OSError, HTTPException, ValueError, OverflowError):
                discovery["state"] = "unavailable"
        result["discovery"] = discovery
    receipts = []
    for ref, meta in refs:
        remaining = deadline - time.monotonic()
        try:
            if remaining <= 0:
                raise TimeoutError()
            evidence = fetch_evidence(ref, min(remaining, 2))
        except (OSError, HTTPException, ValueError, OverflowError):
            evidence = {"state": "unavailable", "reason": "WeftGit release evidence is unavailable.", "releases": []}
        receipts.append({**meta, **ref, **evidence})
    return {**result, "receipts": receipts}
