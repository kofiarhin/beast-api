# Beast API Operations

## Documented production baseline

The [VPS profile](https://github.com/kofiarhin/beast/blob/main/VPS-Beast-AI-Agent-Profile.md) records Beast API PM2/loopback/HTTPS observations dated 2026-09-28. The paths below also reflect the repository deployment templates. They are not a fresh live check. Verify current process settings, deployed revision and active Nginx/TLS configuration before production work.

## Production layout

- Application: `/home/ubuntu/apps/beast-api`
- PM2 process: `beast-api`
- Bind address: `127.0.0.1:3100`
- Public hostname: `beast-api.devkofi.com`
- Public route: `POST /webhooks/linear`
- Private environment file: `/home/ubuntu/.config/beast-api/production.env`
- Runtime state/log directory: application `data/` directory
- Registered agent workspaces: under `/home/ubuntu/projects`

The environment file and runtime data are not committed. Port 3100 and application `data/` are defaults; `PORT` and `BEAST_DATA_DIR` can override them.

## Public exposure

The intended Nginx/TLS topology exposes only the exact Linear webhook route to the loopback Node service. The bootstrap template returns 404 for other paths and denies non-POST methods on the webhook route. Verify the active site before claiming these restrictions hold in production.

The repository contains the Nginx bootstrap configuration in `deploy/nginx-beast-api.devkofi.com.conf`. The live TLS configuration may contain Certbot-managed additions, so the repository file should not be treated as a byte-for-byte copy of the active Nginx site.

## Safe health checks

From the VPS:

```bash
curl -s http://127.0.0.1:3100/health
pm2 status beast-api
ss -ltnp | grep ':3100'
```

Expected: health reports healthy, PM2 reports `beast-api` online, and port 3100 listens on loopback only.

Externally, `/health` is intentionally unavailable. An unsigned webhook POST should be rejected; never paste or print the signing secret to test it.

## Build and test

Before a release candidate:

```bash
npm test
npm run typecheck
npm run build
```

The production process runs the compiled `dist/server.js`.

## Restart policy

A Beast API restart is a production change. Inspect current status and logs first, explain why a restart is required, and obtain explicit approval before restarting it.

The repository includes `deploy/pm2-start.sh` for initial PM2 setup. Do not casually rerun it as a restart command because it creates/saves PM2 state.

## Logs and state

Use PM2 logs and the application runtime logs for diagnosis. Never paste secrets, environment-file contents, webhook signatures, API keys, or tokens into tickets, chat, or GitHub.

`data/state.json` contains local queue/delivery state and is intentionally ignored by Git.

## Updating the project registry

The default registry is `config/projects.json`; `BEAST_PROJECTS_FILE` can override it. Changing the active registry changes where Beast may execute work.

The shipped Beast entry points to `/home/ubuntu/projects/beast` (VPS documentation), not Beast API source. A clean Git checkout alone does not prove it is the correct codebase. For API work, first verify the development checkout under the configured workspace root and its repository identity. Do not guess a path, use the production runtime copy, or silently redirect all Beast tasks. IDE-65 tracks this routing prerequisite.

Review the exact change and preserve existing routing. Apply registry changes and restart Beast API only after explicit approval; only then re-add Beast Ready for the intended task.

## Troubleshooting

**Webhook rejected:** check service health, Linear webhook configuration, signature-secret configuration, and timestamps. Do not print the secret.

**Issue does not run:** confirm the issue belongs to a registered Linear project and that `Beast Ready` was newly added.

**Job blocked:** read the Linear comment. Common causes are an unknown project, missing workspace, non-Git directory, or dirty Git working tree.

**Agent fails:** inspect the job/PM2 logs for the exit reason, then check that the configured agent CLI (`codex` or `claude`) is available and logged in for the service user, and check the workspace. Do not automatically retry state-changing work.

**Missing or misleading progress:** comments are best-effort, may arrive out of order and are not retried durably. Working is posted before launch. Check local job state and PM2 logs before re-adding Beast Ready; a missing comment does not mean the job never ran.

**Verification fails or every check is skipped:** completed is an agent-exit outcome, not acceptance of the ticket. Skipped checks count as passing and failed checks do not prevent the completed job state. Inspect the final diff, summary and required checks; distinguish new failures from pre-existing ones before deciding the next action.

**Verification changes files:** project npm scripts run outside the agent sandbox as host processes. Use trusted scripts and inspect the workspace afterward; the recorded Git status/HEAD snapshot was taken before the scripts.

## Production changes

Deployment, Nginx changes, firewall changes, DNS changes, service changes, and destructive operations are outside ordinary Beast Ready authorization and require explicit approval.
