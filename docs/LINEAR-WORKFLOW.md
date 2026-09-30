# Linear Workflow

Linear is the operational source of truth for Beast work. GitHub is the source of truth for Beast API code and durable technical documentation.

## Normal ticket flow

1. Create or use the correct Linear issue.
2. Put the issue in the Linear project that maps to the intended registered workspace.
3. Make the issue executable: clear title, description, scope, and acceptance criteria where useful.
4. Add `Beast Ready` only when local coding-agent execution is authorized.
5. Linear sends the issue event to Beast API.
6. Beast validates the webhook and authorizes either issue creation with the ready label or an update that newly adds it.
7. Beast resolves the Linear project through `config/projects.json`.
8. The job is persisted as queued. Beast attempts a **Queued** comment.
9. The worker validates the workspace. A dirty, missing, unregistered, or unsafe workspace is blocked.
10. Beast attempts **Working** before launching the agent; this is not proof that a process started.
11. A fresh Codex process works only inside the validated workspace.
12. Beast inspects the result and runs configured verification scripts.
13. Beast attempts **Completed locally**, **Completed locally — verification failed**, **Blocked**, or **Failed**, including a Next Action. Delivery is best-effort.

## Authorization behavior

The `Beast Ready` label is an execution authorization gate, not a general status label. Editing an issue that already carries the label does not re-run it. To intentionally retry a blocked or failed issue, remove the label and add it again after the blocker is resolved.

A valid webhook without an authorized create or ready-label addition does not launch an agent.

## Project mapping

Project selection is exact. Beast does not guess from the issue title, repository name, or filesystem. Unknown or missing Linear projects are blocked.

The default registry is versioned in `config/projects.json`; `BEAST_PROJECTS_FILE` can select another file. Confirm the active registry before production work.

**Beast API routing:** The shipped Beast project maps to `/home/ubuntu/projects/beast`, the VPS documentation repository. It does not select Beast API source. Clean-workspace checks do not detect this mismatch.

Before re-adding Beast Ready for API coding, verify the intended clean development checkout under the workspace root and obtain approval for the exact routing change. Do not guess a checkout, use the production runtime copy, or redirect all Beast documentation/operations tasks. [IDE-65](https://linear.app/ideahub-devkofi/issue/IDE-65) tracks this prerequisite.

## What ordinary Beast Ready execution may do

The current workflow is for local repository work: edit files in the registered clean workspace and run verification.

It does not authorize Git push, pull-request creation, merge, deployment, destructive Git operations, DNS, firewall, Nginx, PM2/system-service changes, or other production changes. Those require a separate explicitly approved workflow.

## Reporting

Comments target the originating Linear issue, but are best-effort. Queued is not awaited, so delivery order is not guaranteed. Working is attempted after workspace validation and before launch; a launch failure can follow its "started" message. Failures to post are logged without a persisted retry. With no Linear API key, no comments are sent.

If a comment is missing, inspect local `GET /jobs/:id`, `data/state.json` (under the configured data directory), and PM2 logs before retrying. This version does not update Linear states/labels or send messages into ChatGPT.

### What completed and passed mean

A successful agent exit without an agent error, timeout or cancellation produces a completed job even if verification fails. The plain-text summary is not validated against acceptance criteria; an incomplete result can therefore be labelled completed.

Missing package metadata, scripts or dependencies produce skipped checks. Skipped checks count as passing, so "Overall: passed" can mean no checks ran. HEAD movement only produces a warning; the result's "nothing was committed" template is not proof of agent compliance.

Inspect the final diff, agent summary, actual checks and acceptance criteria before accepting the result. Local completion does not mean task success, Linear Done, merge or deployment. IDE-65 owns the pending lifecycle fixes.

Keep verified results and next actions in Linear rather than treating chat history as the primary work record.
