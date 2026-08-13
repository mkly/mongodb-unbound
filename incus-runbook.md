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
AWS_PROFILE=mkly aws sts get-caller-identity
```

AWS access is SSO, not static keys — the only entry in `~/.aws/credentials` is
`taskwarrior-sync`, which is unrelated. Every `aws` and `scripts/*.sh` call
below needs `AWS_PROFILE=mkly`; without it you get `NoCredentials`. If the SSO
token has expired, run `aws sso login --profile mkly` yourself (it opens a
browser).

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
incus launch images:ubuntu/24.04/cloud crabbox-ec2:unbounded-pilot \
  -c limits.cpu=28 \
  -c limits.memory=48GiB \
  -c security.nesting=true
```

Notes:

- The remote goes on the **instance name** (`crabbox-ec2:unbounded-pilot`).
  `incus launch` has no `--remote` flag and fails with `unknown flag: --remote`.

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

`agent` lands on **uid 1001, gid 1002** — not 1001/1001. `useradd` takes the
next free gid, and gid 1001 is already taken by the image's `ubuntu` group.
Confirm with `pilot id agent` before using numeric ids anywhere (§4).

### 3.4 Docker (only if using the SWE-bench evaluator harness)

```bash
pilotsh 'curl -fsSL https://get.docker.com | sh && usermod -aG docker agent'
pilotsh 'docker run --rm hello-world'    # confirms nesting works
```

Nested Docker needs two fixes on this host that `security.nesting=true` alone
does not cover. Both are already applied, but they do not survive a host
rebuild, and the failure messages point nowhere near the cause.

**1. Kernel keyring quota (host-wide).** Container init joins a session keyring,
and the kernel default is 200 keys per uid — exhausted well before 20 containers
on a box that also hosts crabbox leases. It surfaces as:

```text
unable to join session keyring: unable to create session key: disk quota exceeded
```

Fixed on the host with `/etc/sysctl.d/90-incus-production.conf` (keyring and
inotify limits, `vm.max_map_count`); this is also baked into the cloud-init
template in `~/repos/incus-infra` so a rebuilt host comes up with it.

**2. runc / AppArmor, CVE-2025-52881 fallout (per container).** runc 1.2.8+ and
1.3.3+ read `/proc/sys` through a detached procfs mount. The AppArmor profile
Incus generates matches that path against its `deny /sys/[^fdck]*` rule and
denies it — silently, since `deny` rules do not audit, so `dmesg` shows nothing:

```text
open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied
```

Docker works with `--network host` and fails whenever a container gets its own
network namespace, which is the tell. Incus fixed this in **6.19**; this host
runs Ubuntu's **6.0.0 LTS** with no newer package in the archive, so the fix is
not available via `apt`. The container-scoped workaround is to run a `runc` from
before the change:

```bash
pilotsh '
  curl -fsSL -o /tmp/runc.amd64 \
    https://github.com/opencontainers/runc/releases/download/v1.2.7/runc.amd64
  cp -n /usr/bin/runc /usr/bin/runc.orig
  install -m 755 /tmp/runc.amd64 /usr/bin/runc
  apt-mark hold containerd.io
  systemctl restart docker
'
pilotsh 'docker run --rm hello-world'
```

This gives up a runc hardening fix for the *inner* Docker containers only. That
is the cheap direction to lose: the Incus container is the real boundary, the
agents already have a shell inside it, and an inner escape lands where they
already are. Unconfining AppArmor on the Incus container instead
(`raw.lxc: lxc.apparmor.profile=unconfined`) would weaken the boundary that
actually matters, and a `raw.apparmor` allow rule cannot help — AppArmor `deny`
always beats a later allow.

The clean fix, when there is time for it, is upgrading Incus on the host to
6.19+ from the zabbly repo and dropping the pinned runc. That is shared infra
with other crabbox containers on it, so it is not a mid-pilot change.

`security.nesting` not taking effect is a *different* failure — it stops Docker
much earlier, before any image is pulled. If `hello-world` pulls the image and
then fails during container init, nesting is working and one of the two above is
your problem.

---

## 4. Push the pilot code and secrets

Build the repo layout from the plan locally, then push it in. Working from a
pushed copy (rather than editing inside the container) keeps the source of
truth on your workstation.

```bash
cd ~/repos/mongodb-hack
pilotsh 'mkdir -p /work/unbounded-pilot'
incus file push -r . crabbox-ec2:unbounded-pilot/work/unbounded-pilot/
pilotsh 'chown -R agent:agent /work/unbounded-pilot'
```

`incus file push -r` rejects ownership flags outright (`Can't supply
uid/gid/mode in recursive mode`), so ownership is a separate `chown`. The
single-file pushes below *do* take `--uid/--gid`, and there the numbers are
**1001:1002** (§3.3).

Note this pushes `.git/` along with everything else. Harmless, but it is the
bulk of the transfer.

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
  crabbox-ec2:unbounded-pilot/work/.env --mode 0600 --uid 1001 --gid 1002
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
  environment.PILOT_ROOT=/work/unbounded-pilot
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

#### d. Run and agent variables belong in the launcher, not the container

The launcher sets `AGENT_ID` for the agent harness and `UNBOUNDED_DB` for the
standalone Unbounded executable. Every agent gets the same database in the
shared condition. Each agent gets a separate database in the isolated
condition:

```python
env = {
    **os.environ,                                  # inherits /work/.env
    "AGENT_ID": str(agent_id),
    "UNBOUNDED_DB": f"{run_id}_shared",           # shared
    # "UNBOUNDED_DB": f"{run_id}_agent_{agent_id}", # isolated
}
subprocess.Popen(cmd, cwd=worktree, env=env)
```

`unbounded` reads `UNBOUNDED_DB`; it does not read `AGENT_ID` or know which
experimental condition the launcher selected.

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

### Agent environment

```bash
pilotsh 'su - agent -c "
  cd /work/unbounded-pilot &&
  python3 -m venv .venv &&
  .venv/bin/pip install -U pip mini-swe-agent
"'
```

The venv is for the **harness**, not for Unbounded. `mini-swe-agent` and the
SWE-bench evaluator are Python, so the agent loop and the scoring step need an
interpreter. The `unbounded` CLI is TypeScript and shares none of this.

Build the TypeScript CLI on your workstation as one Linux executable:

```bash
bun install --frozen-lockfile
bun build --compile --target=bun-linux-x64 src/cli.ts --outfile dist/unbounded
```

The Incus host uses x86-64 Linux, so this command works from another supported
build platform too. The compiled executable includes the Bun runtime and does
not require Bun or Node.js in the pilot container.

Install `unbounded` on every agent's `$PATH`:

```bash
pilotsh 'install -m 0755 \
  /work/unbounded-pilot/dist/unbounded /usr/local/bin/unbounded'

pilotsh 'su - agent -c "unbounded inspect"'
```

**Until that binary exists**, the container carries a placeholder at
`/usr/local/bin/unbounded` and Bun 1.3.14 at `/usr/local/bin/bun` (installed to
`/usr/local/bun`, symlinked, world-readable). The placeholder prefers
`$UNBOUNDED_REPO/dist/unbounded` — the same path the `install` above uses — and
otherwise runs `src/cli.ts`, `src/index.ts`, `cli.ts`, or `index.ts` under Bun.
So either handoff works: a compiled binary, or a source tree pushed into
`/work/unbounded-pilot`. With neither present it exits 127 naming what it looked
for, rather than failing somewhere confusing:

```
unbounded: no CLI found under /work/unbounded-pilot
  looked for: dist/unbounded, src/cli.ts, src/index.ts, cli.ts, index.ts
```

The `install` command above overwrites the placeholder, which is intended — once
the compiled executable is in place nothing needs Bun at runtime. Drop Bun from
the container before publishing `unbounded-base` (§7) if you want the image lean.

### Getting `unbounded` in front of the agents

Installing it in the pilot container is **not** what puts it on an agent's
`PATH`. mini-swe-agent runs each agent inside that instance's own SWE-bench
Docker container, which has neither Bun nor the binary. The compiled executable
has to be mounted in, which is why compiling it is load-bearing rather than a
convenience: one file mounts into forty containers, whereas a source tree would
mean installing Bun inside every SWE-bench image.

Three mounts per agent container, set through `DockerEnvironmentConfig.run_args`:

```text
/work/unbounded-pilot/dist/unbounded          -> /opt/unbounded/bin/unbounded  (ro)
/work/unbounded-pilot/runner/unbounded-wrapper.sh -> /usr/local/bin/unbounded  (ro)
/work/telemetry                               -> /telemetry                    (rw)
```

The wrapper occupies the name on `PATH`, appends a telemetry record, then execs
the real executable at `/opt/unbounded/bin/unbounded`. It is pilot-only: the
Unbounded executable emits no telemetry and has no concept of runs, agents, or
conditions, and that separation is deliberate. All experiment attribution comes
from environment variables the launcher sets — `UNBOUNDED_RUN_ID`,
`UNBOUNDED_TASK_ID`, `UNBOUNDED_AGENT_ID`, `UNBOUNDED_CONDITION`, and
`UNBOUNDED_TELEMETRY`. With `UNBOUNDED_TELEMETRY` unset the wrapper is fully
transparent, which is how the baseline arm runs.

The connection itself comes from `UNBOUNDED_MONGO_URI` and `UNBOUNDED_DB` in the
container environment. Never pass the URI as an argument — every agent can read
every other agent's `ps` output.

Verified working end to end inside `sweb.eval.x86_64.pytest-dev_1776_pytest-8365`:
the binary runs against that image's older glibc, writes to a per-agent Atlas
database, and produces one JSONL record per call at ~305 bytes.

Successful writes also carry `schema_fingerprint` — first 16 hex of a sha256 over
the document's structural signature (field paths and BSON types, `_id` excluded
when the server generated it). Fixed-length and free of model-authored text, so
it clears both constraints that keep document content out of the log, and it is
what makes schema convergence visible in the stream rather than only in a
post-hoc pass over MongoDB.

The executable computes it — `insert` and `update` now report `collection` and
`schemaFingerprint` in their result — and the wrapper reads both out of that
output. This matters more than it looks: `inspect` clusters documents already in
MongoDB by the same `fingerprintDocument()` hash, so the JSONL stream and a
post-hoc pass over the database join on one key. An earlier revision recomputed
the fingerprint in shell from a different algorithm (sorted key names only, via
`python3`), which produced values that could never be compared with `inspect`'s.
Do not reintroduce a second implementation.

Reading `collection` from the output also fixes a leak: the collection argument
is optional in every command, so `unbounded insert '{"note":"…"}'` used to log
the whole model-authored document in the `collection` field — exactly the content
the design refuses to log, and enough to push a record past `PIPE_BUF`. Absent
fields are simply omitted; missing telemetry never costs us the record.

Records are deliberately kept under 4096 bytes. Concurrent `O_APPEND` writes are
atomic on Linux only up to `PIPE_BUF`; above it, twenty agents interleave into
corrupt lines. That is why no document content is ever logged — `document_id`
plus the change stream recovers it, without replaying model-authored text into a
browser.

### Choosing the treatment model

The two treatment arms must run the **same** model — that comparison is the
entire experiment. The baseline arm is a deliberately different reference point
and is left alone.

`swarm.py --model` overrides arms A and B without editing the arm table:

```bash
runner/swarm.py --run-id r001 --model openrouter/qwen/qwen3-coder-30b-a3b-instruct \
                --cost-limit 0.50
```

Per million tokens, in/out:

| Model | in / out | vs. haiku 4.5 |
|---|---|---|
| `openrouter/qwen/qwen3-coder-30b-a3b-instruct` | 0.07 / 0.28 | 14× cheaper |
| `openrouter/openai/gpt-oss-120b` | 0.03 / 0.17 | 30× cheaper |
| `openrouter/deepseek/deepseek-v4-flash-0731` | 0.08 / 0.18 | 20× cheaper |
| `anthropic/claude-haiku-4-5-20251001` | 1.00 / 5.00 | — |

Cost is not the main reason to prefer a small model here. **If the model is
strong enough to solve these tasks alone, shared memory has no headroom to help**
and the pilot measures a ceiling effect instead of a treatment effect. The
opposite risk sets the floor: below some competence threshold neither arm
completes anything, both score ~0%, and there is no signal either way. Sub-$0.05
models (`ling-2.6-flash`, `mistral-nemo`, `llama-3.1-8b`) sit below that floor —
they burn steps on malformed output.

mini-swe-agent does **not** use the tool-calling API. It asks for a bash command
in a fenced code block and parses the text, so a model's advertised tool-calling
support is not the constraint — format-following over a long loop is. Confirm a
candidate emits a clean block before committing 40 agents to it:

```bash
.venv/bin/python -c '
import litellm
r = litellm.completion(model="openrouter/qwen/qwen3-coder-30b-a3b-instruct",
  messages=[{"role":"user","content":"Reply with a single bash code block that prints hello. Nothing else."}])
print(repr(r.choices[0].message.content)); print(r.usage)'
```

LiteLLM reports OpenRouter's own `cost` on the usage object, but mini-swe-agent
prices calls through LiteLLM's static map, which does not carry these models —
and it treats an unpriced call as **fatal**, so the first LM call kills the agent:

```
CRITICAL litellm_model Error calculating cost for model
openrouter/qwen/qwen3-coder-30b-a3b-instruct: This model isn't mapped yet.
ERROR swarm A/pytest-dev__pytest-8365/agent_00 failed: RuntimeError
```

`swarm.py` registers the real per-token prices at startup (`OPENROUTER_PRICES`,
`register_openrouter_prices`). Do **not** reach for the documented escape hatch
`MSWEA_COST_TRACKING=ignore_errors` instead — it would zero out `cost_limit` and
the `estimated_cost` field on every `model_call` record. Adding a new model means
adding a row to that table.

**Measured result: stay on haiku.** Both models were run against
`pytest-dev__pytest-8365` with byte-identical prompts:

| | qwen3-coder-30b | haiku 4.5 |
|---|---|---|
| LM calls | 77 (step limit) | 40 |
| Wall clock | 445 s | 117 s |
| Cost | $0.072 | $0.124 |
| Submitted a diff | no | yes, 11 lines |
| `unbounded` calls | **0** | 6 (2 writes, 2 distinct fingerprints) |

qwen found the correct fix — catching `KeyError` around `getpass.getuser()` — and
then submitted raw source instead of a `git diff`, so nothing scoreable came out.
It also never once invoked `unbounded` across 77 steps. Both are the same failure:
it reasons adequately but does not hold protocol over a long loop. The zero is
disqualifying on its own, because **an agent that never writes to memory makes the
shared and isolated arms identical by construction** — the pilot would return a
null result caused by the model rather than by the hypothesis.

Haiku on the identical prompt searched before working (`find notes`,
`inspect tmpdir`) and then wrote, which is the behaviour the experiment needs.

The cost argument also collapses on the real numbers: at $0.12 per episode, 120
episodes (20 agents × 3 instances × 2 arms) is about $15. Cheaper models are not
worth a null result to save ten dollars. Keep the `--model` flag for when a
candidate worth testing appears, and re-run this same two-model comparison before
trusting one — a model that cannot follow the submission protocol cannot run this
pilot regardless of price.

Two caveats. OpenRouter routes to third-party providers, so latency and rate
limits are less predictable than Anthropic direct — `swarm.py`'s adaptive
concurrency governor exists for exactly this. And `OPENROUTER_API_KEY` belongs in
`/work/.env` alongside the others, never in `incus config set environment.*`.

---

## 4.5 Connecting to MongoDB Atlas

### What's already provisioned

Verified with the Atlas CLI:

| | |
|---|---|
| Org / Project | `mike@mkly.io's Sandbox Project` — `6a7d5a3beb4a5a3fbf07a293` |
| Cluster | `Cluster0`, **M10**, MongoDB 8.0.29, AWS `US_WEST_1`, IDLE, 10 GB, backups on |
| SRV host | `cluster0.kyk94d.mongodb.net` |
| Access list | `44.231.18.79/32` (crabbox-ec2) and `12.78.75.210/32` — both present |
| Database user | `unbounded`, `readWriteAnyDatabase@admin` — created, connection verified |

**Why the role is `readWriteAnyDatabase` and not `readWrite@unbounded`.** It
started as the narrower grant, which is the right instinct — the swarm runs
model-authored shell commands under that account. But the experiment gives each
isolated-arm agent its own database (`{run_id}_agent_07`), and `readWrite` on a
single database named `unbounded` fails auth on every one of them:

```text
not authorized on run_001_agent_07 to execute command { insert: ... }
```

`readWriteAnyDatabase` is still well below `atlasAdmin`: no user management, no
cluster administration, no access-list changes. Rotate this password after the
pilot (§8) — it is the only credential the model-authored commands can reach.

Re-check any time with:

```bash
export ATLAS_PROJECT=6a7d5a3beb4a5a3fbf07a293
atlas clusters list --projectId $ATLAS_PROJECT
atlas accessLists list --projectId $ATLAS_PROJECT
atlas dbusers list --projectId $ATLAS_PROJECT
```

This is an **M10, covered by hackathon credits** — dedicated tier, not free M0.
So the shared-tier limits usually assumed in this kind of setup don't apply:
10 GB storage, ~1500 connections, and no restricted-command list. `$currentOp`,
`collStats`, and `mongodump --oplog` all work.

Cost isn't a constraint on the pilot. The only thing to keep an eye on is that
hackathon credits are finite and dated — if the cluster is still up weeks later,
that's when it starts mattering (§8).

The cluster is in **`US_WEST_1`** (N. California) while the Incus host is in
**us-west-2** (Oregon), so every `unbounded` call pays ~20 ms of cross-region
latency. Not worth relocating for a 4-hour pilot — agents are model-latency
bound — but it's the reason per-op timings won't look like loopback.

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

**1. A database user** — already created; recorded here so a rebuild can repeat
it. Generate the password locally and paste it straight into `pilot.env`; never
into `incus config` (§4b).

There is **no `--autoGeneratePassword` flag** in atlascli 1.58 — it fails with
`unknown flag`. Generate the password yourself and pass it with `-p`. Keep it
alphanumeric so the URI needs no percent-encoding:

```bash
UNBOUNDED_PW="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"

atlas dbusers create readWriteAnyDatabase \
  --projectId 6a7d5a3beb4a5a3fbf07a293 \
  --username unbounded -p "$UNBOUNDED_PW"
```

The pilot uses a database per shared or isolated namespace, so this account
needs access to those databases. `readWriteAnyDatabase` avoids the broader
administrative privileges in `atlasAdmin`. This setup provides logical
isolation: an agent could change `UNBOUNDED_DB` from its shell. Use one
database-scoped credential per agent if the control requires enforced
isolation.

**2. The SRV connection string** (cluster host confirmed via
`atlas clusters connectionStrings describe Cluster0`):

```bash
UNBOUNDED_MONGO_URI='mongodb+srv://unbounded:<password>@cluster0.kyk94d.mongodb.net/?retryWrites=true&w=majority&appName=unbounded-pilot'
```

Add it to `/work/.env` alongside the API keys (§4a). The `unbounded`
executable reads `UNBOUNDED_MONGO_URI` and `UNBOUNDED_DB`. The launcher sets
the database name for each process, so it can switch between shared and
isolated runs without changing the executable.

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

### Capacity notes for a 20-agent swarm

M10 is dedicated infrastructure, so the free-tier restrictions that usually
shape this design don't apply. What still matters:

- **Connection churn.** ~1500 connections is plenty, but if `unbounded` is a CLI
  that opens a fresh `MongoClient` per invocation, 20 agents in a tight loop pay
  full TLS-handshake plus SRV-lookup cost on *every* memory operation, across
  regions. That's latency, not a limit — but it's the difference between a
  memory call feeling free and feeling expensive to the agents. Reuse a client
  where you can, and watch for `connection pool paused`.
- **10 GB storage.** Ample for the agent-visible memory. Still send the plan's
  per-model-call and per-op telemetry to JSONL in `/work/logs/` rather than
  Atlas — not for space reasons now, but because the telemetry observer is
  supposed to be external to the swarm, and mixing it into the same cluster the
  agents read makes the corpus harder to analyze cleanly.
- **No command restrictions.** `unbounded inspect` can use `collStats` and
  `$currentOp`, and `mongodump --oplog` works if you want write ordering — which
  is genuinely useful here, since "which agent wrote what, when" is one of the
  things the pilot is trying to observe.

Because every `unbounded` call is now a network round trip to Atlas rather than a
loopback call, per-operation latency is tens of milliseconds instead of under
one. That is fine for the pilot — agents are model-latency bound — but it does
mean **all three conditions must run against the same cluster** so wall-clock
stays comparable. Don't switch backends between conditions.

Record the tier (`M10`) and region (`US_WEST_1`) in the run metadata so the
timings stay interpretable if a later experiment runs against different
infrastructure.

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

Use the same command with a different database assignment:

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

> **The existing `provisioned` snapshot contains `/work/.env`.** It was taken
> after Atlas connectivity was verified, so it holds the live `unbounded` Atlas
> password. Do **not** publish an image from it. Either rotate the Atlas password
> after publishing, or take a clean snapshot first:
>
> ```bash
> pilotsh 'mv /work/.env /root/.env.hold'
> incus snapshot create crabbox-ec2:unbounded-pilot clean-base
> pilotsh 'mv /root/.env.hold /work/.env'
> incus publish crabbox-ec2:unbounded-pilot/clean-base \
>   crabbox-ec2: --alias unbounded-base
> ```

Publish from a snapshot that predates `/work/.env`, never from the live
container. Snapshots and published images copy the filesystem verbatim — file
mode `0600` protects the file on a running system, not inside an image someone
else can import. Verify before sharing an image:

```bash
incus file pull crabbox-ec2:unbounded-pilot/work/.env - 2>&1 | head -1
```

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

### The Atlas cluster

Nothing to do here at the end of a session. `Cluster0` is an M10 running on
hackathon credits, so leaving it up costs you nothing, and the EC2 teardown
above doesn't affect it either way.

Optional, if you want to stop drawing down credits between sessions:

```bash
atlas clusters pause Cluster0 --projectId 6a7d5a3beb4a5a3fbf07a293
atlas clusters start Cluster0 --projectId 6a7d5a3beb4a5a3fbf07a293   # to resume
```

A paused cluster keeps its data, users, and access list, and Atlas auto-resumes
it after 30 days.

Do keep the local dump (§5) regardless. The corpus is the experimental result,
`terminationProtectionEnabled` is `false`, and credit-based clusters outlive the
hackathon only as long as the credits do.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `incus list crabbox-ec2:` hangs | Tunnel down. `sudo systemctl restart wg-quick@wg0`, check `sudo wg show` for a handshake. |
| Tunnel up but Incus API refuses | Instance still booting. `ssh ubuntu@10.200.0.2 cloud-init status --wait`. |
| Swarm dies when your laptop sleeps | Not launched under `tmux`. Always launch runs detached (§5, hour 2). |
| `docker run`: `unable to join session keyring: disk quota exceeded` | Host kernel keyring quota, not nesting. Raise `kernel.keys.maxkeys`/`maxbytes` on the **host** (§3.4). |
| `docker run`: `reopen fd N: permission denied` on a sysctl | runc ≥1.3 detached-procfs mounts vs. Incus's AppArmor profile (CVE-2025-52881 hardening). Pin runc 1.2.7 (§3.4). Not a nesting problem — don't set `raw.apparmor`. |
| `docker run` fails some other way | Then suspect `security.nesting=true` — check `incus config get crabbox-ec2:unbounded-pilot security.nesting`. |
| Agents can't find `unbounded` | It's in `/usr/local/bin`; confirm with `pilotsh 'su - agent -c "command -v unbounded"'`. |
| `unbounded: no CLI found under /work/unbounded-pilot` | Placeholder is live but the real CLI hasn't landed. Install `dist/unbounded` or push the TS source (§4a). |
| Atlas connection times out from the container | EIP not on the Atlas access list. Verify egress: `pilotsh 'curl -s https://api.ipify.org'` → expect `44.231.18.79` (§4.5). |
| Atlas works in the container, fails from your laptop | Workstation IP changed. Re-add via Atlas "Add Current IP Address". |
| `The "dnspython" module must be installed` | `mongodb+srv://` needs it: `pip install "pymongo[srv]"` (§4.5). |
| Auth fails with a URI that looks correct | Unencoded `@`/`:`/`/` in the password. URL-encode it. |
| `connection pool paused` mid-run | Connection churn from 20 agents. The M10 allows ~1500 connections, so this means clients aren't being reused — pool the client per agent process, don't reconnect per CLI call (§4.5). |
| Host feels wedged mid-run | 20 parallel test suites. Lower agent concurrency or raise `limits.cpu`. |

## Decisions made

- **Provider: Anthropic only.** `/work/.env` carries `ANTHROPIC_API_KEY`;
  `OPENAI_API_KEY` is commented out.
- **Models** (litellm strings, as passed to `mini-swe-agent`):

  | Arm | Role | Model |
  |---|---|---|
  | A — shared memory | small model ×20 | `anthropic/claude-haiku-4-5-20251001` |
  | B — isolated control | small model ×20 | `anthropic/claude-haiku-4-5-20251001` |
  | C — baseline | single agent | `anthropic/claude-sonnet-5` |

  A and B **must** use the identical model — B is the control that isolates
  whether shared memory beats 20 independent samples, so a model difference
  would confound the only comparison that matters.

  Arm C is Sonnet 5, not Opus 5. That is a mid-tier baseline, so a swarm win is
  a weaker claim than beating a top-tier model — name the model in any writeup
  rather than saying "frontier". Arm C is one agent, so adding an Opus 5 run
  later is cheap.

- **Evaluation: the official Docker-based SWE-bench harness** (§3.4 required).
  `swebench` 4.1.0 in the venv; `agent` is in the `docker` group — it is not by
  default, and root having Docker access does not imply the swarm does.

  **Verified end to end.** A gold-patch run scores 1/1 with no errors:

  ```bash
  pilotsh 'su - agent -c "
    cd /work/unbounded-pilot &&
    .venv/bin/python -m swebench.harness.run_evaluation \
      --dataset_name princeton-nlp/SWE-bench_Lite \
      --predictions_path gold --max_workers 1 \
      --instance_ids django__django-11099 --run_id smoke
  "'
  ```

  `--predictions_path gold` feeds the dataset's own correct patch through the
  real harness, so it tests the infrastructure without involving a model. Expect
  `"resolved_instances": 1, "error_instances": 0` in `gold.smoke.json`. Re-run
  this after any change to runc, Docker, or the container profile.

  **Use `--cache_level instance` for the pilot.** The default removes the
  instance image when the run finishes (`Unremoved images: 0`), so every
  evaluation rebuilds it. That is fine for a one-off smoke test and wasteful
  across 20 agents evaluating repeatedly. Watch disk on the ZFS pool if you do —
  SWE-bench instance images are on the order of a gigabyte each.

- **Task instances: three**, chosen for short evaluator runtime with a real
  patch to find. All three verified `resolved 3/3, errors 0` on gold, and their
  images are cached locally:

  | Instance | Tests per eval | Patch | Image |
  |---|---|---|---|
  | `pylint-dev__pylint-7228` | 12 | 13 lines | 2.60 GB |
  | `pallets__flask-4992` | 19 | 11 lines | 2.68 GB |
  | `pytest-dev__pytest-8365` | 33 | 7 lines | 2.31 GB |

  SWE-bench runs only `FAIL_TO_PASS` + `PASS_TO_PASS`, not the repo's full
  suite, so **that test count — not the repo's reputation — is the cost driver**.
  For contrast, `psf__requests-2674` runs 154 tests and `pydata__xarray-4493`
  runs 1690. Check `PASS_TO_PASS` length before substituting an instance.

  Each arm runs all 20 agents against the *same* instance — shared memory has
  nothing to share otherwise — so an instance is a full 20-agent run, not 1/20th
  of the work.

## Open items to resolve before hour 1

- Anthropic **rate limits** at 20-way concurrency. This account returns no
  `ratelimit-*` response headers, so the ceiling can't be read ahead of time.
  `mini-swe-agent`'s failure mode on a 429 storm is a stalled agent, not a loud
  error — so the launcher needs retry-with-backoff, and concurrency should ramp
  rather than open all 20 at once.
- Whether `runner/swarm.py` stays Python or moves to TypeScript alongside the
  CLI. It drives a Python harness, so Python is the path of least resistance.
- The telemetry schema (plan lines 636–642). Must be wired in before the first
  run or arm C's cost comparison can't be reconstructed afterward.
