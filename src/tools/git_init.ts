import { defineTool } from "@deepseek-ai/dsh-tools";
import { basename } from "node:path";
import {
  createRepo,
  describeGithubError,
  getUser,
  repoExists,
  sanitizeRepoName,
  validateRepoName,
} from "../github/client.js";
import { resolveToken } from "../github/token.js";
import {
  addAll,
  addRemote,
  commit,
  currentBranch,
  ensureGitignore,
  gitInit,
  hasRepo,
  isGitAvailable,
  push,
} from "../git/ops.js";
import { ProjectStateStore } from "../state/store.js";
import { getRuntimeConfig } from "../state/config-runtime.js";
import { resolveIdentity } from "../git/identity.js";
import { askUser, type Ctx } from "../types.js";

/**
 * git_init — start a project repo: ask the user whether to create a GitHub
 * repository, confirm the repo name (user may type their own), then init
 * locally, create remotely, and push the initial commit.
 */
export function registerGitInit(ctx: Ctx): void {
  ctx.tools.register(
    defineTool({
      name: "git_init",
      description:
        "初始化项目仓库：询问用户是否在 GitHub 创建仓库；仓库名必须经用户确认，用户不满意时按用户要求修改（可自由输入）。同意后自动完成 本地 git init + GitHub 建仓 + 关联 remote + 首次提交推送。用于新项目（空工作区、无 .git）开始时。",
      parameters: {
        cwd: {
          type: "string",
          description: "项目目录；缺省使用当前工作区",
        },
        repo_name: {
          type: "string",
          description: "建议的 GitHub 仓库名；缺省使用工作区目录名（仍会询问用户确认）",
        },
        visibility: {
          type: "string",
          enum: ["private", "public"],
          description: "仓库可见性；缺省使用配置默认值",
        },
        description: {
          type: "string",
          description: "仓库描述（可选）",
        },
        ask: {
          type: "boolean",
          description: "是否询问用户（建仓 + 仓库名确认）；缺省 true",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["ok", "skipped", "already_repo", "error"] },
            repo_url: { type: "string" },
            remote: { type: "string" },
            branch: { type: "string" },
            visibility: { type: "string" },
            reason: { type: "string" },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args: any, exec: any): Promise<any> {
        const config = getRuntimeConfig();
        const cwd = resolveCwd(args.cwd, exec);
        const state = new ProjectStateStore(cwd);

        if (!(await isGitAvailable())) {
          return {
            status: "error",
            reason: "未检测到 git：请先安装 Git（https://git-scm.com）后重试",
          };
        }
        if (await hasRepo(cwd)) {
          return {
            status: "already_repo",
            reason:
              "工作区已是 git 仓库，跳过初始化。可用 git_status 查看状态、git_sync 同步，或 git_rename 修改 GitHub 仓库名",
          };
        }

        const token = await resolveToken(ctx);
        if (!token) {
          return {
            status: "error",
            reason: "未配置 GitHub 令牌：请在设置中配置凭据 GITHUB_TOKEN 后重试",
          };
        }

        let owner: string;
        try {
          owner = config.github.username || (await getUser(token)).login;
        } catch (error) {
          return { status: "error", reason: `无法获取 GitHub 账号: ${describeGithubError(error)}` };
        }

        // ---- Q1: create the repository? ----
        let visibility = args.visibility ?? config.github.visibility;
        if (args.ask !== false && config.askBeforeInit) {
          const answer = await askUser(ctx, exec, {
            id: "git-init-create",
            header: "新建 GitHub 仓库",
            question: `检测到新项目「${basename(cwd)}」。是否在 GitHub 创建仓库？`,
            options: [
              {
                label: `创建${visibility === "public" ? "公开" : "私有"}仓库 (Recommended)`,
                description: `以 ${visibility} 可见性创建仓库并关联本地项目`,
              },
              { label: "创建公开仓库", description: "所有人可见" },
              { label: "创建私有仓库", description: "仅自己可见" },
              { label: "暂不创建", description: "本次不建仓，可随时用 /git init 重试" },
            ],
          });
          const selected = answer.selected[0] ?? "";
          if (selected.includes("暂不创建")) {
            await state.update({
              initDecision: "declined",
              initAskedAt: new Date().toISOString(),
              pendingInit: false,
            });
            return { status: "skipped", reason: "用户暂不创建仓库" };
          }
          if (selected.includes("公开")) visibility = "public";
          if (selected.includes("私有")) visibility = "private";
        }

        // ---- Q2: confirm the repo name (user MUST confirm; may type their own) ----
        const defaultName = sanitizeRepoName(args.repo_name ?? basename(cwd) ?? "project");
        let repoName = defaultName;
        if (args.ask !== false) {
          const nameAnswer = await askUser(ctx, exec, {
            id: "git-init-name",
            header: "确认仓库名",
            question: `仓库名将使用「${defaultName}」，是否确认？`,
            options: [
              { label: `使用「${defaultName}」 (Recommended)` },
              { label: "自定义名称", description: "输入你想要的仓库名" },
            ],
          });
          const custom = nameAnswer.custom?.trim();
          if (custom) {
            repoName = sanitizeRepoName(custom);
          } else if ((nameAnswer.selected[0] ?? "").includes("自定义")) {
            const textAnswer = await askUser(ctx, exec, {
              id: "git-init-name-text",
              header: "自定义仓库名",
              question: "请输入你想要的仓库名：",
            });
            repoName = sanitizeRepoName(textAnswer.custom?.trim() ?? "");
          }
        }
        if (!repoName) {
          return { status: "error", reason: "仓库名为空，已取消建仓" };
        }
        const invalid = validateRepoName(repoName);
        if (invalid) {
          return { status: "error", reason: `仓库名不合法：${invalid}（可重新调用 git_init 修改）` };
        }

        // ---- Q3: name conflict handling ----
        let finalName = repoName;
        try {
          if (await repoExists(token, owner, repoName)) {
            const conflictAnswer = await askUser(ctx, exec, {
              id: "git-init-name-conflict",
              header: "仓库名已被占用",
              question: `GitHub 上已存在「${owner}/${repoName}」，如何处理？`,
              options: [
                { label: `改用「${repoName}-2」`, description: "自动追加序号" },
                { label: "换个名字", description: "重新输入仓库名" },
              ],
            });
            const custom = conflictAnswer.custom?.trim();
            if (custom) {
              finalName = sanitizeRepoName(custom);
            } else if ((conflictAnswer.selected[0] ?? "").includes("换个名字")) {
              const again = await askUser(ctx, exec, {
                id: "git-init-name-conflict-text",
                header: "重新命名",
                question: "请输入新的仓库名：",
              });
              finalName = sanitizeRepoName(again.custom?.trim() ?? "");
            } else {
              finalName = `${repoName}-2`;
            }
            const stillInvalid = validateRepoName(finalName);
            if (stillInvalid) {
              return { status: "error", reason: `新名称仍不合法：${stillInvalid}` };
            }
            if (await repoExists(token, owner, finalName)) {
              return {
                status: "error",
                reason: `「${owner}/${finalName}」也已被占用，请稍后重试或使用其他名称`,
              };
            }
          }
        } catch (error) {
          return { status: "error", reason: `检查仓库名失败: ${describeGithubError(error)}` };
        }

        // ---- create remotely ----
        let repoUrl: string;
        try {
          const repo = await createRepo(token, {
            owner,
            name: finalName,
            visibility,
            description: args.description,
          });
          repoUrl = repo.html_url;
        } catch (error) {
          return { status: "error", reason: `GitHub 建仓失败: ${describeGithubError(error)}` };
        }

        // ---- init locally, wire remote, initial commit, push ----
        try {
          await gitInit(cwd, token, config.auth.method, config.github.defaultBranch);
          await addRemote(cwd, token, config.auth.method, `https://github.com/${owner}/${finalName}.git`);
          if (config.init.createGitignore) await ensureGitignore(cwd);
          await addAll(cwd, token, config.auth.method);
          await commit(
            cwd,
            token,
            config.auth.method,
            config.init.initialCommitMessage,
            resolveIdentity(config, owner),
          );
          const branch = await currentBranch(cwd, token, config.auth.method);
          await push(cwd, token, config.auth.method, branch, true);
          await state.update({
            repoName: finalName,
            remoteUrl: repoUrl,
            visibility,
            initDecision: "created",
            initAskedAt: new Date().toISOString(),
            pendingInit: false,
            lastSyncAt: new Date().toISOString(),
          });
          return {
            status: "ok",
            repo_url: repoUrl,
            remote: `https://github.com/${owner}/${finalName}.git`,
            branch,
            visibility,
          };
        } catch (error) {
          return {
            status: "error",
            reason: `本地 git 操作失败: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    }),
  );
}

/** TODO(verify): the runtime's canonical way to obtain the session workspace. */
function resolveCwd(explicit: string | undefined, exec: { cwd?: string }): string {
  if (explicit) return explicit;
  if (exec.cwd) return exec.cwd;
  return process.cwd();
}
