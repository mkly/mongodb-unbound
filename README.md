# Unbounded CLI

`unbounded` is a standalone MongoDB command-line client for document CRUD,
collection and index management, random sampling, and observed-schema
inspection. Every result is one line of canonical MongoDB Extended JSON, which
makes the CLI convenient for both people and scripts.

The compiled executable contains everything it needs. Bun and Node.js are not
required on machines where the executable runs.

## Configure a connection

Every database command needs one MongoDB URI and database name. Command-line
options take precedence over environment variables:

1. `--uri` overrides `UNBOUNDED_MONGO_URI`.
2. `--db` overrides `UNBOUNDED_DB`.

For a persistent shell configuration:

```sh
export UNBOUNDED_MONGO_URI='mongodb://127.0.0.1:27017'
export UNBOUNDED_DB='unbounded_demo'
```

Or provide either value for one invocation:

```sh
unbounded --uri 'mongodb://127.0.0.1:27017' --db unbounded_demo collections
```

Keep credentials in environment variables or a secret manager rather than
shell history. `unbounded --help` and `unbounded --version` do not require a
connection.

## Commands

```text
insert [collection] <document>
find [collection] <filter> [--limit N]
get [collection] <id>
update [collection] <id> <update>
delete [collection] <id>
inspect [collection] [sample-size|--size SAMPLE_SIZE]
sample [collection] [size|--size SIZE]
collections
create-collection <collection>
indexes [collection]
create-index <collection> <keys-ejson> [options-ejson]
serve [--host HOST] [--port PORT] [--telemetry PATH]...
```

When a CRUD, `sample`, or single-collection `inspect` command omits its
collection argument, it uses a collection named `default`. `inspect` with no
arguments is the exception: it inspects all user collections, up to its
documented safety bound. `find` returns at most 100 documents by default and
accepts limits from 1 through 1000. Sampling and inspection sizes are also
bounded at 1000.

Examples:

```sh
unbounded insert '{"name":"Ada","score":{"$numberLong":"42"}}'
unbounded find '{"score":{"$gte":{"$numberLong":"40"}}}' --limit 10
unbounded get '{"$oid":"66b58b6a1d4f6b0e7d405111"}'
unbounded update '{"$oid":"66b58b6a1d4f6b0e7d405111"}' '{"$set":{"active":true}}'
unbounded delete '{"$oid":"66b58b6a1d4f6b0e7d405111"}'
unbounded sample events --size 25
unbounded inspect events --size 100
unbounded collections
unbounded create-collection events
unbounded indexes events
unbounded create-index events '{"createdAt":-1}' '{"name":"recent_events"}'
```

Arguments that represent documents, filters, IDs, updates, index keys, or index
options use MongoDB Extended JSON. Quote them so the shell passes each value as
one argument. Canonical wrappers such as `$oid`, `$date`, `$numberLong`, and
`$numberDecimal` preserve BSON types on input and output. Updates are ordinary
MongoDB update documents, so operators such as `$set` are required where the
MongoDB driver requires them.

## Output and errors

Success writes one Extended JSON object to standard output:

```json
{"ok":true,"data":{"collections":["events"]}}
```

Failure writes one Extended JSON object to standard error and exits nonzero:

```json
{"ok":false,"error":{"code":"INVALID_ARGUMENTS","message":"Usage: unbounded insert [collection] <document>"}}
```

Usage and missing-configuration errors exit with status 2. Connection, server,
and unexpected runtime failures exit with status 1. Scripts should check the
exit status and the top-level `ok` field rather than matching error text.

## Build and install

Building requires Bun; running the result does not:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

The build produces `dist/unbounded`, a Linux x64 executable. Install it in any
directory already present on the PATH used by your users or agents:

```sh
install -m 0755 dist/unbounded "$HOME/.local/bin/unbounded"
unbounded --version
unbounded --help
```

Copy that one file to other compatible machines; neither this repository nor a
JavaScript runtime needs to accompany it.

## Embedded Schema Observatory interface

`src/observatory.ts` exports `renderSchemaObservatory`, which returns one
self-contained HTML document with inline styles, browser behavior, and fixture
data. It has no CDN or browser-package dependency, so a server command can embed
the returned string in the compiled executable and serve it directly.

The typed `ObservatoryFixture` contract contains only structural observations:
activity metadata, fingerprint names and field/type paths, adoption times,
field frequencies, and convergence metrics. It intentionally has no place for
document values. `null` metric values mean unknown or insufficient data and the
interface labels them as such rather than displaying zero. The exported
`observatoryFixture` supplies deterministic representative data for rendering
and integration tests. A live source can append normalized activity in the
browser with `window.unboundedObservatory.pushEvent(event)`.

## Serve the live Schema Observatory

`unbounded serve` opens the embedded dashboard and observes the configured
database without writing to it. It binds to `127.0.0.1:3000` by default. Use
`--host` or `--port` to change the listener, and repeat `--telemetry PATH` to
follow one or more agent JSONL files:

