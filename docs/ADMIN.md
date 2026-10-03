# Controlled VPS Administration (IDE-69)

## Status

**Application layer only. No real root privileges are active.** `BEAST_ADMIN_MODE` is `off` by default. The only other mode is `dry-run`, which runs the whole request, authorization and approval flow but executes nothing on the host. `enforce` does not exist yet, and asking for it fails startup. Nothing in `/etc`, sudoers, systemd, Nginx, the firewall, PM2 or cron was changed for this work.

## Model

- **Beast API is the security boundary.** It validates and authorizes every request before anything privileged could happen.
- **A separate privileged executor** (future `beast-executor` broker) will perform only typed operations. It accepts a validated operation plus Beast's grant, never a command string.
- **Claude and Codex stay non-root.** Ordinary coding jobs never reach the admin path, and every child process Beast starts runs under `setpriv --no-new-privs`, so `sudo`, `su` and `pkexec` cannot raise privileges.

Forbidden by design: `sudo <arbitrary command>`, `su`, `bash -c`/`sh -c` with arbitrary input, `execRoot(command)`, `runAsRoot(commandString)`, and any interactive or arbitrary root shell. `src/admin` has no command-string type and does not import `child_process`. Only the read-only probe runs host commands, unprivileged and through fixed argv.

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
   - its author is in `BEAST_ADMIN_APPROVERS` and is not Beast's own Linear user;
   - it arrives before expiry.

   The requester may also approve. `/beast deny <digest>` cancels the plan.
3. **Recheck before execution.** Beast re-reads the issue: the label must still be present and the description unchanged. It re-validates the request and recomputes the digest. Any drift voids the approval.
4. **Single use.** The approval nonce is consumed before execution starts, so an approval can never run twice. Unapproved plans expire after 15 minutes.

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
| `BEAST_ADMIN_MODE` | `off` | `off` or `dry-run`; `enforce` fails startup in this phase |
| `BEAST_ADMIN_LABEL` | `Beast Admin` | Always mutually exclusive with `BEAST_READY_LABEL` |
| `BEAST_ADMIN_REQUESTERS` | _(empty)_ | Comma-separated Linear user IDs |
| `BEAST_ADMIN_APPROVERS` | _(empty)_ | Comma-separated Linear user IDs |
| `BEAST_ADMIN_POLICY_FILE` | `./config/admin-policy.json` | Enabled operations and extra protected targets |

Admin mode also needs `LINEAR_API_KEY` (to verify requesters and approvers), and the Linear webhook must send **Comment** events. Both are live configuration changes that need separate approval.

## Ordinary jobs cannot escalate

`runCommand` starts every child as `setpriv --no-new-privs -- <cmd>`, with no opt-out. If `/usr/bin/setpriv` is missing, nothing runs. A verification script that tries `sudo`, `su` or `pkexec` fails with: *verification script attempted privilege escalation (sudo/su/pkexec); blocked by no-new-privs*.

**Remaining gap until activation:** jobs still run as `ubuntu`. They can't escalate directly, but they could write files such as `~/.bashrc` or `PATH` shims that a later privileged human session would run. The separate `beast-agent` user planned for activation closes this gap.

## Future activation (not done; needs explicit approval)

**Recommended mechanism:** a root-owned `beast-executor` broker, started by systemd socket activation on a Unix socket.
- It accepts connections only from the `beast` service user, checked by peer UID.
- It re-validates every request against its own root-owned policy and performs operations with fixed `execFile` argv. Chown uses `fchown`/`lchown`, never follows symlinks and stays on one filesystem.
- It provides an internal `agent.spawn` that starts agents and verification scripts as `beast-agent` with `no_new_privs` (see `src/admin/protocol.ts`).
- No sudoers rules are involved; the executor is the only privileged path.

**System changes activation would need:**
- `beast` and `beast-agent` system users;
- `beast-executor.socket` and `beast-executor.service`;
- `/etc/beast-executor/policy.json`;
- a root-owned build of the executor;
- `beast-api.service` with `User=beast`;
- moving `beast-api` off `ubuntu`'s PM2;
- workspace ACLs;
- logging the agent CLIs in again as `beast-agent`.
