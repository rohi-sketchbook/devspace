import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  extractAgentCommands,
  inspectLocalAgentWorkspace,
  overlappingChangedFiles,
} from "./local-agent-workspace.js";

const execFileAsync = promisify(execFile);

assert.deepEqual(
  extractAgentCommands({
    items: [
      { type: "commandExecution", command: "npm test", exitCode: 0 },
      { type: "agentMessage", text: "done" },
      { nested: { type: "command_execution", command: "git status --short" } },
    ],
  }),
  ["git status --short", "npm test [exit=0]"],
);
assert.deepEqual(
  overlappingChangedFiles(["src/a.ts", "src\\b.ts"], ["src/b.ts", "src/c.ts"]),
  ["src\\b.ts"],
);

const root = await mkdtemp(join(tmpdir(), "devspace-agent-workspace-test-"));
try {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "devspace@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "DevSpace Test"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "before\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "after\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const snapshot = await inspectLocalAgentWorkspace(root);
  assert.deepEqual(snapshot.changedFiles, ["new.txt", "tracked.txt"]);
} finally {
  await rm(root, { recursive: true, force: true });
}
