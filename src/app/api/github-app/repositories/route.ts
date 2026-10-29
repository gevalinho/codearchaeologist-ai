import { repositoriesForUser } from "../../../../lib/github-ingestion/app";
import { currentSession, privateJson } from "../../../../lib/github-ingestion/session";
export async function GET(request: Request) {
  const user = currentSession(request); if (!user) return privateJson({ connected: false, repositories: [] }, 401);
  try { return privateJson({ connected: true, login: user.login, repositories: await repositoriesForUser(user) }); }
  catch { return privateJson({ error: "GitHub access expired, was revoked, or is temporarily unavailable. Reconnect and retry." }, 502); }
}
