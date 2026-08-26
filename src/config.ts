import z from "@deepseek-ai/schemastery";

/**
 * Plugin configuration model (schemastery).
 * Rendered automatically by DSH's generic settings UI.
 */
const ConfigSchema = z.object({
  // GitHub account identity (the token itself lives in dsh-credentials, see github/token.ts)
  github: z.object({
    username: z
      .string()
      .description("GitHub 用户名或组织名，作为建仓 owner；留空则使用令牌对应账号"),
    visibility: z
      .union([z.const("private"), z.const("public")])
      .default("private")
      .description("默认仓库可见性"),
    defaultBranch: z.string().default("main"),
    insecureTls: z
      .boolean()
      .default(false)
      .description(
        "本机 TLS 证书链异常（被安全软件/代理拦截导致 api.github.com 校验失败）时启用：跳过 REST 证书校验并让 git 使用 openssl + sslVerify=false。仅建议在可信网络开启",
      ),
  }),

  // How git receives the credential without leaking it
  auth: z.object({
    method: z
      .union([z.const("extraheader"), z.const("askpass")])
      .default("extraheader")
      .description(
        "git 凭据注入方式：extraheader=通过 GIT_CONFIG_* 环境变量注入 Authorization 头（推荐，不进 argv、不落盘）；askpass=临时脚本回显令牌",
      ),
  }),

  // Commit identity (repo-local only; never touches global git config)
  git: z.object({
    committerName: z
      .string()
      .default("")
      .description("提交作者名；留空则用 GitHub 用户名（仍留空则 dsh-agent）"),
    committerEmail: z
      .string()
      .default("")
      .description("提交作者邮箱；留空则用 GitHub noreply 邮箱 <用户名>@users.noreply.github.com"),
  }),

  // Sync strategy
  autoSync: z
    .union([z.const(true), z.const(false), z.const("ask")])
    .default(true)
    .description(
      "回合结束兜底：true=自动提交推送 / false=仅 agent 调用 git_sync 时同步 / ask=有变更时询问用户",
    ),

  // File watcher: commit + push on every file change (save), not only at turn end
  fileWatcher: z.object({
    enabled: z
      .boolean()
      .default(true)
      .description("监听工作区文件变化：保存文件后自动提交推送（需 autoSync: true；忽略 .git/node_modules 等目录）"),
    debounceMs: z
      .number()
      .default(1500)
      .description("连续变化后的防抖等待毫秒数（合并一次编辑为一次同步）"),
  }),

  askBeforeInit: z
    .boolean()
    .default(true)
    .description("项目启动时是否询问建仓（false 则按配置自动建仓）"),

  init: z.object({
    createGitignore: z.boolean().default(true),
    initialCommitMessage: z.string().default("chore: initial commit"),
  }),

  safety: z.object({
    scanForSecrets: z
      .boolean()
      .default(true)
      .description("提交前扫描常见敏感文件（.env、密钥文件等）并阻止提交"),
    maxFileSizeMb: z
      .number()
      .default(50)
      .description("超过该大小的文件提交前告警（GitHub 单文件上限 100MB）"),
  }),
});

/** Runtime schema (validated by the Cordis loader). */
export const Config = ConfigSchema;

/** Validated config shape (defaults applied at validation time). */
export type Config = {
  github: {
    username: string;
    visibility: "private" | "public";
    defaultBranch: string;
    insecureTls: boolean;
  };
  auth: {
    method: "extraheader" | "askpass";
  };
  git: {
    committerName: string;
    committerEmail: string;
  };
  autoSync: true | false | "ask";
  fileWatcher: {
    enabled: boolean;
    debounceMs: number;
  };
  askBeforeInit: boolean;
  init: {
    createGitignore: boolean;
    initialCommitMessage: string;
  };
  safety: {
    scanForSecrets: boolean;
    maxFileSizeMb: number;
  };
};
