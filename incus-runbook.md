# Running the Unbounded 4-Hour Pilot on Incus

Runbook for executing [`unbounded-4-hour-pilot-plan.md`](unbounded-4-hour-pilot-plan.md)
on the remote Incus host managed by `~/repos/incus-infra`.

**Target shape:** one long-lived container (`unbounded-pilot`) on the EC2 Incus
host holding MongoDB, the `unbounded` CLI, mini-SWE-agent, and all 20 agent
worktrees. Agents are separated by worktree, not by container — the plan only
requires that they not share a filesystem working copy, and 20 containers would
burn most of hour 2 on provisioning.

Host: **c7a.8xlarge, 32 vCPU / 64 GiB, 300 GiB ZFS pool**, ~$1.64/hr on demand.
Stop it when the pilot ends (§8).

---

## 0. Prerequisites on your workstation

- WireGuard client config installed (`/etc/wireguard/wg0.conf`)
- `incus` CLI with the `crabbox-ec2` remote already configured
- AWS credentials for `us-west-2` (to start/stop the instance)
- API key(s) for the small model and the frontier model

Verify:

```bash
incus remote list          # crabbox-ec2 -> https://10.200.0.2:8443
aws sts get-caller-identity
```

---

## 1. Bring the host up

The instance is stopped between sessions. Start it and wait for the tunnel:

```bash
cd ~/repos/incus-infra
scripts/start-instance.sh          # reads the instance ID from tofu state
sudo systemctl restart wg-quick@wg0
ping -c3 10.200.0.2
incus list crabbox-ec2:
```

If `incus list crabbox-ec2:` hangs, the tunnel is the usual culprit — check
`sudo wg show` for a recent handshake before assuming Incus is broken. The
public IP is stable (Elastic IP), so nothing needs re-pointing after a restart.

---

## 2. Create the pilot container

```bash
incus launch images:ubuntu/24.04/cloud unbounded-pilot \
  --remote crabbox-ec2 \
  -c limits.cpu=28 \
  -c limits.memory=48GiB \
  -c security.nesting=true
```

Notes:

- `security.nesting=true` is needed if you run the SWE-bench evaluator through
  Docker inside the container. Skip it only if you plan to run the tasks' test
  suites directly in a venv (faster to set up, less faithful to the benchmark).
- Leaving ~4 vCPU / 16 GiB unallocated keeps the host responsive and leaves room
  for other crabbox leases on the same box.
- The default profile puts the root disk on the ZFS pool and `eth0` on
  `incusbr0` (10.50.0.0/16). Outbound traffic NATs to the host's Elastic IP,
  which is what Atlas sees and what you allowlist (§4.5).

Convenience alias for the rest of this doc:

```bash
alias pilot='incus exec crabbox-ec2:unbounded-pilot -- '
alias pilotsh='incus exec crabbox-ec2:unbounded-pilot -- bash -lc'
```

---

## 3. Provision the container

### 3.1 Base tooling

```bash
pilotsh 'apt-get update && apt-get install -y \
  git curl ca-certificates gnupg build-essential \
  python3 python3-venv python3-pip jq tmux'
```

### 3.2 MongoDB client tools

Shared memory lives in **Atlas** (§4.5) — no `mongod` runs in the container.
Install only the client tools, for smoke tests and for dumping results:

```bash
pilotsh '
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
    | gpg --dearmor -o /usr/share/keyrings/mongodb-8.0.gpg
  echo "deb [signed-by=/usr/share/keyrings/mongodb-8.0.gpg] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-8.0.list
  apt-get update && apt-get install -y mongodb-mongosh mongodb-database-tools
'
```

Nothing listens locally, so there is no `bindIp` to configure and no local port
to protect. The connection test lives in §4.5, once the URI is in `/work/.env`.

### 3.3 Work user and directories

```bash
pilotsh '
  useradd -m -s /bin/bash agent || true
  mkdir -p /work/{repos,runs,unbounded,logs}
  chown -R agent:agent /work
'
```

### 3.4 Docker (only if using the SWE-bench evaluator harness)

```bash
pilotsh 'curl -fsSL https://get.docker.com | sh && usermod -aG docker agent'
pilotsh 'docker run --rm hello-world'    # confirms nesting works
```

If `hello-world` fails, `security.nesting` did not take effect — restart the
container (`incus restart crabbox-ec2:unbounded-pilot`) and retry before
debugging anything else.

---

## 4. Push the pilot code and secrets

Build the repo layout from the plan locally, then push it in. Working from a
pushed copy (rather than editing inside the container) keeps the source of
truth on your workstation.

