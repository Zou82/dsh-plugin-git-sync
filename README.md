# dsh-plugin-git-sync

让 DeepSeek Harness（DSH）的 agent 自动完成 **Git + GitHub 全流程**的宿主插件：

1. **项目启动询问建仓**：新项目开始时，agent 先询问你是否在 GitHub 建仓；**仓库名必须经你确认**，不满意可直接输入想要的名称，建仓后随时可改名。
2. **每次改代码自动同步**：agent 每轮修改后调用 `git_sync` 提交推送；漏掉时由「回合结束兜底」自动同步（可配置）。
3. **凭据安全**：GitHub 令牌存于 DSH 的凭据存储，**绝不进入对话、远程 URL、进程命令行或任何输出**。

> 完整设计文档见 [DESIGN.md](./DESIGN.md)。

---

## 功能特性

- `git_init`：询问建仓 → 确认/自定义仓库名（冲突自动建议 `name-2`）→ 本地 `git init` + GitHub 建仓 + 首次提交推送
- `git_rename`：**建仓后改名**（GitHub 改名 + 本地 remote 同步 + 状态更新，旧链接 301 重定向）
- `git_sync`：提交并推送（自动 `pull --rebase`，冲突停下交给你，**绝不 force push**）
- `git_status`：查看同步状态（分支 / 远端 / 前后端差异 / 未提交文件）
- 回合结束兜底自动同步（`autoSync` 可配 `true` / `false` / `"ask"`）
- 提交前敏感文件扫描（`.env`、密钥等）、大文件告警
- 自动设置 git 提交身份（repo-local，不动全局配置）

## 环境要求

- DeepSeek Harness Desktop（DSH）2.x，profile 基于 Cordis 插件体系
- 本机已安装 [Git](https://git-scm.com)（`git --version` 可用）
- 一个 GitHub 账号 + 令牌（见下方「配置令牌」）

---

## 安装

### 1. 构建打包

```bash
npm install
npm run build       # 产出 lib/
npm pack            # 产出 dsh-plugin-git-sync-<version>.tgz
```

### 2. 装入 DSH profile

假设你的 profile 目录是 `~/.dsh/profiles/web`（在 DSH Desktop 中即 `web` profile）：

```bash
cd ~/.dsh/profiles/web
pnpm add /path/to/dsh-plugin-git-sync-<version>.tgz
```

### 3. 注册 bundle

编辑 profile 的 `package.json`，把插件加入 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [ "...其它 bundle...", "dsh-plugin-git-sync" ]
    }
  }
}
```

### 4. 重启 DSH Desktop

完全退出并重新打开 DSH Desktop。插件装载后，日志会出现：

```
[I] [git-sync] git-sync: 插件已加载（GitHub 同步已启用）
```

新开对话后，agent 就能使用 `git_init` / `git_sync` / `git_rename` / `git_status` 四个工具。

> **踩坑提示**：如果 bundle 声明或加载失败，DSH 的「启动恢复」机制会把插件**自动加入禁用列表**（`startup-recovery/state.json` 的 `disabledBundles`），表现为「看起来启动正常但插件没加载」。修复问题后，需要手动把插件从该文件的 `disabledBundles` 中移除再重启。

---

## 配置

插件有两类配置：**GitHub 令牌**（凭据）和**插件设置**。两者都可以在 **DSH 设置界面**里改（**设置 → 插件 → 插件配置 → GitHub 同步** 卡片，0.2.0 起内置），也支持直接编辑文件，效果相同且**实时生效**（无需重启）。

### 1. 配置 GitHub 令牌（必须）

**位置**：`~/.dsh/.credentials.yaml`（DSH 凭据文件），或在上述设置卡片中直接填写（令牌只写不读，不出现在界面上）。

在 `refs:` 下添加一行：

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: 你的-其他-密钥
  GITHUB_TOKEN: github_pat_xxxxxxxxxxxx
```

**令牌权限要求**（GitHub → Settings → Developer settings → Personal access tokens）：

| 令牌类型 | 需要的权限 |
|---|---|
| Fine-grained PAT（推荐） | `Administration: Read and write`（建仓）、`Contents: Read and write`（推送）、`Metadata: Read` |
| Classic PAT | `repo`（整个 scope） |

> 安全提示：令牌创建后只显示一次；请勿把令牌写进任何会被提交到 git 的文件。

### 2. 配置插件设置（可选，有默认值）

**位置**：DSH 设置界面 → 插件 → 插件配置 → **GitHub 同步**卡片；或 `~/.dsh/settings.yaml` 的 `git-sync:` 段（二者等价，实时生效）

```yaml
git-sync:
  github:
    username: 你的GitHub用户名        # 建仓 owner；留空则用令牌对应账号
    visibility: private               # 默认仓库可见性：private / public
    defaultBranch: main
    insecureTls: false                # 本机 TLS 被拦截时设为 true（见「常见问题」）
  auth:
    method: extraheader               # git 凭据注入方式：extraheader / askpass
  git:
    committerName: ""                 # 提交作者名；留空用 GitHub 用户名
    committerEmail: ""                # 提交作者邮箱；留空用 GitHub noreply 邮箱
  autoSync: true                      # 回合结束兜底：true 自动推送 / false 关闭 / "ask" 询问
  askBeforeInit: true                 # 项目启动时是否询问建仓
  init:
    createGitignore: true
    initialCommitMessage: "chore: initial commit"
  safety:
    scanForSecrets: true              # 提交前扫描敏感文件并阻止提交
    maxFileSizeMb: 50                 # 大文件告警阈值（GitHub 上限 100MB）
```

