# DSH Git 同步插件 — 设计文档

> 插件名（暂定）：`dsh-plugin-git-sync`
> 版本：v0.1（设计稿）
> 状态：待评审 → 实施

---

## 1. 目标

让 **agent** 能够在用户的授权下完成 Git + GitHub 的全流程自动化：

1. **项目启动时询问建仓**：当用户开始一个新项目（空工作区、尚无 git 仓库），agent 询问用户是否在 GitHub 创建仓库；同意后自动完成：本地 `git init` → GitHub 远端建仓 → 关联 remote → 首次 commit + push。
2. **每次代码更新后上传**：agent 每完成一轮代码修改即同步到远程仓库；若 agent 遗漏，回合结束时由插件兜底自动提交并推送（可配置）。
3. **GitHub 账户配置**：插件提供凭据配置面（Fine-grained PAT），凭据走 DSH 的 `dsh-credentials` 加密存储，agent 建仓、推送全程由插件代劳，**令牌永不进入对话/模型上下文**。

### 非目标（v1 明确不做）
- 不做 GitLab / Gitee / GitHub Enterprise 适配（架构留好抽象，后续可扩展）。
- 不做 OAuth 授权流程（v1 用 PAT，交互最简单可靠）。
- 不做代码评审、PR、分支策略管理。
- 不做冲突自动解决（冲突时停下询问用户）。

---

## 2. 已确认的产品决策

| 决策点 | 结论 |
|---|---|
| 上传时机 | **Agent 自主调用 `git_sync` + 回合结束兜底**（配置 `autoSync` 开启时） |
| 建仓时机 | **空工作区 / 新会话首次写代码时询问一次**，同一项目只问一次 |
| 认证方式 | **Fine-grained PAT**，存于 `dsh-credentials` |
| 支持范围 | 仅 GitHub，架构抽象化，后续可加平台 |
| 仓库命名 | 默认取工作区目录名，**建仓前询问用户确认**；用户不满意按用户要求修改（`custom` 自由文本输入）；**支持建仓后改名**（`git_rename`） |

---

## 3. 核心流程

### 3.1 流程 A：项目启动 → 建仓询问

```
用户开始新项目（空工作区，无 .git）
        │
        ▼
┌─ 启动检测（插件监听会话开始 / 工作区就绪事件）────────┐
│  条件：工作区为空目录 且 无 .git 且 该项目从未被问过    │
└──────────────────────┬───────────────────────────────┘
                       ▼
        agent 即将首次创建项目文件
                       │
                       ▼
        agent 调用 git_init（或插件注入的指令引导 agent 调用）
                       │
                       ▼
   ┌─ 插件通过 ctx.userQuestions 询问用户 ─────────────┐
   │  「检测到新项目「xxx」，是否在 GitHub 创建仓库？   │
   │    [ 创建私有仓库 ] [ 创建公开仓库 ] [ 暂不创建 ]  │
   └──────────────────────┬───────────────────────────┘
                          ▼
        同意？──否──▶ 记录「本项目不建仓」，不再询问；
         │              提供 /git init 命令可随时重试
         │
         ▼
   ┌─ 确认仓库名（用户必须确认，不满意可按要求修改）──┐
   │ 1. 默认名 = 工作区目录名（或 agent 提议名）       │
   │ 2. 询问「仓库名使用「xxx」？」                    │
   │    [ 使用默认名 (Recommended) ] [ 自定义名称 ]    │
   │    —— 用户可直接输入想要的名称（custom 文本）     │
   │ 3. 用户不满意 → 以用户输入为准，可多次往返修改     │
   │ 4. 校验合法性 + GitHub 查重                        │
   │    · 冲突 → 建议 name-2 / 再询问用户              │
   │    · 非法 → 提示规则，重新询问                    │
   └──────────────────────┬───────────────────────────┘
                          ▼
   ┌─ 执行建仓（插件在宿主进程内完成，不经模型）──────┐
   │ 1. 校验凭据（token 有效性、权限）                │
   │ 2. git init -b main                             │
   │ 3. GitHub REST API 创建仓库（默认 private）      │
   │ 4. 写入远程 remote（token 绝不写入 URL）         │
   │ 5. 生成 .gitignore（按需）+ 首次 commit + push   │
   └──────────────────────┬───────────────────────────┘
                          ▼
                 完成 → 汇报「仓库地址 + 首个提交」
                          │
        用户日后不满意名字 ─┴─▶ git_rename：GitHub 改名
                            + 本地 remote set-url + 状态更新
```

