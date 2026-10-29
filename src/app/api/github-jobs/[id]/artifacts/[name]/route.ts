import { authorizeGitHubJob } from "../../../../../../lib/github-ingestion/access";
import { githubJobs } from "../../../../../../lib/github-ingestion/jobs";
import { currentSession } from "../../../../../../lib/github-ingestion/session";

type Context = { params: Promise<{ id: string; name: string }> };
export async function GET(request: Request, context: Context) {
  const { id, name } = await context.params;
  if (name !== "graph.json" && name !== "manifest.json") return Response.json({ error: "Unknown artifact." }, { status: 404 });
  const privateJob = githubJobs.privateJob(id);
  if (privateJob === undefined) return Response.json({ error: "Artifact is unavailable or expired." }, { status: 404 });
  if (!privateJob) { const denied = authorizeGitHubJob(request, false); if (denied) return denied; }
  const user = currentSession(request);
  const artifact = await githubJobs.artifact(id, name, user ?? undefined);
  if (!artifact) return Response.json({ error: "Artifact is unavailable or expired." }, { status: 404 });
  return new Response(artifact, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${name}"`, "X-Content-Type-Options": "nosniff" } });
}
