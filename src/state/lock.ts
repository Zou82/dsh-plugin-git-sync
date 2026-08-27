import type { Config } from "../config.js";

/**
 * Workspace-scoped mutex.
 *
 * Three independent paths drive git in the same workspace concurrently:
 * agent-invoked git_sync, the turn-end fallback sync, and the file watcher.
 * Without mutual exclusion their add-all → commit → pull --rebase → push
 * sequences interleave: index.lock contention, spurious "nothing to commit"
 * failures, or worse, interleaved rebase/push states. Serializing per
 * workspace path removes the whole class of races; nothing inside ever
 * re-enters, so a simple promise chain suffices (no nested acquisition →
 * no deadlock).
 */
const chains = new Map<string, Promise<unknown>>();

/** Run fn serialized per key (the absolute workspace path). */
export function withWorkspaceLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(cwd) ?? Promise.resolve();
  // The successor runs whether the predecessor resolved or rejected.
  const task = previous.then(fn, fn) as Promise<T>;
  chains.set(
    cwd,
    task.then(
      () => undefined,
      () => undefined,
    ),
  );
  return task;
}

/** Test-only helper: number of workspaces holding a chain (never a queue depth). */
export function activeLocks(): number {
  return chains.size;
}
