import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import net from "node:net";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";
import { isPathInsideRoot } from "./roots.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const BLENDER_MCP_HOST = "127.0.0.1";
const BLENDER_MCP_PORT = 9876;
const STATUS_TIMEOUT_MS = 3_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const MAX_OPERATION_TIMEOUT_MS = 900_000;
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 16_384;

export const blenderToolNames = {
  status: "blender_status",
  runScript: "blender_run_script",
  render: "blender_render",
} as const;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const BLENDER_SCRIPT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const BLENDER_RENDER_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export interface BlenderMcpResponse extends Record<string, unknown> {
  status?: string;
  message?: unknown;
}

export type BlenderMcpRequest = (
  requestType: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<BlenderMcpResponse>;

export interface VerifiedArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z.string().describe("Model-readable result text for follow-up reasoning and plain MCP hosts."),
    ...extra,
  };
}

export function blenderToolInstruction(): string {
  return ` Use ${blenderToolNames.status} to check the local BlenderMCP connection. Use ${blenderToolNames.runScript} to execute an existing workspace-relative Python script in Blender when the requested work requires Blender scene changes or artifact generation. Use ${blenderToolNames.render} to render the current Blender scene directly to a workspace-relative image. Do not use bash as a substitute for Blender artifact generation.`;
}

