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


def fetch_evidence(ref, timeout):
    port = weftgit_port()
    with closing(HTTPConnection("127.0.0.1", port, timeout=timeout)) as connection:
        connection.request("GET", "/api/release-receipt?" + urlencode(ref))
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError("WeftGit receipt service unavailable")
        payload = response.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            raise ValueError("Receipt response too large")
    return verify_payload(ref, json.loads(payload), port)


def verify_payload(ref, data, port):
    if not isinstance(data, dict) or data.get("repository") != ref["repo"] or type(data.get("verified")) is not bool:
        raise ValueError("Invalid receipt response")
    is_pr = "pr" in ref
    if is_pr:
        if str(data.get("pull_request")) != ref["pr"]:
            raise ValueError("Mismatched pull request")
    elif data.get("commit_sha") != ref["commit"]:
        raise ValueError("Mismatched commit")
    if not data["verified"]:
        reason = data.get("reason")
        return {"state": "unverified", "reason": reason if isinstance(reason, str) and reason else "No verified publication.", "releases": []}
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
    return {"state": "verified", "reviewed_sha": data.get("reviewed_sha") if is_pr else None,
            "merge_sha": data.get("merge_sha") if is_pr else None, "releases": releases}


def requirement_receipts(db, item):
    if not db.execute("SELECT 1 FROM nodes WHERE id=? AND kind='work'", (item,)).fetchone():
        raise LookupError("Work item not found")
    changes = db.execute("""SELECT n.id,n.title,n.repository,n.external_id FROM edges e JOIN nodes n ON n.id=e.source
        WHERE e.target=? AND e.kind='implements' AND n.kind='change' ORDER BY n.rowid""", (item,)).fetchall()
    result = []
    deadline = time.monotonic() + 5
    for change in changes:
        ref = receipt_ref(change)
        if not ref:
            continue
        remaining = deadline - time.monotonic()
        try:
            if remaining <= 0:
                raise TimeoutError()
            evidence = fetch_evidence(ref, min(remaining, 2))
        except (OSError, HTTPException, ValueError, OverflowError):
            evidence = {"state": "unavailable", "reason": "WeftGit release evidence is unavailable.", "releases": []}
        result.append({"change_id": change["id"], "title": change["title"], **ref, **evidence})
    return {"receipts": result}
