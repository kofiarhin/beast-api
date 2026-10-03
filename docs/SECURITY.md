# Beast API Security Model

## Core rule

A Linear ticket is not enough to execute code. Beast requires a valid signed webhook, a fresh event, an authorized `Beast Ready` transition, an exact registered project, and a safe clean workspace.

## Trust boundaries

**Internet -> Nginx:** the intended public boundary is the HTTPS Linear webhook endpoint only. The checked-in Nginx file is an HTTP bootstrap template; current live TLS/routing must be verified separately.

**Nginx -> Beast API:** Node listens on loopback only.

**Linear -> queue:** HMAC-SHA256 signature validation, timestamp freshness checks, delivery deduplication, event filtering, and ready-label authorization run before enqueueing.

**Queue -> workspace:** only an exact registry mapping can select a workspace. Real paths must remain under the configured workspace root.

**Workspace -> agent:** only a validated clean top-level Git repository can reach the agent launcher.

**Agent -> host:** Codex is launched with `workspace-write` sandboxing. Claude Code is launched with `acceptEdits` and no permission prompts, so file access outside the workspace and Bash commands outside a narrow allowlist (npm test/lint/typecheck/build, read-only Git) are denied; user/project settings, hooks, MCP servers (including Linear) and web tools are disabled, and sessions are not persisted. Its OS sandbox needs `bubblewrap` and `socat`; both are now installed on the VPS, but whether that layer is active has not been re-verified, so treat the allowlist as what restricts Bash. These rules are defence in depth, not a replacement for the post-run Git approval checks. Child environments inherit the host environment except `LINEAR_API_KEY` and `LINEAR_WEBHOOK_SECRET`. This filtering is not a general credential allowlist; unrelated credentials may remain.

**No privilege escalation for ordinary jobs:** every child process Beast starts (agents, verification scripts, Git, host probes) runs under `setpriv --no-new-privs`, so the kernel refuses `sudo`, `su` and `pkexec` even though the `ubuntu` user has unrestricted sudo. If `setpriv` is unavailable nothing runs. Verification that relies on sudo fails with a clear reason. Jobs still run as `ubuntu`, so they could plant files (for example `~/.bashrc`) that a later privileged human session runs; separate service users at activation close this.

**Verification -> host:** Beast launches project npm scripts directly as host child processes, outside the agent sandbox, with the same two credentials filtered. These scripts can write files and run commands with the service user's permissions. Only run trusted project scripts; verification is not a read-only or sandboxed safety boundary.

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

Ordinary execution does not authorize commits, pushes, pull requests, merges, deployment, destructive Git commands, or unrelated file deletion. The agent prompt states these restrictions; do not treat every instruction as a technically enforced prohibition.

HEAD movement only causes a warning and does not fail verification. The completed-result template still says nothing was committed, pushed or deployed, even when HEAD moved. Review actual Git evidence rather than treating that sentence as proof.

Git status and HEAD are captured before npm scripts run, not afterward. All-skipped checks can be reported as passed, and failed checks do not prevent a completed job. Completion is not proof of acceptance or policy compliance. See [LINEAR-WORKFLOW.md](LINEAR-WORKFLOW.md).

## Process safety

Only one agent job runs at a time. Agent processes have a configurable timeout. Cancellation, timeout, and graceful shutdown terminate the process group; Beast does not automatically retry state-changing agent runs.

A forced SIGKILL of the Beast service itself cannot perform graceful child cleanup. After abnormal termination, inspect processes and workspace state before retrying.

## Logging

Structured application logs redact fields whose names look secret-like. Request bodies and headers are not logged. Redaction is defense in depth, not permission to place secrets in normal log fields.

## Production permissions

The current Beast Ready workflow is deliberately narrower than full VPS administration. Controlled admin operations (IDE-69) are a separate, typed, opt-in path with risk classes and exact approvals; they are off by default and can only run in dry-run until a privileged executor is activated. See [ADMIN.md](ADMIN.md). Production deployment, PM2/system changes, Nginx, firewall, DNS, public ports, destructive Git operations, and similar consequential actions require separate explicit approval.
