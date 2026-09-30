import { Config } from "./config.js";
import { setInsecureTls } from "./tls.js";
import { setRuntimeConfig } from "./state/config-runtime.js";
import { registerGitInit } from "./tools/git_init.js";
import { registerGitRename } from "./tools/git_rename.js";
import { registerGitSync } from "./tools/git_sync.js";
import { registerGitStatus } from "./tools/git_status.js";
import { registerProjectStart } from "./lifecycle/project-start.js";
import { registerTurnEndSync } from "./lifecycle/turn-end-sync.js";
import { registerFileWatcher } from "./lifecycle/file-watcher.js";
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
 * 2.0.5 hardening: the web profile's patch layer is live-reloaded, so this
 * `apply` can run again on a fiber whose previous settings registration has
 * not been torn down yet. `settings.register` throws on a duplicate
 * namespace, which would fail the whole entry (and the boot). Every
 * registration below is therefore fault-tolerant: a duplicate registration
 * falls back to the loader-composed config instead of throwing.
 *
 * @param ctx Cordis context (typed structurally via Ctx)
 * @param config validated schemastery config (loader composition layer)
 */
export function apply(ctx: Ctx, config: Config): void {
  // Live config, two composition eras:
  //  * a settings service exposing register() (0.1.x, or a tree patched to keep
  //    the legacy seam): the user layer lives in the settings document and
  //    hot-updates through watch();
  //  * 0.2.x SettingsForms: register() no longer exists. The entry's Config
  //    schema is what the Settings UI renders, an edit lands in the profile
  //    patch, and the live loader re-applies this entry — so the composed
  //    `config` argument is already the effective configuration.
  const register = ctx.settings?.register;
  if (typeof register === "function") {
    try {
      const scope = ctx.settings!.register!("git-sync", Config, { base: config });
      const refresh = () => {
        const resolved = scope.get() as Config;
        setRuntimeConfig(resolved);
        setInsecureTls(resolved.github.insecureTls);
      };
      refresh();
      scope.watch(() => refresh());
    } catch (error) {
      ctx.logger.warn(
        "git-sync: settings 命名空间注册失败（热重载重复注册？），使用组合层配置",
        error,
      );
      setRuntimeConfig(config);
      setInsecureTls(config.github.insecureTls);
    }
  } else {
    // 0.2.x: composed config is the effective config; the Settings UI writes the
    // profile patch and the live loader re-runs apply() with the new value.
    setRuntimeConfig(config);
    setInsecureTls(config.github.insecureTls);
  }

  // Each registration below is individually guarded so a single failure can
  // never take down the whole loader tree.
  const guarded = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      ctx.logger.warn(`git-sync: ${label} 注册失败（已跳过，不影响启动）`, error);
    }
  };
  guarded("git_init", () => registerGitInit(ctx));
  guarded("git_rename", () => registerGitRename(ctx));
  guarded("git_sync", () => registerGitSync(ctx));
  guarded("git_status", () => registerGitStatus(ctx));
  guarded("project-start", () => registerProjectStart(ctx));
  guarded("turn-end", () => registerTurnEndSync(ctx));
  guarded("file-watcher", () => registerFileWatcher(ctx));

  // Inject agent instructions (best-effort; TODO(verify) seam availability).
  try {
    ctx.agentInstructions?.register?.(AGENT_INSTRUCTIONS);
  } catch (error) {
    ctx.logger.warn("git-sync: agent 指令注入失败", error);
  }

  ctx.logger.info("git-sync: 插件已加载（GitHub 同步已启用）");
}
