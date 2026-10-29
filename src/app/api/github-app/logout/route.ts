import { cookieHeader, currentSession, privateJson, revokeSession, sameOrigin, SESSION_COOKIE } from "../../../../lib/github-ingestion/session";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return privateJson({ error: "Request origin is not allowed." }, 403);
  if (currentSession(request)) revokeSession(request);
  return new Response(null, { status: 204, headers: { "Set-Cookie": cookieHeader(SESSION_COOKIE, "", 0), "Cache-Control": "private, no-store" } });
}
