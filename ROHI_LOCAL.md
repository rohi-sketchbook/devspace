# Rohi local operation notes — DevSpace upstream-main port

This branch keeps Rohi's local DevSpace extensions on top of current `Waishnav/devspace` main instead of maintaining the old PR #103-based checkout.

## Upstream baseline

- Upstream repository: `Waishnav/devspace`
- Validated baseline: `d9855aa5e115d25417ac84f0af807968a3dae063` (merged PR #207)
- DevSpace version at migration: `1.0.7`
- Local branch: `rohi/latest-main-local-port`

The old PR #103 checkout remains available as a rollback reference, but the live branch no longer depends on its runtime files or node_modules.

## Local extensions retained

Upstream owns workspace reuse behavior and the newer local-agent runtime/daemon. Upstream 1.0.7 does not expose `download_artifact` on Windows, so the validated Windows artifact implementation remains a local port. Its `koffi` runtime is installed directly in this checkout (`koffi` 3.1.2 plus the matching Windows x64 native package); there is no runtime dependency on the old PR #103 checkout.

Rohi-specific code is intentionally isolated:

- `src/rohi-local-tools.ts` — local MCP tool registration and model instructions.
- `src/image-read.ts` — `read_image` native image loading for PNG/JPEG/WebP/GIF.
- `src/destructive-tools.ts` — guarded workspace deletion and managed Git cleanup.
- matching focused tests.
- `Start-DevSpace-Local.bat`, `Doctor-DevSpace-Local.bat`, `Check-DevSpace-Local.bat` — Windows operation helpers.

Keeping registrations in `rohi-local-tools.ts` minimizes future conflicts with upstream `src/server.ts`.

## Runtime settings

`Start-DevSpace-Local.bat` enables:

```text
DEVSPACE_ARTIFACTS=1
DEVSPACE_SUBAGENTS=1
DEVSPACE_ALLOWED_ROOTS=H:\codexapp,C:\Users\rohi\.devspace\worktrees
DEVSPACE_WORKTREE_ROOT=H:\codexapp\worktrees
```

It continues to use the existing `%USERPROFILE%\.devspace\config.json` and `auth.json`.

Subagents are enabled so the upstream on-demand local-agent daemon and provider adapters are available. The daemon should start only when agent execution is actually requested; ordinary workspace file/edit/shell operations do not require it.

## File and image transfer

Preferred native paths remain:

```text
ChatGPT native file -> download_artifact -> local workspace
local PNG/JPEG/WebP/GIF -> read_image -> MCP native image content -> host vision
```

Use `read` for text and `read_image` when the host must visually inspect a local image. The shared `image-bridge` remains a fallback when native transfer is unavailable.

## Destructive operations

`delete_path` and `git_cleanup` are deliberately separate from `bash` so deletion can stay narrow and inspectable. They must only be used after explicit user authorization for the relevant target or cleanup scope.

`delete_path` refuses the workspace root and symlink escapes. `git_cleanup` restricts worktree cleanup to the configured managed-worktree root and refuses unsafe residue targets.

## Future upstream updates

For future updates:

1. fetch upstream `main`;
2. create an isolated worktree from the new upstream head;
3. reapply the small `rohi-local-tools` integration rather than merging the old PR #103 history;
4. run typecheck, full tests, build, doctor, tool-discovery tests, and a real MCP host smoke test;
5. switch the AgentTools gateway only after the new build is verified.
