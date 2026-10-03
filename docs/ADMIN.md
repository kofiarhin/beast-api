# Controlled VPS Administration (IDE-69)

## Status

**Activated on Beast (enforce mode).** `BEAST_ADMIN_MODE` is `off` by default; `dry-run` runs the whole flow but executes nothing; `enforce` executes through the root broker `beast-executor` and is only accepted together with `BEAST_RUNNER=broker`.

## Model

- **Three accounts.**
  - `beast` runs Beast API. It has no sudo, and its systemd unit sets `NoNewPrivileges=yes`, an empty capability set and a read-only filesystem except its state, the workspace root and the executor socket directory.
  - `beast-agent` runs every coding agent, verification script and Git command. It cannot reach the executor socket.
  - `root` runs only `beast-executor`.
- **Beast API is the policy boundary.** It validates and authorizes every request, including class C approvals from Linear.
- **`beast-executor` is the only privileged path.**
  - It listens on `/run/beast-executor/executor.sock` (mode `0660`, `root:beast`, set by systemd socket activation).
  - It accepts typed operations, never a command string.
  - It re-validates every request independently: its own root-owned policy (`/etc/beast-executor/policy.json`), its own target probe, the facts Beast validated (for example the inode of a chown target), the risk class, and single use of each class C approval digest.
  - It runs a fixed program with a fixed argument vector, or a direct syscall (`lchown`).
- **Jobs never run as Beast or root.**
  - The broker starts `claude`, `codex`, `npm run test|lint|typecheck|build` and `git` as `beast-agent`, through `setpriv` (no capabilities, empty bounding set, `no_new_privs`).
  - It uses an environment it builds itself; only `CI`, `FORCE_COLOR`, `GIT_TERMINAL_PROMPT` and `GIT_OPTIONAL_LOCKS` can be set by Beast API.
  - Beast API therefore never executes workspace content (for example Git hooks or `core.fsmonitor`) as `beast`.

Forbidden by design: `sudo <arbitrary command>`, `su`, `bash -c`/`sh -c` with arbitrary input, `execRoot(command)`, `runAsRoot(commandString)`, and any interactive or arbitrary root shell. `src/admin` has no command-string type and does not import `child_process`. In `src/executor`, only `proc.ts` starts processes, never with a shell.

## Requesting an operation

Add the `Beast Admin` label to an issue whose description contains exactly one directive:

```
Beast admin operation: pm2.restart
Beast admin params: {"app":"ideahub-api"}
```

- The params line is optional for operations without parameters and must be a single-line JSON object.
- The user who added the label is looked up through the Linear API and must be in `BEAST_ADMIN_REQUESTERS`.
- An issue cannot carry both `Beast Admin` and `Beast Ready`. A coding job on such an issue is blocked, and the admin request is denied.

## Risk classes

| Class | Meaning | Gate |
|---|---|---|
| A | read-only inspection | authorized requester |
| B | narrow, reversible change | authorized requester (Beast authorization) |
| C | dangerous or sensitive change | authorized requester **and** exact, scope-bound approval |

## Operations (v1)

Every operation is **disabled until listed in `enabledOperations`** in `config/admin-policy.json`, which ships empty.

| Operation | Class | Params |
|---|---|---|
| `service.status` | A | `unit` |
| `pm2.status` | A | `app` (optional) |
| `nginx.test` | A | none |
| `system.logs` | A | exactly one of `unit` / `app` / `nginx` (`access`\|`error`), plus `lines` (1–500). Output is always redacted, at most 8 KB, and withheld if redaction fails. |
| `package.inspect` | A | `name` |
| `filesystem.inspect` | A | `path`; returns metadata only, never file contents |
| `service.restart` | B, or C for protected services | `unit` |
| `pm2.restart` | B | `app` |
| `nginx.reload` | B | none; reloads only after `nginx -t` passes |
| `filesystem.chown` | C | `path`, `owner`, `group`, `recursive` (explicit `true`/`false`) |

`profile.update` is **not** an admin operation. The existing VPS profile updater stays separate and unchanged and runs through its established mechanism.

**Refused outright, whatever the approval:** restarting `beast-api` or `beast-executor` through `service.restart` or `pm2.restart`.

## Validation (all before any privilege escalation)

The following are rejected:
- unknown or disabled operations;
- unknown, missing or mistyped params;
- params objects that aren't plain objects;
- whitespace, quotes, control characters or shell syntax in any value;
- values starting with `-`;
- integers out of range.

**Names:**
- systemd units must match `^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,127}\.(service|socket|timer|target)$` and be `loaded`;
- PM2 apps must exist in the live list, by exact name;
- owners and groups must be existing account names (numeric IDs are rejected);
- package names must match the Debian format.

**Paths:**
- absolute and already canonical, with no `.`, `..`, `//`, trailing `/` or unsupported characters;
- not under `/proc`, `/sys`, `/dev` or `/run/user`;
- **no symlink in any component, leaf included**;
- must exist and be verifiable without privileges.

**Uncertain means deny:** if Linear, systemd, PM2 or NSS can't be queried, or a path can't be inspected, the request is denied.

## Protected targets

**Services** (restart is class C): `ssh`, `sshd`, `systemd-*`, `dbus`, `ufw`, `cron`, `polkit`, `networking`, `systemd-networkd`, `systemd-resolved`, and `nginx` (restart; `nginx.reload` stays class B).

**Paths:**
- `/`, and anything under `/etc`, `/boot`, `/usr`, `/bin`, `/sbin`, `/lib*`, `/var/lib/dpkg` or `/root`;
- any path containing a component named `.ssh`, `authorized_keys`, `.codex`, `.claude`, `.env`, `.env.*`, `*.env`, `*.pem`, `*.key` or `id_*`;
- Beast's own code, data, policy and audit locations.