**触发方式（三选一，可叠加）：**

- **a. 会话/工作区事件**：插件监听新会话在空工作区启动的事件，标记「待询问」。
- **b. agent 指令引导**：插件向 agent 注入指令（经 `dsh-agent-instructions` 或内置 skill）：*「开始新项目（工作区无 .git 且为空）时，先调用 git_init 询问用户是否建仓」*。
- **c. 斜杠命令**：`/git init` 手动触发（用户或 agent 都可用）。

> 推荐 a + b 组合：事件负责状态标记，指令负责引导 agent 在实际写第一个文件**之前**发起询问。

### 3.2 流程 B：代码更新 → 自动同步

```
agent 完成一轮修改（写/改/删了工作区文件）
        │
        ▼
  ┌─ 主路径：agent 自主调用 git_sync ──────────────┐
  │  git_sync(commit_message?):                    │
  │   - 收集变更（git status --porcelain）          │
  │   - 安全检查（见 §7）                           │
  │   - git add -A → commit（消息缺省时由 agent 生成）│
  │   - git push（每次推送前先 pull --rebase 处理远端差异）│
  └──────────────────────┬─────────────────────────┘
                         │
       回合结束兜底（若 autoSync 开启且仍有未提交变更）
                         │
                         ▼
   ┌─ 插件监听 agent 回合完成事件 ──────────────────┐
   │  - 工作区是 git 仓库？否 → 跳过                  │
   │  - 有未提交变更？否 → 跳过                       │
   │  - 有未推送提交？→ push（可选 ask 模式则询问）   │
   └──────────────────────┬─────────────────────────┘
                          ▼
                  同步完成，汇报简短状态
```

**兜底策略（可配置）：**

| 配置 | 行为 |
|---|---|
| `autoSync: true` | 回合结束自动 commit + push，无需询问 |
| `autoSync: false` | 回合结束不自动推送，仅当 agent 调用 `git_sync` 时同步 |
| `autoSync: "ask"` | 回合结束有变更时询问用户「发现 N 个未提交变更，是否上传？」 |

---

## 4. 系统架构

```
┌────────────────────────── DSH Web GUI（客户端）──────────────────────────┐
│  [设置页] GitHub 同步：token 输入 / 可见性 / autoSync / 状态显示（可选 UI）│
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ Remote（typert）
┌──────────────────────────────────▼───────────────────────────────────────┐
│                    宿主插件 dsh-plugin-git-sync                          │
│                                                                          │
│  ┌──────────────┐  ┌───────────────┐  ┌───────────────────────────────┐  │
│  │ 工具层        │  │ 编排层         │  │ Git 运行器 (GitRunner)         │  │
│  │ git_init     │  │ · 建仓流程     │  │ · node:child_process 调 git    │  │
│  │ git_sync     │  │ · 同步流程     │  │ · 每进程注入 GIT_ASKPASS 凭据   │  │
│  │ git_status   │  │ · 事件监听     │  │ · 输出脱敏（mask token）        │  │
│  │              │  │ · 兜底策略     │  └───────────────────────────────┘  │
│  └──────┬───────┘  └──────┬────────┘  ┌───────────────────────────────┐  │
│         │                 │           │ GitHub 客户端 (GitHubClient)   │  │
│         │                 │           │ · REST: 建仓/查重/可见性        │  │
│         ▼                 ▼           │ · token 解析（ctx.credentials）│  │
│  ┌────────────────────────────────┐   └───────────────────────────────┘  │
│  │ 状态存储 ProjectStateStore      │                                     │
│  │ · 按工作区路径 keyed            │   ┌───────────────────────────────┐  │
│  │ · 项目：repoName/remoteUrl/     │   │ 指令注入 AgentInstructions     │  │
│  │   initAsked/已同步哈希          │   │ · agent 何时调用哪个工具        │  │
│  └────────────────────────────────┘   └───────────────────────────────┘  │
└───────────────┬──────────────────────────────────────┬──────────────────┘
                │                                       │
        ┌───────▼────────┐                    ┌─────────▼─────────┐
        │ dsh-credentials│                    │ dsh-session 事件  │
        │ (token 加密存储)│                    │ (回合完成/文件变更)│
        └────────────────┘                    └───────────────────┘
                │
        ┌───────▼───────────────────────────────┐
        │ GitHub REST API（建仓）+ git 本地执行   │
        └───────────────────────────────────────┘
```

