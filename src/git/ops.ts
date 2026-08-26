import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AuthMethod, RunOptions } from "./runner.js";
import { git, gitAuth, GitError, runGit } from "./runner.js";

/**
 * High-level git operations used by the tools and lifecycle hooks.
 * All network operations go through gitAuth() for credential injection.
 */

export interface StatusLines {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

const SECRET_PATTERNS: RegExp[] = [
  /(^|\/|\\|^)\.env(\.[a-z0-9]+)?$/i,
  /\.pem$/i,
  /(^|\/|\\|^)id_rsa$/i,
  /\.key$/i,
  /\.secret$/i,
  /(^|\/|\\|^)credentials[^/\\]*$/i,
  /\.npmrc$/i,
];

function baseOptions(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): RunOptions {
  return { cwd, token, authMethod };
}

/** Whether git is available on PATH. */
export async function isGitAvailable(): Promise<boolean> {
  try {
    const result = await runGit(["--version"], {
      cwd: process.cwd(),
      authMethod: "extraheader",
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

/** Whether cwd contains a .git directory (or file, for worktrees). */
export function hasRepoSync(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

export async function hasRepo(cwd: string): Promise<boolean> {
  return hasRepoSync(cwd);
}

/** git init -b <branch> (falls back to init + checkout -b on old git). */
export async function gitInit(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  branch: string,
): Promise<void> {
  const opts = baseOptions(cwd, token, authMethod);
  const initResult = await runGit(["init"], opts);
  if (initResult.code !== 0) throw new GitError(initResult.stderr.trim(), "init", initResult.code, initResult.stderr);
  const branchResult = await runGit(["checkout", "-b", branch], opts);
  if (branchResult.code !== 0) {
    // branch may already exist (e.g. git init -b support) — try symbolic rename path
    const symbolic = await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], opts);
    if (symbolic.code !== 0) {
      throw new GitError(
        `无法将默认分支设为 ${branch}: ${branchResult.stderr || symbolic.stderr}`,
        "checkout -b",
        symbolic.code,
        symbolic.stderr,
      );
    }
  }
}

export async function currentBranch(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<string> {
  const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], baseOptions(cwd, token, authMethod));
  return result.stdout.trim() || "main";
}

export async function getRemoteUrl(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<string | undefined> {
  const result = await runGit(["remote", "get-url", "origin"], baseOptions(cwd, token, authMethod));
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function addRemote(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  url: string,
): Promise<void> {
  await git(["remote", "add", "origin", url], baseOptions(cwd, token, authMethod));
}

export async function setRemoteUrl(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  url: string,
): Promise<void> {
  const opts = baseOptions(cwd, token, authMethod);
  const existing = await getRemoteUrl(cwd, token, authMethod);
  if (existing) {
    await git(["remote", "set-url", "origin", url], opts);
  } else {
    await addRemote(cwd, token, authMethod, url);
  }
}

/** Parse `git status --porcelain=v1` into grouped path lists. */
export async function statusPorcelain(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<StatusLines> {
  const result = await git(["status", "--porcelain=v1"], baseOptions(cwd, token, authMethod));
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const path = line.slice(3).replace(/^"(.*)"$/, "$1");
    if (xy === "??") untracked.push(path);
    else if (xy[0] !== " " && xy[0] !== "?") staged.push(path);
    if (xy[1] !== " ") unstaged.push(path);
  }
  return { staged, unstaged, untracked };
}

export async function addAll(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<void> {
  await git(["add", "-A"], baseOptions(cwd, token, authMethod));
}

/**
 * Ensure a repo-local commit identity exists (never touches global config).
 * Needed because many machines have no git user.name/user.email configured,
 * which makes `git commit` fail with "Author identity unknown".
 */
export async function ensureIdentity(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  identity: { name: string; email: string },
): Promise<void> {
  const opts = baseOptions(cwd, token, authMethod);
  const nameCheck = await runGit(["config", "user.name"], opts);
  if (nameCheck.code !== 0 || !nameCheck.stdout.trim()) {
    await git(["config", "user.name", identity.name], opts);
  }
  const emailCheck = await runGit(["config", "user.email"], opts);
  if (emailCheck.code !== 0 || !emailCheck.stdout.trim()) {
    await git(["config", "user.email", identity.email], opts);
  }
}

export async function commit(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  message: string,
  identity?: { name: string; email: string },
): Promise<string> {
  if (identity) await ensureIdentity(cwd, token, authMethod, identity);
  await git(["commit", "-m", message], baseOptions(cwd, token, authMethod));
  return revParseHead(cwd, token, authMethod);
}

export async function revParseHead(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<string> {
  const result = await git(["rev-parse", "HEAD"], baseOptions(cwd, token, authMethod));
  return result.stdout.trim();
}

/** pull --rebase; throws GitError(conflict: true) on conflicts. */
export async function pullRebase(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<void> {
  await gitAuth(["pull", "--rebase", "--autostash"], baseOptions(cwd, token, authMethod));
}

/** push [-u] origin <branch>. */
export async function push(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  branch: string,
  setUpstream = false,
): Promise<void> {
  const args = ["push"];
  if (setUpstream) args.push("-u");
  args.push("origin", branch);
  await gitAuth(args, baseOptions(cwd, token, authMethod));
}

/** Ahead/behind vs upstream; -1 when no upstream configured. */
export async function aheadBehind(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<{ ahead: number; behind: number }> {
  const opts = baseOptions(cwd, token, authMethod);
  const aheadResult = await runGit(["rev-list", "--count", "@{u}..HEAD"], opts);
  const behindResult = await runGit(["rev-list", "--count", "HEAD..@{u}"], opts);
  if (aheadResult.code !== 0 || behindResult.code !== 0) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(aheadResult.stdout.trim()) || 0,
    behind: Number(behindResult.stdout.trim()) || 0,
  };
}

/** Files to be committed that match known secret patterns. */
export async function scanForSecrets(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<string[]> {
  const { staged, untracked } = await statusPorcelain(cwd, token, authMethod);
  return [...staged, ...untracked].filter((path) =>
    SECRET_PATTERNS.some((pattern) => pattern.test(path)),
  );
}

/** Files about to be committed whose size exceeds maxSizeMb. */
export async function oversizedFiles(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  maxSizeMb: number,
): Promise<Array<{ path: string; sizeMb: number }>> {
  const { staged, untracked } = await statusPorcelain(cwd, token, authMethod);
  const found: Array<{ path: string; sizeMb: number }> = [];
  for (const path of [...staged, ...untracked]) {
    try {
      const info = await stat(join(cwd, path));
      const sizeMb = info.size / (1024 * 1024);
      if (sizeMb > maxSizeMb) found.push({ path, sizeMb: Math.round(sizeMb * 10) / 10 });
    } catch {
      // deleted or unreadable — skip
    }
  }
  return found;
}

/** Ensure `.dsh-git-sync/` (plugin state dir) is never committed. */
export async function ensureGitignore(cwd: string): Promise<void> {
  const file = join(cwd, ".gitignore");
  const line = ".dsh-git-sync/";
  let content = "";
  try {
    const { readFile } = await import("node:fs/promises");
    content = await readFile(file, "utf8");
  } catch {
    content = "";
  }
  if (!content.split("\n").includes(line)) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, content.endsWith("\n") || content === "" ? `${content}${line}\n` : `${content}\n${line}\n`, "utf8");
  }
}

export { GitError };
