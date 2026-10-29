import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SqliteSessionStore, sessionEncryptionKey, sessionKeyVersion } from "./session-store";

export const SESSION_COOKIE = "codearch_github_session";
export const OAUTH_COOKIE = "codearch_github_oauth";
export const INSTALL_COOKIE = "codearch_github_install";
export type UserSession = { id: string; login: string; token: string; expiresAt: number; nonce: string };
export type OAuthIntent = { state: string; verifier: string; expiresAt: number };
export type InstallIntent = { state: string; userId: string; expiresAt: number };
const MAX_AGE = 8 * 60 * 60;
const secret = () => { const value = process.env.GITHUB_APP_SESSION_SECRET; if (!value || Buffer.byteLength(value) < 32) throw new Error("GitHub App session signing is unavailable."); return value; };
const mac = (value: string) => createHmac("sha256", secret()).update(value).digest("base64url");
export const nonce = () => randomBytes(32).toString("base64url");
export function seal(value: object): string { const payload = Buffer.from(JSON.stringify(value)).toString("base64url"); return `${payload}.${mac(payload)}`; }
export function unseal<T>(input: string | undefined): T | null {
  if (!input || input.length > 5_000) return null;
  const [payload, signature, extra] = input.split(".");
  if (!payload || !signature || extra) return null;
  const expected = Buffer.from(mac(payload)); const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()) as T; } catch { return null; }
}
export function cookieValue(request: Request, name: string): string | undefined { return request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1); }
export function cookieHeader(name: string, value: string, maxAge = MAX_AGE): string { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`; }
export function sameOrigin(request: Request): boolean { const origin = process.env.GITHUB_APP_ORIGIN; return !!origin && request.headers.get("origin") === origin && (!request.headers.get("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin"); }
export const privateJson = (value: object, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });

let store: { file: string; fingerprint: string; database: SqliteSessionStore } | undefined;
function sessions(): SqliteSessionStore {
  const file = process.env.CODEARCH_DB_PATH;
  if (!file) throw new Error("GitHub session database is unavailable.");
  const key = sessionEncryptionKey(process.env.CODEARCH_TOKEN_ENCRYPTION_KEY);
  const version = sessionKeyVersion(process.env.CODEARCH_TOKEN_KEY_VERSION);
  const fingerprint = createHash("sha256").update(key).update(String(version)).digest("hex");
  if (store?.file === file && store.fingerprint === fingerprint) return store.database;
  store?.database.close();
  store = { file, fingerprint, database: new SqliteSessionStore(file, key, version) };
  return store.database;
}
export function createSession(user: UserSession): string {
  return sessions().create(user);
}
export function revokeSession(request: Request): void { sessions().revoke(cookieValue(request, SESSION_COOKIE)); }
export function currentSession(request: Request): UserSession | null {
  return sessions().lookup(cookieValue(request, SESSION_COOKIE));
}