export async function requestBlenderMcp(
  requestType: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number; host?: string; port?: number } = {},
): Promise<BlenderMcpResponse> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
  const host = options.host ?? BLENDER_MCP_HOST;
  const port = options.port ?? BLENDER_MCP_PORT;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`BlenderMCP host must be loopback: ${host}`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`BlenderMCP port must be between 1024 and 65535: ${port}`);
  }
  const payload = Buffer.from(JSON.stringify({ type: requestType, params }), "utf8");

  return await new Promise<BlenderMcpResponse>((resolve, reject) => {
    const socket = new net.Socket();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (error?: Error, value?: BlenderMcpResponse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? {});
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        finish(new Error(`BlenderMCP response exceeded ${MAX_RESPONSE_BYTES} bytes.`));
        return;
      }
      chunks.push(chunk);
      const text = Buffer.concat(chunks, totalBytes).toString("utf8");
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish(new Error("BlenderMCP returned a non-object JSON response."));
          return;
        }
        finish(undefined, parsed as BlenderMcpResponse);
      } catch (error) {
        if (!(error instanceof SyntaxError)) finish(error as Error);
      }
    });
    socket.once("timeout", () => {
      finish(new Error(`BlenderMCP request timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (settled) return;
      if (chunks.length === 0) {
        finish(new Error("BlenderMCP closed the connection without a response."));
        return;
      }
      const text = Buffer.concat(chunks, totalBytes).toString("utf8");
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish(new Error("BlenderMCP returned a non-object JSON response."));
          return;
        }
        finish(undefined, parsed as BlenderMcpResponse);
      } catch {
        finish(new Error("BlenderMCP returned incomplete or invalid JSON."));
      }
    });

    socket.connect(port, host);
  });
}

export function registerBlenderTools(
  server: McpServer,
  options: {
    config: ServerConfig;
    workspaces: WorkspaceRegistry;
    request?: BlenderMcpRequest;
  },
): void {
  const { config, workspaces } = options;
  const request = options.request ?? requestBlenderMcp;

  registerAppTool(
    server,
    blenderToolNames.status,
    {
      title: "Blender status",
      description:
        "Check the local BlenderMCP endpoint for an open DevSpace workspace and return current scene information when available. This is read-only and always targets 127.0.0.1:9876.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: resultOutputSchema({
        connected: z.boolean(),
        endpoint: z.string(),
        sceneInfoJson: z.string().optional(),
        error: z.string().optional(),
      }),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      try {
        workspaces.getWorkspace(workspaceId);
        const response = await request("get_scene_info", {}, { timeoutMs: STATUS_TIMEOUT_MS });
        ensureSuccessResponse(response, "get_scene_info");
        const result = `BlenderMCP is connected at ${BLENDER_MCP_HOST}:${BLENDER_MCP_PORT}.`;
        logBlenderTool(config, {
          tool: blenderToolNames.status,
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [{ type: "text" as const, text: `${result}\n${safeResponseMessage(response)}`.trim() }],
          structuredContent: {
            result,
            connected: true,
            endpoint: `${BLENDER_MCP_HOST}:${BLENDER_MCP_PORT}`,
            sceneInfoJson: JSON.stringify(response),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result = `BlenderMCP is not available at ${BLENDER_MCP_HOST}:${BLENDER_MCP_PORT}: ${message}`;
        logBlenderTool(config, {
          tool: blenderToolNames.status,
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: {
            result,
            connected: false,
            endpoint: `${BLENDER_MCP_HOST}:${BLENDER_MCP_PORT}`,
            error: message,
          },
        };
      }
    },
  );

  registerAppTool(
    server,
    blenderToolNames.runScript,
    {
      title: "Run Blender script",
      description:
        "Execute an existing Python script from an open workspace through local BlenderMCP. The script path and every declared expected output must be workspace-relative. Use outputs to verify generated .blend, FBX, GLB, image, or other files after execution. The Blender Python process itself is powerful local execution and is not a sandbox.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        scriptPath: z.string().describe("Workspace-relative path to an existing .py Blender script."),
        outputs: z.array(z.string()).max(32).optional().describe(
          "Optional workspace-relative files that must exist after the script succeeds.",
        ),
        timeoutSeconds: z.number().int().min(1).max(MAX_OPERATION_TIMEOUT_MS / 1000).optional().describe(
          "Execution timeout in seconds. Defaults to 300 and is capped at 900.",
        ),
      },
      outputSchema: resultOutputSchema({
        scriptPath: z.string(),
        blenderMessage: z.string().optional(),
        outputs: z.array(z.object({
          path: z.string(),
          bytes: z.number().int().nonnegative(),
          sha256: z.string(),
        })),
      }),
      _meta: {},
      annotations: BLENDER_SCRIPT_ANNOTATIONS,
    },
    async ({ workspaceId, scriptPath, outputs, timeoutSeconds }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        assertRelativeWorkspacePath(scriptPath, "scriptPath");
        const absoluteScriptPath = workspaces.resolvePath(workspace, scriptPath);
        await assertRealFileInsideWorkspace(absoluteScriptPath, workspace.root, ".py");
        const scriptStat = await stat(absoluteScriptPath);
        if (scriptStat.size > MAX_SCRIPT_BYTES) {
          throw new Error(`Blender script exceeds the ${MAX_SCRIPT_BYTES}-byte limit: ${scriptPath}`);
        }
        const code = await readFile(absoluteScriptPath, "utf8");
        if (!code.trim()) throw new Error(`Blender script is empty: ${scriptPath}`);

        const expectedOutputs = normalizeExpectedOutputs(workspaces, workspace, outputs ?? []);
        for (const output of expectedOutputs) {
          await assertOutputTargetInsideWorkspace(output.absolutePath, workspace.root);
        }
        const timeoutMs = normalizeTimeoutMs((timeoutSeconds ?? 300) * 1000);
        const response = await request("execute_code", { code }, { timeoutMs });
        ensureSuccessResponse(response, "execute_code");
        const verifiedOutputs = await verifyArtifacts(expectedOutputs, workspace.root);
        const blenderMessage = safeResponseMessage(response);
        const result = verifiedOutputs.length > 0
          ? `Blender script completed and verified ${verifiedOutputs.length} output file(s): ${scriptPath}`
          : `Blender script completed: ${scriptPath}`;
        logBlenderTool(config, {
          tool: blenderToolNames.runScript,
          workspaceId,
          path: scriptPath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [{ type: "text" as const, text: [result, blenderMessage].filter(Boolean).join("\n") }],
          structuredContent: {
            result,
            scriptPath,
            ...(blenderMessage ? { blenderMessage } : {}),
            outputs: verifiedOutputs,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logBlenderTool(config, {
          tool: blenderToolNames.runScript,
          workspaceId,
          path: scriptPath,
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
    blenderToolNames.render,
    {
      title: "Render Blender scene",
      description:
        "Render the current Blender scene through local BlenderMCP to a workspace-relative image file. The tool temporarily selects an image format from the output extension, restores the scene render path/format/frame afterward, and verifies the generated file.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        outputPath: z.string().describe(
          "Workspace-relative render output path ending in .png, .jpg/.jpeg, .tif/.tiff, .bmp, .hdr, or .exr.",
        ),
        frame: z.number().int().min(0).optional().describe("Optional frame to render. Defaults to the current frame."),
        timeoutSeconds: z.number().int().min(1).max(MAX_OPERATION_TIMEOUT_MS / 1000).optional().describe(
          "Render timeout in seconds. Defaults to 300 and is capped at 900.",
        ),
      },
      outputSchema: resultOutputSchema({
        output: z.object({
          path: z.string(),
          bytes: z.number().int().nonnegative(),
          sha256: z.string(),
        }),
        frame: z.number().int().nonnegative().optional(),
        blenderMessage: z.string().optional(),
      }),
      _meta: {},
      annotations: BLENDER_RENDER_ANNOTATIONS,
    },
    async ({ workspaceId, outputPath, frame, timeoutSeconds }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        assertRelativeWorkspacePath(outputPath, "outputPath");
        const absoluteOutputPath = workspaces.resolvePath(workspace, outputPath);
        await assertOutputTargetInsideWorkspace(absoluteOutputPath, workspace.root);
        const format = renderFormatForPath(outputPath);
        const timeoutMs = normalizeTimeoutMs((timeoutSeconds ?? 300) * 1000);
        const code = buildRenderCode(absoluteOutputPath, format, frame);
        const response = await request("execute_code", { code }, { timeoutMs });
        ensureSuccessResponse(response, "execute_code");
        const [verified] = await verifyArtifacts([
          { path: outputPath, absolutePath: absoluteOutputPath },
        ], workspace.root);
        if (!verified) throw new Error(`Render output was not created: ${outputPath}`);
        const blenderMessage = safeResponseMessage(response);
        const result = `Blender render completed: ${outputPath}`;
        logBlenderTool(config, {
          tool: blenderToolNames.render,
          workspaceId,
          path: outputPath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [{ type: "text" as const, text: [result, blenderMessage].filter(Boolean).join("\n") }],
          structuredContent: {
            result,
            output: verified,
            ...(frame == null ? {} : { frame }),
            ...(blenderMessage ? { blenderMessage } : {}),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logBlenderTool(config, {
          tool: blenderToolNames.render,
          workspaceId,
          path: outputPath,
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

export function buildRenderCode(
  absoluteOutputPath: string,
  format: string,
  frame?: number,
): string {
  const outputLiteral = JSON.stringify(absoluteOutputPath);
  const formatLiteral = JSON.stringify(format);
  const frameExpression = frame == null ? "None" : String(frame);
  return [
    "import bpy",
    "import os",
    `output_path = ${outputLiteral}`,
    `render_format = ${formatLiteral}`,
    `requested_frame = ${frameExpression}`,
    "scene = bpy.context.scene",
    "old_filepath = scene.render.filepath",
    "old_format = scene.render.image_settings.file_format",
    "old_use_file_extension = scene.render.use_file_extension",
    "old_frame = scene.frame_current",
    "try:",
    "    parent = os.path.dirname(output_path)",
    "    if parent:",
    "        os.makedirs(parent, exist_ok=True)",
    "    scene.render.filepath = output_path",
    "    scene.render.image_settings.file_format = render_format",
    "    scene.render.use_file_extension = True",
    "    if requested_frame is not None:",
    "        scene.frame_set(requested_frame)",
    "    bpy.ops.render.render(write_still=True)",
    "finally:",
    "    scene.render.filepath = old_filepath",
    "    scene.render.image_settings.file_format = old_format",
    "    scene.render.use_file_extension = old_use_file_extension",
    "    if scene.frame_current != old_frame:",
    "        scene.frame_set(old_frame)",
  ].join("\n");
}

function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("BlenderMCP timeout must be a positive finite number.");
  }
  return Math.min(Math.round(timeoutMs), MAX_OPERATION_TIMEOUT_MS);
}

function ensureSuccessResponse(response: BlenderMcpResponse, operation: string): void {
  if (response.status === "success") return;
  const message = safeResponseMessage(response) || `${operation} failed.`;
  throw new Error(`BlenderMCP ${operation} failed: ${message}`);
}

function safeResponseMessage(response: BlenderMcpResponse): string {
  const value = response.message;
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function assertRelativeWorkspacePath(inputPath: string, fieldName: string): void {
  if (!inputPath.trim()) throw new Error(`${fieldName} must not be empty.`);
  if (isAbsolute(inputPath)) throw new Error(`${fieldName} must be workspace-relative: ${inputPath}`);
}

async function assertRealFileInsideWorkspace(
  absolutePath: string,
  workspaceRoot: string,
  requiredExtension?: string,
): Promise<void> {
  const fileStat = await stat(absolutePath).catch(() => null);
  if (!fileStat?.isFile()) throw new Error(`File not found: ${absolutePath}`);
  if (requiredExtension && extname(absolutePath).toLowerCase() !== requiredExtension) {
    throw new Error(`Expected a ${requiredExtension} file: ${absolutePath}`);
  }
  const [realFile, realRoot] = await Promise.all([realpath(absolutePath), realpath(workspaceRoot)]);
  if (!isPathInsideRoot(realFile, realRoot)) {
    throw new Error(`Resolved file escapes workspace root: ${absolutePath}`);
  }
}

async function assertOutputTargetInsideWorkspace(
  absolutePath: string,
  workspaceRoot: string,
): Promise<void> {
  const realRoot = await realpath(workspaceRoot);
  const existing = await stat(absolutePath).catch(() => null);
  if (existing) {
    if (!existing.isFile()) {
      throw new Error(`Blender output target must be a file path: ${absolutePath}`);
    }
    const realTarget = await realpath(absolutePath);
    if (!isPathInsideRoot(realTarget, realRoot)) {
      throw new Error(`Blender output target resolves outside workspace root: ${absolutePath}`);
    }
    return;
  }

  let cursor = dirname(absolutePath);
  while (true) {
    const cursorStat = await stat(cursor).catch(() => null);
    if (cursorStat) {
      if (!cursorStat.isDirectory()) {
        throw new Error(`Blender output parent is not a directory: ${cursor}`);
      }
      const realParent = await realpath(cursor);
      if (!isPathInsideRoot(realParent, realRoot)) {
        throw new Error(`Blender output parent resolves outside workspace root: ${absolutePath}`);
      }
      return;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Could not resolve a safe Blender output parent: ${absolutePath}`);
    }
    cursor = parent;
  }
}

