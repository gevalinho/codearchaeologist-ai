import { installationsForUser, repositoriesForUser } from "../../../../lib/github-ingestion/app";
import { connection } from "next/server";
import { GitHubHttpFailure } from "../../../../lib/github-ingestion/network";
import { currentSession, privateJson, revokeSession, cookieHeader, SESSION_COOKIE } from "../../../../lib/github-ingestion/session";
export async function GET(request: Request) {
  await connection();
  const user = currentSession(request); if (!user) return privateJson({ connected: false, repositories: [] }, 401);
  try { const installations = await installationsForUser(user); return privateJson({ connected: true, login: user.login, installations: installations.map(({ id, account, accountType }) => ({ id, account, accountType })), repositories: await repositoriesForUser(user, undefined, installations) }); }
  catch (error) {
    if (error instanceof GitHubHttpFailure && error.status === 401) {
      revokeSession(request);
      const response = privateJson({ connected: false, repositories: [], error: "GitHub authorization expired or was revoked. Reconnect and retry." }, 401);
      response.headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, "", 0));
      return response;
    }
    return privateJson({ error: "GitHub access expired, was revoked, or is temporarily unavailable. Reconnect and retry." }, 502);
  }
}
