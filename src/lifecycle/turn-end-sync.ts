import { resolveToken } from "../github/token.js";
import {
  addAll,
  commit,
  currentBranch,
  hasRepo,
  pullRebase,
  push,
  revParseHead,
  statusPorcelain,
} from "../git/ops.js";
import { ProjectStateStore } from "../state/store.js";
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
 * NOTE: the `session/event` hook receives TWO arguments (session, event) —
 * not a single array payload. TODO(verify): how to obtain the session's
 * workspace path.
 */
export function registerTurnEndSync(ctx: Ctx): void {
  ctx.on("session/event", (session: unknown, event: unknown) => {
    if ((event as { type?: string } | null)?.type !== "turn/end") return;

    void (async () => {
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
        const changed =
          status.staged.length + status.unstaged.length + status.untracked.length;
        if (changed === 0) return;

        if (config.autoSync === "ask") {
          const answer = await askUser(ctx, { agent: undefined }, {
            id: "git-sync-turn-end",
            header: "自动同步",
            question: `发现 ${changed} 个未提交的变更，是否上传到 GitHub？`,
            options: [
              { label: "上传", description: "提交并推送所有变更" },
              { label: "暂不", description: "本次不自动上传" },
            ],
          });
          if ((answer.selected[0] ?? "").includes("暂不")) return;
        }

        await addAll(cwd, token, config.auth.method);
        const hash = await commit(
          cwd,
          token,
          config.auth.method,
          describeFiles(status),
          resolveIdentity(config, config.github.username || undefined),
        );
        await pullRebase(cwd, token, config.auth.method);
        const branch = await currentBranch(cwd, token, config.auth.method);
        await push(cwd, token, config.auth.method, branch);
        await state.update({ lastSyncAt: new Date().toISOString(), lastSyncedCommit: hash });
        ctx.logger.info("git-sync: 回合结束自动同步完成（%s 个变更）", changed);
      } catch (error) {
        // never break the agent loop because of a background sync failure
        ctx.logger.warn("git-sync: 回合结束自动同步失败", error);
      }
    })();
  });
}
