# Beast API Architecture

## Purpose

Beast API is the orchestration service between Linear and coding agents running on the Beast VPS. It does not implement tickets itself. It validates an authorized Linear event, resolves the issue to a registered workspace, queues one job, launches the configured agent, verifies the local result, and reports the outcome to Linear.

## Execution flow

```text
Linear issue
  -> Beast Ready label
  -> Linear webhook
  -> signature + freshness + duplicate checks
  -> authorization
  -> exact project registry lookup
  -> FIFO queue
  -> clean-workspace validation
  -> fresh coding-agent process
  -> Git inspection + project verification commands
  -> Linear result comment
```

The webhook validates and enqueues without waiting for the coding job. When configured, it awaits a Linear API issue read first. The worker handles agent execution and project verification separately.

## Main components

- `src/app.ts`: HTTP routes.
- `src/webhook/`: Linear signature verification, replay protection, authorization, and intake.
- `src/registry/registry.ts`: exact Linear-project to VPS-workspace mapping.
- `src/workspace/`: Git and workspace safety checks.
- `src/queue/`: persistent jobs, webhook deliveries, and the single-concurrency worker.
- `src/agents/`: replaceable agent interface with Codex and Claude Code adapters.
- `src/verify/`: post-run Git and npm verification.
- `src/linear/`: Linear API access and status reporting.
- `src/logger.ts`: structured logging with secret-like fields redacted.

## Project registry

`config/projects.json` is the allowlist. Beast never derives or guesses a filesystem path from a Linear issue. A project must resolve exactly to a registered workspace under `BEAST_WORKSPACE_ROOT`.

Before execution, the workspace must exist, resolve inside the workspace root, be the top-level Git repository, and have a clean working tree. A failure blocks the job without changing the repository. These checks do not establish that it is the intended application repository.

The shipped Beast mapping targets `/home/ubuntu/projects/beast` (VPS documentation), not Beast API source. API work requires a verified development checkout and separately approved routing; do not infer the checkout from the production directory. See [LINEAR-WORKFLOW.md](LINEAR-WORKFLOW.md).

## Agent boundary

`AgentAdapter` keeps orchestration independent from the coding agent. `BEAST_AGENT` selects the adapter (`codex`, the default, or `claude`); either launches one fresh CLI process per job. The agent receives the ticket context and validated workspace, but Linear credentials are removed from its environment.

The Codex process uses `workspace-write` sandboxing. The Claude Code process runs with `acceptEdits`, no permission prompts (anything needing approval is denied), ignored user/project settings and MCP servers, and a narrow Bash allowlist; see the README for the exact rules. Beast does not grant the ordinary ticket workflow permission to commit, push, open pull requests, merge, deploy, alter system configuration, or write outside the registered workspace.

## Queue and persistence

Beast runs one agent job at a time in FIFO order. Job and webhook-delivery state is stored locally in `data/state.json`, which is ignored by Git. Duplicate webhook deliveries and concurrent jobs for the same issue are rejected.

Queued jobs can resume after a normal restart. A job that was still working when Beast stopped is marked failed rather than silently re-executed.

## Verification

After the agent returns, Beast captures Git status and HEAD, then runs configured npm verification scripts when available. Git helpers only inspect state; the npm scripts run as host child processes outside the agent sandbox and can modify files. They inherit the host environment except the two filtered Linear credentials. Use trusted scripts. The recorded Git snapshot is from before those scripts; Beast does not capture it again afterward.

Missing package metadata, scripts or dependencies cause checks to be skipped. Skipped checks count as passing, including when every check is skipped. HEAD movement is a warning only. A successful agent exit without an agent error, timeout or cancellation produces a completed job even if verification fails or the plain-text summary says work is incomplete.

Review the final workspace, actual checks and acceptance criteria. Local completion is not proof of task success, Linear Done, merge or deployment. [IDE-65](https://linear.app/ideahub-devkofi/issue/IDE-65) tracks the pending completion/reporting improvements.

## Production boundary

Node is hard-bound to loopback; 3100 is the default configurable port. The repository Nginx template exposes only `POST /webhooks/linear`. The dated VPS profile records HTTPS proxying to `127.0.0.1:3100`; current runtime and TLS configuration require live verification. See OPERATIONS.md for the evidence boundary.

See [OPERATIONS.md](OPERATIONS.md), [LINEAR-WORKFLOW.md](LINEAR-WORKFLOW.md), and [SECURITY.md](SECURITY.md).
