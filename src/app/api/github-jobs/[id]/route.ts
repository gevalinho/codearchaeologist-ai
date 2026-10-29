import { authorizeGitHubJob, jobJson } from "../../../../lib/github-ingestion/access";
import { githubJobs } from "../../../../lib/github-ingestion/jobs";
import { currentSession, sameOrigin } from "../../../../lib/github-ingestion/session";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const privateJob = githubJobs.privateJob(id);
  if (privateJob === undefined) return jobJson({ error: "GitHub analysis job was not found or has expired." }, 404);
  if (!privateJob) { const denied = authorizeGitHubJob(request, false); if (denied) return denied; }
  const user = currentSession(request);
  const status = await githubJobs.authorizedStatus(id, user ?? undefined);
  return status ? jobJson(status, 200) : jobJson({ error: "GitHub analysis job was not found or has expired." }, 404);
}
export async function DELETE(request: Request, context: Context) {
  if (!sameOrigin(request)) return jobJson({ error: "Request origin is not allowed." }, 403);
  const { id } = await context.params;
  const privateJob = githubJobs.privateJob(id);
  if (privateJob === undefined) return jobJson({ error: "GitHub analysis job was not found or has expired." }, 404);
  if (!privateJob) { const denied = authorizeGitHubJob(request, true); if (denied) return denied; }
  const user = currentSession(request);
  const status = githubJobs.cancel(id, user ?? undefined);
  return status ? jobJson(status, 200) : jobJson({ error: "GitHub analysis job was not found or has expired." }, 404);
}