### 4.1 与 DSH 现有机制的对接点（已核实）

| DSH 能力 | 用法 |
|---|---|
| `@deepseek-ai/dsh-tools` 的 `defineTool` | 注册 `git_init` / `git_sync` / `git_status`，`inject: ["tools"]` |
| Cordis 插件形态 | `export const name` / `inject` / `Config = z.object({...})` / `apply(ctx, config)` |
| `dsh-credentials` (`ctx.credentials`) | 设置里存引用 `GITHUB_TOKEN`，真实值由 provider 保管，`credentialKey("git-sync", "github-token")` |
| `dsh-user-questions` (`ctx.userQuestions`) | 建仓询问、冲突处理询问（答案回插件，不经模型转发） |
| `dsh-session` 事件流 | 监听会话开始、agent 回合完成事件，驱动「待询问」标记与兜底同步 |
| `dsh-agent-instructions` / `dsh-skill` | 注入 agent 行为指令（何时调用 git_init / git_sync、令牌不可输出） |
| `dsh-settings` / schemastery | 插件配置模型（见 §6），宿主通用设置 UI 可直接渲染 |
| `dsh-commands` | `/git init`、`/git sync` 斜杠命令（可选） |
| 桌面端插件装载 | 打包为 profile bundle，经桌面插件清单安装（沿用 `dsh-plugin-desktop` 的机制） |

### 4.2 关键设计决策：Git 执行与令牌安全

**git 命令由插件在宿主进程内用 `node:child_process` 直接执行**（不经过 `bash`/`pwsh` 工具），理由：

1. **令牌零泄露**：token 通过 git 的环境变量配置注入（`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` 注入 `http.extraheader=Authorization: Basic base64(x-access-token:<token>)`——GitHub 的 git 协议端点只认 Basic，Bearer 仅用于 REST API），**不写入 remote URL、不写入 .git/config、不出现在进程命令行**；模型看到的 git 输出经脱敏管道过滤。
2. **输出可控**：插件自行解析 stdout/stderr，剥离任何可能含凭据的内容后，以结构化结果（成功/变更文件数/提交哈希/仓库 URL）返回给模型。
3. **错误语义明确**：区分「网络失败 / 凭据失效 / 仓库不存在 / 冲突」等，给模型清晰的可行动提示。

> 备选注入机制：`GIT_ASKPASS`（临时脚本回显 token），通过配置 `auth.method: "askpass"` 切换；Windows 下默认走 extraheader 方案（实现前已实测验证）。
> 唯一例外：agent 想在**新工作区做非本插件管理的 git 操作**（如临时实验分支），可继续用系统 bash/pwsh 工具，此时与插件状态无关，不触发同步。

---

## 5. 工具接口定义

### 5.1 `git_init` — 初始化项目仓库

```
参数（全部可选，模型通常只需传 repo_name）：
  repo_name: string   — GitHub 仓库名，缺省用工作区目录名
  visibility: "private" | "public"  — 缺省取配置默认值（private）
  description: string — 仓库描述，可选
  ask: boolean        — 是否先询问用户（缺省 true）

返回：
  { status: "ok" | "skipped" | "error",
    repo_url, remote, branch, first_commit,
    reason?   // skipped 时：用户拒绝 / 已是仓库 / 无凭据 等
  }
```

