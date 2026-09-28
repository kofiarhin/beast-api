# Beast API

Beast is the automation/orchestration layer on the VPS. It **does not implement tickets itself**.
It receives authorized Linear tickets and launches a coding agent (Codex CLI today, Claude Code
later) inside the correct, registered project workspace, then verifies the result and reports back
to Linear.

```
ChatGPT → Linear ticket → label "Beast Ready" → Linear webhook → Beast API
  → verify + authorize → map project → registered workspace → coding agent
  → verify result → comment on Linear
```

> **Production status:** Beast API is deployed on the Beast VPS. The Node process remains bound to
> `127.0.0.1:3100`; Nginx/TLS exposes only `POST /webhooks/linear` at
> `beast-api.devkofi.com`. Local health and job-status endpoints are not public.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, execution path, registry, queue, agent and verification boundaries.
- [Linear workflow](docs/LINEAR-WORKFLOW.md) — how an issue becomes an authorized Beast job and how results return to Linear.
- [Operations](docs/OPERATIONS.md) — production layout, health checks, logs, restart rules and troubleshooting.
- [Security](docs/SECURITY.md) — trust boundaries, secrets, workspace protection and production permissions.

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
    launcher.ts          the single guarded entry point for launching an agent
    prompt.ts            structured task prompt for the agent
  queue/
    store.ts             JSON-file persistence (jobs + webhook deliveries)
    worker.ts            single-concurrency worker
  verify/verify.ts       post-run inspection (git status, changed files, checks)
  util/exec.ts           child process runner (no shell, timeouts, secret-free env)
config/projects.json     project registry
data/                    runtime state (state.json, logs/) — created automatically, git-ignored
```

The webhook path and the execution path are fully separated. The webhook handler only
validates, authorizes and enqueues; the worker does everything slow.

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
10. **Enqueue** — a `queued` job is persisted, a "Queued" comment is posted, the worker is kicked,
    and the request returns `202` immediately.

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

- workspace paths must be absolute, normalized, and **inside** `BEAST_WORKSPACE_ROOT`
  (`/home/ubuntu/projects`);
- names and paths must be unique.

Resolution is **exact** (case-insensitive name, or `linearProjectId` if pinned). There is no fuzzy
matching and no path derivation — Beast never guesses a workspace. An issue with no project or an
unregistered project is blocked.

### Registering another project

1. Make sure the repo exists at `/home/ubuntu/projects/<dir>` and is a clean Git repository.
2. Add an entry to `config/projects.json`:
   ```json
   { "name": "My Linear Project Name", "workspace": "/home/ubuntu/projects/my-project" }
   ```
   Optionally add `"linearProjectId": "<uuid>"` so the mapping survives a project rename.
3. Restart Beast API.

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

### Adding Claude Code later

1. Create `src/agents/claude.ts` implementing `AgentAdapter` (e.g. `claude -p` with the prompt on
   stdin, `cwd` = `request.workspace.path`, restricted permission mode / allowed tools, and
   `childEnv()` for the environment).
2. Register it in `ADAPTERS` in `src/agents/index.ts` and remove `claude` from `PLANNED`.
3. Add adapter tests mirroring `tests/agents.test.ts`.
4. Set `BEAST_AGENT=claude`.

Nothing in the webhook, queue, worker, verification or reporting code needs to change.

## Queue / worker

- One worker, **at most one active agent job**; others wait in FIFO order.
- `worker.kick()` is called after each enqueue and on startup (to resume queued jobs).

Per job: mark `working` → re-resolve project from registry → validate workspace → post "Working" →
launch agent → verify → mark `completed` or `failed` → post result → next job.

Job states: `queued`, `working`, `blocked`, `failed`, `completed`.

- `failed` = agent could not start, exited non-zero, or timed out.
- `completed` = agent exited 0. The comment says "Completed locally", or "Completed locally —
  verification failed" if any check failed.

## Verification

After the agent exits, Beast records (without modifying Git state):

- agent exit status / timeout;
- `git status` and the list of changed files (captured **before** running any scripts);
- whether `HEAD` moved (flagged as a warning — the agent should not commit);
- `npm run <script>` for each of `BEAST_VERIFY_SCRIPTS` (default `test,lint,typecheck,build`)
  that exists in `package.json`. Missing scripts or missing `node_modules` are reported as
  `skipped`. Scripts run with `CI=true` and a secret-free environment.

Nothing is pushed or deployed.

## Linear reporting

Comments are posted for **Queued**, **Working**, **Blocked**, **Failed** and **Completed locally**.
Each says what happened and ends with a **Next Action**. Completed/failed comments include the
verification summary. Reporting errors are logged and never break job processing. Without
`LINEAR_API_KEY`, comments are only logged locally.

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
| `BEAST_AGENT`                | `codex`                         | Agent adapter                                 |
| `BEAST_DATA_DIR`             | `./data`                        | State + logs                                  |
| `BEAST_PROJECTS_FILE`        | `./config/projects.json`        | Registry                                      |
| `BEAST_WORKSPACE_ROOT`       | `/home/ubuntu/projects`         | All workspaces must be inside                 |
| `BEAST_AGENT_TIMEOUT_MS`     | `3600000`                       | Agent timeout                                 |
| `BEAST_VERIFY_TIMEOUT_MS`    | `600000`                        | Per verification script                       |
| `BEAST_VERIFY_SCRIPTS`       | `test,lint,typecheck,build`     | npm scripts to run if present                 |
| `BEAST_WEBHOOK_TOLERANCE_MS` | `60000`                         | Max webhook age                               |
| `BEAST_CODEX_BIN`            | `codex`                         | Codex binary                                  |
| `BEAST_CODEX_MODEL`          | _(Codex default)_               | Optional model override                       |
| `LINEAR_API_URL`             | `https://api.linear.app/graphql`|                                               |

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

⚠️ Using a registered project name here **will launch Codex** in that real workspace (if it is clean).

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
registry validation; adapter selection; Codex args, cwd, stdin and secret stripping; prompt
content; persistence and restart recovery; log redaction.

## Safety boundaries (summary)

- The Node service binds to `127.0.0.1` only; Nginx publicly exposes only the signed Linear webhook route.
- No execution without a valid signature, a fresh timestamp and the ready label.
- One agent at a time; one active job per issue.
- Agents only run in registered, existing, clean Git repositories under `/home/ubuntu/projects`.
- Codex is sandboxed to the workspace; Beast's secrets are not passed to it.
- Beast never commits, stashes, discards, pushes, opens PRs, merges or deploys.
