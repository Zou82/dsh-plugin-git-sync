import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskToken } from "../github/token.js";
import { isInsecureTls } from "../tls.js";

/**
 * git process runner.
 *
 * Credential injection (never in argv, never persisted, never in URLs):
 *  - "extraheader": GIT_CONFIG_COUNT/KEY_0/VALUE_0 env vars set
 *    http.extraheader = "Authorization: Bearer <token>" for this process only.
 *  - "askpass": a temporary script echoes the token when git prompts
 *    (fallback; primarily useful on non-Windows).
 */

export type AuthMethod = "extraheader" | "askpass";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the process was killed by the configured timeoutMs. */
  timedOut?: boolean;
}

/** Typed git failure; stderr/stdout are already token-masked. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code: number,
    readonly stderr: string,
    readonly conflict: boolean = false,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunOptions {
  cwd: string;
  token?: string;
  authMethod: AuthMethod;
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
}

function buildGitEnv(opts: RunOptions): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    ...opts.extraEnv,
  };
  let count = 0;
  if (opts.token && opts.authMethod === "extraheader") {
    // GitHub's git smart-HTTP endpoint accepts Basic auth with the token as
    // password and "x-access-token" as username (Bearer only works on the
    // REST API). Base64 so the token is not trivially readable in env dumps.
    const basic = Buffer.from(`x-access-token:${opts.token}`).toString("base64");
    env[`GIT_CONFIG_KEY_${count}`] = "http.extraheader";
    env[`GIT_CONFIG_VALUE_${count}`] = `AUTHORIZATION: basic ${basic}`;
    count++;
  }
  if (isInsecureTls()) {
    // Machines whose TLS chain is intercepted: schannel breaks with
    // SEC_E_NO_CREDENTIALS, so force the openssl backend and skip
    // verification for this process only (per github.insecureTls config).
    env[`GIT_CONFIG_KEY_${count}`] = "http.sslbackend";
    env[`GIT_CONFIG_VALUE_${count}`] = "openssl";
    count++;
    env[`GIT_CONFIG_KEY_${count}`] = "http.sslVerify";
    env[`GIT_CONFIG_VALUE_${count}`] = "false";
    count++;
  }
  if (count > 0) env.GIT_CONFIG_COUNT = String(count);
  return env;
}

/** Write a temporary GIT_ASKPASS script for the current platform. */
async function writeAskpassScript(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-git-sync-askpass-"));
  const file = join(dir, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
  const body =
    process.platform === "win32"
      ? `@echo off\r\necho ${token}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${token}'\n`;
  await writeFile(file, body, { mode: 0o600 });
  return file;
}

/** Run `git <args>` in opts.cwd and resolve with masked output. */
export function runGit(args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = buildGitEnv(opts);
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(
        new GitError(`git 启动失败: ${error.message}`, args.join(" "), -1, ""),
      );
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: maskToken(stdout, opts.token),
        stderr: maskToken(stderr, opts.token),
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
}

/**
 * Run git and throw GitError on non-zero exit. stderr/stdout are masked.
 * A rebase/pull conflict is surfaced via `conflict: true`.
 */
export async function git(args: string[], opts: RunOptions): Promise<RunResult> {
  const result = await runGit(args, opts);
  if (result.code !== 0) {
    // A killed-by-timeout process reports an opaque exit code / empty stderr:
    // surface the actual cause instead of "失败 (exit -1)".
    const message = result.timedOut
      ? `git ${args[0]} 超时（${opts.timeoutMs}ms），已终止进程`
      : result.stderr.trim() || `git ${args[0]} 失败 (exit ${result.code})`;
    const conflict =
      !result.timedOut &&
      /CONFLICT|conflict|Automatic merge failed|pull is not possible|have diverged/i.test(
        result.stderr + result.stdout,
      );
    throw new GitError(message, args.join(" "), result.code, result.stderr, conflict);
  }
  return result;
}

/** Run git with askpass injection (used when authMethod === "askpass"). */
export async function gitWithAskpass(
  args: string[],
  opts: RunOptions,
): Promise<RunResult> {
  if (!opts.token) return git(args, opts);
  const script = await writeAskpassScript(opts.token);
  try {
    return await git(args, {
      ...opts,
      extraEnv: { GIT_ASKPASS: script },
    });
  } finally {
    await rm(join(script, ".."), { recursive: true, force: true });
  }
}

/** Dispatch on the configured auth method. */
export function gitAuth(args: string[], opts: RunOptions): Promise<RunResult> {
  return opts.authMethod === "askpass"
    ? gitWithAskpass(args, opts)
    : git(args, opts);
}
