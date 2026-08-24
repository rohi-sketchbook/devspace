---
name: subagent-delegation
description: Delegate bounded coding, investigation, and test work to user-configured DevSpace subagents. Use proactively during substantive development when a clear low-risk subtask can be split from host-owned design, integration, and final verification.
---

# Subagent Delegation

Use this skill proactively during substantive development whenever a bounded,
low-risk subtask can be delegated with clear acceptance criteria. Do not wait
for the user to explicitly ask for delegation. Also use it when the user names a
subagent, asks for another agent's opinion, or when parallel bounded work is
useful.

The host remains the owner of architecture, ambiguous requirements, integration,
and final verification. Never hide delegation: tell the user whenever a worker
is started, what it owns, and when ownership changes.

In a direct ChatGPT conversation, host ownership is implicit. Do not prefix
ordinary host-only updates with `担当: ChatGPT`. Explicitly identify Codex when
a worker is delegated work, including its model and bounded scope. If work is
parallel, state what Codex owns and what the host is handling. If a subagent
hands work back to the host for any reason, explicitly report the transition,
for example `担当変更: Codex → ChatGPT (usage limit)`. The final response only
needs an owner split when a subagent actually participated; in that case state
which parts were performed by the subagent and which were verified or completed
by the host.

When the `work-activity` skill is available and the user task has an active
Activity id, keep that Activity synchronized with delegation. Before starting a
Codex worker, add/update the Codex worker with the selected model, phase, and
bounded task description. Leave the host worker running when work is truly
parallel. When Codex finishes its portion, mark that worker `done`; on a quota or
provider handoff, mark Codex `done` or `blocked` as appropriate and update the
ChatGPT worker with `takeOwnership=true`. Do not complete the overall Activity
until host review/integration and validation are finished.

## Routing policy

Default to delegation for routine leaf work that is bounded, low-risk, and has
clear acceptance criteria. For every substantive coding task, actively look for
one or more such subproblems; if they exist, delegate them without waiting for an
explicit user request. Keep the host working on design, integration, review, or
other independent work in parallel when useful.

Keep architecture, ambiguous product behavior, cross-cutting design, destructive
or externally visible actions, difficult debugging, runtime/GUI judgment,
integration of multiple subsystems, and final verification with ChatGPT/host.

Preferred routing:

- Codex Terra (`gpt-5.6-terra`): focused implementation, mechanical refactors,
  tests, and straightforward bug fixes. Prefer Terra for routine code changes
  that can be reviewed and integrated by the host afterward.
- Codex Luna (`gpt-5.6-luna`): read-only exploration, file discovery, impact
  analysis, simple audits, and other lightweight high-throughput work. Prefer
  Luna early when repository discovery would otherwise occupy the host.
- Host-only is appropriate for trivial edits where delegation overhead exceeds
  the work, or when no safe independent subproblem exists.
- If a delegated task becomes ambiguous, broad, repeatedly fails, or needs a
  design decision, stop delegating and return ownership to the host.

For a raw Codex implementation run, use `--write-mode allowed --isolation auto`.
DevSpace automatically creates a clean isolated worktree. For read-only Codex
work, use `--write-mode read_only --isolation checkout` so no unnecessary
worktree is created. If isolation reports `WORKTREE_SOURCE_DIRTY`, do not bypass
it: keep that write task with the host unless the user has explicitly arranged
a clean base.

## Core commands

Use only these commands for normal delegation:

Use the DevSpace CLI that belongs to the currently running server. DevSpace
injects its path as `DEVSPACE_CLI_PATH` into workspace shell commands; do not
use a different globally installed `devspace` executable. If the variable is
missing, treat that as a DevSpace integration/version mismatch: do not silently
skip delegation and do not invoke a provider CLI directly. Report the failed
worker start, return that subtask to the host, and verify/restart the DevSpace
server before relying on subagents again.

```bash
node "$DEVSPACE_CLI_PATH" agents ls
node "$DEVSPACE_CLI_PATH" agents run <profile-or-provider> "<prompt>"
node "$DEVSPACE_CLI_PATH" agents continue <id> "<prompt>"
node "$DEVSPACE_CLI_PATH" agents show <id>
node "$DEVSPACE_CLI_PATH" agents handoff <id>
```

`ls` shows existing subagent sessions for the current workspace. DevSpace scopes
it automatically from the shell environment injected by the workspace tool.
Use the returned logical `agt_...` ID with `continue`; provider session IDs and
prefixes are not interchangeable with logical agent IDs.

`run <profile> "<prompt>"` starts a new configured profile and prints a
DevSpace agent id.

