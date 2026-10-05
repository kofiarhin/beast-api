# Linear Workflow

Linear is the operational source of truth for Beast work. GitHub is the source of truth for Beast API code and durable technical documentation.

## Normal ticket flow

1. Create or use the correct Linear issue.
2. Make the issue executable: clear title, description, scope, safety limits, verification and Next Action.
3. Resolve the workspace using the canonical precedence: explicit `Beast workspace:` directive, registered repository/workspace mapping, then Linear project default. Unknown or ambiguous targets are blocked.
4. Verify the resolved workspace is the expected registered Git repository before execution.
5. Add `Beast Ready` only when execution is authorized and the task contract is complete.
6. Linear sends the issue event to Beast API.
7. Beast validates the webhook and authorizes either issue creation with the ready label or an update that newly adds it.
8. The job is persisted as queued. Beast attempts a **Queued** comment.
9. The worker validates workspace safety. A missing, unregistered, unsafe, or repository-mismatched workspace is blocked. Dirty-workspace behavior depends on the currently deployed execution model and must never discard unrelated work.
10. Beast may attempt **Working** before launching the agent. This is not proof that a process started.
11. A fresh configured coding-agent process works inside the validated execution boundary.
12. Beast inspects the result and runs configured verification.
13. Beast reports the local result and a Next Action.

## Authorization behavior

The `Beast Ready` label is an execution authorization gate, not a general status label. Editing an issue that already carries the label does not re-run it. To intentionally retry a blocked or failed issue, remove the label and add it again after the blocker is resolved and the task is still approved.

A valid webhook without an authorized create or ready-label addition does not launch an agent.

## Workspace resolution

Canonical resolution precedence is:

1. Explicit `Beast workspace:` directive in the issue.
2. Registered repository/workspace mapping.
3. Linear project default workspace when the first two do not select a target.
4. Unknown or ambiguous target → BLOCK.

Beast must not guess from the issue title, repository name, or filesystem. Before launching an agent, the resolved workspace must match the expected registered Git repository identity. A mismatch must block execution.

The default registry is versioned in `config/projects.json`; `BEAST_PROJECTS_FILE` can select another file. Confirm the active registry before production work.

**Beast API routing:** the shipped Beast project mapping historically selected `/home/ubuntu/projects/beast`, the VPS documentation repository, rather than Beast API source. Clean-workspace checks alone do not detect repository-identity mistakes. IDE-100 tracks the permanent workspace-routing and repository-identity fix. Do not guess a checkout or silently redirect documentation tasks.

## What ordinary Beast Ready execution may do

`Beast Ready` authorizes only the bounded operations defined in the approved task contract and currently supported by Beast. It does not by itself authorize push, pull-request creation, merge, deployment, destructive Git operations, DNS, firewall, Nginx, PM2/system-service changes, scheduled production changes, deletion, or reboot. Those require separate explicit approval.

## Operational states vs API job states

The canonical operational states are:

- REQUESTED — task prepared.
- QUEUED — Beast API accepted the job.
- RUNNING — an agent process actually started.
- VERIFIED — required verification actually ran and passed.
- DONE — verified, profile reconciled if required, and Linear completed.
- BLOCKED/FAILED — Beast could not safely or successfully complete the task.

Beast API internal states such as `queued`, `working`, `blocked`, `failed`, and `completed` are implementation details. Do not treat `working` as RUNNING unless process start is confirmed. Do not treat `completed` as VERIFIED or DONE unless the required checks and acceptance criteria actually passed.

## Reporting

Comments target the originating Linear issue, but are best-effort. Queued may not be awaited, so delivery order is not guaranteed. A Working comment may be attempted before launch and therefore does not prove an agent process started. Failures to post must not be mistaken for missing execution; use authoritative job/runtime evidence.

### What completed and passed mean

A successful agent exit is not automatically task success. The agent summary must be checked against the task requirements and acceptance criteria.

A skipped verification check is not evidence that its requirement passed. If required tests, lint, typecheck, build, health checks, or other acceptance checks did not actually run and pass, do not claim VERIFIED.

Inspect the final diff, agent result, actual checks and acceptance criteria before accepting the result. Local completion does not mean task success, Linear Done, merge or deployment.

Keep verified results and the exact Next Action in Linear rather than treating chat history as the primary work record.
