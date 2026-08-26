import type { Ctx } from "../types.js";

/**
 * GitHub token handling through the dsh-credentials seam.
 * Settings/config only ever carry a *reference*; the provider owns the value.
 */

/** Reference name used in settings (an env-var-style identifier). */
export const TOKEN_REF = "GITHUB_TOKEN";

/** Credential key halves for record-backed providers (scope/id). */
export const CREDENTIAL_SCOPE = "git-sync";
export const CREDENTIAL_ID = "github-token";

/** Resolve the GitHub token for one operation. Returns undefined when unconfigured. */
export async function resolveToken(ctx: Ctx): Promise<string | undefined> {
  const resolved = await ctx.credentials.resolve(TOKEN_REF);
  return resolved?.value && resolved.value.length > 0 ? resolved.value : undefined;
}

/** Status for settings surfaces ("configured / source / writable"). */
export async function describeToken(ctx: Ctx) {
  return ctx.credentials.describe(TOKEN_REF);
}

/**
 * Redact every occurrence of the token from text (git output, error messages).
 * Safe to call with undefined token (no-op).
 */
export function maskToken(text: string, token: string | undefined): string {
  if (!token || token.length < 4) return text;
  return text.split(token).join("***");
}

/** Convenience: mask a value against a possibly-undefined token. */
export function mask(value: unknown, token: string | undefined): string {
  return maskToken(String(value), token);
}
