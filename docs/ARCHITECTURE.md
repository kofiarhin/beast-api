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
  -> read-only verification
  -> Linear result comment
```

The webhook request path stays fast. It validates and enqueues; the worker performs slow work after the HTTP request returns.

## Main components

- `src/app.ts`: HTTP routes.
- `src/webhook/`: Linear signature verification, replay protection, authorization, and intake.
- `src/registry/registry.ts`: exact Linear-project to VPS-workspace mapping.
- `src/workspace/`: Git and workspace safety checks.
- `src/queue/`: persistent jobs, webhook deliveries, and the single-concurrency worker.
- `src/agents/`: replaceable agent interface and Codex adapter.
- `src/verify/`: post-run Git and npm verification.
- `src/linear/`: Linear API access and status reporting.
- `src/logger.ts`: structured logging with secret-like fields redacted.

## Project registry

`config/projects.json` is the allowlist. Beast never derives or guesses a filesystem path from a Linear issue. A project must resolve exactly to a registered workspace under `BEAST_WORKSPACE_ROOT`.

Before execution, the workspace must exist, resolve inside the workspace root, be the top-level Git repository, and have a clean working tree. A failure blocks the job without changing the repository.

## Agent boundary

`AgentAdapter` keeps orchestration independent from the coding agent. The current adapter launches a fresh Codex CLI process for each job. The agent receives the ticket context and validated workspace, but Linear credentials are removed from its environment.

The Codex process uses `workspace-write` sandboxing. Beast does not grant the ordinary ticket workflow permission to commit, push, open pull requests, merge, deploy, alter system configuration, or write outside the registered workspace.

## Queue and persistence

Beast runs one agent job at a time in FIFO order. Job and webhook-delivery state is stored locally in `data/state.json`, which is ignored by Git. Duplicate webhook deliveries and concurrent jobs for the same issue are rejected.

Queued jobs can resume after a normal restart. A job that was still working when Beast stopped is marked failed rather than silently re-executed.

## Verification

After a normal agent exit, Beast captures Git status and changed files, checks whether HEAD moved, and runs configured npm verification scripts when they exist. Verification is observational: Beast does not clean, reset, stash, or commit the workspace.

## Production boundary

The Node process binds only to `127.0.0.1:3100`. Nginx is the public boundary and exposes only `POST /webhooks/linear`. Local health and job-status endpoints are intentionally not public.

See [OPERATIONS.md](OPERATIONS.md), [LINEAR-WORKFLOW.md](LINEAR-WORKFLOW.md), and [SECURITY.md](SECURITY.md).