```bash
cd ~/repos/mongodb-hack
incus file push -r . crabbox-ec2:unbounded-pilot/work/unbounded-pilot/ \
  --uid 1001 --gid 1001        # 'agent' uid/gid; check with: pilot id agent
```

For iteration during the pilot, re-push just the changed files:

```bash
incus file push runner/swarm.py crabbox-ec2:unbounded-pilot/work/unbounded-pilot/runner/swarm.py
```

### Secrets and environment variables

There are three places env vars can come from, with different lifetimes and
different exposure. Use all three, for different things.

#### a. Pushed env file — for API keys (recommended)

Keep secrets in a mode-0600 file owned by `agent`, sourced by whatever launches
the agents. Nothing secret enters the Incus database.

```bash
incus file push ~/.config/unbounded/pilot.env \
  crabbox-ec2:unbounded-pilot/work/.env --mode 0600 --uid 1001 --gid 1001
```

`pilot.env`:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...           # or whichever provider hosts the small model
UNBOUNDED_MONGO_URI=mongodb+srv://...   # Atlas SRV string, see §4.5
```

Load it in any shell that needs it:

```bash
set -a; . /work/.env; set +a
```

Keep the file out of `/work/unbounded-pilot` so a `incus file push -r` of the
repo can never clobber it, and add `.env` to the repo's `.gitignore`.

To rotate a key mid-pilot, re-push the file — already-running agents keep the
old value in their process environment until relaunched.

#### b. `incus config set environment.*` — for non-secret, always-present vars

```bash
incus config set crabbox-ec2:unbounded-pilot \
  environment.PILOT_ROOT=/work/unbounded-pilot \
  environment.UNBOUNDED_DB=unbounded
```

Note `UNBOUNDED_MONGO_URI` is **not** in that list. The Atlas SRV string embeds
the database user's password, which makes it a secret — it belongs in
`/work/.env` (§4a) with the API keys, not here.

These are exported into the instance and into every `incus exec` session, so
they survive reboots and need no sourcing. **Do not put API keys here:** the
values are stored in the Incus database in the clear, printed by
`incus config show`, readable by anyone with access to the remote, and copied
into every snapshot and published image — including the `unbounded-base` image
in §7.

#### c. `incus exec --env` — for one-off overrides

```bash
incus exec crabbox-ec2:unbounded-pilot --env AGENT_ID=03 -- \
  su agent -c 'env | grep AGENT_ID'
```

Per-invocation and never persisted, which makes it right for ad-hoc debugging.
Note the value lands in your local shell history, so prefer it for non-secrets;
for a secret, pipe it in on stdin instead:

```bash
pass show anthropic/pilot | incus exec crabbox-ec2:unbounded-pilot -- \
  sh -c 'install -m600 -o agent -g agent /dev/stdin /work/.anthropic-key'
```

#### d. Per-agent variables belong in the launcher, not the container

`AGENT_ID` and `UNBOUNDED_WORKSPACE` differ per agent, so they must be set on
each subprocess — this is the one-line difference between the shared and
isolated conditions:

```python
env = {
    **os.environ,                                    # inherits /work/.env
    "AGENT_ID": str(agent_id),
    "UNBOUNDED_WORKSPACE": run_id,                    # shared
    # "UNBOUNDED_WORKSPACE": f"{run_id}-{agent_id}",  # isolated
}
subprocess.Popen(cmd, cwd=worktree, env=env)
```

Source `/work/.env` once in the tmux launch command (§5, hour 2) and every agent
inherits the keys from there.

#### If a systemd service needs a variable

`environment.*` is not reliably visible to units started by systemd. Use a drop-in:

```bash
pilotsh 'mkdir -p /etc/systemd/system/<unit>.d && cat > /etc/systemd/system/<unit>.d/env.conf <<EOF
[Service]
EnvironmentFile=/work/.env
EOF
systemctl daemon-reload && systemctl restart <unit>'
```

Only relevant if you daemonize part of the pilot; the runs in §5 are foreground
processes under tmux and don't need this.

#### What not to do

- No secrets in `cloud-init.user-data` on the instance config — same exposure as
  `environment.*`, plus it persists in published images.
- Don't bake keys into the `unbounded-base` image (§7 publishes from the
  pre-`.env` snapshot for exactly this reason).
- Don't pass keys as command-line arguments to the agent processes — 20 agents
  means 20 copies of the key visible in `ps` output to anything in the container.

### Python environment

```bash
pilotsh 'su - agent -c "
  cd /work/unbounded-pilot &&
  python3 -m venv .venv &&
  .venv/bin/pip install -U pip \"pymongo[srv]\" &&   # [srv] is required for Atlas, see §4.5
  .venv/bin/pip install mini-swe-agent
