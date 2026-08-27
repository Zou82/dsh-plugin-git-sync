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
import { ProjectStateStore } from "../state/store.js";
import { withWorkspaceLock } from "../state/lock.js";
import { resolveIdentity } from "../git/identity.js";
import { describeFiles } from "../git/message.js";
import { askUser, sessionWorkspaceCwd, type Ctx } from "../types.js";
import { getRuntimeConfig } from "../state/config-runtime.js";

/**
 * Turn-end fallback sync: after each agent turn, if the workspace is a
 * plugin-managed repo with uncommitted changes, commit + push automatically
 * (config.autoSync: true), or ask first (config.autoSync: "ask").
 * This is the safety net for the agent forgetting to call git_sync.
 *
 * Like the file watcher, the flow holds the workspace lock so it can never
 * interleave with a concurrent git_sync or debounce sync, and a conflicted
 * pull aborts cleanly instead of wedging the repo mid-rebase.
 *
 * NOTE: the `session/event` hook receives TWO arguments (session, event) —
 * not a single array payload. TODO(verify): how to obtain the session's
 * workspace path.
 */
export function registerTurnEndSync(ctx: Ctx): void {
  ctx.on("session/event", (session: unknown, event: unknown) => {
    if ((event as { type?: string } | null)?.type !== "turn/end") return;

    void runTurnEndSync(ctx, session);
  });
}

function runTurnEndSync(ctx: Ctx, session: unknown): Promise<void> {
  return withWorkspaceLock(
    sessionWorkspaceCwd(session) ?? "",
    async () => {
      try {
        const config = getRuntimeConfig();
        if (config.autoSync === false) return;
        const cwd = sessionWorkspaceCwd(session);
        if (!cwd) return;
        if (!(await hasRepo(cwd))) return;

        const state = new ProjectStateStore(cwd);
        const current = await state.load();
        if (current.initDecision !== "created") return; // only sync plugin-managed repos

        const token = await resolveToken(ctx);
        if (!token) return; // no credentials — skip silently

        const status = await statusPorcelain(cwd, token, config.auth.method);
        const paths = [...status.staged, ...status.unstaged, ...status.untracked];
        if (paths.length === 0) return;

        if (config.autoSync === "ask") {
          const answer = await askUser(ctx, { agent: undefined }, {
            id: "git-sync-turn-end",
            header: "自动同步",
            question: `发现 ${paths.length} 个未提交的变更，是否上传到 GitHub？`,
            options: [
              { label: "上传", description: "提交并推送所有变更" },
              { label: "暂不", description: "本次不自动上传" },
            ],
          });
          if ((answer.selected[0] ?? "").includes("暂不")) return;
        }

        if (config.safety.scanForSecrets) {
          const secrets = [...status.staged, ...status.untracked].filter(isSecretPath);
          if (secrets.length > 0) {
            ctx.logger.warn(
              "git-sync: 回合结束同步检测到敏感文件，已跳过自动提交：%s",
              secrets.join("、"),
            );
            return;
          }
        }
        // Same large-file guard as the file watcher: without it an oversized
        // artifact would be committed and then fail to push forever.
        const oversized = await oversizedFiles(
          cwd,
          token,
          config.auth.method,
          config.safety.maxFileSizeMb,
          paths,
        );
        if (oversized.length > 0) {
          ctx.logger.warn(
            "git-sync: 回合结束同步检测到超过 %dMB 的文件，已跳过自动提交：%s",
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
          describeFiles(status),
          resolveIdentity(config, config.github.username || undefined),
        );
        try {
          await pullRebase(cwd, token, config.auth.method);
        } catch (error) {
          if (error instanceof GitError && error.conflict) {
            const aborted = await abortRebaseSafe(cwd, token, config.auth.method);
            ctx.logger.warn(
              "git-sync: 回合结束自动同步遇到远端冲突，已%s。请手动调用 git_sync 处理与远端的分歧",
              aborted ? "中止 rebase 并恢复本地改动" : "尝试恢复本地状态",
            );
            return;
          }
          throw error;
        }
        const branch = await currentBranch(cwd, token, config.auth.method);
        await push(cwd, token, config.auth.method, branch, true); // -u: covers branches pushed for the first time here
        await state.update({ lastSyncAt: new Date().toISOString(), lastSyncedCommit: hash });
        ctx.logger.info("git-sync: 回合结束自动同步完成（%s 个变更）", paths.length);
      } catch (error) {
        // never break the agent loop because of a background sync failure
        ctx.logger.warn("git-sync: 回合结束自动同步失败", error);
      }
    },
  );
}