行为要点：
- 若工作区已是 git 仓库 → 不重复 init，直接进入「关联 GitHub remote」分支（采纳已有仓库）。
- `ask: true` 时先走 `ctx.userQuestions`，用户拒绝则返回 `skipped` 并记录「本项目不建仓」。
- **仓库名必须经用户确认**：
  - 默认名 = `repo_name` 参数或工作区目录名；
  - 询问「使用默认名 / 自定义名称」，用户可直接输入想要的名称（`answer.custom`），不满意可反复修改；
  - 校验 GitHub 命名规则，查重失败则建议 `name-2` 或再次询问；
- 建仓后写入 `ProjectStateStore`。

### 5.4 `git_rename` — 修改仓库名（建仓后改名）

```
参数：
  new_name: string   — 用户要求的新仓库名（必填）
  confirm: boolean   — 是否先询问用户确认（缺省 true）

返回：
  { status: "ok" | "cancelled" | "error",
    old_name, new_name, new_remote_url,
    reason? }
```

行为要点：
- 用户对现有仓库名不满意时调用（agent 引导用户说出新名字，或用户直接要求改名）。
- 流程：`ctx.userQuestions` 确认 → GitHub REST `PATCH /repos/{owner}/{name}` 改名 → 本地 `git remote set-url origin <新 URL>` → 更新 `ProjectStateStore.repoName/remoteUrl`。
- 新名冲突/非法 → 返回明确错误与可行动建议，不破坏现有仓库。
- 改名后旧 URL 由 GitHub 自动 301 重定向，历史链接不失效。

### 5.2 `git_sync` — 提交并推送

```
参数：
  commit_message: string  — 提交信息；缺省时由 agent 依据变更内容生成
  include: string[]?      — 仅提交指定路径（缺省全部）
  mode: "commit_push" | "commit_only" | "push_only"  — 缺省 commit_push

返回：
  { status: "ok" | "nothing_to_do" | "conflict" | "error",
    commits: [{ hash, message }],
    files_changed: number,
    pushed: boolean,
    needs_user_action?: string  // 冲突/凭据失效时给模型的具体指引
  }
```

行为要点：
- 空变更 → `nothing_to_do`（不产生空提交）。
- push 前自动 `git pull --rebase`；有冲突 → 停下，返回 `conflict` + 冲突文件清单，交给用户/模型处理，**绝不强推**。
- 推送失败按错误分类：凭据失效 → 提示重新配置；仓库被删 → 询问是否重建。

### 5.3 `git_status` — 查询同步状态

```
参数：无

返回：
  { is_repo, branch, remote_url, ahead, behind,
    staged, unstaged, untracked, last_sync_at }
```

用途：agent 在回合开始/结束时快速自检，决定是否需要 `git_sync`；也是兜底钩子的内部查询。

---

## 6. 配置模型（schemastery 草案）

```ts
import { z } from "@deepseek-ai/schemastery";

export const Config = z.object({
  // GitHub 账户（身份信息；令牌本身走 credentials，见 §7）
  github: z.object({
    username: z.string().description("GitHub 用户名或组织名，用于建仓时作为 owner"),
    visibility: z.union([z.literal("private"), z.literal("public")])
      .default("private").description("默认仓库可见性"),
    defaultBranch: z.string().default("main"),
  }),

  // 凭据注入机制
  auth: z.object({
    method: z.union([z.literal("extraheader"), z.literal("askpass")])
      .default("extraheader").description("git 凭据注入方式：extraheader=环境变量注入 Authorization 头（推荐，Windows 已验证）；askpass=临时脚本回显"),
  }),

  // 提交身份（仅 repo-local，绝不改全局配置）
  git: z.object({
    committerName: z.string().default("").description("提交作者名；留空用 GitHub 用户名"),
    committerEmail: z.string().default("").description("提交作者邮箱；留空用 GitHub noreply 邮箱"),
  }),

  // 同步策略
  autoSync: z.union([
    z.literal(true), z.literal(false), z.literal("ask"),
  ]).default(true).description("回合结束兜底：true=自动提交推送 / false=仅 agent 调用时同步 / ask=有变更时询问"),

  askBeforeInit: z.boolean().default(true)
    .description("项目启动时是否询问建仓（false 则自动建仓）"),

  init: z.object({
    createGitignore: z.boolean().default(true),
    initialCommitMessage: z.string().default("chore: initial commit"),
  }),

  safety: z.object({
    scanForSecrets: z.boolean().default(true)
      .description("提交前扫描常见敏感文件（.env、密钥文件等）并告警"),
    maxFileSizeMb: z.number().default(50)
      .description("超过该大小的文件提交前告警（GitHub 单文件上限 100MB）"),
  }),
});
```