也可以在 `cordis.patch.yml` 的 `config:` 段提供同样的配置（二选一，patch 内配置随包分发、settings 是运行时可改的）。

### 3. 配置项一览

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `github.username` | 空（用令牌账号） | 建仓 owner（个人名或组织名） |
| `github.visibility` | `private` | 默认仓库可见性 |
| `github.defaultBranch` | `main` | 默认分支名 |
| `github.insecureTls` | `false` | 本机 TLS 证书链异常时跳过校验（仅可信网络建议开启） |
| `auth.method` | `extraheader` | git 凭据注入方式 |
| `git.committerName` / `committerEmail` | 空 | 提交身份，留空自动用 GitHub 账号 + noreply 邮箱 |
| `autoSync` | `true` | 回合结束兜底策略 |
| `askBeforeInit` | `true` | 是否询问建仓 |
| `init.createGitignore` | `true` | 建仓时生成 .gitignore |
| `init.initialCommitMessage` | `chore: initial commit` | 首次提交信息 |
| `safety.scanForSecrets` | `true` | 敏感文件扫描 |
| `safety.maxFileSizeMb` | `50` | 大文件告警阈值 |

---

## 使用

插件工具在**新开对话**中可用（当前对话的工具列表是固定的）。典型流程：

**① 建仓（含仓库名确认/自定义）**

> 我准备在 D:\my-project 开始一个新项目（目录为空），帮我建 GitHub 仓库并写一个 Python 脚本。

- agent 调用 `git_init` → 询问「是否建仓」（选私有/公开/暂不）
- 询问「仓库名使用 my-project？」→ 选「自定义名称」输入你想要的名称（不满意可改）
- 名称冲突时自动建议 `my-project-2` 或让你重输
- 自动完成本地 init + GitHub 建仓 + 首次提交推送

**② 改名**

> 把仓库名改成 better-name。

- agent 调用 `git_rename` → 确认 → GitHub 改名 + 本地 remote 同步（旧链接 301 重定向）

**③ 改代码后自动同步**

> 加一个参数解析功能。

- agent 改完代码调用 `git_sync` 提交推送；漏掉时回合结束自动兜底推送

---

## 安全设计

- **令牌零泄露**：git 凭据通过 `GIT_CONFIG_*` 环境变量注入 `http.extraheader`（Basic auth，`x-access-token` 用户名），不写 remote URL、不写 `.git/config`、不进进程命令行；所有 git/API 输出经脱敏
- **绝不 force push**：始终 `pull --rebase` + 普通 push，冲突停下交给你
- **敏感文件防护**：提交前扫描 `.env*`、`*.pem`、`id_rsa*`、`*.key` 等并阻止提交
- **状态目录自动忽略**：插件状态存于项目内 `.dsh-git-sync/`，建仓时自动写入 `.gitignore`
- **大文件告警**：超过阈值（默认 50MB，GitHub 上限 100MB）先确认再提交

## 插件状态存储

每个项目一个状态文件：`<workspace>/.dsh-git-sync/state.json`（仓库名、远程地址、最近同步等），已自动加入项目的 `.gitignore`，不会进入提交。

---

## 常见问题

| 现象 | 原因与解决 |
|---|---|
| 推送报 `remote: invalid credentials` | GitHub 的 git 协议端点只接受 **Basic auth**（插件已内置 `x-access-token` + 令牌的 Basic 注入）；若你手动改过，确保不要用 Bearer |
| 访问 api.github.com 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / git 报 `SEC_E_NO_CREDENTIALS` | 本机存在 TLS 证书链拦截（安全软件/代理）。设置 `github.insecureTls: true`（跳过证书校验 + git 换 openssl 后端），或修复本机证书信任 |
| 插件状态 `pending (waiting for services: ...)` | 插件 `inject` 声明了运行时不存在/不该声明的服务。本插件只声明 `tools/credentials/userQuestions`；`logger` 是 Cordis 内置、session 事件走 `ctx.on` |
| 插件「没加载」但启动无报错 | 首次加载失败被「启动恢复」自动禁用：检查 `startup-recovery/state.json` 的 `disabledBundles`，移除插件名后重启 |
| 找不到 `git` 命令 | 先安装 Git 并确保在 PATH 中 |
| 仓库名不合法/被占用 | `git_init` 会校验命名规则（1–100 字符、`-` `_` `.`、不能以 `.` 开头结尾）并在占用时建议后缀或让你重输 |

---

## 开发

```bash
npm install
npm run typecheck   # 类型检查
npm run build       # 构建到 lib/
```

真实令牌冒烟测试（建仓 → 推送 → 改名 → 清理，会在你的 GitHub 上创建临时仓库并自动删除）：

```bash
$env:DSH_GITHUB_SMOKE_TOKEN = "github_pat_..."
node scripts/smoke-github.mjs
```

## License

[MIT](./LICENSE)
