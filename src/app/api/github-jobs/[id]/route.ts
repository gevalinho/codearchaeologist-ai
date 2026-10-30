import { jobJson } from "../../../../lib/github-ingestion/access";
import { githubJobs, productionGithubJobs } from "../../../../lib/github-ingestion/jobs";
import { sameOrigin } from "../../../../lib/github-ingestion/session";
import { verifiedGitHubSession } from "../../../../lib/github-ingestion/production-auth";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const user = await verifiedGitHubSession(request);
  const manager = process.env.NODE_ENV === "production" ? (() => { try { return productionGithubJobs(); } catch { return null; } })() : githubJobs;
  if (!manager || !user || !manager.ownedJob(id, user)) return jobJson({ error: "GitHub analysis job was not found or has expired." }, 404);
  const status = await manager.authorizedStatus(id, user, () => verifiedGitHubSession(request));
  return status ? jobJson(status, 200) : jobJson({ error: "GitHub analysis job was not found or has expired." }, 404);
}
export async function DELETE(request: Request, context: Context) {
  if (!sameOrigin(request)) return jobJson({ error: "Request origin is not allowed." }, 403);
  const { id } = await context.params;
  const user = await verifiedGitHubSession(request);
  const manager = process.env.NODE_ENV === "production" ? (() => { try { return productionGithubJobs(); } catch { return null; } })() : githubJobs;
  if (!manager || !user || !manager.ownedJob(id, user)) return jobJson({ error: "GitHub analysis job was not found or has expired." }, 404);
  if (!await manager.authorizedStatus(id, user, () => verifiedGitHubSession(request))) return jobJson({ error: "GitHub analysis job was not found or has expired." }, 404);
  const status = manager.cancel(id, user);
  return status ? jobJson(status, 200) : jobJson({ error: "GitHub analysis job was not found or has expired." }, 404);
}
