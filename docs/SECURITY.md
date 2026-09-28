# Beast API Security Model

## Core rule

A Linear ticket is not enough to execute code. Beast requires a valid signed webhook, a fresh event, an authorized `Beast Ready` transition, an exact registered project, and a safe clean workspace.

## Trust boundaries

**Internet -> Nginx:** only the HTTPS Linear webhook endpoint is public.

**Nginx -> Beast API:** Node listens on loopback only.

**Linear -> queue:** HMAC-SHA256 signature validation, timestamp freshness checks, delivery deduplication, event filtering, and ready-label authorization run before enqueueing.

**Queue -> workspace:** only an exact registry mapping can select a workspace. Real paths must remain under the configured workspace root.

**Workspace -> agent:** only a validated clean top-level Git repository can reach the agent launcher.

**Agent -> host:** Codex runs with workspace-write sandboxing and a restricted environment. Linear credentials are stripped.

## Secrets

Secrets belong in private server configuration, never in Git. The repository intentionally ignores `.env`, runtime data, logs, and build/dependency output.

Never commit or paste:
- Linear API keys
- Linear webhook signing secrets
- tokens or passwords
- SSH private keys
- production `.env` values
- credential-store contents

`.env.example` documents variable names only.

## Repository protection

Beast refuses dirty workspaces rather than stashing, resetting, discarding, or overwriting existing work. It also warns if the agent moves Git HEAD.

Ordinary execution does not authorize commits, pushes, pull requests, merges, deployment, destructive Git commands, or unrelated file deletion.

## Process safety

Only one agent job runs at a time. Agent processes have a configurable timeout. Cancellation, timeout, and graceful shutdown terminate the process group; Beast does not automatically retry state-changing agent runs.

A forced SIGKILL of the Beast service itself cannot perform graceful child cleanup. After abnormal termination, inspect processes and workspace state before retrying.

## Logging

Structured application logs redact fields whose names look secret-like. Request bodies and headers are not logged. Redaction is defense in depth, not permission to place secrets in normal log fields.

## Production permissions

The current Beast Ready workflow is deliberately narrower than full VPS administration. Production deployment, PM2/system changes, Nginx, firewall, DNS, public ports, destructive Git operations, and similar consequential actions require separate explicit approval.
