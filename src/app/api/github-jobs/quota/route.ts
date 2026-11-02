import { jobJson } from "../../../../lib/github-ingestion/access";
import { SCAN_START_LIMIT, SCAN_START_WINDOW_MS, sharedQuotas } from "../../../../lib/github-ingestion/quota-store";
import { sameOrigin } from "../../../../lib/github-ingestion/session";
import { verifiedGitHubSession } from "../../../../lib/github-ingestion/production-auth";

export async function GET(request: Request) {
  if (!sameOrigin(request)) return jobJson({ error: "Request origin is not allowed." }, 403);
  const user = await verifiedGitHubSession(request);
  if (!user) return jobJson({ error: "Connect GitHub again to analyze repositories." }, 401);
  try {
    const status = sharedQuotas().scanStartStatus(user.id, SCAN_START_LIMIT, SCAN_START_WINDOW_MS);
    return jobJson({ limit: status.limit, used: status.used, remaining: status.remaining, nextAvailableAt: status.nextAvailableAt === null ? null : new Date(status.nextAvailableAt).toISOString(), serverNow: new Date(status.now).toISOString() }, 200);
  } catch {
    return jobJson({ error: "Scan allowance is temporarily unavailable." }, 503);
  }
}