> 宿主插件的 schemastery 配置会被 DSH 通用设置 UI 自动渲染为表单，因此**不强制**做独立客户端 UI（Phase 5 可选）。

---

## 7. 凭据与安全模型

### 7.1 令牌存储

- **位置**：`dsh-credentials`，scope = `git-sync`，id = `github-token`。
- **设置只存引用**：配置项 `GITHUB_TOKEN`（一个环境变量风格的引用名），设置面板永远显示「已配置/未配置」，**不显示、不回显令牌值**。
- **解析时机**：每次 git/GitHub 操作前由插件 resolve，变更立即可用，无需重启。

### 7.2 令牌权限（配置指引写入文档与 UI 提示）

- Fine-grained PAT：
  - **Administration: Read and write**（建仓所需）
  - **Contents: Read and write**（推送所需）
  - **Metadata: Read**（API 基础）
  - 仓库范围：All repositories（或至少包含目标项目）
- Classic PAT 备选：`repo` scope。

### 7.3 安全红线

| 红线 | 措施 |
|---|---|
| 令牌进对话/模型上下文 | 禁止。凭据只在宿主进程内解析；git 输出全量脱敏；`git remote -v` 等命令的输出由插件重写后返回 |
| 令牌写入 remote URL | 禁止。用 `http.extraheader`（经 `GIT_CONFIG_*` 环境变量注入）或 `GIT_ASKPASS` |
| 令牌出现在进程命令行 | 避免。凭据经子进程**环境变量**传入，不进 argv |
| 令牌落盘 | 禁止写入 `.git/config` 与插件状态文件 |
| 推送敏感文件 | `safety.scanForSecrets` 开启时，提交前扫描 `.env*`、`*.pem`、`id_rsa*`、`*.key`、`credentials*` 等，命中即告警并要求确认/排除 |
| 强推覆盖远端 | 禁止 `push --force`。始终 `pull --rebase` + 普通 push，冲突交还用户 |
| 超大文件 | 超限文件告警（GitHub 100MB 硬上限、50MB 默认告警阈值） |
| 明文落盘 | 插件状态文件（`ProjectStateStore`）不存令牌；`.git/config` 用 repo-local `http.extraHeader` 时也要避免——v1 用进程级注入，落盘为零 |

---

## 8. 状态数据模型（ProjectStateStore）

按**工作区绝对路径** keyed，存于插件 storage（`dsh-storage`）：

```ts
interface ProjectState {
  workspacePath: string;      // 唯一键
  repoName?: string;          // GitHub 仓库名（改名后更新为新名）
  remoteUrl?: string;         // 改名后更新为新 URL
  visibility?: "private" | "public";
  initAskedAt?: string;       // 询问过的时间
  initDecision?: "created" | "declined";
  pendingInit?: boolean;      // 空工作区新会话标记「待询问建仓」
  lastSyncAt?: string;
  lastSyncedCommit?: string;  // 兜底去重用
}
```

规则：
- `initDecision: "declined"` 的项目不再自动询问（`/git init` 可重试）。
- `git_rename` 成功后同步更新 `repoName` / `remoteUrl`。
- 工作区被删除后条目可惰性清理。

---

## 9. 边界情况与错误处理

