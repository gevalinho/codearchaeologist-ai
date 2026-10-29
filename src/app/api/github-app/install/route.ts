import { cookieHeader, currentSession, INSTALL_COOKIE, nonce, privateJson, seal, type InstallIntent } from "../../../../lib/github-ingestion/session";
export async function GET(request: Request) {
  const user = currentSession(request); if (!user) return privateJson({ error: "Connect GitHub first." }, 401);
  const slug = process.env.GITHUB_APP_SLUG; if (!slug || !/^[A-Za-z0-9-]+$/.test(slug)) return privateJson({ error: "GitHub App installation is unavailable." }, 503);
  const intent: InstallIntent = { state: nonce(), userId: user.id, expiresAt: Date.now() + 600_000 };
  const url = new URL(`https://github.com/apps/${slug}/installations/new`); url.searchParams.set("state", intent.state);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Set-Cookie": cookieHeader(INSTALL_COOKIE, seal(intent), 600), "Cache-Control": "private, no-store" } });
}
