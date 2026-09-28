# Beast API Operations

## Production layout

- Application: `/home/ubuntu/apps/beast-api`
- PM2 process: `beast-api`
- Bind address: `127.0.0.1:3100`
- Public hostname: `beast-api.devkofi.com`
- Public route: `POST /webhooks/linear`
- Private environment file: `/home/ubuntu/.config/beast-api/production.env`
- Runtime state/log directory: application `data/` directory
- Registered agent workspaces: under `/home/ubuntu/projects`

The environment file and runtime data are not committed.

## Public exposure

Nginx terminates HTTPS and proxies only the exact Linear webhook route to the loopback Node service. Other public paths return 404, and non-POST methods on the webhook route are denied. Port 3100 is not a public listener.

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

Changing `config/projects.json` changes where Beast may execute work. Confirm the intended Linear project and exact workspace, verify the repository exists and is clean, review the change, then restart Beast API only after explicit approval.

## Troubleshooting

**Webhook rejected:** check service health, Linear webhook configuration, signature-secret configuration, and timestamps. Do not print the secret.

**Issue does not run:** confirm the issue belongs to a registered Linear project and that `Beast Ready` was newly added.

**Job blocked:** read the Linear comment. Common causes are an unknown project, missing workspace, non-Git directory, or dirty Git working tree.

**Agent fails:** inspect the job/PM2 logs for the exit reason, then check Codex availability/authentication and the workspace. Do not automatically retry state-changing work.

**Verification fails:** distinguish failures caused by the agent's changes from pre-existing project failures before deciding the next action.

## Production changes

Deployment, Nginx changes, firewall changes, DNS changes, service changes, and destructive operations are outside ordinary Beast Ready authorization and require explicit approval.
