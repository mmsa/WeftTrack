"""Pull one requirement and submit a traceable result using a dedicated member code."""
import argparse
import json
import os
import re
import sys
from http.client import HTTPConnection


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", default="local", help="local, example, or a project ID")
    actions = parser.add_subparsers(dest="action", required=True)
    show = actions.add_parser("show", help="Read one requirement, its claim and related work")
    show.add_argument("item_id")
    claim = actions.add_parser("claim", help="Resume your claim or take the next eligible requirement")
    claim.add_argument("--item", help="Claim a specific eligible work ID")
    report = actions.add_parser("report", help="Link a change and send work to review")
    report.add_argument("claim_id")
    for field in ("summary", "repository", "external-id", "title"):
        report.add_argument("--" + field, required=True)
    release = actions.add_parser("release", help="Return claimed work to the queue")
    release.add_argument("claim_id")
    args = parser.parse_args()
    token = os.getenv("WEFTTRACK_ACCESS_CODE")
    if not token and args.action != "show":
        parser.error("Set WEFTTRACK_ACCESS_CODE to a dedicated member access code")
    if args.workspace in {"local", "example"}:
        prefix = "" if args.workspace == "local" else "/example"
    elif re.fullmatch("[0-9a-f]{32}", args.workspace):
        prefix = "/projects/" + args.workspace
    else:
        parser.error("Unknown workspace format")
    if args.action == "show":
        if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", args.item_id):
            parser.error("Invalid work ID")
        path = "/work/" + args.item_id
        body = None
    elif args.action == "claim":
        path = "/claims/next"
        body = {"item": args.item} if args.item else {}
    else:
        if not re.fullmatch("[0-9a-f]{32}", args.claim_id):
            parser.error("Invalid claim ID")
        path = "/claims/" + args.claim_id + "/" + args.action
        body = {key: getattr(args, key) for key in ("summary", "repository", "external_id", "title")} if args.action == "report" else {}
    connection = HTTPConnection("127.0.0.1", 8090, timeout=15)
    try:
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        connection.request("GET" if args.action == "show" else "POST", prefix + path,
                           json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        payload = json.loads(response.read())
        print(json.dumps(payload, indent=2), file=sys.stdout if response.status < 400 else sys.stderr)
        return int(response.status >= 400)
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        connection.close()


if __name__ == "__main__":
    sys.exit(main())