A recursive change that covers one of these, or a whole home directory, is protected too.

Protected targets fail closed unless the exact operation is approved. The plan comment marks them `PROTECTED TARGET`, and the flag is part of the approval digest. The policy file can add protected entries but cannot remove the built-in ones.

## Class C approval

1. **Plan.** Beast posts a plan comment with:
   - the operation and its exact parameters;
   - the current target state, for example the inode, owner and mode of a chown target;
   - the protected flag;
   - an expiry 15 minutes ahead;
   - the line `/beast approve <64-hex digest>`.

   The digest covers the operation, its version, parameters, target facts, risk class, protected flag, issue, description hash, requester, a nonce and the expiry.
2. **Approval comment.** It counts only if:
   - it is a **new comment** whose entire body is exactly `/beast approve <digest>`;
   - it is on the **same issue**;
   - it is not edited;
   - it was not posted by Beast itself (Beast records the ID of every comment it posts);
   - its author is in `BEAST_ADMIN_APPROVERS` and is not Beast's own Linear user. Exception: with `BEAST_ADMIN_SHARED_LINEAR_IDENTITY=true` (Beast's API key belongs to the human approver), that user may approve; Beast-posted comments are still rejected by ID;
   - it arrives before expiry.

   The requester may also approve. `/beast deny <digest>` cancels the plan.
3. **Recheck before execution.** Beast re-reads the issue: the label must still be present and the description unchanged. It re-validates the request and recomputes the digest. Any drift voids the approval.
4. **Single use.** The approval nonce is consumed before execution starts, and the broker separately records each digest it has executed, so an approval can never run twice. Unapproved plans expire after 15 minutes.

## Results, audit, failures

- **Results** have a known status (`succeeded`, `failed`, `denied`, `dry_run`), scalar fields only, and output that is redacted and bounded. A redaction failure withholds the output.
- **Audit:** `data/admin-audit.jsonl` (mode 0600) is an append-only hash chain covering every request, decision, plan, approval, execution and result, with redacted data.
  - A chain that fails verification blocks all admin execution.
  - If the audit entry can't be written, the operation is not executed.
- **Failures:**
  - An executor error becomes `failed`. It is never retried and never falls back to another executor.
  - Admin jobs interrupted by a restart are marked failed.
  - A single admin lane runs one operation at a time, separately from coding jobs.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `BEAST_ADMIN_MODE` | `off` | `off`, `dry-run` or `enforce`; `enforce` requires `BEAST_RUNNER=broker` |
| `BEAST_RUNNER` | `local` | `broker` runs every child process as `beast-agent` through beast-executor |
| `BEAST_EXECUTOR_SOCKET` | `/run/beast-executor/executor.sock` | |
| `BEAST_ADMIN_LABEL` | `Beast Admin` | Always mutually exclusive with `BEAST_READY_LABEL` |
| `BEAST_ADMIN_REQUESTERS` | _(empty)_ | Comma-separated Linear user IDs |
| `BEAST_ADMIN_APPROVERS` | _(empty)_ | Comma-separated Linear user IDs |
| `BEAST_ADMIN_SHARED_LINEAR_IDENTITY` | `false` | `true` when Beast's Linear API key belongs to an approver |
| `BEAST_ADMIN_POLICY_FILE` | `./config/admin-policy.json` | Production: `/etc/beast-api/admin-policy.json` |

Admin mode also needs `LINEAR_API_KEY` (to verify requesters and approvers), and the Linear webhook must send **Comment** events.

## Ordinary jobs cannot escalate

- With `BEAST_RUNNER=broker`, jobs run as `beast-agent` under `no_new_privs` with no capabilities. `beast-agent` has no sudo, and it is not in the `beast` group, so it cannot open the executor socket.
- With `BEAST_RUNNER=local` (development), `runCommand` starts every child as `setpriv --no-new-privs -- <cmd>`, with no opt-out. If `/usr/bin/setpriv` is missing, nothing runs.
- A verification script that tries `sudo`, `su` or `pkexec` fails with: *verification script attempted privilege escalation (sudo/su/pkexec); blocked by no-new-privs*.

## Production layout (activation)

| Item | Location |
|---|---|
| Beast API unit | `/etc/systemd/system/beast-api.service` (from `deploy/systemd/`), user `beast` |
| Beast API env file | `/etc/beast-api/production.env` (`root:beast 0640`) |
| Beast API admin policy | `/etc/beast-api/admin-policy.json` (root-owned) |
| Beast API state, job logs, admin audit | `/var/lib/beast-api` |
| Executor units | `/etc/systemd/system/beast-executor.{socket,service}` |
| Executor code | `/opt/beast-executor` (root-owned copy of `dist/`) |
| Executor policy | `/etc/beast-executor/policy.json` (from `deploy/executor-policy.json`) |
| Executor state (used approval digests, capture files) | `/var/lib/beast-executor` |
| Agent account | `beast-agent`. Its own Claude/Codex logins live in its home. It has ACL access to `/home/ubuntu/projects` (default ACLs keep `ubuntu` access to files it creates). |

Updating the executor means rebuilding, copying `dist/` to `/opt/beast-executor` as root, then restarting `beast-executor`. That restart stops any running job, so do it only when the queue is idle.

**Known limits.**
- Recursive chown re-checks each directory around `readdir` but cannot use `openat`, so a racing writer inside the tree is reduced, not eliminated. Class C approval and the protected-path list bound the exposure.
- `beast-agent` can traverse `/home/ubuntu`, so world-readable files there remain readable to jobs, as they were when jobs ran as `ubuntu`.
