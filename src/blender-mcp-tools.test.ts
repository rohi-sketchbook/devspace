import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  blenderMcpEndpoint,
  buildRenderCode,
  registerBlenderTools,
  requestBlenderMcp,
  type BlenderMcpRequest,
} from "./blender-mcp-tools.js";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry } from "./workspaces.js";

test("requestBlenderMcp uses the BlenderMCP JSON protocol over loopback", async (t) => {
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString("utf8")) as {
        type: string;
        params: Record<string, unknown>;
      };
      assert.equal(request.type, "get_scene_info");
      assert.deepEqual(request.params, {});
      socket.end(JSON.stringify({ status: "success", message: "scene ok" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await requestBlenderMcp("get_scene_info", {}, {
    host: "127.0.0.1",
    port: address.port,
    timeoutMs: 2_000,
  });
  assert.equal(response.status, "success");
  assert.equal(response.message, "scene ok");
});

test("requestBlenderMcp refuses non-loopback endpoints", async () => {
  await assert.rejects(
    () => requestBlenderMcp("get_scene_info", {}, { host: "192.0.2.10", port: 9876 }),
    /must be loopback/,
  );
});

test("Blender tools execute workspace scripts and verify generated artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-blender-tools-test-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "build.py"),
    "# -*- coding: shift_jis -*-\nprint('build')\n",
  );

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const workspaces = new WorkspaceRegistry(config);
  const opened = await workspaces.openWorkspace(project);
  let executeCalls = 0;
  const fakeRequest: BlenderMcpRequest = async (requestType, params) => {
    if (requestType === "get_scene_info") {
      return { status: "success", result: { name: "Scene" } };
    }
    assert.equal(requestType, "execute_code");
    executeCalls += 1;
    const code = String(params?.code ?? "");
    if (code.includes("print('build')")) {
      await writeFile(join(project, "generated.blend"), Buffer.from("BLENDER"));
    }
    const renderPathMatch = /^output_path = (.+)$/m.exec(code);
    if (renderPathMatch?.[1]) {
      const renderPath = JSON.parse(renderPathMatch[1]) as string;
      await mkdir(dirname(renderPath), { recursive: true });
      await writeFile(renderPath, Buffer.from("PNGDATA"));
    }
    return { status: "success", result: "ok" };
  };

  const server = new McpServer({ name: "blender-tools-test", version: "1.0.0" });
  registerBlenderTools(server, { config, workspaces, request: fakeRequest });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "blender-tools-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  assert.equal(names.has("blender_status"), true);
  assert.equal(names.has("blender_run_script"), true);
  assert.equal(names.has("blender_render"), true);

  const scriptResult = await client.callTool({
    name: "blender_run_script",
    arguments: {
      workspaceId: opened.workspace.id,
      scriptPath: "build.py",
      outputs: ["generated.blend"],
    },
  });
  assert.equal(scriptResult.isError, undefined);
  const scriptStructured = scriptResult.structuredContent as {
    outputs: Array<{ path: string; bytes: number; sha256: string }>;
  };
  assert.equal(scriptStructured.outputs[0]?.path, "generated.blend");
  assert.equal(scriptStructured.outputs[0]?.bytes, 7);
  assert.match(scriptStructured.outputs[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);

  const renderResult = await client.callTool({
    name: "blender_render",
    arguments: {
      workspaceId: opened.workspace.id,
      outputPath: "renders/preview.png",
      frame: 12,
    },
  });
  assert.equal(renderResult.isError, undefined);
  const renderStructured = renderResult.structuredContent as {
    output: { path: string; bytes: number; sha256: string };
    frame: number;
  };
  assert.equal(renderStructured.output.path, "renders/preview.png");
  assert.equal(renderStructured.output.bytes, 7);
  assert.equal(renderStructured.frame, 12);

  const callsBeforeRejectedOutput = executeCalls;
  const rejected = await client.callTool({
    name: "blender_run_script",
    arguments: {
      workspaceId: opened.workspace.id,
      scriptPath: "build.py",
      outputs: [join(root, "outside.blend")],
    },
  });
  assert.equal(rejected.isError, true);
  assert.equal(executeCalls, callsBeforeRejectedOutput);

  const outsideDirectory = join(root, "outside-workspace");
  await mkdir(outsideDirectory, { recursive: true });
  await symlink(outsideDirectory, join(project, "escape"), "junction");
  const callsBeforeSymlinkEscape = executeCalls;
  const symlinkRejected = await client.callTool({
    name: "blender_render",
    arguments: {
      workspaceId: opened.workspace.id,
      outputPath: "escape/leak.png",
    },
  });
  assert.equal(symlinkRejected.isError, true);
  assert.equal(executeCalls, callsBeforeSymlinkEscape);
});

test("buildRenderCode restores Blender render state after rendering", () => {
  const code = buildRenderCode("H:\\codexapp\\project\\renders\\preview.png", "PNG", 12);
  assert.match(code, /bpy\.ops\.render\.render\(write_still=True\)/);
  assert.match(code, /scene\.render\.filepath = old_filepath/);
  assert.match(code, /scene\.render\.image_settings\.file_format = old_format/);
  assert.match(code, /scene\.frame_set\(old_frame\)/);
  assert.match(code, /requested_frame = 12/);
});

test("the production BlenderMCP endpoint remains fixed to local loopback", () => {
  assert.deepEqual(blenderMcpEndpoint, { host: "127.0.0.1", port: 9876 });
});
