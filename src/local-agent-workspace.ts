import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_COMMANDS = 64;
const MAX_COMMAND_LENGTH = 1_000;

export interface LocalAgentWorkspaceSnapshot {
  changedFiles: string[];
}

export async function inspectLocalAgentWorkspace(root: string): Promise<LocalAgentWorkspaceSnapshot> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z"], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { changedFiles: parsePorcelainPaths(stdout) };
  } catch {
    return { changedFiles: [] };
  }
}

export function extractAgentCommands(value: unknown): string[] {
  const commands: string[] = [];
  const seenObjects = new Set<object>();
  const seenCommands = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length > 0 && commands.length < MAX_COMMANDS) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (seenObjects.has(current)) continue;
    seenObjects.add(current);
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    const record = current as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "commandExecution" || type === "command_execution") {
      const command = typeof record.command === "string" ? record.command.trim() : "";
      const exitCode = typeof record.exitCode === "number"
        ? record.exitCode
        : (typeof record.exit_code === "number" ? record.exit_code : undefined);
      const status = typeof record.status === "string" ? record.status.trim() : "";
      const resultSuffix = exitCode !== undefined
        ? ` [exit=${exitCode}]`
        : (status ? ` [status=${status}]` : "");
      const summary = command ? `${command}${resultSuffix}` : "";
      if (summary && !seenCommands.has(summary)) {
        seenCommands.add(summary);
        commands.push(summary.slice(0, MAX_COMMAND_LENGTH));
      }
    }
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") pending.push(nested);
    }
  }
  return commands;
}

export function overlappingChangedFiles(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] {
  if (!left?.length || !right?.length) return [];
  const rightSet = new Set(right.map(normalizeGitPath));
  return left
    .filter((path) => rightSet.has(normalizeGitPath(path)))
    .sort((a, b) => a.localeCompare(b));
}

function parsePorcelainPaths(output: string): string[] {
  if (!output) return [];
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.push(path);
    if (status.includes("R") || status.includes("C")) {
      const renamedPath = entries[index + 1];
      if (renamedPath) paths.push(renamedPath);
      index += 1;
    }
  }
  return Array.from(new Set(paths.map(normalizeGitPath))).sort((a, b) => a.localeCompare(b));
}

function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/");
}
