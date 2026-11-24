# WeftTrack

WeftTrack is an open-source work tracker prototype. **WeftForge** is the proposed name for the companion Git hosting project being developed separately.

Run with Python 3.9+ and SQLite 3.24+, then open [WeftTrack](http://127.0.0.1:8090/) in your browser. The board lets you add work items, move them through allowed states, register code changes, and create and inspect relationships.

The first visit opens **Example project** when your local board is empty. The workspace selector switches to **My workspace** and remembers your choice in this browser. Example edits are saved in `wefttrack-example.sqlite3`. Your existing work stays in `wefttrack.sqlite3`. Select a card to move it or inspect its links. In the relationship map, select a neighbor to follow its connections.

The same server exposes a JSON API:

```sh
python3 app.py
curl -H 'Content-Type: application/json' -d '{"title":"Add CSV export"}' http://127.0.0.1:8090/work
curl http://127.0.0.1:8090/graph
```

| Method and route | Body and behavior |
|---|---|
| POST /work | `title`. Returns a new work node with a stable UUID. |
| PATCH /work/{id} | `status`. Enforces open → active → review → done, with return paths from active to open, review to active, and done to open. |
| PUT /changes | `repository`, `external_id`, `title`. Upserts an external change and preserves its node ID on retries. |
| POST /links | `source`, `target`, `kind`. Creates a directed edge using node UUIDs. |
| GET /graph | Returns all nodes and edges as JSON. |

The local API binds to loopback and has no authentication. Use it as a single-user development prototype.

## Relationship model

Work and code changes are nodes. An epic or task can be represented by a work node today. A parent points to its child via `parent_of`, a blocker points to the blocked item via `blocks`, and a code change points to the work it implements via `implements`. Hierarchy and blocking edges reject cycles. Each work item can have one parent.

SQLite stores the graph with foreign keys, indexed edges, and write transactions. That keeps updates atomic and makes recursive queries available without operating a separate graph database. WeftTrack owns work state and edges. WeftForge would own repositories and code-change state.

### Companion integration

The prototype accepts a repository namespace such as `weftforge:instance-id:repository-uuid` and an external ID such as `pull-request:42`. Use immutable identifiers in the namespace so repository renames and transfers preserve the link. Upsert the change first, then use its returned UUID as the source of an `implements` edge. A repeat link currently returns HTTP 409.

Before connecting separate deployments, add authenticated event delivery, a versioned event envelope with an event ID and source sequence, and transactional deduplication. Check both endpoints' visibility before exposing a linked change or traversing an edge. Add commit, pipeline, and deployment node types as the companion's API becomes available. Two repositories can implement the contract independently without sharing a database.

## Reference

[Jira reference and implementation roadmap](JIRA-REFERENCE.md).