| 场景 | 行为 |
|---|---|
| 未安装 git | 检测 `git --version` 失败 → 提示安装，建仓流程中止并说明 |
| 机器未配置 git 身份（user.name/email） | 插件在提交前自动设置 **repo-local** 身份（配置优先 → GitHub 用户名 + noreply 邮箱 → dsh-agent 兜底），绝不修改全局配置 |
| 凭据未配置 | `git_init`/`git_sync` 返回明确错误 + 指引到设置页；回合兜底跳过并提示一次 |
| 令牌失效/权限不足 | 按 GitHub API 错误码分类（401/403），提示重新配置令牌 |
| 仓库名冲突 | 创建前查重；冲突时建议 `name-2`、`name-3`…，或再次询问用户 |
| 仓库名不合法 | 按 GitHub 命名规则校验（1–100 字符、字母数字 `-` `_` `.`、不能以 `.` 开头结尾、不能连续两个 `.`），提示规则后重新询问 |
| 建仓后用户不满意名字 | `git_rename`：GitHub 改名 + 本地 remote set-url + 状态更新；旧 URL 由 GitHub 301 重定向 |
| 工作区已是 git 仓库 | 采纳现有仓库：补 remote、不重复 init；已有非 GitHub remote 则只添加 GitHub remote 或询问 |
| 用户拒绝建仓 | 记录 declined；agent 继续正常开发，不阻塞 |
| 远端有差异 | `pull --rebase`；冲突 → 停下交用户，绝不 force push |
| 仓库在 GitHub 被删 | push 报错 → 询问是否用当前内容重建仓库 |
| 网络失败 | 3 次指数退避重试后返回错误 |
| 提交为空 | `nothing_to_do`，不产生空提交 |
| 大文件/敏感文件 | 按 `safety` 配置告警或拦截 |
| 多账号 | v1 单账号；凭据 key 结构（scope/id）预留多 id，后续可加 `github-token-<name>` |
| Windows 环境 | 用 PATH 中 git；验证 `GIT_ASKPASS` 在 Windows 的表现，必要时改用 credential helper 注入 |

---

## 10. 实施计划

### 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| **M0 脚手架** | 包结构、`package.json`（`dsh` 宿主注入声明）、tsconfig、构建 | 可装载的空插件 |
| **M1 凭据与 GitHub 客户端** | `ctx.credentials` 接线、设置 schema、GitHub REST 客户端（建仓/查重/可见性）、token 脱敏工具 | 设置页可见「GitHub 同步」配置；可用 API 建仓 |
| **M2 Git 运行器** | `child_process` git 封装、`GIT_ASKPASS` 注入、输出脱敏、pull-rebase-push 语义 | 本地 git 全操作可用 |
| **M3 工具层** | `git_init`（含仓库名确认交互）/ `git_sync` / `git_status` / `git_rename` 注册 + agent 指令注入 | agent 可自主完成建仓（含改名）与同步 |
| **M4 生命周期钩子** | 会话开始（空工作区）标记、回合结束兜底、`ctx.userQuestions` 询问 | 「建仓询问一次 + 回合结束兜底」闭环 |
| **M5 斜杠命令与 UI（可选）** | `/git init` `/git sync`；独立客户端设置面板 | 手动触发与可视化 |
| **M6 边界处理与测试** | §9 全表、单元/集成测试、Windows 验证 | 稳定版 |

### 建议的文件结构

```
dsh-plugin-git-sync/
├── package.json            # dsh.host.inject: ["tools","credentials","settings",
│                           #   "userQuestions","session","storage","agentInstructions"]
├── tsconfig.json
├── src/
│   ├── index.ts            # name / inject / Config / apply(ctx, config)
│   ├── config.ts           # schemastery 配置模型
│   ├── github/
│   │   ├── client.ts       # GitHub REST 封装（建仓、查重、用户信息）
│   │   └── token.ts        # credentials 解析 + 脱敏
│   ├── git/
│   │   ├── runner.ts       # child_process git 封装（ASKPASS 注入、输出脱敏）
│   │   └── ops.ts          # init / add / commit / pull-rebase / push / status
│   ├── tools/
│   │   ├── git_init.ts
│   │   ├── git_sync.ts
│   │   └── git_status.ts
│   ├── lifecycle/
│   │   ├── project-start.ts   # 会话开始 → 待询问标记
│   │   └── turn-end-sync.ts   # 回合结束 → 兜底同步
│   ├── state/store.ts      # ProjectStateStore
│   └── prompts/instructions.ts  # agent 指令注入
├── client/                 # 可选：设置 UI
└── tests/
```

