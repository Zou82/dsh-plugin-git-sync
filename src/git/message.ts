import type { StatusLines } from "./ops.js";

/**
 * Build a short, describing commit message from the current change set:
 * `chore: auto-sync (src/app.ts, README.md, +2 more)`.
 * Used as the deterministic fallback for turn-end and file-watcher syncs and
 * as the default when git_sync is called without an explicit message.
 */
export function describeFiles(status: StatusLines, maxFiles = 3): string {
  // A file can appear in several buckets at once (e.g. partially staged and
  // further modified); deduplicate so the summary counts real files.
  const seen = new Set<string>();
  const names = [...status.staged, ...status.unstaged, ...status.untracked].filter((name) =>
    seen.has(name) ? false : seen.add(name),
  );
  if (names.length === 0) return "chore: auto-sync";
  const shown = names.slice(0, maxFiles).map((name) => name.split(/[\\/]/).pop() ?? name);
  const extra = names.length > maxFiles ? `, +${names.length - maxFiles} more` : "";
  return `chore: auto-sync (${shown.join(", ")}${extra})`;
}

/** A conventional-commit style default for agent-provided messages. */
export function conventionalHint(): string {
  return "Use Conventional Commits: `feat(scope): summary` / `fix(scope): summary` / `chore(scope): summary`.";
}