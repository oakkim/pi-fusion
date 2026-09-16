/**
 * Managed git worktrees. Port of opencode-agent's worktree model:
 * spawn in an isolated checkout + branch, merge back when done.
 *
 * Layout: <agentDir>/fusion-worktrees/<project>-<hash>/<name>
 * Branch: pi-fusion/<name>
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { WorktreeInfo } from "./types.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: unknown; message?: unknown };
    const detail = typeof e.stderr === "string" && e.stderr.trim() ? e.stderr.trim() : String(e.message ?? err);
    throw new Error(`git ${args.join(" ")} failed: ${detail.split("\n")[0]}`);
  }
}

export function validateWorktreeName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/.test(name)) {
    throw new Error(`Invalid worktree name ${JSON.stringify(name)}: use 1-64 chars of [a-zA-Z0-9-_], starting alphanumeric.`);
  }
}

export function branchFor(name: string): string {
  return `pi-fusion/${name}`;
}

function projectKey(toplevel: string): string {
  const hash = createHash("sha1").update(toplevel).digest("hex").slice(0, 8);
  const base = (toplevel.split("/").filter(Boolean).pop() ?? "root").replace(/[^a-zA-Z0-9-_]/g, "_");
  return `${base}-${hash}`;
}

export async function toplevelOf(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error("fusion worktree requires a git repository (cwd is not inside one).");
  }
}

export async function createWorktree(cwd: string, name: string): Promise<WorktreeInfo> {
  validateWorktreeName(name);
  // Canonicalize both sides: macOS symlinks (/var -> /private/var) otherwise
  // make relative() climb out with ".." and execDirOf() escape the worktree.
  const toplevel = await realpath(await toplevelOf(cwd));
  const relDir = relative(toplevel, await realpath(cwd)) || ".";
  if (relDir.startsWith("..")) {
    throw new Error(`Could not map ${cwd} into repo ${toplevel}.`);
  }
  const branch = branchFor(name);
  const path = join(getAgentDir(), "fusion-worktrees", projectKey(toplevel), name);

  if (existsSync(path)) {
    throw new Error(`Worktree path already exists: ${path} (pick another name or close/remove the old worker).`);
  }
  const existingBranch = await git(toplevel, ["branch", "--list", branch]);
  if (existingBranch) {
    throw new Error(`Branch ${branch} already exists (pick another name or delete it).`);
  }
  const projectBranch = await git(toplevel, ["branch", "--show-current"]).catch(() => "");

  await git(toplevel, ["worktree", "add", path, "-b", branch]);
  return { name, branch, path, projectRoot: toplevel, relDir, projectBranch };
}

/** Directory the executor tools should run in (mirrors cwd inside the worktree). */
export function execDirOf(w: WorktreeInfo): string {
  return w.relDir === "." ? w.path : join(w.path, w.relDir);
}

export interface MergeResult {
  committed: boolean;
  mergeOutput: string;
}

export async function mergeWorktree(w: WorktreeInfo, label?: string): Promise<MergeResult> {
  if (!w.projectBranch) {
    throw new Error("Cannot merge: project checkout is on a detached HEAD. Check out a branch first.");
  }
  // 1. Commit worktree changes (with fallback identity so it always works).
  await git(w.path, ["add", "-A"]);
  const dirty = await git(w.path, ["status", "--porcelain"]);
  let committed = false;
  if (dirty) {
    const msg = `pi-fusion ${w.name}: ${label ?? "sidekick work"}`.slice(0, 200);
    await git(w.path, ["-c", "user.name=pi-fusion", "-c", "user.email=pi-fusion@local", "commit", "-m", msg]);
    committed = true;
  }
  // 2. Refuse a dirty target (mirrors opencode-agent).
  const targetDirty = await git(w.projectRoot, ["status", "--porcelain"]);
  if (targetDirty) {
    throw new Error("Project checkout has uncommitted changes; commit or stash them before merging.");
  }
  // 3. Merge the branch into the current project branch.
  const current = await git(w.projectRoot, ["branch", "--show-current"]).catch(() => "");
  if (current !== w.projectBranch) {
    throw new Error(`Project is on ${JSON.stringify(current || "detached")}, expected ${JSON.stringify(w.projectBranch)}. Check out ${w.projectBranch} first.`);
  }
  const mergeOutput = await git(w.projectRoot, ["merge", "--no-edit", w.branch]);
  return { committed, mergeOutput };
}

export async function removeWorktree(w: WorktreeInfo): Promise<void> {
  await git(w.projectRoot, ["worktree", "remove", "--force", w.path]).catch((err: Error) => {
    throw new Error(`Could not remove worktree: ${err.message}`);
  });
  // Branch delete is best-effort (may already be gone).
  await git(w.projectRoot, ["branch", "-D", w.branch]).catch(() => undefined);
}
