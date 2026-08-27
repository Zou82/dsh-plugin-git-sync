import { watch, type FSWatcher } from "node:fs";
import { resolveToken } from "../github/token.js";
import {
  abortRebaseSafe,
  addAll,
  commit,
  currentBranch,
  hasRepo,
  isSecretPath,
  oversizedFiles,
  pullRebase,
  push,
  statusPorcelain,
} from "../git/ops.js";
import { GitError } from "../git/runner.js";
import { resolveIdentity } from "../git/identity.js";
import { describeFiles } from "../git/message.js";
import { ProjectStateStore } from "../state/store.js";
import { withWorkspaceLock } from "../state/lock.js";
import { getRuntimeConfig } from "../state/config-runtime.js";
import { sessionWorkspaceCwd, type Ctx } from "../types.js";

/**
 * File watcher: when the session workspace's files change (a save, an edit),
 * commit + push after a short debounce — so "every content change is synced"
 * holds at file level, not only at agent turn end.
 *
 * Guards:
 *  - only plugin-managed repos (created via git_init) are touched
 *  - only when autoSync === true
 *  - .git / .dsh-git-sync / node_modules changes are ignored (no self-loops)
 *  - secret scans and large-file guards still apply before any commit
 *  - syncs are serialized through the workspace lock so they never interleave
 *    with git_sync or turn-end flows
 *  - everything is torn down when the plugin is disposed
 *
 * Recursive fs.watch is supported on Windows/macOS; on platforms without it
 * the watcher degrades to top-level events / polling fallback.
 */
const watchers = new Map<string, FSWatcher>();
const pollers = new Map<string, ReturnType<typeof setInterval>>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

const ALWAYS_IGNORED = new Set([".git", ".dsh-git-sync", "node_modules"]);

function shouldIgnore(relative: string): boolean {
  const segments = relative.split(/[\\/]/);
  if (segments.some((segment) => ALWAYS_IGNORED.has(segment))) return true;
  // Y1: user-configured ignore segments (dist/, build/, __pycache__, ...)
  const extra = getRuntimeConfig().fileWatcher.ignore ?? [];
  return segments.some((segment) => extra.includes(segment));
}

function isWatching(cwd: string): boolean {
  return watchers.has(cwd) || pollers.has(cwd);
}

/** Close every handle this module created (plugin dispose / host reload). */
export function stopAllWatchers(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  for (const watcher of watchers.values()) {
    try {
      watcher.close();
    } catch {
      // already closed
    }
  }
  watchers.clear();
  for (const poller of pollers.values()) clearInterval(poller);
  pollers.clear();
}

export function registerFileWatcher(ctx: Ctx): void {
  ctx.on("session/created", (payload: unknown) => {
    const cwd = sessionWorkspaceCwd(payload);
    if (!cwd) return;
    if (isWatching(cwd)) return; // already watching this workspace

    try {
      const watcher = watch(cwd, { recursive: true }, (_eventType, filename) => {
        const name = filename?.toString() ?? "";
        if (shouldIgnore(name)) return;
        scheduleSync(ctx, cwd);
      });
      watchers.set(cwd, watcher);
      ctx.logger.info("git-sync: 已开始监听工作区文件变化（%s）", cwd);
    } catch (error) {
      // Y2: fs.watch unavailable (Linux non-recursive, ENOENT, ...) — fall back
      // to a lightweight poll of `git status` (never scans file contents).
      ctx.logger.warn("git-sync: 文件监听不可用，改用轮询回退（%s）", cwd, error);
      const pollMs = getRuntimeConfig().fileWatcher.pollMs;
      const poll = () => {
        void (async () => {
          try {
            const config = getRuntimeConfig();
            if (!config.fileWatcher.enabled || config.autoSync !== true) return;
            if (!(await hasRepo(cwd))) return;
            const token = await resolveToken(ctx);
            if (!token) return;
            const status = await statusPorcelain(cwd, token, config.auth.method);
            const changed =
              status.staged.length + status.unstaged.length + status.untracked.length;
            if (changed > 0) scheduleSync(ctx, cwd);
          } catch {
            // transient — next tick retries
          }
        })();
      };
      pollers.set(cwd, setInterval(poll, pollMs));
    }
  });

  // Cordis disposes plugins on unload/reload; without this the fs.watch
  // handles, debounce timers and poll intervals would survive the plugin.
  ctx.on("dispose" as string, () => {
    if (watchers.size > 0 || pollers.size > 0 || pending.size > 0) {
      ctx.logger.info("git-sync: 已停止 %d 个文件监听与 %d 个轮询回退", watchers.size, pollers.size);
    }
    stopAllWatchers();
  });
}

