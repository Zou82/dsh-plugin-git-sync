import { Config } from "./config.js";
import { setInsecureTls } from "./tls.js";
import { registerGitInit } from "./tools/git_init.js";
import { registerGitRename } from "./tools/git_rename.js";
import { registerGitSync } from "./tools/git_sync.js";
import { registerGitStatus } from "./tools/git_status.js";
import { registerProjectStart } from "./lifecycle/project-start.js";
import { registerTurnEndSync } from "./lifecycle/turn-end-sync.js";
import { AGENT_INSTRUCTIONS } from "./prompts/instructions.js";

/** Cordis plugin identity. */
export const name = "git-sync";

/** Services this plugin requires (verified against installed packages).
 * NOTE: `logger` is built into every Cordis context (ctx.logger) and
 * `session` events are reached via ctx.on(...), so neither is injected. */
export const inject = ["tools", "credentials", "userQuestions"];

export { Config };
export type { Config as ConfigType } from "./config.js";

/**
 * Plugin entry: register tools, lifecycle hooks, and agent instructions.
 * @param ctx Cordis context (typed structurally via Ctx)
 * @param config validated schemastery config
 */
export function apply(ctx: unknown, config: unknown): void {
  const c = ctx as Parameters<typeof registerGitInit>[0];
  const cfg = config as Config;

  setInsecureTls(cfg.github.insecureTls);
  registerGitInit(c, cfg);
  registerGitRename(c, cfg);
  registerGitSync(c, cfg);
  registerGitStatus(c, cfg);
  registerProjectStart(c, cfg);
  registerTurnEndSync(c, cfg);

  // Inject agent instructions (best-effort; TODO(verify) seam availability).
  try {
    c.agentInstructions?.register?.(AGENT_INSTRUCTIONS);
  } catch (error) {
    c.logger.warn("git-sync: agent 指令注入失败", error);
  }

  c.logger.info("git-sync: 插件已加载（GitHub 同步已启用）");
}