"'
```

Then make `unbounded` available on every agent's `$PATH` — this is the one
affordance the plan says must be present in the agent shell:

```bash
pilotsh 'cat > /usr/local/bin/unbounded <<EOF
#!/bin/sh
exec /work/unbounded-pilot/.venv/bin/python /work/unbounded-pilot/unbounded/cli.py "\$@"
EOF
chmod 755 /usr/local/bin/unbounded'

pilotsh 'su - agent -c "unbounded inspect"'
```

---

## 4.5 Connecting to MongoDB Atlas

### The IP to allowlist: `44.231.18.79/32`

That is the Elastic IP attached to the Incus host
(`aws_eip.incus_host`, association `eipassoc-0272efe1f60def2c2`, instance
`i-07385a8aea2c2f5b8`). Container traffic to the internet takes this path:

```text
container (10.50.0.0/16)
  -> incusbr0, ipv4.nat=true       # SNAT to the host
  -> host eth0
  -> internet gateway (Elastic IP) # Atlas sees this
  -> Atlas
```

Two properties that matter:

- **The WireGuard tunnel is irrelevant here.** It's a split tunnel — the server
  peer's `AllowedIPs` is only your client `/32`, so container egress to Atlas
  never enters it. Your workstation IP is *not* what Atlas sees from the swarm.
- **The EIP survives stop/start**, so the allowlist entry stays valid across
  `scripts/stop-instance.sh` cycles. The `35.167.142.110` recorded on
  `aws_instance.incus_host` in the Tofu state is the pre-EIP auto-assigned
  address and is not what egresses. Don't allowlist it.

Confirm from inside the container before blaming Atlas for anything:

```bash
pilotsh 'curl -s https://api.ipify.org; echo'      # expect 44.231.18.79
```

### Also allowlist your workstation

§6 connects `mongosh` and analysis notebooks to the same cluster from your
laptop, which egresses directly, not through the host. Right now that is
**`12.78.75.210/32`** — but if that's a residential connection it will change,
so use Atlas's "Add Current IP Address" button rather than pinning it, and
re-add it when analysis suddenly can't connect.

In Atlas: **Network Access → IP Access List → Add IP Address**. Add both
entries with a comment (`incus-host-eip`, `mkly-workstation`) so the temporary
one is obvious later.

`0.0.0.0/0` would also work and is tempting for a 4-hour hackathon. It exposes
the cluster to credential-stuffing from anywhere, and the swarm has one stable
source IP, so there's no reason to reach for it.

VPC peering and PrivateLink aren't options on the free tier — M0 supports the
IP access list only. That's fine here; the EIP is stable.

### Everything else you need

**1. A database user.** Atlas → Database Access → Add New Database User, SCRAM
password auth, built-in role `readWrite` on the pilot database (not
`atlasAdmin`). Autogenerate the password and paste it straight into
`pilot.env` — never into `incus config` (§4b).

**2. The SRV connection string**, from Atlas → Connect → Drivers:

```bash
UNBOUNDED_MONGO_URI='mongodb+srv://unbounded:<password>@<cluster>.xxxxx.mongodb.net/?retryWrites=true&w=majority&appName=unbounded-pilot'
```

Add it to `/work/.env` alongside the API keys (§4a). This is the single place
the cluster is named — `unbounded/cli.py` should read `UNBOUNDED_MONGO_URI` and
nothing else, so pointing the swarm at a different cluster is a one-line change.

URL-encode the password if it contains `@ : / ? # [ ] %`. An unencoded `@` in a
password produces a parse error that reads like a DNS failure and wastes ten
minutes.

**3. `dnspython` — the most common way this fails.** `mongodb+srv://` needs SRV
and TXT lookups, which PyMongo cannot do without it:

```bash
pilotsh 'su - agent -c "cd /work/unbounded-pilot && .venv/bin/pip install -U \"pymongo[srv]\""'
```

Without it you get `ConfigurationError: The "dnspython" module must be installed`.
Note this replaces the plain `pymongo` install in §4.

**4. TLS trust.** Atlas is TLS-only; `ca-certificates` is already installed in
§3.1. If you get `CERTIFICATE_VERIFY_FAILED`, run `update-ca-certificates`
rather than reaching for `tlsAllowInvalidCertificates`.

**5. Egress on 27017.** Nothing to change — the security group allows all
outbound, and `incusbr0` NATs freely. Only ingress is restricted.

Smoke-test the whole path before hour 1:

```bash
pilotsh 'su - agent -c "set -a; . /work/.env; set +a; mongosh \"\$UNBOUNDED_MONGO_URI\" --quiet --eval \"db.runCommand({ping:1})\""'
```

