/**
 * GitHub REST API client (minimal surface: user, repo create/check/rename).
 * The token is only ever sent in the Authorization header of HTTPS requests.
 */

import { isInsecureTls } from "../tls.js";

const API = "https://api.github.com";

/** Lazy undici Agent used only when github.insecureTls is enabled. */
let insecureAgent: unknown;
async function getInsecureAgent() {
  if (isInsecureTls() && insecureAgent === undefined) {
    try {
      const { Agent } = await import("undici");
      insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
    } catch {
      insecureAgent = null; // undici unavailable — fall back to default TLS
    }
  }
  return isInsecureTls() ? insecureAgent : undefined;
}

export interface GithubUser {
  login: string;
}

export interface GithubRepo {
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
}

/** Classified GitHub API failure. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly apiCode?: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

/**
 * Validate a repository name against GitHub rules.
 * Returns null when valid, otherwise a Chinese human-readable reason.
 */
export function validateRepoName(name: string): string | null {
  if (!name || name.length === 0) return "名称不能为空";
  if (name.length > 100) return "长度不能超过 100 字符";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "只能包含字母、数字、点、连字符、下划线";
  if (name.startsWith(".") || name.endsWith(".")) return "不能以点开头或结尾";
  if (name.includes("..")) return "不能包含连续的两个点";
  return null;
}

/**
 * Normalize an arbitrary base string into a plausible repo name:
 * lowercase, non-alphanumeric runs -> "-", strip leading/trailing separators.
 */
export function sanitizeRepoName(base: string): string {
  const cleaned = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");
  return cleaned.length > 100 ? cleaned.slice(0, 100) : cleaned;
}

async function apiFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  let response: Response;
  try {
    const dispatcher = await getInsecureAgent();
    response = await fetch(`${API}${path}`, {
      ...init,
      ...(dispatcher !== undefined ? { dispatcher } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "dsh-plugin-git-sync",
        ...init.headers,
      },
    });
  } catch (error) {
    throw new GithubError(`GitHub API 请求失败（网络错误）: ${String(error)}`);
  }
  const text = await response.text();
  let body: any = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!response.ok) {
    const message =
      (body?.message as string) ?? `GitHub API ${response.status}`;
    throw new GithubError(message, response.status, body?.errors?.[0]?.code);
  }
  return { status: response.status, body };
}

/** Current authenticated user (used when github.username is not configured). */
export async function getUser(token: string): Promise<GithubUser> {
  const { body } = await apiFetch("/user", token);
  return body as GithubUser;
}

/** Whether a repo exists under owner/name (404 -> false). */
export async function repoExists(
  token: string,
  owner: string,
  name: string,
): Promise<boolean> {
  try {
    await apiFetch(`/repos/${owner}/${name}`, token);
    return true;
  } catch (error) {
    if (error instanceof GithubError && error.status === 404) return false;
    throw error;
  }
}

/** Create a repository (personal namespace, or org when owner is an org). */
export async function createRepo(
  token: string,
  opts: {
    owner: string;
    name: string;
    visibility: "private" | "public";
    description?: string;
  },
): Promise<GithubRepo> {
  const isOrg = opts.owner !== (await getUser(token)).login;
  const path = isOrg ? `/orgs/${opts.owner}/repos` : "/user/repos";
  const { body } = await apiFetch(path, token, {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      private: opts.visibility === "private",
      ...(opts.description ? { description: opts.description } : {}),
    }),
  });
  return body as GithubRepo;
}

/** Rename a repository; GitHub redirects the old URL (301) afterwards. */
export async function renameRepo(
  token: string,
  owner: string,
  name: string,
  newName: string,
): Promise<GithubRepo> {
  const { body } = await apiFetch(`/repos/${owner}/${name}`, token, {
    method: "PATCH",
    body: JSON.stringify({ name: newName }),
  });
  return body as GithubRepo;
}

/** Human-readable guidance for classified API errors. */
export function describeGithubError(error: unknown): string {
  if (!(error instanceof GithubError)) return `未知错误: ${String(error)}`;
  switch (error.status) {
    case 401:
      return "GitHub 令牌无效或已过期：请在设置中重新配置 GITHUB_TOKEN";
    case 403:
      return "GitHub 令牌权限不足：需要 Administration(写) 与 Contents(写) 权限（或 classic PAT 的 repo 权限）";
    case 404:
      return "GitHub 资源不存在（可能仓库已被删除）";
    case 422:
      return `GitHub 拒绝该操作（名称可能不合法或已被占用）: ${error.message}`;
    default:
      return `GitHub API 错误 ${error.status ?? "?"}: ${error.message}`;
  }
}
