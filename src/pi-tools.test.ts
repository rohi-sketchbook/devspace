import assert from "node:assert/strict";
import { runShellTool } from "./pi-tools.js";
import { devspaceProcessEnvironment } from "./process-sessions.js";

const workspaceRoot = process.cwd();
const response = await runShellTool(
  {
    command:
      `node -e "console.log([process.env.DEVSPACE_CLI_PATH, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT].join('|'))"`,
  },
  {
    cwd: workspaceRoot,
    root: workspaceRoot,
    env: devspaceProcessEnvironment({
      workspaceId: "workspace-pi-shell",
      workspaceRoot,
    }),
  },
);

assert.equal(response.isError, undefined);
const output = response.content
  .filter((block) => block.type === "text")
  .map((block) => block.text)
  .join("\n");
assert.match(output, /cli\.js\|workspace-pi-shell\|/);
assert.ok(output.includes(workspaceRoot));
