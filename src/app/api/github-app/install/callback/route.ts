import { cookieHeader, cookieValue, currentSession, INSTALL_COOKIE, privateJson, unseal, type InstallIntent } from "../../../../../lib/github-ingestion/session";
import { connection } from "next/server";
export async function GET(request: Request) {
  await connection();
  const user = currentSession(request), intent = unseal<InstallIntent>(cookieValue(request, INSTALL_COOKIE));
  const url = new URL(request.url), state = url.searchParams.get("state");
  if (!user || !intent || intent.userId !== user.id || intent.expiresAt <= Date.now() || !state || state !== intent.state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return privateJson({ error: "Invalid installation return. Reconnect and try again." }, 401);
  return new Response(null, { status: 303, headers: { Location: "/?github_connection=updated", "Set-Cookie": cookieHeader(INSTALL_COOKIE, "", 0), "Cache-Control": "private, no-store" } });
}
