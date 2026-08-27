/**
 * Submit dsh-plugin-git-sync to the awesome-dsh-plugin curated list.
 *
 * Preconditions (CI bar — verified automatically before submitting):
 *   - repository age >= 1 day
 *   - commit count  >= 10
 *   - package.json declares `dsh.bundle` (already satisfied)
 *
 * Usage:
 *   node scripts/submit-awesome.mjs
 *
 * Token: read from $env:GITHUB_TOKEN or DSH credentials (GITHUB_TOKEN ref).
 * The token needs: fork + Contents write on the fork + Pull requests write
 * on the awesome repo. If the PR API call is denied, the script prints the
 * one-click "compare" URL to open the pull request in a browser.
 *
 * Files submitted (from the local awesome-dsh-plugin checkout):
 *   data/plugins/BoneLight666__dsh-plugin-git-sync.yml  (the entry)
 *   README.md / README.zh.md                            (regenerated)
 * Point at the checkout with $env:AWESOME_CHECKOUT, or it defaults to the
 * Downloads extraction path used during preparation.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setInsecureTls } from "../lib/tls.js";

setInsecureTls(true);
const { Agent, setGlobalDispatcher } = await import("undici");
setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));

const OWNER = "BoneLight666";
const REPO = "dsh-plugin-git-sync";
const AWESOME_OWNER = "awesome-dsh-plugin";
const AWESOME_REPO = "awesome-dsh-plugin";
const ENTRY_FILE = `data/plugins/${OWNER}__${REPO}.yml`;
const BRANCH = `add-${REPO}`;

const AWESOME_CHECKOUT =
  process.env.AWESOME_CHECKOUT ??
  join(homedir(), "Downloads", "awesome-dsh-plugin-main", "awesome-dsh-plugin-main");

// ---- token ----
function tokenFromCredentials() {
  try {
    const text = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
    const m = /^\s*GITHUB_TOKEN:\s*(\S+)/m.exec(text);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}
const TOKEN = process.env.GITHUB_TOKEN || tokenFromCredentials();
if (!TOKEN) {
  console.error("缺少令牌：设置 GITHUB_TOKEN 环境变量，或在 DSH 凭据中配置 GITHUB_TOKEN");
  process.exit(2);
}

const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "dsh-plugin-git-sync",
};

async function api(path, init) {
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers: { ...HEADERS, ...(init?.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---- 1. precondition: repo age + commits ----
const repo = (await api(`/repos/${OWNER}/${REPO}`)).body;
const ageDays = (Date.now() - new Date(repo.created_at).getTime()) / 86400000;
let commits = 0;
for (let page = 1; ; page++) {
  const res = await api(`/repos/${OWNER}/${REPO}/commits?per_page=100&page=${page}`);
  if (!Array.isArray(res.body) || res.body.length === 0) break;
  commits += res.body.length;
  if (res.body.length < 100) break;
}
console.log(`仓库年龄: ${ageDays.toFixed(2)} 天（要求 >=1）; 提交数: ${commits}（要求 >=10）`);
if (ageDays < 1) console.error("❌ 仓库未满 1 天，CI 会拒绝；请明天再运行。");
if (commits < 10) console.error("❌ 提交数不足 10，CI 会拒绝；请补充真实开发提交后重试。");
if (ageDays < 1 || commits < 10) process.exit(1);

// ---- 2. local files exist ----
const entryPath = join(AWESOME_CHECKOUT, ENTRY_FILE);
const readmePath = join(AWESOME_CHECKOUT, "README.md");
const readmeZhPath = join(AWESOME_CHECKOUT, "README.zh.md");
for (const p of [entryPath, readmePath, readmeZhPath]) {
  if (!existsSync(p)) {
    console.error(`缺少文件: ${p}`);
    process.exit(1);
  }
}
if (!readFileSync(readmePath, "utf8").includes(`${OWNER}/${REPO}`)) {
  console.error("README 未包含本条目，请先运行 `node scripts/generate-readme.mjs` 再提交");
  process.exit(1);
}

// ---- 3. fork ----
const fork = await api(`/repos/${AWESOME_OWNER}/${AWESOME_REPO}/forks`, { method: "POST" });
if (fork.status !== 202 && fork.status !== 200) {
  console.error(`fork 失败 (${fork.status}): ${JSON.stringify(fork.body)}`);
  process.exit(1);
}
const forkName = fork.body.full_name || `${OWNER}/${AWESOME_REPO}`;
console.log(`fork: ${forkName}`);

// ---- 4. clone fork, add files, push branch (git CLI with token injection) ----
const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "http.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  GIT_CONFIG_KEY_1: "http.sslbackend",
  GIT_CONFIG_VALUE_1: "openssl",
  GIT_CONFIG_KEY_2: "http.sslVerify",
  GIT_CONFIG_VALUE_2: "false",
};
const work = mkdtempSync(join(tmpdir(), "awesome-submit-"));
const run = (args, opts = {}) => execFileSync("git", args, { env: gitEnv, stdio: "inherit", ...opts });
try {
  run(["clone", "--depth", "1", `https://github.com/${forkName}.git`, work]);
  // overwrite with our prepared files
  for (const [src, rel] of [
    [entryPath, ENTRY_FILE],
    [readmePath, "README.md"],
    [readmeZhPath, "README.zh.md"],
  ]) {
    copyFileSync(src, join(work, rel));
  }
  run(["checkout", "-b", BRANCH], { cwd: work });
  run(["add", ENTRY_FILE, "README.md", "README.zh.md"], { cwd: work });
  run([
    "-c", "user.name=dsh-agent",
    "-c", "user.email=dsh-agent@users.noreply.github.com",
    "commit", "-m", `Add ${OWNER}/${REPO}`,
  ], { cwd: work });
  run(["push", "origin", BRANCH], { cwd: work });
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ---- 5. open the pull request ----
const pr = await api(`/repos/${AWESOME_OWNER}/${AWESOME_REPO}/pulls`, {
  method: "POST",
  body: JSON.stringify({
    title: `Add ${OWNER}/${REPO}`,
    head: `${OWNER}:${BRANCH}`,
    base: "main",
    body: `Adds [${OWNER}/${REPO}](https://github.com/${OWNER}/${REPO}) to the Git & Code Review category.\n\n- declares \`dsh.bundle\` in package.json\n- git_init / git_rename / git_sync / git_status tools + turn-end auto-sync + settings card\n- READMEs regenerated via \`node scripts/generate-readme.mjs\``,
  }),
});
if (pr.status === 201) {
  console.log(`✅ PR 已创建: ${pr.body.html_url}`);
} else {
  const compare = `https://github.com/${AWESOME_OWNER}/${AWESOME_REPO}/compare/main...${OWNER}:${BRANCH}?expand=1`;
  console.log(`PR 创建被拒 (${pr.status}): ${pr.body.message || ""}`);
  console.log(`分支已推送。请打开以下链接一键创建 PR:`);
  console.log(compare);
}
