import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  describeGithubError,
  getUser,
  renameRepo,
  repoExists,
  sanitizeRepoName,
  validateRepoName,
} from "../github/client.js";
import { resolveToken } from "../github/token.js";
import { hasRepo, setRemoteUrl } from "../git/ops.js";
import { ProjectStateStore } from "../state/store.js";
import { getRuntimeConfig } from "../state/config-runtime.js";
import { askUser, resolveWorkspaceCwd, type Ctx } from "../types.js";

/**
 * git_rename — change the GitHub repository name after creation.
 * The user may be unsatisfied with the name at any time; the plugin renames
 * on GitHub, rewires the local remote, and updates project state. GitHub
 * keeps the old URL working via 301 redirect.
 */
export function registerGitRename(ctx: Ctx): void {
  ctx.tools.register(
    defineTool({
      name: "git_rename",
      description:
        "修改 GitHub 仓库名（建仓后改名）：用户对当前仓库名不满意时调用。按用户要求的新名称在 GitHub 上改名，并同步更新本地 remote 与项目状态；旧链接由 GitHub 自动 301 重定向。",
      parameters: {
        new_name: {
          type: "string",
          required: true,
          description: "用户要求的新仓库名（必填，以用户输入为准）",
        },
        confirm: {
          type: "boolean",
          description: "是否先询问用户确认改名；缺省 true",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["ok", "cancelled", "error"] },
            old_name: { type: "string" },
            new_name: { type: "string" },
            new_remote_url: { type: "string" },
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
        const current = await state.load();

        if (!(await hasRepo(cwd))) {
          return { status: "error", reason: "工作区不是 git 仓库（先调用 git_init 建仓）" };
        }
        if (!current.repoName) {
          return {
            status: "error",
            reason: "找不到本项目的 GitHub 仓库记录（未通过 git_init 建仓，无法自动改名）",
          };
        }

        const token = await resolveToken(ctx);
        if (!token) {
          return { status: "error", reason: "未配置 GitHub 令牌：请先配置 GITHUB_TOKEN" };
        }

        const newName = sanitizeRepoName(args.new_name);
        const invalid = validateRepoName(newName);
        if (invalid) {
          return { status: "error", reason: `新仓库名不合法：${invalid}` };
        }

        let owner: string;
        try {
          owner = config.github.username || (await getUser(token)).login;
        } catch (error) {
          return { status: "error", reason: `无法获取 GitHub 账号: ${describeGithubError(error)}` };
        }

        if (newName === current.repoName) {
          return {
            status: "ok",
            old_name: current.repoName,
            new_name: newName,
            new_remote_url: current.remoteUrl,
          };
        }

        try {
          if (await repoExists(token, owner, newName)) {
            return {
              status: "error",
              reason: `「${owner}/${newName}」已被占用，无法改名；请换一个名称`,
            };
          }
        } catch (error) {
          return { status: "error", reason: `检查新名称失败: ${describeGithubError(error)}` };
        }

        if (args.confirm !== false) {
          const answer = await askUser(ctx, exec, {
            id: "git-rename-confirm",
            header: "确认改名",
            question: `确认将仓库「${current.repoName}」改名为「${newName}」？`,
            options: [
              { label: "确认改名", description: `GitHub 仓库将更名为 ${newName}` },
              { label: "取消", description: "保持当前名称不变" },
            ],
          });
          if ((answer.selected[0] ?? "").includes("取消")) {
            return { status: "cancelled", reason: "用户取消改名" };
          }
        }

        try {
          const repo = await renameRepo(token, owner, current.repoName, newName);
          const newUrl = `https://github.com/${owner}/${newName}.git`;
          await setRemoteUrl(cwd, token, config.auth.method, newUrl);
          await state.update({ repoName: newName, remoteUrl: repo.html_url });
          return {
            status: "ok",
            old_name: current.repoName,
            new_name: newName,
            new_remote_url: repo.html_url,
          };
        } catch (error) {
          return { status: "error", reason: `改名失败: ${describeGithubError(error)}` };
        }
      },
    }),
  );
}
