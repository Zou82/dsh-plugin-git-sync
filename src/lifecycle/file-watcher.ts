import { watch, type FSWatcher } from "node:fs";
import { resolveToken } from "../github/token.js";
import {
  addAll,
  commit,
  currentBranch,
  hasRepo,
  pullRebase,
  push,
  revParseHead,
  scanForSecrets,
  statusPorcelain,
} from "../git/ops.js";
import { resolveIdentity } from "../git/identity.js";
import { ProjectStateStore } from "../state/store.js";
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
 *  - secret scans still apply before any commit
 *
 * Recursive fs.watch is supported on Windows/macOS; on platforms without it
 * the watcher degrades to top-level events (fallback documented in README).
 */
const watchers = new Map<string, FSWatcher>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

const IGNORED_SEGMENTS = new Set([".git", ".dsh-git-sync", "node_modules"]);

function shouldIgnore(relative: string): boolean {
  return relative.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment));
}

export function registerFileWatcher(ctx: Ctx): void {
  ctx.on("session/created", (payload: unknown) => {
    const cwd = sessionWorkspaceCwd(payload);
    if (!cwd) return;
    if (watchers.has(cwd)) return; // already watching this workspace

    try {
      const watcher = watch(cwd, { recursive: true }, (_eventType, filename) => {
        const name = filename?.toString() ?? "";
        if (shouldIgnore(name)) return;
        scheduleSync(ctx, cwd);
      });
      watchers.set(cwd, watcher);
      ctx.logger.info("git-sync: 已开始监听工作区文件变化（%s）", cwd);
    } catch (error) {
      // e.g. ENOENT (dir not ready) or unsupported recursive watch on Linux
      ctx.logger.warn("git-sync: 文件监听启动失败（%s）", cwd, error);
    }
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

async function runSync(ctx: Ctx, cwd: string): Promise<void> {
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
    const changed =
      status.staged.length + status.unstaged.length + status.untracked.length;
    if (changed === 0) return;

    if (config.safety.scanForSecrets) {
      const secrets = await scanForSecrets(cwd, token, config.auth.method);
      if (secrets.length > 0) {
        ctx.logger.warn(
          "git-sync: 文件监听检测到敏感文件，已跳过自动提交：%s",
          secrets.join("、"),
        );
        return;
      }
    }

    await addAll(cwd, token, config.auth.method);
    const hash = await commit(
      cwd,
      token,
      config.auth.method,
      "chore: auto-sync",
      resolveIdentity(config, config.github.username || undefined),
    );
    await pullRebase(cwd, token, config.auth.method);
    const branch = await currentBranch(cwd, token, config.auth.method);
    await push(cwd, token, config.auth.method, branch);
    await state.update({ lastSyncAt: new Date().toISOString(), lastSyncedCommit: hash });
    ctx.logger.info("git-sync: 文件变化已自动同步（%s 个变更）", changed);
  } catch (error) {
    ctx.logger.warn("git-sync: 文件监听自动同步失败", error);
  }
}
