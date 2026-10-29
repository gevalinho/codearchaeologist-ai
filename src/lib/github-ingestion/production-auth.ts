import "server-only";
import { fixedHostFetch, GitHubHttpFailure, type FixedHostFetch } from "./network";
import { currentSession, revokeSession, type UserSession } from "./session";

/** Recheck the OAuth token with GitHub; a durable cookie alone does not prove it is still valid. */
export async function verifiedGitHubSession(request: Request, fetchFixed: FixedHostFetch = fixedHostFetch): Promise<UserSession | null> {
  let user: UserSession | null;
  try { user = currentSession(request); } catch { return null; }
  if (!user) return null;
  try {
    const bytes = await fetchFixed("api.github.com", "/user", 32_000, AbortSignal.timeout(8_000), { bearer: user.token });
    const identity = JSON.parse(bytes.toString("utf8")) as { id?: unknown; login?: unknown };
    if (String(identity.id) !== user.id || identity.login !== user.login) { revokeSession(request); return null; }
    return user;
  } catch (error) {
    if (error instanceof GitHubHttpFailure && error.status === 401) revokeSession(request);
    return null;
  }
}
