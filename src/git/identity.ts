import type { Config } from "../config.js";

/** Commit identity used when the machine has none configured globally. */
export interface CommitIdentity {
  name: string;
  email: string;
}

/**
 * Resolve the commit identity: explicit config wins, then the GitHub owner,
 * then a neutral fallback. The plugin only ever sets this repo-locally.
 */
export function resolveIdentity(
  config: Config,
  owner: string | undefined,
): CommitIdentity {
  const name = config.git.committerName.trim() || owner?.trim() || "dsh-agent";
  const email =
    config.git.committerEmail.trim() ||
    (owner?.trim() ? `${owner.trim()}@users.noreply.github.com` : "dsh-agent@users.noreply.github.com");
  return { name, email };
}
