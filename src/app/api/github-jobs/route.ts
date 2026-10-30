import { jobJson, readSmallJson } from "../../../lib/github-ingestion/access";
import { githubJobs, productionGithubJobs } from "../../../lib/github-ingestion/jobs";
import { sameOrigin } from "../../../lib/github-ingestion/session";
import { verifiedGitHubSession } from "../../../lib/github-ingestion/production-auth";
import { QuotaExceeded } from "../../../lib/github-ingestion/quota-store";
const failure = (error: unknown) => error instanceof QuotaExceeded ? Response.json({ error: "Scan quota exceeded. Retry later.", rule: error.rule, retryAfter: error.retryAfterSeconds }, { status: 429, headers: { "Cache-Control": "private, no-store", "Retry-After": String(error.retryAfterSeconds) } }) : jobJson({ error: error instanceof Error ? error.message : "Could not start repository analysis." }, error instanceof Error && /limit|capacity|running/.test(error.message) ? 429 : 400);

export async function POST(request: Request) {
  if (!sameOrigin(request)) return jobJson({ error: "Request origin is not allowed." }, 403);
  const user = await verifiedGitHubSession(request);
  if (!user) return jobJson({ error: "Connect GitHub again to analyze repositories." }, 401);
  let manager = githubJobs;
  if (process.env.NODE_ENV === "production") {
    try { manager = productionGithubJobs(); }
    catch { return jobJson({ error: "Repository scanning is unavailable until the isolated scanner worker is configured." }, 503); }
  }
  if (request.headers.get("x-codearchaeologist-ingestion") === "github-app") {
    try {
      const body = await readSmallJson(request) as { installationId?: unknown; repositoryId?: unknown };
      if (!body || typeof body !== "object" || Object.keys(body).length !== 2 || !Number.isSafeInteger(body.installationId) || !Number.isSafeInteger(body.repositoryId)) return jobJson({ error: "Select an authorized repository." }, 400);
      return jobJson(await manager.createPrivate(user, body.installationId as number, body.repositoryId as number), 202);
    } catch (error) { return failure(error); }
  }
  if (process.env.ENABLE_GITHUB_INGESTION !== "1") return jobJson({ error: "Public GitHub analysis is unavailable on this deployment." }, 503);
  try {
    const body = await readSmallJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { url?: unknown }).url !== "string") return jobJson({ error: "A canonical GitHub repository URL is required." }, 400);
    const status = manager.createPublic((body as { url: string }).url, user);
    return jobJson(status, 202);
  } catch (error) { return failure(error); }
}
