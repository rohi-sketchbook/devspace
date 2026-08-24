# Subagent profile schema

DevSpace agent profiles are user-owned markdown files with YAML
frontmatter. They describe roles such as reviewer, explorer, or implementer.
The internal on-demand `devspace-agentd` process owns provider invocation. The
CLI and MCP server use it as clients when they need agent execution.

When subagents are enabled, the internal `devspace-agentd` process owns the
durable agent manager and live provider runtimes. `devspace agents run` is a
thin local client that starts or reuses the daemon automatically; `devspace
serve` is not required. A run returns an agent id immediately, while the daemon
persists its status, latest response, provider session id, execution workspace,
changed-file snapshot, executed-command summary, quota snapshot, conflicts, and
handoff reason.

Profiles are discovered from:

- `~/.devspace/agents/*.md`
- `.devspace/agents/*.md`

Packaged files under `examples/agents/` are starter templates only.

## Minimal shape

```md
---
schema: devspace-agent/v1
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
model: gpt-5.6-terra
thinking: medium
writeMode: read_only
isolation: checkout
disabled: false
---

You are a read-only reviewer. Do not edit files.
Focus on correctness, security, test gaps, and maintainability.
Cite files and return concise findings.
```

## Frontmatter fields

### `schema`

Optional schema identifier:

```yaml
schema: devspace-agent/v1
```

### `name`

Stable profile identifier shown to the model and accepted by:

```bash
devspace agents run <name> "<prompt>"
```

Use lowercase kebab-case names. If omitted, DevSpace uses the filename without
`.md`.

### `description`

Required short purpose. This is exposed by `open_workspace` so the supervising
model can choose the right profile.

### `provider`

Required built-in provider id:

```yaml
provider: codex
provider: claude
provider: opencode
provider: pi
provider: cursor
provider: copilot
```

Unsupported or custom providers are rejected. DevSpace maps providers to their
native integration:

- `codex`: the host-installed `codex app-server` command
- `claude`: Claude Code SDK
- `opencode`: OpenCode SDK
- `pi`: the installed Pi coding-agent SDK, one in-process session per DevSpace agent
- `cursor`: ACP
- `copilot`: ACP

Codex is resolved from the user's environment rather than bundled with
DevSpace. Run `codex login` normally before using it; set `CODEX_COMMAND` when
the executable is not on the normal PATH. OpenCode, Cursor, and Copilot
runtimes are started and reused by the daemon internally, while Pi is embedded
through its Node SDK.

### `model`

Optional provider model id or alias.

```yaml
model: gpt-5.6-terra
model: sonnet
```

### `thinking`

Optional provider reasoning effort, thinking level, or model variant. If omitted,
DevSpace lets the provider default apply. Values are provider-specific
passthrough strings; DevSpace does not translate names between harnesses.

```yaml
thinking: low
thinking: high
thinking: xhigh
```

DevSpace passes this through to providers that expose a matching control:

- `claude`: SDK effort with adaptive thinking.
- `codex`: app-server model reasoning effort.
- `pi`: the AgentSession thinking-level control.
- `opencode`: model variant.
- `cursor` and `copilot`: ACP thought-level config when supported.

### `writeMode`

Optional execution authority:

```yaml
writeMode: read_only
writeMode: allowed
writeMode: full_access
```

`read_only` prevents file mutation. `allowed` uses the provider's normal
workspace-write sandbox. `full_access` is intentionally explicit and should not
be used for routine delegated work.

### `isolation`

Optional execution-workspace policy:

```yaml
isolation: auto
isolation: worktree
isolation: checkout
```

For Codex write-capable tasks, `auto` isolates the worker in a managed Git
worktree. `worktree` requires isolation. `checkout` runs in the owner checkout
and should normally be reserved for read-only work. DevSpace refuses to create
a write-worker worktree from a dirty source checkout because uncommitted owner
changes would not be present in the new worktree.

### `disabled`

Optional boolean. Disabled profiles are not exposed.

```yaml
disabled: true
```

## Markdown body

The body is the profile prompt prefix DevSpace prepends when launching that
profile. It is not included in `open_workspace` by default.

Recommended body content:

- When to use this profile.
- Whether the worker should act read-only or may make changes.
- Output format.
- Review or testing expectations.

## Model-facing workflow

The Subagent skill teaches only:

```bash
devspace agents ls
devspace agents run <profile-or-provider> "<prompt>"
devspace agents continue <id> "<prompt>"
devspace agents show <id>
devspace agents handoff <id>
```

`open_workspace` exposes compact profile metadata:

```json
{
  "name": "reviewer",
  "description": "Read-only reviewer for bugs, security risks, and missing tests.",
  "provider": "codex",
  "model": "gpt-5.6-terra",
  "thinking": "medium",
  "writeMode": "read_only",
  "isolation": "checkout"
}
```

`devspace agents ls` lists existing subagent sessions for the current workspace;
it does not list profile definitions.

Use `devspace agents continue <id>` for a later turn. The logical agent ID is
the `agt_...` value returned by `run` or `ls`; provider session IDs are not
accepted as substitutes.

The full profile body stays out of the model context until DevSpace launches the
profile.

For a running or completed task, `agents handoff <id>` surfaces the owner and
execution workspaces, base SHA, original task, changed files, executed commands,
provider usage, latest response/error, conflict files, and any host-handoff
reason. Write-capable Codex tasks use an isolated execution workspace by default;
the owner workspace remains the scope used to locate and list the logical agent.

## Runtime lifecycle

DevSpace keeps provider sessions warm while they are active or recently used,
but persists only the provider session id and durable agent metadata. Native
sharing follows the provider boundary: Codex uses one app-server across agents,
OpenCode uses one server across sessions, ACP providers use one process across
sessions, while Claude and Pi keep one warm runtime per DevSpace agent. There is
one active turn per agent; different agents may run concurrently.

If the daemon restarts during a turn, persisted `starting` and `running` agents
become `error` with a restart message. The next `agents continue <id>` request can
continue the provider session when that provider supports resumption. The MCP
server can restart independently because it does not own this state.

## Current non-goals

- Custom or arbitrary CLI-backed agents.
- Inferring semantic test success from worker prose. DevSpace records command
  execution and working-tree state, but the host remains responsible for final
  verification.
- Exposing raw provider transcripts by default.
- Teaching the model provider-specific CLIs.
- First-class MCP agent tools. Future tools should call the same local agent
  daemon used by `devspace agents` rather than executing providers in the MCP
  server process.
