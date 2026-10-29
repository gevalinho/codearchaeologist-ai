import "server-only";
import type { Graph } from "../archaeology/scanner";
import type { UserSession } from "../github-ingestion/session";
import { githubJobs, type GitHubJobManager } from "../github-ingestion/jobs";
import { parseGraph } from "./graph";
import { discoverFeatures } from "./features";
import { planReconstruction } from "./reconstruction-planner";
import { createEvidencePacket, type EvidencePacket } from "./ai-evidence";
import { createRepositoryEvidencePacket, type RepositoryEvidencePacket } from "./ai-repository-evidence";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
type Packet = EvidencePacket | RepositoryEvidencePacket;

type JobAccess = Pick<GitHubJobManager, "ownedJob" | "privateJob" | "artifact">;
export async function authorizedGitHubGraph(jobId: unknown, origin: unknown, user: UserSession, jobs: JobAccess = githubJobs): Promise<Graph | null> {
  if (typeof jobId !== "string" || !UUID.test(jobId) || origin !== "private-github" && origin !== "public-github") return null;
  if (!jobs.ownedJob(jobId, user) || jobs.privateJob(jobId) !== (origin === "private-github")) return null;
  const json = await jobs.artifact(jobId, "graph.json", user);
  if (!json) return null;
  try {
    const graph = parseGraph(json);
    if (graph.githubSource?.visibility !== (origin === "private-github" ? "private" : "public")) return null;
    return graph;
  } catch { return null; }
}

/** The browser packet is accepted only when it is the deterministic packet for the user's validated artifact. */
export async function authorizedGitHubPacket(packet: Packet, jobId: unknown, user: UserSession, jobs: JobAccess = githubJobs): Promise<boolean> {
  const graph = await authorizedGitHubGraph(jobId, packet.origin, user, jobs);
  if (!graph || graph.snapshotId !== packet.snapshotId) return false;
  try {
    const features = discoverFeatures(graph);
    const canonical = "scope" in packet
      ? createRepositoryEvidencePacket(graph, features, packet.origin)
      : (() => { const feature = features.find(item => item.id === packet.featureId); return feature ? createEvidencePacket(graph, feature, planReconstruction(graph, feature), packet.origin) : null; })();
    return canonical !== null && JSON.stringify(canonical) === JSON.stringify(packet);
  } catch { return false; }
}
