import { finishLogin, LoginFailure } from "../../../../lib/github-ingestion/app";
import { cookieHeader, cookieValue, createSession, OAUTH_COOKIE, SESSION_COOKIE, unseal, type OAuthIntent, privateJson } from "../../../../lib/github-ingestion/session";
export async function GET(request: Request) {
  const url = new URL(request.url), state = url.searchParams.get("state"), code = url.searchParams.get("code");
  const intent = unseal<OAuthIntent>(cookieValue(request, OAUTH_COOKIE));
  if (!intent || !/^[A-Za-z0-9_-]{43}$/.test(intent.state) || !/^[A-Za-z0-9_-]{43}$/.test(intent.verifier) || intent.expiresAt <= Date.now() || state !== intent.state || !code || !/^[A-Za-z0-9_-]{1,256}$/.test(code)) return privateJson({ error: "Invalid or expired GitHub authorization." }, 401);
  try {
    const user = await finishLogin(code, intent), handle = createSession(user);
    const response = new Response(null, { status: 303, headers: { Location: "/", "Cache-Control": "private, no-store" } });
    response.headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, handle)); response.headers.append("Set-Cookie", cookieHeader(OAUTH_COOKIE, "", 0));
    return response;
  } catch (error) {
    console.error("[GitHub App OAuth] callback failure", error instanceof LoginFailure ? { stage: error.stage, category: error.category ?? "none", httpStatus: error.httpStatus ?? null, providerCode: error.providerCode ?? null } : { stage: "session_creation", category: "unknown", httpStatus: null, providerCode: null });
    return privateJson({ error: "GitHub authorization failed. Reconnect and try again." }, 401);
  }
}
