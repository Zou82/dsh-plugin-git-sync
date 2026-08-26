import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { hasRepoSync } from "../git/ops.js";
import { ProjectStateStore } from "../state/store.js";
import { sessionWorkspaceCwd, type Ctx } from "../types.js";

/**
 * Mark "pending init" when a session starts in an empty, repo-less directory.
 * Best-effort advisory: the real ask happens in git_init (agent-driven),
 * guided by the injected instructions.
 */
export function registerProjectStart(ctx: Ctx): void {
  ctx.on("session/created", (payload: unknown) => {
    try {
      const cwd = sessionWorkspaceCwd(payload);
      if (!cwd) return;
      if (hasRepoSync(cwd)) return;

      void (async () => {
        try {
          const entries = await readdir(cwd);
          const meaningful = entries.filter(
            (entry) => entry !== ".git" && !entry.startsWith(".dsh-git-sync"),
          );
          if (meaningful.length === 0) {
            const state = new ProjectStateStore(cwd);
            const current = await state.load();
            if (current.initDecision === "declined") return;
            await state.update({
              pendingInit: true,
              initAskedAt: current.initAskedAt ?? new Date().toISOString(),
            });
            ctx.logger.info(
              "git-sync: 检测到空工作区（%s），已标记「待询问建仓」；agent 将在创建文件前调用 git_init",
              cwd,
            );
          }
        } catch {
          // directory may not exist yet — ignore
        }
      })();
    } catch (error) {
      ctx.logger.warn("git-sync: project-start marker 失败", error);
    }
  });
}
