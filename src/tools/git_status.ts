import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveToken } from "../github/token.js";
import {
  aheadBehind,
  currentBranch,
  getRemoteUrl,
  hasRepo,
  statusPorcelain,
} from "../git/ops.js";
import { ProjectStateStore } from "../state/store.js";
import type { Ctx } from "../types.js";
import type { Config } from "../config.js";

/**
 * git_status — inspect the current sync state of the workspace.
 */
export function registerGitStatus(ctx: Ctx, config: Config): void {
  ctx.tools.register(
    defineTool({
      name: "git_status",
      description:
        "查看当前项目的 git 同步状态：是否已建仓、分支、远端地址、前后端差异、未提交/未跟踪文件。用于决定是否需要调用 git_sync。",
      parameters: {
        cwd: {
          type: "string",
          description: "项目目录；缺省使用当前工作区",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            is_repo: { type: "boolean" },
            branch: { type: "string" },
            remote_url: { type: "string" },
            ahead: { type: "number" },
            behind: { type: "number" },
            staged: { type: "number" },
            unstaged: { type: "number" },
            untracked: { type: "number" },
            files: {
              type: "array",
              items: { type: "string" },
            },
            last_sync_at: { type: "string" },
            repo_name: { type: "string" },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args: any, _exec: any): Promise<any> {
        const cwd = args.cwd ?? process.cwd();
        if (!(await hasRepo(cwd))) {
          return { is_repo: false, reason: "工作区不是 git 仓库（可调用 git_init 建仓）" };
        }
        const token = await resolveToken(ctx);
        const branch = await currentBranch(cwd, token, config.auth.method);
        const remoteUrl = await getRemoteUrl(cwd, token, config.auth.method);
        const { ahead, behind } = await aheadBehind(cwd, token, config.auth.method);
        const status = await statusPorcelain(cwd, token, config.auth.method);
        const state = await new ProjectStateStore(cwd).load();
        return {
          is_repo: true,
          branch,
          remote_url: remoteUrl,
          ahead,
          behind,
          staged: status.staged.length,
          unstaged: status.unstaged.length,
          untracked: status.untracked.length,
          files: [...status.staged, ...status.unstaged, ...status.untracked],
          last_sync_at: state.lastSyncAt,
          repo_name: state.repoName,
        };
      },
    }),
  );
}