function normalizeExpectedOutputs(
  workspaces: WorkspaceRegistry,
  workspace: ReturnType<WorkspaceRegistry["getWorkspace"]>,
  outputs: string[],
): Array<{ path: string; absolutePath: string }> {
  const seen = new Set<string>();
  return outputs.map((output) => {
    assertRelativeWorkspacePath(output, "outputs[]");
    const absolutePath = workspaces.resolvePath(workspace, output);
    const key = absolutePath.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate expected Blender output: ${output}`);
    seen.add(key);
    return { path: output, absolutePath };
  });
}

async function verifyArtifacts(
  outputs: Array<{ path: string; absolutePath: string }>,
  workspaceRoot: string,
): Promise<VerifiedArtifact[]> {
  const realRoot = await realpath(workspaceRoot);
  const verified: VerifiedArtifact[] = [];
  for (const output of outputs) {
    const outputStat = await stat(output.absolutePath).catch(() => null);
    if (!outputStat?.isFile()) {
      throw new Error(`Expected Blender output was not created: ${output.path}`);
    }
    const realOutput = await realpath(output.absolutePath);
    if (!isPathInsideRoot(realOutput, realRoot)) {
      throw new Error(`Generated Blender output resolves outside workspace root: ${output.path}`);
    }
    verified.push({
      path: output.path,
      bytes: outputStat.size,
      sha256: await sha256File(realOutput),
    });
  }
  return verified;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function renderFormatForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "PNG";
    case ".jpg":
    case ".jpeg":
      return "JPEG";
    case ".tif":
    case ".tiff":
      return "TIFF";
    case ".bmp":
      return "BMP";
    case ".hdr":
      return "HDR";
    case ".exr":
      return "OPEN_EXR";
    default:
      throw new Error(`Unsupported Blender render extension: ${extname(path) || "(none)"}`);
  }
}

function logBlenderTool(
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

export const blenderMcpEndpoint = {
  host: BLENDER_MCP_HOST,
  port: BLENDER_MCP_PORT,
} as const;
