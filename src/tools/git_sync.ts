import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveToken } from "../github/token.js";
import {
  addAll,
  addPaths,
  commit,
  conflictedFiles,
  createBranch,
  currentBranch,
  hasRepo,
  isSecretPath,
  oversizedFiles,
  pullRebase,
  push,
  revParseHead,
  statusPorcelain,
} from "../git/ops.js";
import { GitError } from "../git/runner.js";
import { ProjectStateStore } from "../state/store.js";
import { withWorkspaceLock } from "../state/lock.js";
import { getRuntimeConfig } from "../state/config-runtime.js";
import type { Config } from "../config.js";
import { resolveIdentity } from "../git/identity.js";
import { describeFiles } from "../git/message.js";
import { askUser, resolveWorkspaceCwd, type Ctx, type ToolExec } from "../types.js";

/**
 * git_sync — commit and push the current changes.
 * The agent calls this after each round of code changes; the turn-end hook
 * (lifecycle/turn-end-sync) is the safety net when the agent misses it.
 *
 * The whole flow runs under the workspace lock: concurrent auto-syncs or a
 * simultaneous file-watcher run must not interleave with this sequence.
 */
export function registerGitSync(ctx: Ctx): void {
  ctx.tools.register(
    defineTool({
      name: "git_sync",
      description:
        "提交并推送当前代码变更到 GitHub 仓库（先 pull --rebase 处理远端差异，冲突时停下交用户，绝不强制推送）。提交信息建议遵循 Conventional Commits（feat/fix/chore(scope): summary）。每完成一轮代码修改后都应调用本工具。",
      parameters: {
        commit_message: {
          type: "string",
          description: "提交信息；缺省时按变更内容生成",
        },
        mode: {
          type: "string",
          enum: ["commit_push", "commit_only", "push_only"],
          description: "commit_push=提交并推送（缺省）；commit_only=仅提交；push_only=仅推送已有提交",
        },
        include: {
          type: "array",
          items: { type: "string" },
          description: "仅提交指定路径（缺省全部）。支持目录前缀（含子目录）与裸文件名匹配",
        },
        create_branch: {
          type: "string",
          description: "基于当前 HEAD 创建新分支并切换（任务分支），然后照常提交推送",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["ok", "nothing_to_do", "conflict", "error"] },
            commits: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  hash: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
            files_changed: { type: "number" },
            pushed: { type: "boolean" },
            needs_user_action: { type: "string" },
            reason: { type: "string" },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args: any, exec: any): Promise<any> {
        const config = getRuntimeConfig();
        const cwd = resolveWorkspaceCwd(args.cwd, exec);
        return withWorkspaceLock(cwd, () => runGitSync(ctx, args, exec as ToolExec, config, cwd));
      },
    }),
  );
}

/** Normalize the include parameter: unique trimmed string specs; [] = unscoped. */
function normalizeInclude(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const specs: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !specs.includes(trimmed)) specs.push(trimmed);
  }
  return specs;
}

/**
 * Whether a repository-relative status path falls inside the given include
 * specs. Matching rules: exact path, directory prefix (spec + "/"), or — for
 * a bare filename spec without "/" — basename equality at any depth.
 */
function pathMatchesInclude(path: string, specs: string[]): boolean {
  const norm = path.replace(/\\/g, "/");
  return specs.some((specRaw) => {
    const spec = specRaw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!spec) return false;
    if (norm === spec || norm.startsWith(`${spec}/`)) return true;
    if (!spec.includes("/")) return norm.split("/").pop() === spec;
    return false;
  });
}

