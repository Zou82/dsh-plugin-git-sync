# Changelog

本插件所有显著变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.1] - 2026-08-27

### 修复
- **git_sync 的 include 参数实现落地**：此前仅声明未实现；现按「路径前缀（含子目录）或裸文件名」定向 `git add -- <paths>`，敏感文件/大文件检查与 files_changed 同步限定在该范围内，无匹配时返回明确提示
- **porcelain 解析重写**：改用 `git status --porcelain=v1 -z` 按 NUL 解析——中文/空格文件名不再变成 C 转义形式；重命名条目取新路径而非「旧 -> 新」字符串，修复大文件检查静默跳过与提交摘要失真
- **三条同步路径互斥**：新增工作区级锁串行化 git_sync / 回合结束兜底 / 文件监听，消除并发 add-commit-pull-push 交错导致的 index.lock 冲突与空提交报错
- **自动同步大文件守卫**：回合结束与文件监听同步复用 oversizedFiles 检查，超限跳过并告警，避免超过 GitHub 上限的文件卡死后续所有推送
- **插件卸载资源清理**：dispose 时关闭全部 fs.watch 句柄、防抖定时器与轮询 interval，不再泄漏
- **后台 rebase 冲突自愈**：pull --rebase 冲突时自动 `rebase --abort`（autostash 自动恢复本地改动），仓库不再卡在半途 rebase 态
- **网络命令硬超时**：pull/push 增加 10 分钟兜底超时，挂起时终止进程并给出明确错误（原 timeoutMs 机制从未被启用）
- **insecureTls 回退修复**：undici 导入失败时回退默认 TLS 校验栈，不再把 `dispatcher: null` 传给 fetch 导致全部请求异常
- **后台推送统一带 -u**：无上游配置的分支也能被自动同步首次推送，不再每轮静默失败
- **ahead/behind 兜底修正**：无 upstream 时回退比较 origin/<branch>，仍不可得则将本地历史计为 ahead——未推送的新分支不再显示「已同步」
- 设置卡片补上缺失的 `fileWatcher.pollMs` 字段（此前仅 host 配置和文档可见）
- 提交摘要 describeFiles 按实际文件去重（部分暂存且继续修改的文件不再重复计数）
- 新增 `scripts/smoke-fixes.mjs` 功能冒烟测试（解析器单测 + 真实仓库场景）

## [0.5.0] - 2026-08-27

### 新增
- **现有仓库采纳**：`git_init` 遇到已有 git 仓库时，询问用户是否关联到 GitHub（建仓 + 关联 remote + 推送现有内容；空仓库自动补首次提交）
- **描述性提交信息**：兜底提交（回合结束 / 文件监听）从固定 `chore: auto-sync` 改为带变更文件摘要（如 `chore: auto-sync (app.py, README.md, +2 more)`）
- **Conventional Commits 引导**：配置 `commit.conventional`（默认开启）+ 工具描述引导 agent 使用 `feat/fix/chore(scope): summary`
- **自定义忽略规则**：`fileWatcher.ignore`（默认 `dist/build/__pycache__/.venv/...`），设置卡片可编辑
- **轮询回退**：`fs.watch` 不可用时自动切换轻量轮询（`fileWatcher.pollMs`，仅 `git status` 检查，不扫描文件内容）
- **冲突文件清单**：`pull --rebase` 冲突时列出冲突文件与恢复步骤（`git add` → `rebase --continue`）
- **任务分支**：`git_sync` 新增 `create_branch` 参数，基于当前 HEAD 建分支并推送

## [0.4.0] - 2026-08-26

### 新增
- **文件监听（保存即同步）**：会话工作区文件变化（保存/编辑）后防抖自动提交推送，不再只等回合结束
  - 仅作用于插件建过的仓库，且需 `autoSync: true`
  - 忽略 `.git` / `.dsh-git-sync` / `node_modules`，避免自触发循环
  - 敏感文件扫描仍生效
- 配置：`fileWatcher.enabled`（默认 true）、`fileWatcher.debounceMs`（默认 1500）

## [0.3.0] - 2026-08-26

### 修复
- **会话工作区解析**：工具执行上下文没有顶层 `cwd`，原先会回退到 `process.cwd()`（宿主进程目录，可能指向 DSH 应用安装目录）
  - 现与官方 bash 工具一致，通过 `exec.agent.session.header.cwd` 解析真实会话工作区
  - 生命周期钩子通过 `session.header.cwd` 解析
  - 此前在真实会话中 `git_init` / `git_sync` 可能操作错误目录，「每次修改自动同步」无从成立

## [0.2.2] - 2026-08-26

### 变更
- 设置卡片支持**展开/合拢**（标题栏箭头切换，默认收起；未保存徽标移至标题栏）

## [0.2.1] - 2026-08-26

### 修复
- 设置卡片样式注入的 `querySelector` 选择器引号错误导致浏览器端加载失败

## [0.2.0] - 2026-08-26

### 新增
- **GUI 配置卡片**：浏览器端 client half，在「设置 → 插件 → 插件配置」渲染「GitHub 同步」卡片
  - 全部配置项可编辑并实时生效（宿主端注册 `git-sync` 设置命名空间）
  - GitHub 令牌可通过卡片直接配置（只写不读，凭据存储）
- 工具层改为运行时读取配置（GUI 修改无需重启）

## [0.1.3] - 2026-08-26

### 修复
- `session/event` 监听器参数错误（事件为双参数 `(session, event)`，原实现按数组解构导致 `payload is not iterable` 刷屏）

## [0.1.2] - 2026-08-26

### 修复
- `inject` 收紧为 `["tools", "credentials", "userQuestions"]`（`logger` 为 Cordis 内置、`session` 事件走 `ctx.on`，声明它们会导致插件 `pending (waiting for services)`）

## [0.1.1] - 2026-08-26

### 修复
- 补上桌面端 bundle 必需声明：`dsh.bundle.patch` + `cordis.patch.yml`（否则「declares no dsh.bundle」加载失败）

## [0.1.0] - 2026-08-26

### 新增
- 核心工具：`git_init`（询问建仓、仓库名确认/自定义、冲突处理）、`git_rename`（建仓后改名）、`git_sync`（提交推送，pull-rebase 冲突停下，绝不 force push）、`git_status`
- 回合结束兜底自动同步（`autoSync`）
- 凭据安全：令牌经 `dsh-credentials` 存储，git 通过 `GIT_CONFIG_*` 环境变量注入 Basic auth，输出全量脱敏
- 提交前敏感文件扫描、大文件告警
- 自动设置 repo-local 提交身份（不动全局配置）
- 真实令牌冒烟测试（scripts/smoke-github.mjs）
