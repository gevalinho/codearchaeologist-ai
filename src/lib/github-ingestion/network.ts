import "server-only";
import { resolve4 } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { request } from "node:https";

export type GitHubHost = "api.github.com" | "raw.githubusercontent.com" | "github.com";
export type FixedRequestOptions = { method?: "GET" | "POST"; bearer?: string; body?: string; contentType?: string; oauthJson?: true; repositoryMove?: true };
export type FixedHostFetch = (host: GitHubHost, path: string, maxBytes: number, signal: AbortSignal, options?: FixedRequestOptions) => Promise<Buffer>;
export type OAuthNetworkCategory = "dns" | "dns_policy" | "tls" | "connection" | "timeout" | "redirect" | "http" | "response_limit" | "cancelled" | "request";
export class OAuthNetworkFailure extends Error {
  constructor(readonly category: OAuthNetworkCategory, readonly httpStatus?: number, readonly providerCode?: string) {
    super("GitHub OAuth token exchange failed."); this.name = "OAuthNetworkFailure";
  }
}
export class GitHubHttpFailure extends Error {
  constructor(readonly status: number) { super(`GitHub request failed with HTTP ${status}.`); this.name = "GitHubHttpFailure"; }
}
const providerCodes = new Set(["incorrect_client_credentials", "redirect_uri_mismatch", "bad_verification_code", "bad_refresh_token", "access_denied", "invalid_request", "unsupported_grant_type", "unverified_user_email"]);
export function safeOAuthProviderCode(value: unknown): string | undefined { return typeof value === "string" && providerCodes.has(value) ? value : undefined; }
export function oauthProviderCode(body: Buffer): string | undefined {
  try { return safeOAuthProviderCode((JSON.parse(body.toString("utf8")) as { error?: unknown }).error); } catch { return undefined; }
}
export function oauthTransportCategory(code: unknown): OAuthNetworkCategory {
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (typeof code === "string" && (/^ERR_TLS_|^CERT_|^UNABLE_TO_VERIFY|^DEPTH_ZERO_SELF_SIGNED_CERT|^SELF_SIGNED_CERT/.test(code))) return "tls";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") return "connection";
  return "connection";
}

export function publicIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && c === 0 || a === 192 && b === 0 && c === 2 || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function pinnedPublicAddress(addresses: string[]): string {
  if (!addresses.length || addresses.some(address => !publicIPv4(address))) throw new Error("GitHub DNS resolution did not return only public addresses.");
  return addresses[0];
}

/** Node may request one address or an array when auto-select-family enables all lookups. */
export function pinnedLookup(address: string) {
  return (_hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, result: string | LookupAddress[], family?: number) => void): void => {
    if (options.all === true) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}

export function requireSuccessfulGitHubStatus(status: number, method: "GET" | "POST" = "GET"): void {
  if (status >= 300 && status < 400) throw new Error("GitHub redirected to an unapproved destination.");
  if (status === 403 || status === 429) throw new Error("GitHub rate limit or access policy blocked this request. Retry later.");
  if (status === 404) throw new Error("Public GitHub repository or source file was not found.");
  if (status !== 200 && !(method === "POST" && status === 201)) throw new GitHubHttpFailure(status);
}

/** A renamed public repository's metadata endpoint may move to GitHub's numeric API identity. */
export function approvedRepositoryMove(host: GitHubHost, path: string, status: number, location: string | string[] | undefined, options: FixedRequestOptions): string | null {
  if (!options.repositoryMove || host !== "api.github.com" || !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(path) || status !== 301 || options.method && options.method !== "GET" || options.bearer || options.body || options.oauthJson || typeof location !== "string") return null;
  let url: URL;
  try { url = new URL(location); } catch { return null; }
  return url.protocol === "https:" && url.hostname === "api.github.com" && !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/repositories\/[1-9]\d{0,19}$/.test(url.pathname) ? url.pathname : null;
}

export function githubAccept(host: GitHubHost, path: string, options: FixedRequestOptions = {}): string {
  if (options.oauthJson) {
    if (host !== "github.com" || path !== "/login/oauth/access_token" || options.method !== "POST") throw new Error("OAuth response format is restricted to token exchange.");
    return "application/json";
  }
  return host === "raw.githubusercontent.com" ? "application/octet-stream" : "application/vnd.github+json";
}

export function githubRequestHeaders(host: GitHubHost, path: string, options: FixedRequestOptions = {}): Record<string, string | number> {
  return { "User-Agent": "CodeArchaeologistAI-RepositoryScanner", Accept: githubAccept(host, path, options), "Accept-Encoding": "identity", ...(host === "api.github.com" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}), ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}), ...(options.contentType ? { "Content-Type": options.contentType } : {}), ...(options.body !== undefined ? { "Content-Length": Buffer.byteLength(options.body, "utf8") } : {}) };
}

