# Beast API

Beast is the automation/orchestration layer on the VPS. It **does not implement tickets itself**.
It receives authorized Linear tickets and launches a coding agent (Codex CLI or Claude Code,
selected by `BEAST_AGENT`) inside the correct, registered project workspace, then verifies the
result and reports back to Linear.

```
ChatGPT → Linear ticket → label "Beast Ready" → Linear webhook → Beast API
  → verify + authorize → map project → registered workspace → coding agent
  → verify result → comment on Linear
```

> **Documented production baseline:** The [2026-09-28 VPS profile](https://github.com/kofiarhin/beast/blob/main/VPS-Beast-AI-Agent-Profile.md)
> records Beast API under PM2 with HTTPS proxying to `127.0.0.1:3100`.
> The repository's Nginx template exposes only `POST /webhooks/linear`; health and job-status
> routes are intended to remain local. This is dated evidence, not a current live check.
> Verify the active configuration and deployed revision before production work.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, execution path, registry, queue, agent and verification boundaries.
- [Linear workflow](docs/LINEAR-WORKFLOW.md) — how an issue becomes an authorized Beast job and how results return to Linear.
- [Operations](docs/OPERATIONS.md) — production layout, health checks, logs, restart rules and troubleshooting.
- [Security](docs/SECURITY.md) — trust boundaries, secrets, workspace protection and production permissions.
- [Controlled admin](docs/ADMIN.md) — typed VPS admin operations, risk classes, approvals and the future privileged executor (IDE-69).

---

## Architecture

```
src/
  server.ts              entry point: wires everything, listens on 127.0.0.1:PORT
  app.ts                 Express routes (/health, /webhooks/linear, /jobs/:id)
  config.ts              environment configuration
  logger.ts              structured JSON logs with secret redaction
  webhook/
    signature.ts         HMAC-SHA256 signature + timestamp (replay) checks
    intake.ts            event → authorize → resolve project → enqueue
  linear/
    client.ts            LinearClient interface, GraphQL client, "unconfigured" client
    reporter.ts          formats Queued/Working/Blocked/Failed/Completed comments
  registry/registry.ts   project → workspace registry (config/projects.json)
  workspace/
    validate.ts          workspace safety checks → ValidatedWorkspace
    git.ts               read-only git helpers
  agents/
    types.ts             AgentAdapter interface
    index.ts             BEAST_AGENT → adapter selection
    codex.ts             Codex CLI adapter
    claude.ts            Claude Code CLI adapter
    launcher.ts          the single guarded entry point for launching an agent
    prompt.ts            structured task prompt for the agent
  queue/
    store.ts             JSON-file persistence (jobs + webhook deliveries)
    worker.ts            single-concurrency worker
  verify/verify.ts       post-run inspection (git status, changed files, checks)
  util/exec.ts           child process runner (no shell, timeouts, Linear credential filtering)
config/projects.json     project registry
data/                    runtime state (state.json, logs/) — created automatically, git-ignored
```

The webhook handler validates, authorizes and enqueues without waiting for the coding job.
When configured, it first awaits a Linear API issue read. The worker handles agent execution
and project verification separately.

## Endpoints

| Method | Path               | Purpose                                             |
| ------ | ------------------ | --------------------------------------------------- |
| GET    | `/health`          | Liveness + job counts per state                     |
| POST   | `/webhooks/linear` | Linear webhook receiver                             |
| GET    | `/jobs/:id`        | Job status, reason, Next Action, verification result |

## Webhook flow

`POST /webhooks/linear`:

1. **Secret configured?** If `LINEAR_WEBHOOK_SECRET` is empty, every webhook is rejected (`503`).
2. **Signature** — `Linear-Signature` must equal HMAC-SHA256(raw body, secret), compared in
   constant time. Otherwise `401`.
3. **Freshness** — `webhookTimestamp` must be within `BEAST_WEBHOOK_TOLERANCE_MS` (default 60s)
   to prevent replays. Otherwise `401`.
4. **Duplicate delivery** — the `Linear-Delivery` ID (or a hash of the body if absent) is checked
   against persisted deliveries and in-flight requests. Duplicates return `200 {"status":"duplicate"}`.
5. **Event filter** — only `type: "Issue"` with `action` `create` or `update`.
6. **Issue details** — fetched from the Linear API when `LINEAR_API_KEY` is set (authoritative);
   otherwise taken from the payload.
7. **Authorization** — see below.
8. **Per-issue lock** — if the issue already has a `queued`/`working` job, the event is ignored.
9. **Project resolution** — unknown project → a `blocked` job is recorded and reported; no agent.
10. **Enqueue** — a `queued` job is persisted, a "Queued" comment is attempted without awaiting
    delivery, the worker is kicked, and the request returns `202` without waiting for the agent.

The delivery is only recorded as processed after steps 5–10 succeed, so if Linear's API is
temporarily unreachable Beast returns `500` and Linear's retry is processed normally.

## Linear authorization

A webhook alone never causes execution. A ticket runs only when:

- it carries the label named by `BEAST_READY_LABEL` (default `Beast Ready`, matched
  case-insensitively), **and**
- the event is a `create` of an already-labelled issue, or an `update` where the ready label was
  **newly added** (`updatedFrom.labelIds` did not contain it).

So editing the title or description of an already-labelled ticket does not re-run it. To retry a
blocked/failed ticket, remove the label and add it again.

When `LINEAR_API_KEY` is set, labels are read from the Linear API rather than trusted from the
payload.

## Project registry and workspace selection

`config/projects.json` maps Linear project names to workspaces:

```json
{
  "projects": [
    { "name": "Beast",       "workspace": "/home/ubuntu/projects/beast" },
    { "name": "DevKofi",     "workspace": "/home/ubuntu/projects/devkofi" },
    { "name": "IdeaHub API", "workspace": "/home/ubuntu/projects/ideahub-api" },
    { "name": "LeadRadar",   "workspace": "/home/ubuntu/projects/leadradar" }
  ]
}
```

Rules enforced at startup:

- workspace paths must be absolute and normalized;
- an entry outside `/home/ubuntu/projects` is loaded but quarantined: startup logs a warning and
  every ticket for that project is blocked, because Beast never runs an agent outside the root;
- names and paths must be unique.

Resolution is **exact** (case-insensitive name, or `linearProjectId` if pinned). There is no fuzzy
matching and no path derivation — Beast never guesses a workspace. An issue with no project or an
unregistered project is blocked, unless it carries an explicit workspace directive (below).

### Targeting any project under `/home/ubuntu/projects`

An authorized ticket can override its registered workspace with directive lines in its description.
Each directive must sit on its own line, starting at the beginning of the line:

```
Beast workspace: /home/ubuntu/projects/escowear
Beast workspace mode: create
```

- `mode` is `existing` (the default) or `create`. `existing` needs a clean Git repository at that path.
  `create` makes a new directory and runs `git init`, without making a commit. It refuses any path that
  already exists, so an existing project is never overwritten. It also refuses a path inside another
  repository.
- The path must be absolute, normalized and a strict child of `/home/ubuntu/projects`. Beast rejects
  `..`, trailing slashes, the root itself, and any symlink in the path, including dangling links.
- A ticket with more than one directive, or with an unknown mode, is blocked. A path that only
  appears in ordinary prose never grants access.
- `BEAST_WORKSPACE_ROOT` cannot point anywhere else: startup fails if it is set to another path.

**Beast API routing caution:** The shipped `Beast` entry selects
`/home/ubuntu/projects/beast`, the VPS documentation repository, not Beast API source.
A registered, clean Git repository can still be the wrong repository for a ticket.
Before authorizing Beast API coding, verify a clean API development checkout under the
workspace root and obtain approval for its exact routing. Do not guess the checkout path,
use the production runtime copy, or silently redirect all Beast documentation tasks.
[IDE-65](https://linear.app/ideahub-devkofi/issue/IDE-65) tracks the known routing prerequisite.

### Registering another project

1. Make sure the repo exists at `/home/ubuntu/projects/<dir>` and is a clean Git repository.
2. Add an entry to `config/projects.json`:
   ```json
   { "name": "My Linear Project Name", "workspace": "/home/ubuntu/projects/my-project" }
   ```
   Optionally add `"linearProjectId": "<uuid>"` so the mapping survives a project rename.
3. Apply the reviewed registry change and restart Beast API only with explicit approval.

## Workspace safety

Before any agent starts, `validateWorkspace` checks, in order:

1. the workspace is registered;
2. the directory exists (and its real path, after resolving symlinks, is still inside the
   workspace root);
3. it is the **root** of a Git repository (not a subfolder of some other repo);
4. `git status --porcelain --untracked-files=all` is empty.

Any failure → job `blocked`, reported to Linear with the reason, dirty file list and a Next Action.
Beast **never** stashes, discards, resets, overwrites or commits existing changes.

Only `validateWorkspace` can produce a `ValidatedWorkspace` (tracked in a private `WeakSet`).
`launchAgent` refuses anything else, re-checks the path against the registry, and checks that the
task's path matches. This is the only code path that launches an agent.

## Agent adapter

```ts
interface AgentAdapter {
  readonly name: string;
  run(request: AgentRunRequest): Promise<AgentResult>;
}
```

Adapters only launch one fresh agent process for one task in one validated workspace. Queueing,
safety checks, verification and Linear reporting are independent of the agent. `BEAST_AGENT`
selects the adapter (`src/agents/index.ts`); an unknown value fails at startup.

### Codex execution

For each job Beast runs a fresh process:

```
codex exec --sandbox workspace-write -c approval_policy="never" \
  --cd <workspace> --color never --output-last-message data/logs/<job>.log.last-message.txt -
```

- working directory = the registered workspace;
- the structured prompt is sent on stdin;
- the `workspace-write` sandbox confines file writes to the workspace;
- `LINEAR_API_KEY` and `LINEAR_WEBHOOK_SECRET` are removed from the agent's environment;
- stdout/stderr go to `data/logs/<jobId>.log`; the final message becomes the Linear summary;
- the process group is killed after `BEAST_AGENT_TIMEOUT_MS` (default 60 min).

The prompt contains the issue ID/identifier, title, description, project, acceptance criteria
(extracted from an "Acceptance criteria" section when present), workspace path, what the agent
may and must not do (no push/PR/merge/deploy/commit/stash, no system config, nothing outside the
workspace, no unrelated deletions), and the expected verification.

### Claude Code execution

With `BEAST_AGENT=claude`, Beast runs a fresh non-interactive process for each job:

```
claude -p --output-format stream-json --verbose \
  --permission-mode acceptEdits --permission-prompts none \
  --tools Bash,Read,Edit,Write,Glob,Grep \
  --setting-sources "" --settings '<Beast settings JSON>' --strict-mcp-config \
  --disable-slash-commands --no-session-persistence [--model <BEAST_CLAUDE_MODEL>]
```

- working directory = the registered workspace; the same structured prompt as Codex is sent on stdin;
- `LINEAR_API_KEY` and `LINEAR_WEBHOOK_SECRET` are removed from the agent's environment;
- user, project and local Claude settings are ignored (a repository cannot grant itself
  permissions), all MCP servers are disabled (including the Linear MCP), hooks are disabled,
  and web tools are not available;
- file edits are accepted only inside the workspace. Nobody answers permission prompts, so
  anything that would need approval is **denied**: Read/Edit/Write outside the workspace, and
  Bash commands not explicitly allowed;
- allowed Bash without a prompt: `npm test`, `npm run test|lint|typecheck|build`,
  `git status|diff|log|show`;
- denied Bash (`src/agents/claude.ts`): Git commit/push/stash/reset/checkout/switch/restore/clean,
  branch/tag/remote/ref/config changes, merge/rebase, `gh`, `sudo`, PM2/systemctl/Nginx/certbot/ufw,
  Docker, deploy CLIs, ssh/scp/rsync; `.env` files may not be read or written;
- Claude Code's OS sandbox is enabled with no unsandboxed retry. It needs `bubblewrap` and
  `socat`; on this VPS `socat` is not installed, so Claude Code disables the sandbox (with a
  warning in the transcript) and other Bash commands are denied, as above;
- the stream-json transcript is redacted to `data/logs/<jobId>.log`; the final `result` event
  becomes the Linear summary. An error result (for example max turns) is reported as a failed
  run even if the CLI exits 0;
- sessions are not persisted under `~/.claude`; the process group is killed on timeout,
  cancellation or shutdown, as for Codex.

Claude authenticates with whatever login the service user's Claude Code already has; Beast
stores no Claude credentials. The permission rules are defence in depth: prefix rules cannot catch
every spelling of a command, so Beast's post-run Git approval checks and verification still apply
exactly as they do for Codex.

### Adding another agent

Implement `AgentAdapter`, register it in `ADAPTERS` in `src/agents/index.ts`, and add adapter
tests. Nothing in the webhook, queue, worker, verification or reporting code needs to change.

## Queue / worker

- One worker, **at most one active agent job**; others wait in FIFO order.
- `worker.kick()` is called after each enqueue and on startup (to resume queued jobs).

Per job: mark `working` → re-resolve project from registry → validate workspace → post "Working" →
launch agent → verify → mark `completed` or `failed` → post result → next job.

Job states: `queued`, `working`, `blocked`, `failed`, `completed`.

- `failed` = agent could not start, exited non-zero, or timed out.
- `completed` = agent exited 0 without a reported agent error, timeout or cancellation.
  Verification failure does not prevent this state. The result comment then says
  "Completed locally — verification failed".
- The agent summary is plain text; Beast does not validate it against ticket acceptance
  criteria or treat a blocked/incomplete summary as a structured outcome.
- Local completion is not proof of task success, Linear Done, merge or deployment.

## Verification

After the agent exits, Beast records (without modifying Git state):

- agent exit status / timeout;
- `git status` and the list of changed files (captured **before** running any scripts);
- whether `HEAD` moved (flagged as a warning — the agent should not commit);
- `npm run <script>` for each of `BEAST_VERIFY_SCRIPTS` (default `test,lint,typecheck,build`)
  that exists in `package.json`. Missing scripts or missing `node_modules` are reported as
  `skipped`. Scripts run with `CI=true`; only `LINEAR_API_KEY` and
  `LINEAR_WEBHOOK_SECRET` are removed from the inherited environment.

**Limits of the result:**

- Skipped checks count as passing in the overall calculation. All checks can be skipped and
  the report can still say "Overall: passed"; this does not prove required checks ran.
- HEAD movement only produces a warning; it does not make verification fail. The result
  template still says nothing was committed, pushed or deployed. Treat that sentence as
  intended policy, not verified evidence of what the agent did.
- Git inspection is read-only, but npm scripts run as host child processes outside the Codex
  sandbox. Trusted project scripts may write build output or make other changes.
- Git status and HEAD are not captured again after those scripts, so their changes are absent
  from the recorded snapshot. Inspect the final workspace before accepting the result.

Review the diff, agent summary, actual check results and ticket acceptance criteria before
calling the work complete. [IDE-65](https://linear.app/ideahub-devkofi/issue/IDE-65) tracks the
completion/reporting improvements; they are not implemented in this version.

## Linear reporting

Beast attempts comments for **Queued**, **Working**, **Blocked**, **Failed** and
**Completed locally**, each ending with a **Next Action**. Result comments include verification
when available.

Delivery is best-effort. Queued is not awaited, so comments can arrive out of order.
Working is posted after workspace validation but **before** the agent launch; its "started"
wording does not prove a process started. A launch failure can follow it.

Reporting failures are logged without a persisted retry. Without `LINEAR_API_KEY`, no comment
is sent and a local log entry records that reporting is disabled. A missing comment does not
prove a missing job: inspect local `GET /jobs/:id`, `data/state.json`, and PM2 logs before retrying.

This version does not update Linear issue states or labels, and does not send messages into
ChatGPT. Those lifecycle improvements remain separate work under IDE-65.

## Persistence / idempotency

`data/state.json` (mode `0600`) stores jobs and processed webhook deliveries. Every mutation is
written atomically (temp file + rename).

- Duplicate deliveries are remembered across restarts.
- The same issue cannot have two `queued`/`working` jobs (enforced in the store).
- Queued jobs resume after restart.
- Jobs still `working` when Beast stopped are marked `failed` on startup (never silently re-run,
  because the workspace may contain partial changes), and reported to Linear.

This is single-process storage by design; run only one Beast instance.

## Logging

One JSON object per line on stdout. Safe fields: issue ID, project, workspace, job ID, job state,
agent, verification result. Any field whose name looks sensitive (`key`, `secret`, `token`,
`authorization`, `password`, `signature`, `env`, …) is redacted. Request headers and bodies are
never logged.

## Environment variables

| Variable                     | Default                         | Notes                                         |
| ---------------------------- | ------------------------------- | --------------------------------------------- |
| `PORT`                       | `3100`                          | Host is always `127.0.0.1`                    |
| `LINEAR_API_KEY`             | _(empty)_                       | Enables issue fetch + comments                |
| `LINEAR_WEBHOOK_SECRET`      | _(empty)_                       | Required to accept webhooks                   |
| `BEAST_READY_LABEL`          | `Beast Ready`                   | Authorization label                           |
| `BEAST_AGENT`                | `codex`                         | Agent adapter: `codex` or `claude`            |
| `BEAST_DATA_DIR`             | `./data`                        | State + logs                                  |
| `BEAST_PROJECTS_FILE`        | `./config/projects.json`        | Registry                                      |
| `BEAST_WORKSPACE_ROOT`       | `/home/ubuntu/projects`         | Fixed; any other value fails startup          |
| `BEAST_AGENT_TIMEOUT_MS`     | `3600000`                       | Agent timeout                                 |
| `BEAST_VERIFY_TIMEOUT_MS`    | `600000`                        | Per verification script                       |
| `BEAST_VERIFY_SCRIPTS`       | `test,lint,typecheck,build`     | npm scripts to run if present                 |
| `BEAST_WEBHOOK_TOLERANCE_MS` | `60000`                         | Max webhook age                               |
| `BEAST_CODEX_BIN`            | `codex`                         | Codex binary                                  |
| `BEAST_CODEX_MODEL`          | _(Codex default)_               | Optional model override                       |
| `BEAST_CLAUDE_BIN`           | `claude`                        | Claude Code binary                            |
| `BEAST_CLAUDE_MODEL`         | _(Claude Code default)_         | Optional model override                       |
| `LINEAR_API_URL`             | `https://api.linear.app/graphql`|                                               |
| `BEAST_ADMIN_MODE`           | `off`                           | `off`, `dry-run` or `enforce` (needs broker)  |
| `BEAST_RUNNER`               | `local`                         | `broker`: jobs run as beast-agent via executor|
| `BEAST_EXECUTOR_SOCKET`      | `/run/beast-executor/executor.sock` | Privileged executor socket                |
| `BEAST_ADMIN_SHARED_LINEAR_IDENTITY` | `false`                 | Linear API key belongs to an approver         |
| `BEAST_ADMIN_LABEL`          | `Beast Admin`                   | Admin request label                           |
| `BEAST_ADMIN_REQUESTERS`     | _(empty)_                       | Linear user IDs allowed to request            |
| `BEAST_ADMIN_APPROVERS`      | _(empty)_                       | Linear user IDs allowed to approve class C    |
| `BEAST_ADMIN_POLICY_FILE`    | `./config/admin-policy.json`    | Enabled admin operations (empty by default)   |

See `.env.example`. Never commit `.env`.

## Local startup

```bash
cd /home/ubuntu/apps/beast-api
npm install
cp .env.example .env        # fill in LINEAR_WEBHOOK_SECRET (and LINEAR_API_KEY if desired)
npm run build
npm start                   # or: npm run dev   (runs TypeScript directly via tsx)
curl http://127.0.0.1:3100/health
```

Sending a signed test webhook locally:

```bash
BODY=$(node -e 'console.log(JSON.stringify({action:"create",type:"Issue",webhookTimestamp:Date.now(),
  data:{id:"test-1",identifier:"TEST-1",title:"Test",labels:[{id:"l1",name:"Beast Ready"}],
  project:{id:"p",name:"Some Project"}}}))')
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$LINEAR_WEBHOOK_SECRET" | awk '{print $2}')
curl -s -XPOST http://127.0.0.1:3100/webhooks/linear -H 'Content-Type: application/json' \
  -H "Linear-Signature: $SIG" -H 'Linear-Delivery: test-1' -d "$BODY"
```

⚠️ Using a registered project name here **will launch the configured agent** in that real workspace (if it is clean).

## Testing

```bash
npm test          # vitest
npm run typecheck
npm run build
```

Tests mock Linear and the agent, build throwaway Git repositories under `./.test-tmp/` (removed
afterwards), and never touch the real project repositories.

Covered: health; invalid/missing/tampered signature; stale timestamp; valid webhook accepted and
returned before the agent finishes; ready-label authorization (including Linear-API-over-payload);
no re-trigger on unrelated updates; duplicate deliveries (also across restart); per-issue lock;
unknown project blocked; missing workspace / non-Git / dirty repo blocked (dirty changes left
intact); one job at a time; forged/unregistered workspaces refused by the launcher; symlink escape;
registry validation; adapter selection; Codex and Claude args, cwd, stdin and secret stripping;
Claude permission settings, result parsing, transcript redaction, cancellation and timeout; prompt
content; persistence and restart recovery; log redaction.

## Safety boundaries (summary)

- The Node service binds to `127.0.0.1` only; Nginx publicly exposes only the signed Linear webhook route.
- No execution without a valid signature, a fresh timestamp and the ready label.
- One agent at a time; one active job per issue.
- Agents only run in registered, existing, clean Git repositories under `/home/ubuntu/projects`.
- Codex is launched with `workspace-write`; Claude Code with `acceptEdits`, no permission prompts,
  ignored settings/MCP servers and a narrow Bash allowlist. Linear API/signing credentials are
  filtered from child environments. This is not a general credential allowlist.
- The agent prompt forbids commit/stash/discard/push/PR/merge/deploy and system changes.
  These policy instructions are not proof that every prohibited action is technically blocked.
- Beast's Git helpers only inspect state. Host-run project verification scripts are outside
  the Codex sandbox and must be trusted.
- Every child process runs under `setpriv --no-new-privs`: agents and verification scripts cannot
  gain root through `sudo`, `su` or `pkexec`.
- Admin operations are typed, opt-in per operation, validated before escalation and approved per
  exact scope for class C. Only the root broker `beast-executor` executes them ([ADMIN.md](docs/ADMIN.md)).
