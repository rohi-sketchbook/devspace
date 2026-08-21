import { execFile } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

export interface DeletePathResult {
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface GitCleanupResult {
  action: "remove_worktree" | "delete_branch" | "prune_worktrees" | "remove_worktree_residue";
  target?: string;
  result: string;
}

export async function deleteWorkspacePath(input: {
  workspaceRoot: string;
  absolutePath: string;
  recursive?: boolean;
}): Promise<DeletePathResult> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const absolutePath = assertAllowedPath(input.absolutePath, [workspaceRoot]);

  if (samePath(absolutePath, workspaceRoot)) {
    throw new Error("Refusing to delete the workspace root.");
  }

  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  const canonicalParent = await realpath(dirname(absolutePath));
  if (!isPathInsideRoot(canonicalParent, canonicalWorkspaceRoot)) {
    throw new Error(`Refusing to delete through a symlink outside the workspace root: ${absolutePath}`);
  }

  const stats = await lstat(absolutePath);
  const kind: DeletePathResult["kind"] = stats.isSymbolicLink()
    ? "symlink"
    : stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : "other";

  if (kind === "directory" && !input.recursive) {
    throw new Error("Directory deletion requires recursive=true.");
  }

  await rm(absolutePath, {
    recursive: kind === "directory",
    force: false,
  });

  return { path: absolutePath, kind };
}

export async function gitCleanup(input: {
  repoRoot: string;
  worktreeRoot: string;
  action: GitCleanupResult["action"];
  target?: string;
  force?: boolean;
}): Promise<GitCleanupResult> {
  const repoRoot = resolve(input.repoRoot);
  const worktreeRoot = resolve(input.worktreeRoot);

  switch (input.action) {
    case "remove_worktree": {
      const target = requireTarget(input.target, "remove_worktree");
      const worktreePath = assertManagedWorktreeTarget(target, worktreeRoot);
      const registered = await listRegisteredWorktrees(repoRoot);
      if (!registered.some((path) => samePath(path, worktreePath))) {
        throw new Error(`Refusing to remove an unregistered worktree: ${worktreePath}`);
      }

      const args = ["worktree", "remove"];
      if (input.force) args.push("--force");
      args.push(worktreePath);
      await git(args, repoRoot);
      return {
        action: input.action,
        target: worktreePath,
        result: `Removed registered worktree: ${worktreePath}`,
      };
    }

    case "delete_branch": {
      const branch = requireTarget(input.target, "delete_branch");
      await validateBranchName(branch, repoRoot);
      const currentBranch = (await git(["branch", "--show-current"], repoRoot)).trim();
      if (currentBranch && currentBranch === branch) {
        throw new Error(`Refusing to delete the current branch: ${branch}`);
      }
      await git(["show-ref", "--verify", `refs/heads/${branch}`], repoRoot);
      await git(["branch", input.force ? "-D" : "-d", "--", branch], repoRoot);
      return {
        action: input.action,
        target: branch,
        result: `Deleted local branch: ${branch}`,
      };
    }

    case "prune_worktrees": {
      await git(["worktree", "prune"], repoRoot);
      return {
        action: input.action,
        result: "Pruned stale Git worktree metadata.",
      };
    }

    case "remove_worktree_residue": {
      const target = requireTarget(input.target, "remove_worktree_residue");
      const residuePath = assertManagedWorktreeTarget(target, worktreeRoot);
      const expectedPrefix = `${basename(repoRoot)}-`;
      if (!basename(residuePath).startsWith(expectedPrefix)) {
        throw new Error(
          `Refusing to remove a residue whose name does not match this repository (${expectedPrefix}*): ${residuePath}`,
        );
      }

      const residueStats = await lstat(residuePath);
      if (residueStats.isSymbolicLink() || !residueStats.isDirectory()) {
        throw new Error(`Refusing to remove a residue that is not a real directory: ${residuePath}`);
      }

      const registered = await listRegisteredWorktrees(repoRoot);
      if (registered.some((path) => samePath(path, residuePath))) {
        throw new Error(`Refusing to remove a registered worktree as residue: ${residuePath}`);
      }

      const gitMarker = join(residuePath, ".git");
      try {
        await lstat(gitMarker);
        throw new Error(`Refusing to remove residue because it still contains .git: ${residuePath}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
          throw error;
        }
      }

      await rm(residuePath, { recursive: true, force: false });
      return {
        action: input.action,
        target: residuePath,
        result: `Removed unregistered managed-worktree residue: ${residuePath}`,
      };
    }
  }
}

function requireTarget(target: string | undefined, action: string): string {
  const trimmed = target?.trim();
  if (!trimmed) {
    throw new Error(`${action} requires a non-empty target.`);
  }
  return trimmed;
}

function assertManagedWorktreeTarget(target: string, worktreeRoot: string): string {
  const absolutePath = assertAllowedPath(target, [worktreeRoot]);
  if (samePath(absolutePath, worktreeRoot)) {
    throw new Error("Refusing to delete the managed worktree root itself.");
  }
  if (!isPathInsideRoot(absolutePath, worktreeRoot)) {
    throw new Error(`Worktree target is outside the managed worktree root: ${target}`);
  }

  const relationship = relative(worktreeRoot, absolutePath);
  if (!relationship || relationship.startsWith("..") || relationship.includes(sep)) {
    throw new Error(`Managed worktree cleanup only accepts an immediate child directory: ${target}`);
  }

  return absolutePath;
}

async function validateBranchName(branch: string, repoRoot: string): Promise<void> {
  if (branch.startsWith("-")) {
    throw new Error(`Invalid local branch name: ${branch}`);
  }
  await git(["check-ref-format", "--branch", branch], repoRoot);
}

async function listRegisteredWorktrees(repoRoot: string): Promise<string[]> {
  const output = await git(["worktree", "list", "--porcelain"], repoRoot);
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length).trim()));
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