function scheduleSync(ctx: Ctx, cwd: string): void {
  const existing = pending.get(cwd);
  if (existing !== undefined) clearTimeout(existing);
  const debounceMs = getRuntimeConfig().fileWatcher.debounceMs;
  const timer = setTimeout(() => {
    pending.delete(cwd);
    void runSync(ctx, cwd);
  }, debounceMs);
  pending.set(cwd, timer);
}

/** Debounced sync entry: serialized under the workspace lock. */
function runSync(ctx: Ctx, cwd: string): Promise<void> {
  // performSync never rejects (single catch boundary below); this guard is
  // belt-and-braces so `void runSync(...)` can never leak a rejection.
  return withWorkspaceLock(cwd, () => performSync(ctx, cwd)).catch((error) => {
    ctx.logger.warn("git-sync: 文件监听自动同步失败", error);
  });
}

/** Lock-held body of the debounce sync. */
async function performSync(ctx: Ctx, cwd: string): Promise<void> {
  try {
    const config = getRuntimeConfig();
    if (!config.fileWatcher.enabled || config.autoSync !== true) return;
    if (!(await hasRepo(cwd))) return;

    const state = new ProjectStateStore(cwd);
    const current = await state.load();
    if (current.initDecision !== "created") return; // only plugin-managed repos

    const token = await resolveToken(ctx);
    if (!token) return;

    const status = await statusPorcelain(cwd, token, config.auth.method);
    const paths = [...status.staged, ...status.unstaged, ...status.untracked];
    if (paths.length === 0) return;

    if (config.safety.scanForSecrets) {
      const secrets = [...status.staged, ...status.untracked].filter(isSecretPath);
      if (secrets.length > 0) {
        ctx.logger.warn(
          "git-sync: 文件监听检测到敏感文件，已跳过自动提交：%s",
          secrets.join("、"),
        );
        return;
      }
    }

    const oversized = await oversizedFiles(
      cwd,
      token,
      config.auth.method,
      config.safety.maxFileSizeMb,
      paths,
    );
    if (oversized.length > 0) {
      ctx.logger.warn(
        "git-sync: 文件监听检测到超过 %dMB 的文件，已跳过自动提交：%s",
        config.safety.maxFileSizeMb,
        oversized.map((entry) => `${entry.path} (${entry.sizeMb}MB)`).join("、"),
      );
      return;
    }

    await addAll(cwd, token, config.auth.method);
    const hash = await commit(
      cwd,
      token,
      config.auth.method,
      describeFiles(status), // R2: descriptive message with file summary
      resolveIdentity(config, config.github.username || undefined),
    );
    try {
      await pullRebase(cwd, token, config.auth.method);
    } catch (error) {
      // A conflicted pull leaves the repo mid-rebase; every later sync would
      // fail until a human notices. Abort restores HEAD and reapplies the
      // autostash, returning the workspace to its pre-pull state.
      if (error instanceof GitError && error.conflict) {
        const aborted = await abortRebaseSafe(cwd, token, config.auth.method);
        ctx.logger.warn(
          "git-sync: 自动同步遇到远端冲突，已%s。请手动调用 git_sync 处理与远端的分歧",
          aborted ? "中止 rebase 并恢复本地改动" : "尝试恢复本地状态",
        );
        return;
      }
      throw error;
    }
    const branch = await currentBranch(cwd, token, config.auth.method);
    await push(cwd, token, config.auth.method, branch, true); // -u: works even without a configured upstream
    await state.update({ lastSyncAt: new Date().toISOString(), lastSyncedCommit: hash });
    ctx.logger.info("git-sync: 文件变化已自动同步（%s 个变更）", paths.length);
  } catch (error) {
    ctx.logger.warn("git-sync: 文件监听自动同步失败", error);
  }
}
