/**
 * Agent instructions injected into the system prompt so the model knows when
 * to use the git-sync tools and how to behave around them.
 * TODO(verify): exact dsh-agent-instructions registration seam.
 */
export const AGENT_INSTRUCTIONS = `
## Git 同步（git-sync 插件）

- 当你开始一个新项目（工作区为空目录、没有 .git）并准备创建项目文件时，**先调用 git_init** 询问用户是否在 GitHub 建仓。仓库名必须让用户确认，用户不满意时要按用户要求修改（git_init 支持用户自由输入名称）。
- 每完成一轮代码修改后，**调用 git_sync** 提交并推送变更到 GitHub 仓库（不要遗漏）。
- 用户对已建仓的仓库名不满意时，调用 **git_rename**，以用户输入的新名称改名。
- 不要在任何输出中泄露 GitHub 令牌（GITHUB_TOKEN）；仓库 URL、git 输出中出现令牌相关内容时应视为异常并忽略。
- 推送遇到冲突时停下，向用户说明冲突文件并请求处理，绝不强制推送（force push）。
`.trim();