/** Resolves once, rejects non-public answers, pins the chosen IP, and keeps TLS hostname verification. */
export const fixedHostFetch: FixedHostFetch = async (host, path, maxBytes, signal, options = {}) => {
  if (host !== "api.github.com" && host !== "raw.githubusercontent.com" && host !== "github.com") throw new Error("Unapproved GitHub download host.");
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f]/.test(path) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error("Invalid GitHub request.");
  if (options.method && options.method !== "GET" && options.method !== "POST" || options.bearer && /[\r\n]/.test(options.bearer) || options.body && Buffer.byteLength(options.body) > 4_096) throw new Error("Invalid GitHub request options.");
  const headers = githubRequestHeaders(host, path, options);
  if (signal.aborted) throw new Error("GitHub acquisition cancelled.");
  let addresses: string[];
  try { addresses = await resolve4(host); } catch { if (options.oauthJson) throw new OAuthNetworkFailure("dns"); throw new Error("GitHub DNS resolution failed."); }
  if (signal.aborted) throw new Error("GitHub acquisition cancelled.");
  let pinnedAddress: string;
  try { pinnedAddress = pinnedPublicAddress(addresses); } catch { if (options.oauthJson) throw new OAuthNetworkFailure("dns_policy"); throw new Error("GitHub DNS resolution did not return only public addresses."); }
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false, redirecting = false;
    const finish = (error?: Error, data?: Buffer) => { if (settled) return; settled = true; signal.removeEventListener("abort", cancelled); if (error) reject(error); else resolve(data!); };
    const req = request({ protocol: "https:", hostname: host, servername: host, port: 443, path, method: options.method ?? "GET", agent: false, rejectUnauthorized: true,
      lookup: pinnedLookup(pinnedAddress),
      headers,
    }, response => {
      const status = response.statusCode ?? 0;
      const movedPath = approvedRepositoryMove(host, path, status, response.headers.location, options);
      if (movedPath) {
        redirecting = true;
        response.destroy();
        void fixedHostFetch("api.github.com", movedPath, maxBytes, signal).then(data => finish(undefined, data), error => finish(error instanceof Error ? error : new Error("GitHub connection failed.")));
        return;
      }
      if (options.oauthJson && status !== 200) {
        const category: OAuthNetworkCategory = status >= 300 && status < 400 ? "redirect" : "http";
        const announced = Number(response.headers["content-length"]);
        if (Number.isFinite(announced) && announced > maxBytes) { response.destroy(); finish(new OAuthNetworkFailure("response_limit", status)); return; }
        let size = 0; const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { response.destroy(); finish(new OAuthNetworkFailure("response_limit", status)); } else chunks.push(chunk); });
        response.on("end", () => finish(new OAuthNetworkFailure(category, status, oauthProviderCode(Buffer.concat(chunks)))));
        response.on("error", () => finish(new OAuthNetworkFailure("connection")));
        return;
      }
      try { requireSuccessfulGitHubStatus(status, options.method); } catch (error) { response.destroy(); finish(error as Error); return; }
      const announced = Number(response.headers["content-length"]);
      if (Number.isFinite(announced) && announced > maxBytes) { response.destroy(); finish(options.oauthJson ? new OAuthNetworkFailure("response_limit", status) : new Error("GitHub response exceeds the size limit.")); return; }
      let size = 0; const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { response.destroy(); finish(options.oauthJson ? new OAuthNetworkFailure("response_limit", status) : new Error("GitHub response exceeds the size limit.")); } else chunks.push(chunk); });
      response.on("end", () => finish(undefined, Buffer.concat(chunks, size)));
      response.on("error", () => finish(options.oauthJson ? new OAuthNetworkFailure("connection") : new Error("GitHub response failed.")));
    });
    const cancelled = () => req.destroy(new Error("GitHub acquisition cancelled."));
    signal.addEventListener("abort", cancelled, { once: true });
    req.setTimeout(10_000, () => req.destroy(Object.assign(new Error("GitHub request timed out."), { code: "ETIMEDOUT" })));
    req.on("error", error => { if (!redirecting) finish(options.oauthJson ? new OAuthNetworkFailure(signal.aborted ? "cancelled" : oauthTransportCategory((error as NodeJS.ErrnoException).code)) : error instanceof Error && /timed out|cancelled/.test(error.message) ? error : new Error("GitHub connection failed.")); });
    req.end(options.body);
  });
};
