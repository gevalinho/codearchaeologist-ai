import { beginLogin } from "../../../../lib/github-ingestion/app";
import { cookieHeader, OAUTH_COOKIE, seal, privateJson } from "../../../../lib/github-ingestion/session";
export async function GET() {
  try { const { url, intent } = beginLogin(); return new Response(null, { status: 302, headers: { Location: url, "Set-Cookie": cookieHeader(OAUTH_COOKIE, seal(intent), 600), "Cache-Control": "private, no-store" } }); }
  catch { return privateJson({ error: "GitHub App sign-in is unavailable." }, 503); }
}
