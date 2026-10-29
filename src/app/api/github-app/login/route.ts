import { beginLogin } from "../../../../lib/github-ingestion/app";
import { cookieHeader, OAUTH_COOKIE, seal, privateJson } from "../../../../lib/github-ingestion/session";
import { QuotaExceeded, sharedQuotas } from "../../../../lib/github-ingestion/quota-store";
export async function GET() {
  try { sharedQuotas().reserve({ scope: "oauth_login", subject: "untrusted-client-global", limit: 10, windowMs: 900_000 }); const { url, intent } = beginLogin(); return new Response(null, { status: 302, headers: { Location: url, "Set-Cookie": cookieHeader(OAUTH_COOKIE, seal(intent), 600), "Cache-Control": "private, no-store" } }); }
  catch (error) { if (error instanceof QuotaExceeded) return new Response(JSON.stringify({ error: "Login quota exceeded. Retry later.", retryAfter: error.retryAfterSeconds }), { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Retry-After": String(error.retryAfterSeconds) } }); return privateJson({ error: "GitHub App sign-in is unavailable." }, 503); }
}