### Free-tier limits that bite a 20-agent swarm

M0 is shared infrastructure, and 20 concurrent agents is a heavier client than
it's sized for. Three constraints worth designing around up front:

- **512 MB storage.** Per-model-call and per-unbounded-op telemetry (the plan's
  §Telemetry) can fill that inside one run. Write telemetry to JSONL on the
  container's ZFS-backed disk (`/work/logs/`) and keep Atlas for the
  agent-visible shared memory only. That is also cleaner experimentally — the
  telemetry observer is supposed to be external to the swarm — and it keeps the
  512 MB budget spent on the thing the experiment actually measures.
- **500 connections, and shared-tier rate limiting.** If `unbounded` is a CLI
  that opens a fresh `MongoClient` per invocation, 20 agents in a tight loop
  will churn connections hard. Either keep the CLI's client short-lived and
  explicitly closed, or front it with a small local daemon holding one pooled
  client. Watch for `connection pool paused` and server-side throttling.
- **Restricted commands.** Shared tiers block some admin/diagnostic operations.
  Build `unbounded inspect` on ordinary `aggregate` with `$sample`, `db.stats()`,
  and `listIndexes` — all available — rather than `$currentOp` or `collStats`.
  `mongodump` works; `mongodump --oplog` does not.

Because every `unbounded` call is now a network round trip to Atlas rather than a
loopback call, per-operation latency is tens of milliseconds instead of under
one. That is fine for the pilot — agents are model-latency bound — but it does
mean **all three conditions must run against the same cluster** so wall-clock
stays comparable. Don't switch backends between conditions.

If M0 throttling starts distorting the run, the fix is a paid tier (M10 is
roughly $0.08/hr, trivial next to the $1.64/hr host), not a different backend.
Record the tier in the run metadata either way.

---

## 5. Hour-by-hour execution

### Hour 1 — one agent end to end

```bash
pilotsh 'su - agent -c "
  cd /work/repos &&
  git clone --filter=blob:none https://github.com/<swe-bench-instance-repo> task-1
"'

incus exec crabbox-ec2:unbounded-pilot -- su - agent
# inside: set -a; . /work/.env; set +a
#         cd /work/unbounded-pilot && ./.venv/bin/mini ...
```

Gate before proceeding: the agent completes a loop, `unbounded insert` and
`unbounded find` both round-trip, and token usage is recorded.

### Hour 2 — shared population

Worktrees per the plan:

```bash
pilotsh 'su - agent -c "
  for i in \$(seq -w 1 20); do
    git -C /work/repos/task-1 worktree add /work/runs/run-001/agent-\$i <base-commit>
  done
"'
```

Launch under `tmux` so the swarm survives a dropped WireGuard tunnel — this is
the single most important operational detail, since the tunnel does drop:

```bash
pilotsh 'su - agent -c "tmux new-session -d -s run-001 \"
  set -a; . /work/.env; set +a
  cd /work/unbounded-pilot &&
  .venv/bin/python runner/swarm.py --run-id run-001 --condition shared --agents 20 \
    2>&1 | tee /work/logs/run-001.log
\""'
```

Watch it:

```bash
incus exec crabbox-ec2:unbounded-pilot -- su - agent -c 'tmux attach -t run-001'
pilotsh 'tail -f /work/logs/run-001.log'
```

With 28 vCPU and API-hosted models, 20 concurrent agents are I/O bound, not CPU
bound. Watch `pilot top -bn1` anyway if agents are running test suites in
parallel — 20 simultaneous pytest runs will saturate the box.

### Hour 3 — isolated control + frontier baseline

