import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { deleteWorkspacePath, gitCleanup } from "./destructive-tools.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "devspace-destructive-tools-"));

  try {
    const file = join(root, "delete-me.txt");
    await writeFile(file, "delete me", "utf8");
    const deleted = await deleteWorkspacePath({ workspaceRoot: root, absolutePath: file });
    assert.equal(deleted.kind, "file");
    assert.equal(await exists(file), false);

    await assert.rejects(
      () => deleteWorkspacePath({ workspaceRoot: root, absolutePath: root, recursive: true }),
      /workspace root/,
    );

    const repoRoot = join(root, "sample-repo");
    const worktreeRoot = join(root, "worktrees");
    await mkdir(repoRoot);
    await mkdir(worktreeRoot);
    await git(repoRoot, "init");
    await git(repoRoot, "config", "user.email", "devspace-test@example.invalid");
    await git(repoRoot, "config", "user.name", "DevSpace Test");
    await writeFile(join(repoRoot, "tracked.txt"), "tracked\n", "utf8");
    await git(repoRoot, "add", "tracked.txt");
    await git(repoRoot, "commit", "-m", "initial");

    const worktreePath = join(worktreeRoot, `${basename(repoRoot)}-registered`);
    await git(repoRoot, "worktree", "add", "-b", "cleanup-test", worktreePath, "HEAD");
    await gitCleanup({
      repoRoot,
      worktreeRoot,
      action: "remove_worktree",
      target: worktreePath,
      force: true,
    });
    assert.doesNotMatch(await git(repoRoot, "worktree", "list", "--porcelain"), /registered/);

    await gitCleanup({
      repoRoot,
      worktreeRoot,
      action: "delete_branch",
      target: "cleanup-test",
      force: true,
    });
    await assert.rejects(() => git(repoRoot, "show-ref", "--verify", "refs/heads/cleanup-test"));

    const residuePath = join(worktreeRoot, `${basename(repoRoot)}-residue`);
    await mkdir(residuePath);
    await writeFile(join(residuePath, "orphan.txt"), "orphan\n", "utf8");
    await gitCleanup({
      repoRoot,
      worktreeRoot,
      action: "remove_worktree_residue",
      target: residuePath,
    });
    assert.equal(await exists(residuePath), false);

    const protectedPath = join(worktreeRoot, `${basename(repoRoot)}-protected`);
    await mkdir(join(protectedPath, ".git"), { recursive: true });
    await assert.rejects(
      () => gitCleanup({
        repoRoot,
        worktreeRoot,
        action: "remove_worktree_residue",
        target: protectedPath,
      }),
      /still contains \.git/,
    );

    await gitCleanup({ repoRoot, worktreeRoot, action: "prune_worktrees" });
    console.log("destructive-tools tests passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
