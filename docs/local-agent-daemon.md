# Local agent daemon

Local agent execution is owned by an on-demand `devspace-agentd` process, not
by the MCP server and not by an individual CLI invocation. The daemon is an
internal implementation detail: the normal workflow remains:

```text
devspace agents run/continue/show/handoff/ls
          │
          ▼
    devspace-agentd
          │
          ├── LocalAgentManager
          ├── LocalAgentStore
          ├── LocalAgentRuntimePool
          └── provider runtimes
```

The CLI starts the daemon automatically when an agent command needs it. The
MCP server can use the same local client when an MCP operation needs agent
functionality, but `devspace serve` is not required for local-agent execution.
The daemon is scoped to one DevSpace `stateDir`, so one SQLite store and one
runtime owner serve all clients using that configuration.

Communication uses a private Unix domain socket on Linux/macOS or a named pipe
on Windows. The endpoint is not exposed through the public MCP HTTP port.
Provider session identifiers and logical agent records are durable; live
provider runtimes are disposable and may be recreated after a daemon restart.
Expected subagent failures cross the daemon boundary as structured error codes,
not message-string conventions. Agent records in `error` state retain the safe
message plus `errorCode` and `errorRetryable` fields so callers can distinguish
provider cancellation, provider availability, workspace conflicts, daemon
timeouts, and similar recovery categories after a background turn completes.
Internal provider causes are kept out of the daemon payload and persisted JSON.

The implementation treats `better-result` as the application-failure boundary,
not as a replacement for every exception. Expected target, scope, provider,
store, and daemon failures return typed Results. Sequential fallible setup uses
`Result.gen` when it makes the success path clearer, small Result-to-Result
transformations use `map`/`andThen`, and error policy at serialization or IPC
boundaries uses exhaustive tagged-error matching. Programmer defects and broken
invariants remain exceptions; cleanup and shutdown also stay best-effort so a
secondary release failure cannot replace the primary agent failure.

The daemon state directory contains the socket or pipe identity, an atomic
lock, a PID marker, and diagnostic logs. A second client cannot start another
daemon for the same state directory. Stale lock and socket files are recovered
only after the recorded PID is no longer alive.

The daemon is started on demand and may exit after its active turns, clients,
and warm runtime idle periods have ended. Users do not need to manage it during
normal operation. Diagnostic commands are available for startup, process, and
cleanup problems:

```bash
devspace agents daemon status
devspace agents daemon stop
devspace agents daemon logs
```

Agent commands accept `--json` when a machine-readable response is needed.
Immediate failures are emitted as `{ ok: false, error: { code, message,
retryable, ... } }`; successful `show`, `ls`, `run`, and `continue` output keeps
the structured error fields on agent records when present.
Successful `daemon status` and `daemon stop` output the daemon status object,
and successful `daemon logs` output is `{ "logs": "<text>" }`.

Provider quota exhaustion is stored separately as `PROVIDER_USAGE_LIMIT` rather
than a generic execution failure. Codex performs a best-effort preflight
`account/rateLimits/read` and, by default, reserves the last 10% of the shared
Codex quota instead of starting another delegated turn. If that account method
is unavailable for the active authentication/provider mode, execution continues
and the normal turn-level usage-limit handling remains authoritative.

Write-capable Codex tasks default to an isolated managed Git worktree. The daemon
keeps the logical owner workspace separate from the execution workspace and
refuses to fork a worker from a dirty owner checkout, because doing so would
silently omit uncommitted owner changes. Read-only workers stay in the owner
checkout. A read-only agent cannot later be escalated to write authority in that
checkout; the host must start a fresh isolated write task.

At turn completion or failure, DevSpace snapshots changed files and bounded
command-execution metadata. It compares each managed worker against both the
current owner checkout and sibling managed workers. Overlapping changed files
are persisted as `conflictFiles` with `handoffReason=file_conflict`, so the host
can review the integration instead of blindly applying it.

Plain-text `agents show` emits `HOST_HANDOFF_RECOMMENDED` for quota exhaustion,
provider failures, or detected file conflicts. `agents handoff <id>` returns the
original task, owner/execution workspaces, base SHA, changed files, commands,
provider usage, response/error, conflicts, and handoff reason. The supervising
host should open the existing execution workspace in checkout mode, inspect the
partial diff, finish or repair the work there, rerun verification, and only then
integrate it. Provider session IDs remain persisted so a provider thread can be
continued later when appropriate.

Agent identity is explicit at the client boundary. `agents run` starts a new
logical agent from a profile or provider; `agents continue <id>` continues an
existing logical agent. Provider session IDs are never accepted as logical
agent IDs, and the daemon does not resolve ambiguous prefixes.

Shutdown gives active turns a bounded graceful window. If that window expires,
the process exits with active records left durable; the next daemon startup
reconciles stale `starting` and `running` records to `error` without discarding
their `providerSessionId` or `latestResponse`.