Same command, different workspace namespacing (the plan's one-line difference):

```bash
... runner/swarm.py --run-id run-002 --condition isolated --agents 20
... runner/swarm.py --run-id run-003 --condition frontier --agents 1
```

Run these sequentially, not concurrently — a shared box makes wall-clock time
incomparable across conditions, and wall-clock is one of the reported metrics.

### Hour 4 — evaluate and analyze

Collect diffs and run analysis in the container, then pull results out:

```bash
pilotsh 'su - agent -c "
  cd /work/unbounded-pilot &&
  .venv/bin/python analysis/fingerprints.py --runs run-001 run-002 run-003 \
    > /work/runs/summary.json
"'

incus file pull -r crabbox-ec2:unbounded-pilot/work/runs ~/repos/mongodb-hack/runs/
```

Dump the raw memory too. Atlas outlives the container, but M0 is a free sandbox
that can be paused or reclaimed, and the whole point of the pilot is the
document corpus — get a local copy:

```bash
pilotsh 'su - agent -c "set -a; . /work/.env; set +a;
  mongodump --uri=\"\$UNBOUNDED_MONGO_URI\" --gzip --archive=/work/runs/unbounded.archive"'

incus file pull crabbox-ec2:unbounded-pilot/work/runs/unbounded.archive \
  ~/repos/mongodb-hack/runs/unbounded.archive
```

Also pull `/work/logs/` — that's where telemetry JSONL lives, and it is not in
Atlas (§4.5).

---

## 6. Analyzing from your workstation

Shared memory is in Atlas, so analysis doesn't go through the container at all —
connect straight from your laptop with the same SRV string, provided your
workstation IP is on the access list (§4.5):

```bash
mongosh "$UNBOUNDED_MONGO_URI"
```

This is the nice property of using Atlas rather than a container-local server:
you can run fingerprint analysis in a local notebook against live data while the
swarm is still running, and nothing you do locally can perturb the run.

Telemetry is the exception — it's JSONL on the container's disk, so pull it
(`incus file pull -r .../work/logs`) or read it in place with
`pilotsh 'tail -f /work/logs/run-001.jsonl'`.

Useful for running fingerprint analysis in a local notebook while the swarm is
still running.

---

## 7. Snapshots and reuse

Snapshot after provisioning but **before** the first run, so a botched run costs
minutes rather than a rebuild:

```bash
incus snapshot create crabbox-ec2:unbounded-pilot provisioned
incus snapshot restore crabbox-ec2:unbounded-pilot provisioned   # to roll back
```

Between conditions, snapshot the memory state so a run is reproducible:

```bash
incus snapshot create crabbox-ec2:unbounded-pilot after-run-001
```

If you want a reusable base for later experiment days:

```bash
incus stop crabbox-ec2:unbounded-pilot
incus publish crabbox-ec2:unbounded-pilot/provisioned \
  crabbox-ec2: --alias unbounded-base
incus start crabbox-ec2:unbounded-pilot
```

Publish from the `provisioned` snapshot, not the live container — that snapshot
predates `/work/.env`, so the image carries no API keys.

---

## 8. Teardown

The host costs ~$1.64/hr running. When the pilot is done:

```bash
# results are already pulled locally (§5)
incus stop crabbox-ec2:unbounded-pilot          # keep the container for next time
cd ~/repos/incus-infra && scripts/stop-instance.sh
```

Stopping the EC2 instance preserves the Elastic IP, both EBS volumes, and every
container and snapshot on the ZFS pool. `scripts/start-instance.sh` brings it
all back at the same address.

Delete the container only if you no longer want the environment:

```bash
incus delete --force crabbox-ec2:unbounded-pilot
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `incus list crabbox-ec2:` hangs | Tunnel down. `sudo systemctl restart wg-quick@wg0`, check `sudo wg show` for a handshake. |
| Tunnel up but Incus API refuses | Instance still booting. `ssh ubuntu@10.200.0.2 cloud-init status --wait`. |
| Swarm dies when your laptop sleeps | Not launched under `tmux`. Always launch runs detached (§5, hour 2). |
| `docker run` fails in the container | `security.nesting=true` missing or not applied — set it and restart the container. |
| Agents can't find `unbounded` | The wrapper is in `/usr/local/bin`; confirm with `pilot su - agent -c 'command -v unbounded'`. |
| Atlas connection times out from the container | EIP not on the Atlas access list. Verify egress: `pilotsh 'curl -s https://api.ipify.org'` → expect `44.231.18.79` (§4.5). |
| Atlas works in the container, fails from your laptop | Workstation IP changed. Re-add via Atlas "Add Current IP Address". |
| `The "dnspython" module must be installed` | `mongodb+srv://` needs it: `pip install "pymongo[srv]"` (§4.5). |
| Auth fails with a URI that looks correct | Unencoded `@`/`:`/`/` in the password. URL-encode it. |
| `connection pool paused` mid-run | M0 connection churn from 20 agents — pool the client or move up a tier (§4.5). |
| Host feels wedged mid-run | 20 parallel test suites. Lower agent concurrency or raise `limits.cpu`. |

## Open items to resolve before hour 1

These depend on choices the plan deliberately leaves open:

- Which SWE-bench Lite instances (and therefore which repos and base commits) —
  `<base-commit>` and the clone URL in §5 are placeholders.
- Which small model and provider, which decides what goes in `/work/.env`.
- Whether evaluation uses the official Docker-based SWE-bench harness (needs
  §3.4) or direct test runs in the task venv (skip §3.4, save ~10 minutes).
