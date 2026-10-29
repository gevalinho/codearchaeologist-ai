import { cookieHeader, currentSession, INSTALL_COOKIE, nonce, privateJson, seal, type InstallIntent } from "../../../../lib/github-ingestion/session";
import { connection } from "next/server";
import { QuotaExceeded, sharedQuotas } from "../../../../lib/github-ingestion/quota-store";
export async function GET(request: Request) {
  await connection();
  const user = currentSession(request); if (!user) return privateJson({ error: "Connect GitHub first." }, 401);
  const slug = process.env.GITHUB_APP_SLUG; if (!slug || !/^[A-Za-z0-9-]+$/.test(slug)) return privateJson({ error: "GitHub App installation is unavailable." }, 503);
  try { sharedQuotas().reserve({ scope: "installation_start", subject: user.id, limit: 5, windowMs: 900_000 }); }
  catch (error) { if (error instanceof QuotaExceeded) return new Response(JSON.stringify({ error: "Installation quota exceeded. Retry later.", retryAfter: error.retryAfterSeconds }), { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Retry-After": String(error.retryAfterSeconds) } }); throw error; }
  const intent: InstallIntent = { state: nonce(), userId: user.id, expiresAt: Date.now() + 600_000 };
  const url = new URL(`https://github.com/apps/${slug}/installations/new`); url.searchParams.set("state", intent.state);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Set-Cookie": cookieHeader(INSTALL_COOKIE, seal(intent), 600), "Cache-Control": "private, no-store" } });
}