`run <provider> "<prompt>"` starts a raw built-in provider when no configured
profile is needed. Built-in providers are listed by `open_workspace`.

`continue <id> "<prompt>"` sends a follow-up to an existing agent. Do not use
`run <id>` for continuation.

Continuation supports the same per-turn model and thinking overrides:

```bash
node "$DEVSPACE_CLI_PATH" agents continue <id> --model <model> "<prompt>"
node "$DEVSPACE_CLI_PATH" agents continue <id> --thinking <level> "<prompt>"
```

`show <id>` prints status and the latest response. If the agent is still
running, `show` waits briefly. If there is still no final response, call `show`
again later.

If `show` reports `HOST_HANDOFF_RECOMMENDED`, call `agents handoff <id>` to
collect the task, execution workspace, base SHA, changed files, executed commands,
provider usage, and conflict information. For an isolated worker, call
`open_workspace` on the returned `execution_workspace` using checkout mode; do
not request another worktree. Treat worker edits as unverified partial work,
inspect the diff, rerun relevant verification, and only then integrate them.

For `reason=usage_limit`, do not immediately retry Codex. DevSpace performs a
preflight quota check and normally stops new Codex work once the shared Codex
bucket reaches 90% used. The model-to-quota-bucket mapping is provider-owned, so
this guard intentionally uses the supported shared `codex` bucket rather than
hard-coding model-specific bucket names.

For `reason=file_conflict`, do not apply the worktree blindly. The listed files
were also changed by another managed worker and require host review before
integration. For `reason=provider_failure`, inspect the partial work and continue
with the host instead of repeatedly spending worker quota on the same failure.

The commands automatically start the internal `devspace-agentd` process when
needed. `devspace serve` is not required for local-agent execution. The daemon
owns shared agent sessions and provider runtimes for the configured DevSpace
state directory.

Do not run provider CLIs such as `codex`, `claude`, `opencode`, `pi`,
`cursor-agent`, or `copilot` directly unless you are explicitly debugging
DevSpace agent integration.

## Choosing a profile

Choose profiles from the compact subagent profile catalog returned by
`open_workspace`. Use the profile name with `node "$DEVSPACE_CLI_PATH" agents run`. If no
profile fits and delegation is still appropriate, use a built-in provider name
from `open_workspace`.

Profiles may declare a model and optional thinking level. To override the
configured/default provider model or thinking level for a run, pass `--model`
or `--thinking`:

```bash
node "$DEVSPACE_CLI_PATH" agents run codex --model gpt-5.6-terra --write-mode allowed --isolation auto "<implementation prompt>"
node "$DEVSPACE_CLI_PATH" agents run codex --model gpt-5.6-luna --write-mode read_only --isolation checkout "<investigation prompt>"
node "$DEVSPACE_CLI_PATH" agents run <profile-or-provider> --thinking <level> "<prompt>"
```

Use `--thinking` only when the user asks for a specific reasoning depth or when
the task clearly needs a different effort than the configured profile default.
Thinking values are provider-specific passthrough values. Use names supported by
the selected local agent harness; DevSpace does not translate values between
providers.

Good delegation targets:

- `reviewer`: second opinion, bug risk, security risk, test gaps.
- `explorer`: read-only codebase investigation and impact analysis.
- `implementer`: focused implementation with clear acceptance criteria.

Prefer delegation for ordinary bounded coding and investigation work when an
appropriate worker is available. Do not force delegation for tiny tasks, unsafe
or ambiguous work, or work whose coordination cost is greater than simply doing
it in the host.

## Worker prompts

Agents start with only the prompt you send plus their configured profile
instructions. Make prompts self-contained.

Implementation prompt shape:

```text
Goal:
<clear goal>

Context:
<repo/module/user constraints>

Relevant files:
<paths and why they matter>

Acceptance criteria:
- <criterion>

Rules:
- Keep changes focused.
- Do not perform unrelated refactors.
- Report blockers clearly.
```

Read-only investigation prompt shape:

```text
Question:
<specific question>

Scope:
<files/directories/modules to inspect>

Rules:
- Do not modify files.
- Cite relevant file paths and symbols.
- Separate facts from guesses.
```

## After the worker responds

Always review the result before presenting it as verified.

For write-capable tasks, inspect changed files and run or explain relevant
tests. For read-only tasks, verify that important claims are supported by repo
evidence.

Be transparent in the final response:

```text
I used <profile>. It reported <summary>. I verified <checks>. Remaining risk:
<risk or none>.
```

Never hide that a subagent was used.
