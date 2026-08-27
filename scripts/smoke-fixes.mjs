// Functional smoke for 0.5.1 fixes: porcelain -z parsing (renames,
// non-ASCII names), aheadBehind fallback without upstream, oversized files
// and the workspace lock.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

let failed = 0;
function expect(cond, msg) {
  console.log((cond ? "PASS" : "FAIL") + ":", msg);
  if (!cond) failed++;
}

// ---------- part 1: pure parser ----------
// A -z stream separates RECORDS with NUL; each record is "XY<space>path".
// Rename/copy records are followed by one extra NUL-delimited field (old path).
const { parseStatusZ } = await import("../lib/git/ops.js");

const SAMPLE =
  [
    "?? \u65b0\u8ddf\u8e2a\u6587\u4ef6.md",
    "R  \u65b0\u540d\u5b57.txt", "old.txt",
    ".M app.py",
    "UU merge-me.txt",
  ].join("\0") + "\0";

{
  const parsed = parseStatusZ(SAMPLE);
  console.log("PARSED:", JSON.stringify(parsed));
  expect(parsed.untracked.includes("\u65b0\u8ddf\u8e2a\u6587\u4ef6.md"), "parser keeps raw UTF-8 untracked names");
  expect(parsed.staged.includes("\u65b0\u540d\u5b57.txt"), "rename record yields NEW path in staged");
  expect(!parsed.staged.concat(parsed.unstaged, parsed.untracked).some((p) => p.includes("->")),
    "no ' -> ' artifact");
  expect(!parsed.unstaged.includes("old.txt") && !parsed.staged.includes("old.txt"),
    "rename origin field consumed, not emitted as a path");
  expect(parsed.unstaged.includes("app.py"), "worktree-only modification lands in unstaged");
  expect(parsed.staged.includes("merge-me.txt") && parsed.unstaged.includes("merge-me.txt"),
    "unmerged entry appears in both buckets");
}

{
  const parsed = parseStatusZ("?? solo.css\0");
  expect(parsed.untracked.includes("solo.css") && parsed.staged.length === 0 && parsed.unstaged.length === 0,
    "trailing NUL tolerated");
}
{
  const parsed = parseStatusZ("");
  expect(parsed.staged.length + parsed.unstaged.length + parsed.untracked.length === 0, "empty output");
}

// ---------- part 2: real repo via runGit ----------
const root = join(tmpdir(), "dsh-git-sync-smoke-" + Date.now());
mkdirSync(root);
const git = (...args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0 || r.error) {
    throw new Error(`git ${args.join(" ")} failed: ${r.status} ${r.stderr || r.error}`);
  }
};

try {
  git("init", "-b", "main");
  git("config", "user.name", "smoke-test");
  git("config", "user.email", "smoke@example.invalid");
  writeFileSync(join(root, "old.txt"), "one\n");
  git("add", ".");
  git("commit", "-m", "init");
  git("mv", "old.txt", "\u65b0\u540d\u5b57.txt");   // staged non-ASCII rename
  writeFileSync(join(root, "\u65b0\u8ddf\u8e2a.md"), "# hi\n");

  const ops = await import("../lib/git/ops.js");
  const status = await ops.statusPorcelain(root, undefined, "extraheader");
  console.log("STATUS:", JSON.stringify(status));
  expect(status.staged.includes("\u65b0\u540d\u5b57.txt") && !status.staged.some((p) => p.includes("->")),
    "runtime porcelain parses staged rename correctly");
  expect(status.untracked.includes("\u65b0\u8ddf\u8e2a.md"), "runtime porcelain keeps Chinese untracked name intact");

  // oversizedFiles through its own status query
  const bigBytes = Buffer.alloc(2 * 1024 * 1024, 7);
  writeFileSync(join(root, "\u5927\u6587\u4ef6.bin"), bigBytes);
  const oversizeQuery = await ops.oversizedFiles(root, undefined, "extraheader", 1);
  console.log("OVERSIZE(query):", JSON.stringify(oversizeQuery));
  expect(oversizeQuery.some((entry) => entry.path === "\u5927\u6587\u4ef6.bin"),
    "oversizedFiles self-query resolves non-ASCII path");

  // and through explicit candidates (background-sync style)
  const oversizeCands = await ops.oversizedFiles(
    root, undefined, "extraheader", 1,
    ["\u65b0\u540d\u5b57.txt", "\u65b0\u8ddf\u8e2a.md", "\u5927\u6587\u4ef6.bin"],
  );
  expect(oversizeCands.length === 1 && oversizeCands[0].path === "\u5927\u6587\u4ef6.bin",
    "oversizedFiles candidate-list form filters precisely");

  // aheadBehind with NO upstream: whole local history counts as ahead=1, behind=0
  const ab = await ops.aheadBehind(root, undefined, "extraheader", "main");
  console.log("AHEAD/BEHIND:", JSON.stringify(ab));
  expect(ab.ahead === 1 && ab.behind === 0, "aheadBehind fallback reports history as ahead");

  // isSecretPath parity with previous regexes
  expect(ops.isSecretPath(".env.local") && ops.isSecretPath("src/secret.key") &&
         !ops.isSecretPath("src/app.py"), "isSecretPath patterns behave");
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ---------- part 3: workspace lock ----------
const { withWorkspaceLock } = await import("../lib/state/lock.js");
{
  let active = 0;
  let maxActive = 0;
  const runs = Array.from({ length: 5 }, () =>
    withWorkspaceLock("smoke-ws", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 50));
      active--;
    }),
  );
  await Promise.all(runs);
  expect(maxActive === 1, `workspace lock keeps concurrency at 1 (got ${maxActive})`);
  let survived;
  await withWorkspaceLock("smoke-ws-throw", async () => { throw new Error("boom"); })
    .catch((error) => { survived = error; });
  const next = await withWorkspaceLock("smoke-ws-throw", async () => "after-failure");
  expect(survived instanceof Error && next === "after-failure",
    "chain continues after a rejected predecessor");
}

console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
