import "server-only";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { fixedHostFetch, OAuthNetworkFailure, safeOAuthProviderCode, type FixedHostFetch, type OAuthNetworkCategory } from "./network";
import { nonce, type OAuthIntent, type UserSession } from "./session";
import { parsePublicGitHubUrl, type GitHubRepository } from "./url";

const json = (bytes: Buffer): Record<string, unknown> => { try { const value = JSON.parse(bytes.toString("utf8")); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {} throw new Error("GitHub returned invalid metadata."); };
const numberId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export type LoginFailureStage = "configuration" | "token_exchange" | "token_response" | "user_lookup" | "user_response";
export class LoginFailure extends Error {
  constructor(readonly stage: LoginFailureStage, readonly category?: OAuthNetworkCategory | "provider_error" | "response_format" | "missing_token" | "identity", readonly httpStatus?: number, readonly providerCode?: string) { super("GitHub authorization failed."); this.name = "LoginFailure"; }
}
const configured = () => {
  const id = process.env.GITHUB_APP_CLIENT_ID, clientSecret = process.env.GITHUB_APP_CLIENT_SECRET, appId = process.env.GITHUB_APP_ID, slug = process.env.GITHUB_APP_SLUG, origin = process.env.GITHUB_APP_ORIGIN;
  if (!id || !clientSecret || !appId || !/^[1-9][0-9]*$/.test(appId) || !slug || !/^[A-Za-z0-9-]+$/.test(slug) || !origin || !/^https:\/\/[^/]+$/.test(origin) && !/^http:\/\/localhost(?::\d+)?$/.test(origin)) throw new Error("GitHub App is not configured.");
  return { id, clientSecret, appId, slug, origin };
};
export function beginLogin(): { url: string; intent: OAuthIntent } {
  const config = configured(); const intent = { state: nonce(), verifier: nonce(), expiresAt: Date.now() + 600_000 };
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.id); url.searchParams.set("redirect_uri", `${config.origin}/api/github-app/callback`); url.searchParams.set("state", intent.state);
  url.searchParams.set("code_challenge", createHash("sha256").update(intent.verifier).digest("base64url")); url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), intent };
}
export async function finishLogin(code: string, intent: OAuthIntent, fetchFixed: FixedHostFetch = fixedHostFetch): Promise<UserSession> {
  let config: ReturnType<typeof configured>;
  try { config = configured(); } catch { throw new LoginFailure("configuration"); }
  let tokenBytes: Buffer;
  try {
    tokenBytes = await fetchFixed("github.com", "/login/oauth/access_token", 32_000, new AbortController().signal, { method: "POST", oauthJson: true, contentType: "application/x-www-form-urlencoded", body: new URLSearchParams({ client_id: config.id, client_secret: config.clientSecret, code, redirect_uri: `${config.origin}/api/github-app/callback`, code_verifier: intent.verifier }).toString() });
  } catch (error) { if (error instanceof OAuthNetworkFailure) throw new LoginFailure("token_exchange", error.category, error.httpStatus, error.providerCode); throw new LoginFailure("token_exchange", "request"); }
  let tokenBody: Record<string, unknown>;
  try { tokenBody = json(tokenBytes); } catch { throw new LoginFailure("token_response", "response_format"); }
  const providerCode = safeOAuthProviderCode(tokenBody.error);
  if (providerCode) throw new LoginFailure("token_response", "provider_error", 200, providerCode);
  const token = tokenBody.access_token;
  if (typeof token !== "string" || token.length < 10) throw new LoginFailure("token_response", "missing_token");
  let userBytes: Buffer;
  try { userBytes = await fetchFixed("api.github.com", "/user", 32_000, new AbortController().signal, { bearer: token }); }
  catch { throw new LoginFailure("user_lookup", "request"); }
  let user: Record<string, unknown>;
  try { user = json(userBytes); } catch { throw new LoginFailure("user_response", "response_format"); }
  if (!numberId(user.id) || typeof user.login !== "string" || !/^[A-Za-z0-9-]+$/.test(user.login)) throw new LoginFailure("user_response", "identity");
  return { id: String(user.id), login: user.login, token, expiresAt: Date.now() + 8 * 60 * 60_000, nonce: nonce() };
}
export function appJwt(): string {
  const config = configured(); const pem = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!pem) throw new Error("GitHub App private key is unavailable.");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId })).toString("base64url");
  const input = `${header}.${body}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), createPrivateKey(pem)).toString("base64url")}`;
}
export type AuthorizedRepository = { id: number; owner: string; name: string; private: boolean; installationId: number };
export type UserInstallation = { id: number; account: string; accountType: "User" | "Organization"; contentsRead: boolean; suspended: boolean };
export async function installationsForUser(user: UserSession, fetchFixed: FixedHostFetch = fixedHostFetch): Promise<UserInstallation[]> {
  const appId = Number(process.env.GITHUB_APP_ID);
  if (!numberId(appId)) throw new Error("GitHub App identity is unavailable.");
  const response = json(await fetchFixed("api.github.com", "/user/installations?per_page=100", 1_000_000, new AbortController().signal, { bearer: user.token }));
  if (!Array.isArray(response.installations) || !Number.isSafeInteger(response.total_count) || (response.total_count as number) > 100 || response.installations.length !== response.total_count) throw new Error("GitHub installation list is incomplete or too large.");
  const output: UserInstallation[] = [];
  for (const raw of response.installations) {
    if (!raw || typeof raw !== "object") continue;
    const installation = raw as Record<string, unknown>, account = installation.account as Record<string, unknown> | undefined;
    if (!numberId(installation.id) || installation.app_id !== appId || typeof account?.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(account.login) || !["User", "Organization"].includes(installation.target_type as string)) continue;
    const permissions = installation.permissions as Record<string, unknown> | undefined;
    output.push({ id: installation.id, account: account.login, accountType: installation.target_type as "User" | "Organization", contentsRead: permissions?.contents === "read", suspended: installation.suspended_at != null });
  }
  return output;
}
export function installationSettingsUrl(installation: UserInstallation): string {
  if (!numberId(installation.id) || !/^[A-Za-z0-9-]{1,39}$/.test(installation.account)) throw new Error("Invalid GitHub installation.");
  if (installation.accountType === "Organization") return `https://github.com/organizations/${installation.account}/settings/installations/${installation.id}`;
  if (installation.accountType === "User") return `https://github.com/settings/installations/${installation.id}`;
  throw new Error("Invalid GitHub installation account type.");
}
export async function repositoriesForUser(user: UserSession, fetchFixed: FixedHostFetch = fixedHostFetch, knownInstallations?: UserInstallation[]): Promise<AuthorizedRepository[]> {
  const signal = new AbortController().signal;
  const installations = knownInstallations ?? await installationsForUser(user, fetchFixed);
  const output: AuthorizedRepository[] = [];
  for (const installation of installations) {
    if (installation.suspended || !installation.contentsRead) continue;
    const page = json(await fetchFixed("api.github.com", `/user/installations/${installation.id}/repositories?per_page=100`, 2_000_000, signal, { bearer: user.token }));
    if (!Array.isArray(page.repositories) || !Number.isSafeInteger(page.total_count) || (page.total_count as number) > 100) throw new Error("Too many GitHub repositories in an installation; narrow access or contact the operator.");
    for (const item of page.repositories) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>, owner = record.owner as Record<string, unknown> | undefined;
      if (!numberId(record.id) || typeof owner?.login !== "string" || typeof record.name !== "string" || typeof record.private !== "boolean") continue;
      try { parsePublicGitHubUrl(`https://github.com/${owner.login}/${record.name}`); } catch { continue; }
      output.push({ id: record.id, owner: owner.login, name: record.name, private: record.private, installationId: installation.id });
    }
  }
  return output;
}
export async function authorizeRepository(user: UserSession, installationId: number, repositoryId: number, fetchFixed: FixedHostFetch = fixedHostFetch): Promise<AuthorizedRepository | null> {
  if (!numberId(installationId) || !numberId(repositoryId)) return null;
  return (await repositoriesForUser(user, fetchFixed)).find(repo => repo.installationId === installationId && repo.id === repositoryId) ?? null;
}
export async function installationToken(repository: AuthorizedRepository, fetchFixed: FixedHostFetch = fixedHostFetch): Promise<string> {
  const body = json(await fetchFixed("api.github.com", `/app/installations/${repository.installationId}/access_tokens`, 32_000, new AbortController().signal, { method: "POST", bearer: appJwt(), contentType: "application/json", body: JSON.stringify({ repository_ids: [repository.id], permissions: { contents: "read", metadata: "read" } }) }));
  if (typeof body.token !== "string" || body.token.length < 10 || typeof body.expires_at !== "string" || Date.parse(body.expires_at) < Date.now() + 60_000) throw new Error("GitHub installation authorization expired or was revoked.");
  return body.token;
}
export const asRepository = (record: AuthorizedRepository): GitHubRepository => parsePublicGitHubUrl(`https://github.com/${record.owner}/${record.name}`);
