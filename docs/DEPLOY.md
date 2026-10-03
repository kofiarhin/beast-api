# Controlled Production Deployment (IDE-82)

Beast can deploy an exact Git commit to a registered deployment target, verify it, health-check it and roll it back. It is built on the controlled admin path in [ADMIN.md](ADMIN.md): deployments are typed admin operations, validated by Beast API, approved per deployment in Linear, and executed by `beast-executor`.

There is no deploy shell, no command string and no free-form parameter. A ticket can name a **target id** and a **full 40-character commit id**, nothing else. Everything a deployment does comes from a root-owned definition file.

## Operations

| Operation | Class | Params | Effect |
|---|---|---|---|
| `deploy.status` | A | `target` | Definition, deployed commit, PM2 state, one health probe, last Beast deployment |
| `deploy.run` | **C** | `target`, `commit` | Verify the commit, deploy it, restart, health-check; roll back automatically on failure |
| `deploy.rollback` | **C** | `target` | Return to the commit that preceded Beast's last successful deployment of the target |

`deploy.run` and `deploy.rollback` are always class C. Every deployment needs its own `/beast approve <digest>` from an authorized approver. The approval digest binds:

- the target's full definition (`deployment.definitionHash` plus every field, shown in the plan);
- the currently deployed commit (`target.currentCommit`);
- the requested commit (`deploy.commit`) or the rollback commit (`rollback.toCommit`);
- the issue, its description, the requester, a nonce and a 15-minute expiry.

If the checkout moves, the definition changes or the commit changes, the approval is void. Each approval runs once.

Request one with the `Beast Admin` label and:

```
Beast admin operation: deploy.run
Beast admin params: {"target":"beast-deploy-test","commit":"<40-hex commit id>"}
```

## Deployment definitions

Definitions live only in `/etc/beast-executor/deployments.json` (`root:root 0644`; repository copy `deploy/executor-deployments.json`). A missing file means no targets. An invalid file denies every deployment. Unknown keys are rejected at every level.

| Field | Meaning |
|---|---|
| `id` | Target id used in tickets (`^[a-z0-9][a-z0-9-]{0,62}$`) |
| `project`, `production` | Display name; `false` marks an isolated test target |
| `mechanism` | `pm2-git`: a Git checkout run by a PM2 app owned by the PM2 user. The only mechanism so far |
| `source.workspace`, `source.branch` | Git workspace under `/home/ubuntu/projects`, and the branch a commit must be on |
| `target.checkout`, `target.pm2App` | Production checkout (strictly under `/home/ubuntu/apps`, owned by the PM2 user, never Beast's own) and the PM2 app that must run from it |
| `install` | `npm-ci` or `none` |
| `preDeploy` | npm script names run in an isolated clone of the exact commit before production is touched |
| `build` | npm script names run in the production checkout after checkout, before restart |
| `health` | `http://127.0.0.1:<port><path>` only, expected status, attempts, interval |
| `rollback` | `previous-commit` or `none` |

**Register a target only from a verified, documented procedure.** Do not guess build commands, health URLs or rollback behaviour. Adding or changing a definition is a root-owned VPS configuration change and needs Kofi's approval.

## What `deploy.run` does

All checks run before anything changes. The broker re-runs Beast's validation itself and compares the facts.

1. **Validate** (Beast API and broker):
   - the target is known;
   - no path component is a symlink;
   - the checkout is the root of a Git repo with no modified tracked files;
   - the PM2 app exists and runs from the checkout;
   - the commit exists, is on the source branch, is a fast-forward of the deployed commit and is not already deployed.
2. **Pre-deployment verification** as `beast-agent`, in a fresh clone of the exact commit in a private temp directory: `npm ci`, then each `preDeploy` script. On failure, production is untouched.
3. **Recheck** that the checkout is still at the approved commit.
4. **Check out** as the PM2 owner: `git fetch <source> <branch>`, confirm the commit is on it, `git merge --ff-only <commit>`.
5. **Activate**: `npm ci`, each `build` script, `pm2 restart <app>`, the health check, and a PM2 `online` check.
6. **On any failure after checkout**: `git reset --keep <previous>`, then activate again (with `rollback: previous-commit`). The result reports whether the rollback is healthy.
7. **Record** the deployment in `/var/lib/beast-executor/deployments/<id>.json` (root-only). Explicit rollbacks use this record.

## Privilege model

- Root runs no deployment step itself. It runs each step through `setpriv` with no capabilities and `no_new_privs`, so `sudo` is impossible:
  - the source workspace and the verification clone (which agents can write) run as `beast-agent`;
  - the production checkout and PM2 run as the PM2 owner (`ubuntu`), the account that already runs the app.
- Git runs with `core.fsmonitor=false` and `core.hooksPath=/dev/null`, so repository configuration cannot start programs.
- Steps get a fixed environment (`HOME`, `PATH`, locale, `CI=true`) and no Beast or executor secrets.
- Output goes through Beast's redaction and size bounds before it reaches the audit log or Linear.
- Health checks only ever request `127.0.0.1`.

## Registered targets

| Target | Production | Notes |
|---|---|---|
| `beast-deploy-test` | no | Isolated test target for verifying this path. Source `/home/ubuntu/projects/beast-deploy-test`, checkout `/home/ubuntu/apps/beast-deploy-test`, PM2 `beast-deploy-test`, `127.0.0.1:3199` only, no Nginx site. Not in the saved PM2 dump. |

No production application is registered. As of 2026-10-03 none has a documented deployment procedure:

- **Banging Prices:** the profile states its VPS procedure is undocumented, and its `/apps` checkout has local changes.
- **DevKofi:** a hand-copied release, not a Git checkout.
- **IdeaHub API:** a Git checkout with a PM2 ecosystem file, but no recorded runbook.

Each production target needs a confirmed procedure and an approved definition before it is added. Mechanisms not yet supported (static `/var/www` frontends, Vercel, Heroku, systemd services) need a new typed mechanism, not a script.

## Known limits

- A deployment holds the executor's single admin lane until it finishes. The Beast API side waits at most 90 minutes.
- If Beast API restarts during a deployment, the admin job is marked failed, but the broker finishes the deployment and records it. Check with `deploy.status`.
- `pm2-git` restarts with `pm2 restart <app>`. It does not change the app's PM2 configuration or environment.
