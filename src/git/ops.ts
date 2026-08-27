import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AuthMethod, RunOptions } from "./runner.js";
import { git, gitAuth, GitError, runGit } from "./runner.js";

/**
 * High-level git operations used by the tools and lifecycle hooks.
 * All network operations go through gitAuth() for credential injection.
 */

/** Hard ceiling for network git commands — protects against hung transports. */
export const NETWORK_TIMEOUT_MS = 600_000;

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

/**
 * Pure parser for `git status --porcelain=v1 -z` output.
 *
 * -z is used deliberately over plain porcelain: paths are NUL-separated and
 * never quoted, so non-ASCII (中文) filenames arrive as raw UTF-8 instead of
 * C-escaped octal, and rename/copy records are unambiguous. Rename records
 * carry `XY<space><to>` followed by a second NUL-delimited field with the
 * original path; we keep the new path only.
 *
 * Same classification as the previous quoted format: first column marks
 * staged (index) state, second column unstaged (worktree) state. Unmerged
 * pairs (UU/AA/...) legitimately land in both buckets.
 */
export function parseStatusZ(stdout: string): StatusLines {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    // Trailing NUL / empty separators — skip. A record needs "XY " at least.
    if (!record || record.length < 4) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    if (xy === "??") {
      untracked.push(path);
      continue;
    }
    // Rename/copy: an extra NUL-delimited field follows with the old name.
    if ((xy[0] === "R" || xy[0] === "C") && xy[1] === " ") i++;
    if (xy[0] !== " " && xy[0] !== "?") staged.push(path);
    if (xy[1] !== " ") unstaged.push(path);
  }
  return { staged, unstaged, untracked };
}

/** Parse `git status --porcelain=v1 -z` output for cwd. */
export async function statusPorcelain(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<StatusLines> {
  const result = await runGit(["status", "--porcelain=v1", "-z"], baseOptions(cwd, token, authMethod));
  if (result.code !== 0) return { staged: [], unstaged: [], untracked: [] };
  return parseStatusZ(result.stdout);
}

export async function addAll(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<void> {
  await git(["add", "-A"], baseOptions(cwd, token, authMethod));
}

/**
 * Stage only the given pathspecs (`git add -- <paths>…`), used by git_sync's
 * `include` parameter. Empty input is a no-op so callers can branch freely.
 */
export async function addPaths(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  await git(["add", "--", ...paths], baseOptions(cwd, token, authMethod));
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

/**
 * pull --rebase; throws GitError(conflict: true) on conflicts.
 * Network commands get a hard timeout so a hung transport cannot wedge the
 * calling tool turn (or a lifecycle hook) forever.
 */
export async function pullRebase(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<void> {
  await gitAuth(["pull", "--rebase", "--autostash"], {
    ...baseOptions(cwd, token, authMethod),
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
}

/**
 * Best-effort `rebase --abort` after a conflicted background pull.
 * Safe: abort restores HEAD to the pre-rebase state and automatically
 * re-applies the autostash created by pull --autostash. Returns whether an
 * in-progress rebase was actually aborted.
 */
export async function abortRebaseSafe(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<boolean> {
  try {
    await git(["rebase", "--abort"], baseOptions(cwd, token, authMethod));
    return true;
  } catch {
    // No rebase in progress or nothing to restore — nothing to clean up.
    return false;
  }
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
  await gitAuth(args, { ...baseOptions(cwd, token, authMethod), timeoutMs: NETWORK_TIMEOUT_MS });
}

/**
 * Ahead/behind vs upstream; when no upstream is configured the counts fall
 * back to comparing against origin/<branch>, and finally degrade to "every
 * local commit is ahead" — so an unpushed branch no longer reports the
 * misleading clean {0,0} (which remains only for unborn/unreadable HEAD).
 */
export async function aheadBehind(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  branch?: string,
): Promise<{ ahead: number; behind: number }> {
  const opts = baseOptions(cwd, token, authMethod);
  const upstreamAhead = await runGit(["rev-list", "--count", "@{u}..HEAD"], opts);
  const upstreamBehind = await runGit(["rev-list", "--count", "HEAD..@{u}"], opts);
  if (upstreamAhead.code === 0 && upstreamBehind.code === 0) {
    return {
      ahead: Number(upstreamAhead.stdout.trim()) || 0,
      behind: Number(upstreamBehind.stdout.trim()) || 0,
    };
  }

  // No upstream configured — try origin/<branch> (set by earlier -u pushes).
  if (branch && /^[A-Za-z0-9._/-]+$/.test(branch)) {
    const remoteRef = `origin/${branch}`;
    const remoteAhead = await runGit(["rev-list", "--count", `${remoteRef}..HEAD`], opts);
    const remoteBehind = await runGit(["rev-list", "--count", `HEAD..${remoteRef}`], opts);
    if (remoteAhead.code === 0 && remoteBehind.code === 0) {
      return {
        ahead: Number(remoteAhead.stdout.trim()) || 0,
        behind: Number(remoteBehind.stdout.trim()) || 0,
      };
    }
  }

  // Last resort: with no remote reference at all every local commit is ahead.
  const localCount = await runGit(["rev-list", "--count", "HEAD"], opts);
  if (localCount.code === 0) {
    return { ahead: Number(localCount.stdout.trim()) || 0, behind: 0 };
  }
  return { ahead: 0, behind: 0 };
}

/** Files to be committed that match known secret patterns. */
export function isSecretPath(path: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(path));
}

/** Files among staged+untracked that match known secret patterns. */
export async function scanForSecrets(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<string[]> {
  const { staged, untracked } = await statusPorcelain(cwd, token, authMethod);
  return [...staged, ...untracked].filter(isSecretPath);
}

/**
 * Files whose size exceeds maxSizeMb. Pass an explicit candidate list (the
 * already-known about-to-be-committed paths) to avoid a second status query;
 * without one, staged+untracked are checked as before.
 */
export async function oversizedFiles(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  maxSizeMb: number,
  candidates?: string[],
): Promise<Array<{ path: string; sizeMb: number }>> {
  let paths: string[];
  if (candidates) {
    paths = candidates;
  } else {
    const { staged, untracked } = await statusPorcelain(cwd, token, authMethod);
    paths = [...staged, ...untracked];
  }
  const found: Array<{ path: string; sizeMb: number }> = [];
  for (const path of paths) {
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

/** Create and switch to a new branch from the current HEAD. */
export async function createBranch(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
  name: string,
): Promise<string> {
  await git(["checkout", "-b", name], baseOptions(cwd, token, authMethod));
  return name;
}

/** Files currently in a conflicted (unmerged) state. */
export async function conflictedFiles(
  cwd: string,
  token: string | undefined,
  authMethod: AuthMethod,
): Promise<string[]> {
  const result = await runGit(["diff", "--name-only", "--diff-filter=U"], baseOptions(cwd, token, authMethod));
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
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
