import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveToken } from "../github/token.js";
import {
  addAll,
  commit,
  currentBranch,
  hasRepo,
  oversizedFiles,
  pullRebase,
  push,
  revParseHead,
  scanForSecrets,
  statusPorcelain,
} from "../git/ops.js";
import { GitError } from "../git/runner.js";
import { ProjectStateStore } from "../state/store.js";
import { getRuntimeConfig } from "../state/config-runtime.js";
import { resolveIdentity } from "../git/identity.js";
import { askUser, resolveWorkspaceCwd, type Ctx } from "../types.js";

/**
 * git_sync — commit and push the current changes.
 * The agent calls this after each round of code changes; the turn-end hook
 * (lifecycle/turn-end-sync) is the safety net when the agent misses it.
 */
export function registerGitSync(ctx: Ctx): void {
  ctx.tools.register(
    defineTool({
      name: "git_sync",
      description:
        "提交并推送当前代码变更到 GitHub 仓库（先 pull --rebase 处理远端差异，冲突时停下交用户，绝不强制推送）。每完成一轮代码修改后都应调用本工具。",
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
          description: "仅提交指定路径（缺省全部）",
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
        const changed =
          status.staged.length + status.unstaged.length + status.untracked.length;

        // ---- commit phase ----
        if (mode !== "push_only") {
          if (changed === 0) {
            if (mode === "commit_push") {
              // nothing to commit — still try to push pending commits
              return pushPending(ctx, cwd, token, config, state, 0);
            }
            return { status: "nothing_to_do", files_changed: 0, pushed: false };
          }

          // safety scans
          if (config.safety.scanForSecrets) {
            const secrets = await scanForSecrets(cwd, token, config.auth.method);
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

          const message =
            args.commit_message?.trim() || `chore: sync ${new Date().toISOString()}`;
          await addAll(cwd, token, config.auth.method);
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
      },
    }),
  );
}

/** pull --rebase then push; classifies conflicts and other failures. */
async function pushPending(
  ctx: Ctx,
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
      return {
        status: "conflict",
        pushed: false,
        reason: "远端与本地存在冲突，已停下。请解决冲突后重新调用 git_sync",
        needs_user_action: error.stderr.trim() || "请查看冲突文件并解决后重试",
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
    await push(cwd, token, config.auth.method, branch);
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