async function runGitSync(
  ctx: Ctx,
  args: any,
  exec: ToolExec,
  config: Config,
  cwd: string,
): Promise<Record<string, unknown>> {
  const state = new ProjectStateStore(cwd);

  if (!(await hasRepo(cwd))) {
    return {
      status: "error",
      reason: "工作区不是 git 仓库：请先调用 git_init 建仓",
    };
  }

  const token = await resolveToken(ctx);
  if (!token) {
    return {
      status: "error",
      reason: "未配置 GitHub 令牌：请先配置 GITHUB_TOKEN（仅本地 commit 可继续）",
    };
  }

  const mode = args.mode ?? "commit_push";
  const status = await statusPorcelain(cwd, token, config.auth.method);
  const allPaths = [...status.staged, ...status.unstaged, ...status.untracked];

  // ---- optional task branch (Y4) ----
  if (args.create_branch && typeof args.create_branch === "string") {
    try {
      await createBranch(cwd, token, config.auth.method, args.create_branch);
    } catch (error) {
      return {
        status: "error",
        reason: `创建分支失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ---- scope to the include parameter when provided ----
  const specs = normalizeInclude(args.include);
  const scoped = specs.length > 0;
  // Without include, everything about-to-be-committed participates. With it,
  // only matching paths do (secret/size checks and files_changed follow suit).
  const targets = scoped ? allPaths.filter((path) => pathMatchesInclude(path, specs)) : allPaths;
  const changed = targets.length;

  // ---- commit phase ----
  if (mode !== "push_only") {
    if (allPaths.length === 0) {
      if (mode === "commit_push") {
        // nothing to commit — still try to push pending commits
        return pushPending(ctx, cwd, token, config, state, 0);
      }
      return { status: "nothing_to_do", files_changed: 0, pushed: false };
    }
    if (scoped && changed === 0) {
      return {
        status: "nothing_to_do",
        files_changed: 0,
        pushed: false,
        reason: `指定的 include 路径没有匹配到任何未提交变更：${specs.join("、")}`,
      };
    }

    // safety scans (restricted to the included paths when scoped)
    if (config.safety.scanForSecrets) {
      const candidates =
        scoped
          ? [...status.staged, ...status.untracked].filter((path) =>
              pathMatchesInclude(path, specs),
            )
          : [...status.staged, ...status.untracked];
      const secrets = candidates.filter(isSecretPath);
      if (secrets.length > 0) {
        return {
          status: "error",
          reason:
            `检测到疑似敏感文件，已阻止提交：${secrets.join("、")}。` +
            `请将这些文件加入 .gitignore 或调整 safety.scanForSecrets 配置后重试`,
        };
      }
    }
    const oversized = await oversizedFiles(
      cwd,
      token,
      config.auth.method,
      config.safety.maxFileSizeMb,
      targets,
    );
    if (oversized.length > 0) {
      const names = oversized
        .map((entry) => `${entry.path} (${entry.sizeMb}MB)`)
        .join("、");
      const answer = await askUser(ctx, exec, {
        id: "git-sync-oversized",
        header: "大文件告警",
        question: `以下文件超过 ${config.safety.maxFileSizeMb}MB（GitHub 单文件上限 100MB），仍要提交吗？\n${names}`,
        options: [
          { label: "仍要提交" },
          { label: "取消提交", description: "先处理这些文件再同步" },
        ],
      });
      if ((answer.selected[0] ?? "").includes("取消")) {
        return { status: "error", reason: "用户取消提交（存在大文件）" };
      }
    }

    const message = args.commit_message?.trim() || describeFiles(status);
    if (scoped) {
      await addPaths(cwd, token, config.auth.method, specs);
    } else {
      await addAll(cwd, token, config.auth.method);
    }
    const hash = await commit(
      cwd,
      token,
      config.auth.method,
      message,
      resolveIdentity(config, config.github.username || undefined),
    );

    if (mode === "commit_only") {
      await state.update({ lastSyncAt: new Date().toISOString(), lastSyncedCommit: hash });
      return {
        status: "ok",
        commits: [{ hash, message }],
        files_changed: changed,
        pushed: false,
      };
    }
    return pushPending(ctx, cwd, token, config, state, changed, [{ hash, message }]);
  }

  // ---- push_only ----
  return pushPending(ctx, cwd, token, config, state, changed);
}

/** pull --rebase then push; classifies conflicts and other failures. */
async function pushPending(
  _ctx: Ctx,
  cwd: string,
  token: string,
  config: ReturnType<typeof getRuntimeConfig>,
  state: ProjectStateStore,
  changed: number,
  commits: Array<{ hash: string; message: string }> = [],
): Promise<Record<string, unknown>> {
  try {
    await pullRebase(cwd, token, config.auth.method);
  } catch (error) {
    if (error instanceof GitError && error.conflict) {
      // Y3: list the conflicted files and give concrete recovery steps
      const files = await conflictedFiles(cwd, token, config.auth.method).catch(() => []);
      const fileList = files.length > 0 ? ` 冲突文件：${files.join("、")}` : "";
      return {
        status: "conflict",
        pushed: false,
        reason: "远端与本地存在冲突，已停下。请解决冲突后重新调用 git_sync",
        needs_user_action:
          `解决冲突后：git add <文件> → git rebase --continue，或放弃本次改动。${fileList}`,
      };
    }
    return {
      status: "error",
      pushed: false,
      reason: `同步远端失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const branch = await currentBranch(cwd, token, config.auth.method);
    await push(cwd, token, config.auth.method, branch, true); // -u: safe for both new and tracked branches
    const head = await revParseHead(cwd, token, config.auth.method);
    await state.update({ lastSyncAt: new Date().toISOString(), lastSyncedCommit: head });
    return { status: "ok", commits, files_changed: changed, pushed: true };
  } catch (error) {
    if (error instanceof GitError) {
      const stderr = error.stderr;
      if (/Repository not found|remote: Repository not found/i.test(stderr)) {
        return {
          status: "error",
          pushed: false,
          reason:
            "远端仓库不存在（可能已在 GitHub 上被删除），请确认是否需要用当前内容重建仓库",
          needs_user_action: "可调用 git_init 重新建仓，或检查 GitHub 上的仓库状态",
        };
      }
      if (/Authentication failed|401|403|Invalid authentication/i.test(stderr)) {
        return {
          status: "error",
          pushed: false,
          reason: "推送被拒绝：GitHub 令牌失效或权限不足，请重新配置 GITHUB_TOKEN",
          needs_user_action: "在设置中更新 GITHUB_TOKEN（需 Contents 写权限）",
        };
      }
      return {
        status: "error",
        pushed: false,
        reason: `推送失败: ${stderr.trim() || error.message}`,
      };
    }
    return {
      status: "error",
      pushed: false,
      reason: `推送失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