---

## 11. 未来扩展（非 v1）

- 平台抽象：`GitHostProvider` 接口 → GitLab / Gitee / GitHub Enterprise。
- OAuth App 授权流程（替代 PAT 输入）。
- 分支策略：每任务分支 + 合并。
- 提交信息模板（Conventional Commits）、自动版本号。
- 私有仓库内容扫描（secrets 扫描接入）。
- 多 GitHub 账号并行配置。

---

## 12. 风险与待验证点

1. **凭据注入机制在 Windows（git for Windows）下的行为** — 已实测：`GIT_CONFIG_*` 环境变量注入 `http.extraheader` 可用，但 GitHub 的 git 协议端点**只接受 Basic auth**（`base64(x-access-token:<token>)`），Bearer 仅用于 REST API。**真实令牌冒烟已全部通过**（建仓 → 推送 → 改名 → 再推送 → 旧 URL 301 → 清理）。
2. **本机 TLS 证书链拦截（环境问题，非插件缺陷）** — 冒烟发现本机存在证书链拦截：Node 需 `--use-system-ca` 才能访问 api.github.com；git 的 schannel 后端报 `SEC_E_NO_CREDENTIALS`，需换 openssl 后端并临时 `sslVerify=false`。**插件在 DSH 宿主中运行时同样受此影响**，需在本机修复证书信任（安装拦截根证书）或配置 DSH 宿主使用系统 CA。
3. **`dsh-session` 的「回合完成」事件** — 已实测：`session/event` 监听器是**双参数** `(session, event)`，`event.type === "turn/end"` 判定回合结束；`session/created` 是单参数（session 对象）。工作区路径字段待确认（`session.workspace ?? session.cwd`，当前为 best-effort）。
4. **Fine-grained PAT 建仓权限** — 已实测通过（Administration/Contents 写权限可建仓、推送、改名、删仓）。
5. **`ctx.userQuestions.ask` 的宿主调用方式** — 已确认 `ask({questions, agent, signal})` → `{answers:[{id, selected[], custom?}]}`，`custom` 承载用户自由输入（仓库名）。
6. **桌面端 bundle 装载流程** — 已实测跑通：`dsh.bundle.patch` 指向 `cordis.patch.yml`（`insert` 插件进 profile 组合）；`pnpm add <tgz>` 装入 profile；`dsh.profile.bundles` 注册；**首次装载失败会被桌面「启动恢复」机制自动加入 `disabledBundles`**（`startup-recovery/state.json`），修复后需手动解除；插件 `inject` 只能声明真实服务（`tools/credentials/userQuestions`），`logger` 为 Cordis 内置、`session` 事件走 `ctx.on`，声明了会导致 `pending (waiting for services)`。
7. **`dsh-agent-instructions` 的注入点** — 实测**运行时不可用**（`agentInstructions` 缺失，已 try/catch 降级）；agent 行为引导需改走 skill 或工具描述（后续改进）。
8. **`ctx.workspace` / 工具 `exec` 上下文中的工作区路径来源** — 工具内当前用 `args.cwd ?? exec.cwd ?? process.cwd()`；会话事件里用 `session.workspace ?? session.cwd`（待运行时确认字段）。

---

## 附：术语

- **工作区（workspace）**：DSH 会话绑定的项目目录。
- **宿主插件（host plugin）**：运行在 agent 侧的 Cordis 插件，负责注册工具与事件。
- **客户端插件（client plugin）**：运行在 Web GUI 侧的插件，负责 UI。
- **兜底同步**：agent 回合结束时由插件自动执行的同步，作为 agent 自主调用 `git_sync` 的保险。
