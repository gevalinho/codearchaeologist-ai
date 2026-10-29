import { authorizeGitHubJob, jobJson, readSmallJson } from "../../../lib/github-ingestion/access";
import { githubJobs } from "../../../lib/github-ingestion/jobs";
import { currentSession, sameOrigin } from "../../../lib/github-ingestion/session";
import { QuotaExceeded } from "../../../lib/github-ingestion/quota-store";
const failure = (error: unknown) => error instanceof QuotaExceeded ? Response.json({ error: "Scan quota exceeded. Retry later.", rule: error.rule, retryAfter: error.retryAfterSeconds }, { status: 429, headers: { "Cache-Control": "private, no-store", "Retry-After": String(error.retryAfterSeconds) } }) : jobJson({ error: error instanceof Error ? error.message : "Could not start repository analysis." }, error instanceof Error && /limit|capacity|running/.test(error.message) ? 429 : 400);

export async function POST(request: Request) {
  if (request.headers.get("x-codearchaeologist-ingestion") === "github-app") {
    if (!sameOrigin(request)) return jobJson({ error: "Request origin is not allowed." }, 403);
    const user = currentSession(request); if (!user) return jobJson({ error: "Connect GitHub to analyze authorized repositories." }, 401);
    try {
      const body = await readSmallJson(request) as { installationId?: unknown; repositoryId?: unknown };
      if (!body || typeof body !== "object" || Object.keys(body).length !== 2 || !Number.isSafeInteger(body.installationId) || !Number.isSafeInteger(body.repositoryId)) return jobJson({ error: "Select an authorized repository." }, 400);
      return jobJson(await githubJobs.createPrivate(user, body.installationId as number, body.repositoryId as number), 202);
    } catch (error) { return failure(error); }
  }
  const denied = authorizeGitHubJob(request, true); if (denied) return denied;
  try {
    const body = await readSmallJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { url?: unknown }).url !== "string") return jobJson({ error: "A canonical GitHub repository URL is required." }, 400);
    const status = githubJobs.create((body as { url: string }).url);
    return jobJson(status, 202);
  } catch (error) { return failure(error); }
}
