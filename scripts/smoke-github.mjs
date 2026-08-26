/**
 * 真实 GitHub 令牌冒烟测试（M1/M2 关键验证）
 *
 * 流程：建仓（API）→ 本地 init + commit → extraheader 注入推送 → 改名（API）
 *       → 更新 remote 再推送 → 验证新 URL → （尽力）清理
 *
 * 令牌来源（任选其一，避免进对话/命令行历史）：
 *   1. 环境变量：  $env:DSH_GITHUB_SMOKE_TOKEN = "github_pat_..."  然后 node scripts/smoke-github.mjs
 *   2. 参数：      node scripts/smoke-github.mjs --token=github_pat_...
 *
 * 令牌权限要求：fine-grained PAT（Administration 写、Contents 写、Metadata 读）
 *               或 classic PAT（repo 权限，含 delete_repo 以便清理）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRepo,
  describeGithubError,
  getUser,
  renameRepo,
  repoExists,
  validateRepoName,
} from "../lib/github/client.js";
import {
  addAll,
  addRemote,
  commit,
  currentBranch,
  gitInit,
  push,
  revParseHead,
  setRemoteUrl,
  statusPorcelain,
} from "../lib/git/ops.js";
import { resolveIdentity } from "../lib/git/identity.js";
import { setInsecureTls } from "../lib/tls.js";

// 本机存在 TLS 证书链拦截：启用插件的 insecureTls 开关（等价于配置 github.insecureTls=true）
setInsecureTls(true);
// 脚本自身的裸 fetch 也要走同样的 TLS 策略（与插件 apiFetch 一致）
const { Agent, setGlobalDispatcher } = await import("undici");
setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));

const argToken = process.argv.find((a) => a.startsWith("--token="))?.slice(8);
const token = process.env.DSH_GITHUB_SMOKE_TOKEN || argToken;
if (!token) {
  console.error("缺少令牌：请设置环境变量 DSH_GITHUB_SMOKE_TOKEN 或传 --token=...");
  process.exit(2);
}

const AUTH = "extraheader";
let failed = false;
function step(name, ok, extra = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failed = true;
}

// ---- 1. 令牌与账号 ----
const me = await getUser(token);
console.log(`账号: @${me.login}（令牌有效）`);

// ---- 1.5 清理历史残留的冒烟仓库（尽力而为；必须在建仓之前） ----
try {
  const listRes = await fetch(
    `https://api.github.com/user/repos?per_page=100&sort=created&direction=desc`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "dsh-plugin-git-sync",
      },
    },
  );
  if (listRes.ok) {
    const repos = (await listRes.json()).filter((r) =>
      r.name.startsWith("dsh-git-sync-smoke-"),
    );
    for (const repo of repos) {
      const del = await fetch(`https://api.github.com/repos/${me.login}/${repo.name}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "dsh-plugin-git-sync",
        },
      });
      if (del.ok || del.status === 204) console.log(`🧹 已清理残留冒烟仓库 ${repo.name}`);
      else console.log(`⚠️  无法清理 ${repo.name}（${del.status}，可能缺 delete_repo 权限）`);
    }
  }
} catch {
  // 清理失败不阻塞主流程
}

// ---- 2. 建仓 ----
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const repoName = `dsh-git-sync-smoke-${stamp}`;
const renamedName = `${repoName}-renamed`;
console.log(`\n计划仓库: ${me.login}/${repoName}（私有） → 改名 ${renamedName}`);

try {
  const repo = await createRepo(token, {
    owner: me.login,
    name: repoName,
    visibility: "private",
    description: "dsh-plugin-git-sync 冒烟测试（可删除）",
  });
  step("GitHub 建仓", true, repo.html_url);
} catch (error) {
  step("GitHub 建仓", false, describeGithubError(error));
  process.exit(1);
}

// ---- 3. 本地 init + commit + 推送（extraheader 注入） ----
const dir = await mkdtemp(join(tmpdir(), "dsh-git-sync-smoke-"));
await gitInit(dir, token, AUTH, "main");
const url = `https://github.com/${me.login}/${repoName}.git`;
const identity = resolveIdentity(
  {
    github: { username: me.login, visibility: "private", defaultBranch: "main" },
    auth: { method: AUTH },
    git: { committerName: "", committerEmail: "" },
    autoSync: true,
    askBeforeInit: true,
    init: { createGitignore: true, initialCommitMessage: "chore: initial commit" },
    safety: { scanForSecrets: true, maxFileSizeMb: 50 },
  },
  me.login,
);

try {
  await gitInit(dir, token, AUTH, "main");
  await writeFile(join(dir, "hello.txt"), "smoke test\n");
  await addAll(dir, token, AUTH);
  const hash = await commit(dir, token, AUTH, "chore: smoke initial", identity);
  await addRemote(dir, token, AUTH, url);
  const branch = await currentBranch(dir, token, AUTH);
  await push(dir, token, AUTH, branch, true);
  step("extraheader 注入推送（首次 push -u）", true, `commit ${hash.slice(0, 8)}`);
} catch (error) {
  step("extraheader 注入推送", false, error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// ---- 4. 改名 + 更新 remote + 再推送 ----
try {
  const renamed = await renameRepo(token, me.login, repoName, renamedName);
  const newUrl = `https://github.com/${me.login}/${renamedName}.git`;
  await setRemoteUrl(dir, token, AUTH, newUrl);
  await writeFile(join(dir, "hello2.txt"), "after rename\n");
  await addAll(dir, token, AUTH);
  await commit(dir, token, AUTH, "chore: after rename", identity);
  const branch = await currentBranch(dir, token, AUTH);
  await push(dir, token, AUTH, branch);
  const head = await revParseHead(dir, token, AUTH);
  step("改名 + remote set-url + 再推送", true, `${renamed.html_url} @ ${head.slice(0, 8)}`);

  // 验证：旧名应 301 重定向或 404（不跟随重定向），新名存在、remote URL 无令牌
  const oldCheck = await fetch(`https://api.github.com/repos/${me.login}/${repoName}`, {
    method: "GET",
    redirect: "manual",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "dsh-plugin-git-sync",
    },
  });
  const oldGone = oldCheck.status === 301 || oldCheck.status === 302 || oldCheck.status === 404;
  const newExists = await repoExists(token, me.login, renamedName);
  const remoteOut = await (await import("node:child_process")).execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir }).toString();
  const urlClean = !remoteOut.includes(token);
  step("旧仓库名已消失", oldGone);
  step("新仓库名存在", newExists);
  step("remote URL 不含令牌", urlClean, remoteOut.trim());
} catch (error) {
  step("改名流程", false, error instanceof Error ? error.message : String(error));
  failed = true;
}

// ---- 5. 清理（尽力而为：删除需要 delete_repo 权限） ----
try {
  const res = await fetch(`https://api.github.com/repos/${me.login}/${renamedName}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "dsh-plugin-git-sync",
    },
  });
  if (res.ok || res.status === 204) step("清理冒烟仓库", true);
  else step("清理冒烟仓库", false, `无 delete_repo 权限（${res.status}），请手动删除 ${me.login}/${renamedName}`);
} catch (error) {
  step("清理冒烟仓库", false, String(error));
}
await rm(dir, { recursive: true, force: true });

console.log(failed ? "\n冒烟测试有失败项" : "\n冒烟测试全部通过 🎉");
process.exit(failed ? 1 : 0);
