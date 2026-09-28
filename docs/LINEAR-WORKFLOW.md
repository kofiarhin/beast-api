# Linear Workflow

Linear is the operational source of truth for Beast work. GitHub is the source of truth for Beast API code and durable technical documentation.

## Normal ticket flow

1. Create or use the correct Linear issue.
2. Put the issue in the Linear project that maps to the intended registered workspace.
3. Make the issue executable: clear title, description, scope, and acceptance criteria where useful.
4. Add `Beast Ready` only when local coding-agent execution is authorized.
5. Linear sends the issue event to Beast API.
6. Beast validates the webhook and confirms that the ready label was newly added.
7. Beast resolves the Linear project through `config/projects.json`.
8. The job is queued. Linear receives a **Queued** comment.
9. The worker validates the workspace. A dirty, missing, unregistered, or unsafe workspace is blocked.
10. Linear receives **Working** when the agent starts.
11. A fresh Codex process works only inside the validated workspace.
12. Beast inspects the result and runs configured verification scripts.
13. Linear receives **Completed locally**, **Blocked**, or **Failed**, including a Next Action.

## Authorization behavior

The `Beast Ready` label is an execution authorization gate, not a general status label. Editing an issue that already carries the label does not re-run it. To intentionally retry a blocked or failed issue, remove the label and add it again after the blocker is resolved.

A valid webhook without the ready-label transition does not launch an agent.

## Project mapping

Project selection is exact. Beast does not guess from the issue title, repository name, or filesystem. Unknown or missing Linear projects are blocked.

The current registry is versioned in `config/projects.json`. Production must use only workspaces explicitly registered there.

## What ordinary Beast Ready execution may do

The current workflow is for local repository work: edit files in the registered clean workspace and run verification.

It does not authorize Git push, pull-request creation, merge, deployment, destructive Git operations, DNS, firewall, Nginx, PM2/system-service changes, or other production changes. Those require a separate explicitly approved workflow.

## Reporting

Beast comments on the same Linear issue so the issue records the durable operational history: queued, working, blocked/failed/completed state, verification summary, and the next action.

Do not use chat history as the primary record of active Beast work.
