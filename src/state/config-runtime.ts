import type { Config } from "../config.js";

/**
 * Live runtime config: the effective config is the settings namespace
 * "git-sync" resolved over the loader-composed base. The settings scope
 * publishes changes live (GUI edits take effect without restart), and tools
 * read through this holder at call time instead of capturing a stale copy.
 */
let current: Config | undefined;

export function setRuntimeConfig(cfg: Config): void {
  current = cfg;
}

export function getRuntimeConfig(): Config {
  if (current === undefined) {
    throw new Error("git-sync: runtime config is not initialized");
  }
  return current;
}
