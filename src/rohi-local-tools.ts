import { performance } from "node:perf_hooks";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { deleteWorkspacePath, gitCleanup } from "./destructive-tools.js";
import { readImageForMcp } from "./image-read.js";
import { logEvent } from "./logger.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export const rohiLocalToolNames = {
  readImage: "read_image",
  deletePath: "delete_path",
  gitCleanup: "git_cleanup",
} as const;

const DESTRUCTIVE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z.string().describe("Model-readable result text for follow-up reasoning and plain MCP hosts."),
    ...extra,
  };
}

export function rohiLocalToolInstruction(config: ServerConfig): string {
  if (config.toolMode === "codex") {
    return ` ${rohiLocalToolNames.readImage} is available for native local-image inspection when an image must be shown to the host.`;
  }
  return ` Use ${rohiLocalToolNames.readImage} for native local-image inspection. Use ${rohiLocalToolNames.deletePath} only for explicitly authorized workspace-path deletion and ${rohiLocalToolNames.gitCleanup} only for explicitly authorized managed-worktree or local-branch cleanup; do not substitute shell deletion commands.`;
}

export function registerRohiLocalTools(
  server: McpServer,
  options: {
    config: ServerConfig;
    workspaces: WorkspaceRegistry;
  },
): void {
  const { config, workspaces } = options;

  registerAppTool(
    server,
    rohiLocalToolNames.readImage,
    {
      title: "Read image",
      description:
        "Read a PNG, JPEG, WebP, or GIF image inside an open workspace and return it as native MCP image content. Use this when the host needs to visually inspect a local image or provide that image to an image-capable workflow. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().describe("Image path relative to the workspace root."),
      },
      outputSchema: resultOutputSchema({
        mimeType: z.string().describe("Detected image MIME type."),
        bytes: z.number().int().positive().describe("Original image size in bytes."),
      }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, path }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const absolutePath = workspaces.resolvePath(workspace, path);
        const image = await readImageForMcp(absolutePath);
        const result = `Loaded local image ${path} (${image.mimeType}, ${image.bytes} bytes).`;
        logLocalTool(config, {
          tool: rohiLocalToolNames.readImage,
          workspaceId,
          path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [
            { type: "image" as const, data: image.data, mimeType: image.mimeType },
            { type: "text" as const, text: result },
          ],
          structuredContent: {
            result,
            mimeType: image.mimeType,
            bytes: image.bytes,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logLocalTool(config, {
          tool: rohiLocalToolNames.readImage,
          workspaceId,
          path,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );

  if (config.toolMode === "codex") return;

  registerAppTool(
    server,
    rohiLocalToolNames.deletePath,
    {
      title: "Delete path",
      description:
        "Delete one file, symlink, or directory inside an open workspace. Use only after the user explicitly authorizes deletion of the relevant target or scope. The workspace root itself and symlink escapes are refused. Directory deletion requires recursive=true.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().describe("Path to delete, relative to the workspace root."),
        recursive: z.boolean().optional().default(false).describe(
          "Required for directory deletion. Has no effect on ordinary files or symlinks.",
        ),
      },
      outputSchema: resultOutputSchema({
        path: z.string(),
        kind: z.enum(["file", "directory", "symlink", "other"]),
      }),
      _meta: {},
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, path, recursive }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const absolutePath = workspaces.resolvePath(workspace, path);
        const deleted = await deleteWorkspacePath({
          workspaceRoot: workspace.root,
          absolutePath,
          recursive,
        });
        const result = `Deleted ${deleted.kind}: ${path}`;
        logLocalTool(config, {
          tool: rohiLocalToolNames.deletePath,
          workspaceId,
          path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: {
            result,
            path,
            kind: deleted.kind,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logLocalTool(config, {
          tool: rohiLocalToolNames.deletePath,
          workspaceId,
          path,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    rohiLocalToolNames.gitCleanup,
    {
      title: "Git cleanup",
      description:
        "Perform an explicitly authorized destructive Git cleanup operation for an open checkout workspace. Supported actions are remove_worktree, delete_branch, prune_worktrees, and remove_worktree_residue. Worktree targets are restricted to immediate children of DevSpace's configured managed worktree root; residue removal additionally refuses registered worktrees and any target that still contains .git.",
      inputSchema: {
        workspaceId: z.string().describe(
          "Workspace identifier for the repository checkout that owns the Git metadata.",
        ),
        action: z.enum([
          "remove_worktree",
          "delete_branch",
          "prune_worktrees",
          "remove_worktree_residue",
        ]),
        target: z.string().optional().describe(
          "Worktree/residue absolute path, or local branch name. Omit for prune_worktrees.",
        ),
        force: z.boolean().optional().default(false).describe(
          "Use Git force removal/deletion when the selected action supports it.",
        ),
      },
      outputSchema: resultOutputSchema({
        action: z.enum([
          "remove_worktree",
          "delete_branch",
          "prune_worktrees",
          "remove_worktree_residue",
        ]),
        target: z.string().optional(),
      }),
      _meta: {},
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, action, target, force }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        if (workspace.mode !== "checkout") {
          throw new Error("git_cleanup requires a checkout workspace, not a managed worktree workspace.");
        }
        const cleaned = await gitCleanup({
          repoRoot: workspace.root,
          worktreeRoot: config.worktreeRoot,
          action,
          target,
          force,
        });
        logLocalTool(config, {
          tool: rohiLocalToolNames.gitCleanup,
          workspaceId,
          path: target,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [{ type: "text" as const, text: cleaned.result }],
          structuredContent: {
            result: cleaned.result,
            action: cleaned.action,
            ...(cleaned.target ? { target: cleaned.target } : {}),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logLocalTool(config, {
          tool: rohiLocalToolNames.gitCleanup,
          workspaceId,
          path: target,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );
}

function logLocalTool(
  config: ServerConfig,
  fields: {
    tool: string;
    workspaceId?: string;
    path?: string;
    success: boolean;
    durationMs: number;
    error?: string;
  },
): void {
  if (!config.logging.toolCalls) return;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", fields);
}