```sh
unbounded serve \
  --telemetry telemetry/shared-01/agent-ada.jsonl \
  --telemetry telemetry/shared-01/agent-babbage.jsonl
```

Open `http://127.0.0.1:3000/`. The page supports collection, run, task, agent,
and condition filters. Its browser API is deliberately small and versioned:

- `GET /health` reports process health.
- `GET /v1/snapshot` returns `{api_version:"v1", diagnostics, observatory}`.
- `GET /v1/events` is a server-sent-event stream whose `snapshot` events use
  the same envelope and update the page as MongoDB or telemetry changes arrive.

The server reads a bounded initial snapshot of each user collection, follows a
database change stream, and computes canonical structural fingerprints and
convergence metrics in memory. It never creates an observer collection or
stores metadata in MongoDB. Changes without matching telemetry remain visible
with unknown attribution; unknown and insufficient metrics are `null`, never
fabricated as zero.

MongoDB change streams require a replica set or sharded cluster. Atlas supports
them, but the connecting user must be allowed to read the database and open a
change stream. A standalone local `mongod` cannot provide live change events;
use a local replica set for the full demo. The default loopback bind keeps the
dashboard private to the machine. Binding to a non-loopback address exposes
structural metadata and telemetry attribution without authentication, so put it
behind an authenticated tunnel or reverse proxy and do not expose it directly
to an untrusted network.

Telemetry files use a shared JSONL envelope. Every record has `type`,
`event_id`, `timestamp`, `run_id`, `task_id`, `agent_id`, and `condition`.
The four record types and their writers are:

- `model_call`: written by `runner/swarm.py` around each model invocation.
- `unbounded_op`: written by `runner/unbounded-wrapper.sh` around a CLI call.
- `db_write`: written by the wrapper after a successful write, providing the
  attribution that is correlated with MongoDB's authoritative change event.
- `run_summary`: written by `runner/swarm.py` when a run finishes.

The Unbounded executable itself emits no telemetry. Malformed lines, incomplete
envelopes, unknown record types, and stream disconnects appear in the snapshot's
`diagnostics` array and do not stop observation.

For a copy-paste local demo, start a MongoDB replica set, export the connection
variables shown above, then run:

```sh
mkdir -p /tmp/unbounded-telemetry
: > /tmp/unbounded-telemetry/agent-demo.jsonl
unbounded serve --telemetry /tmp/unbounded-telemetry/agent-demo.jsonl
```

In another terminal, use the database walkthrough below or append telemetry
records using the runner. The browser updates without a reload. Stop the server
with Ctrl-C; it closes HTTP clients, file followers, the change stream, and the
MongoDB connection.

## Copy-paste database walkthrough

With a reachable MongoDB instance and the environment variables above, this
sequence exercises collection and index creation, CRUD, sampling, and schema
inspection. The inserted ID is fixed so later commands are reproducible.

```sh
unbounded create-collection agents
unbounded create-index agents '{"name":1}' '{"unique":true}'
unbounded insert agents '{"_id":{"$oid":"66b58b6a1d4f6b0e7d405111"},"name":"Ada","skills":["mongo","typescript"]}'
unbounded find agents '{"name":"Ada"}' --limit 10
unbounded get agents '{"$oid":"66b58b6a1d4f6b0e7d405111"}'
unbounded update agents '{"$oid":"66b58b6a1d4f6b0e7d405111"}' '{"$set":{"active":true}}'
unbounded sample agents --size 5
unbounded inspect agents --size 20
unbounded indexes agents
unbounded collections
unbounded delete agents '{"$oid":"66b58b6a1d4f6b0e7d405111"}'
```

The executable is intentionally only a neutral MongoDB client. It does not
contain workspace injection, agent identity, swarm coordination, benchmark
behavior, experiment telemetry, or hidden writes beyond the command explicitly
requested by the caller.

## Observatory activity model

`src/activity.ts` provides the read-only input layer used by the schema
observatory. `createActivityStream` combines bounded collection snapshots, a
MongoDB change stream, and any number of per-agent JSONL files into a stream of
normalized records. Sources are optional, and the MongoDB and file adapters are
injectable so callers can test or replace the I/O boundary.

An activity record has `kind: "activity"`, a stable `id`, an ISO `timestamp`,
`provenance` (`mongodb`, `telemetry`, or `correlated`), and an `operation`.
Collection, document ID/content, fingerprint (`schema_fingerprint` on the
wrapper's `db_write` records), success, telemetry type, and the
run/task/agent/condition attribution are present only when the source supplies
them. Correlated writes use MongoDB's document content and timestamp together
with JSONL attribution. Unmatched MongoDB changes remain valid unattributed
activity.

Malformed JSONL, incomplete records, unknown telemetry types, and change-stream
disconnects produce `kind: "diagnostic"` records instead of terminating the
stream. JSONL is deduplicated by `event_id`; MongoDB changes are deduplicated by
resume token and reconnect from the last token. A partial trailing JSONL line is
held until a following append completes it.
# mongodb-unbound
