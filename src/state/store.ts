import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Per-project plugin state, stored inside the workspace at
 * `<workspace>/.dsh-git-sync/state.json` (the dir is gitignored by the
 * plugin itself, so it never gets committed).
 * Keyed by the workspace absolute path (the file lives there, so the key is
 * implicit — one state file per project).
 */

export interface ProjectState {
  workspacePath: string;
  repoName?: string;
  remoteUrl?: string;
  visibility?: "private" | "public";
  initAskedAt?: string;
  initDecision?: "created" | "declined";
  pendingInit?: boolean;
  lastSyncAt?: string;
  lastSyncedCommit?: string;
}

const STATE_DIR = ".dsh-git-sync";
const STATE_FILE = "state.json";

export class ProjectStateStore {
  constructor(private readonly cwd: string) {}

  private file(): string {
    return join(this.cwd, STATE_DIR, STATE_FILE);
  }

  /** Load state; returns a fresh shell when missing or corrupt. */
  async load(): Promise<ProjectState> {
    try {
      const parsed = JSON.parse(await readFile(this.file(), "utf8")) as ProjectState;
      parsed.workspacePath = this.cwd;
      return parsed;
    } catch {
      return { workspacePath: this.cwd };
    }
  }

  /** Merge a partial patch and persist. */
  async update(patch: Partial<ProjectState>): Promise<ProjectState> {
    const next: ProjectState = { ...(await this.load()), ...patch };
    next.workspacePath = this.cwd;
    await mkdir(dirname(this.file()), { recursive: true });
    await writeFile(this.file(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  /** Remove the state directory for this project. */
  async clear(): Promise<void> {
    await rm(join(this.cwd, STATE_DIR), { recursive: true, force: true });
  }
}
