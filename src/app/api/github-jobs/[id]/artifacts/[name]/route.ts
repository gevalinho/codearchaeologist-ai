import { githubJobs } from "../../../../../../lib/github-ingestion/jobs";
import { verifiedGitHubSession } from "../../../../../../lib/github-ingestion/production-auth";

type Context = { params: Promise<{ id: string; name: string }> };
export async function GET(request: Request, context: Context) {
  const { id, name } = await context.params;
  if (name !== "graph.json" && name !== "manifest.json") return Response.json({ error: "Unknown artifact." }, { status: 404 });
  const user = await verifiedGitHubSession(request);
  if (!user || !githubJobs.ownedJob(id, user)) return Response.json({ error: "Artifact is unavailable or expired." }, { status: 404 });
  const artifact = await githubJobs.artifact(id, name, user);
  if (!artifact) return Response.json({ error: "Artifact is unavailable or expired." }, { status: 404 });
  return new Response(artifact, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${name}"`, "X-Content-Type-Options": "nosniff" } });
}
