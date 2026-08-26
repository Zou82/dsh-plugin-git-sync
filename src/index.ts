import { Config } from "./config.js";
import { setInsecureTls } from "./tls.js";
import { setRuntimeConfig } from "./state/config-runtime.js";
import { registerGitInit } from "./tools/git_init.js";
import { registerGitRename } from "./tools/git_rename.js";
import { registerGitSync } from "./tools/git_sync.js";
import { registerGitStatus } from "./tools/git_status.js";
import { registerProjectStart } from "./lifecycle/project-start.js";
import { registerTurnEndSync } from "./lifecycle/turn-end-sync.js";
import { AGENT_INSTRUCTIONS } from "./prompts/instructions.js";
import type { Ctx } from "./types.js";

/** Cordis plugin identity. */
export const name = "git-sync";

/** Services this plugin requires (verified against installed packages).
 * NOTE: `logger` is built into every Cordis context (ctx.logger) and
 * `session` events are reached via ctx.on(...), so neither is injected.
 * `settings` registers the user-editable "git-sync" namespace (GUI card). */
export const inject = ["tools", "credentials", "userQuestions", "settings"];

export { Config };
export type { Config as ConfigType } from "./config.js";

/**
 * Plugin entry: register tools, lifecycle hooks, the settings namespace, and
 * agent instructions.
 *
 * Effective config = settings namespace "git-sync" (user layer, GUI-editable)
 * resolved over the loader-composed base (patch/cordis.yml config). Changes
 * published by the settings service apply live via the runtime-config holder.
 *
 * @param ctx Cordis context (typed structurally via Ctx)
 * @param config validated schemastery config (loader composition layer)
 */
export function apply(ctx: Ctx, config: Config): void {
  // Register the user-editable settings namespace; GUI edits take effect live.
  const scope = ctx.settings.register("git-sync", Config, { base: config });
  const refresh = () => {
    const resolved = scope.get() as Config;
    setRuntimeConfig(resolved);
    setInsecureTls(resolved.github.insecureTls);
  };
  refresh();
  scope.watch(() => refresh());

  registerGitInit(ctx);
  registerGitRename(ctx);
  registerGitSync(ctx);
  registerGitStatus(ctx);
  registerProjectStart(ctx);
  registerTurnEndSync(ctx);

  // Inject agent instructions (best-effort; TODO(verify) seam availability).
  try {
    ctx.agentInstructions?.register?.(AGENT_INSTRUCTIONS);
  } catch (error) {
    ctx.logger.warn("git-sync: agent 指令注入失败", error);
  }

  ctx.logger.info("git-sync: 插件已加载（GitHub 同步已启用）");
}
