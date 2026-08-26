/**
 * Module-level TLS policy for machines whose TLS chain is intercepted
 * (e.g. some security software / corporate MITM): api.github.com fails with
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE and git's schannel backend breaks.
 *
 * Opt-in via config `github.insecureTls`. When on:
 *  - the GitHub REST client skips certificate verification (undici Agent)
 *  - git receives http.sslbackend=openssl + http.sslVerify=false per process
 *
 * Off by default: never relax TLS unless the user explicitly asks.
 */
let insecureTls = false;

export function setInsecureTls(value: boolean): void {
  insecureTls = value;
}

export function isInsecureTls(): boolean {
  return insecureTls;
}
