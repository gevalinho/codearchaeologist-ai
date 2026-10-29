import { ingestRepository } from "../src/lib/archaeology/ingestion";

function argumentsForScan(args: string[]): { repo: string; out?: string } {
  let repo = process.env.ARCHAEOLOGY_REPO_ROOT;
  let out: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== "--repo" && flag !== "--out") throw new Error(`Unknown option: ${flag}. Use --repo /absolute/path [--out local-directory].`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path.`);
    if (flag === "--repo") repo = value; else out = value;
  }
  if (!repo) throw new Error("Set --repo /absolute/path or ARCHAEOLOGY_REPO_ROOT.");
  if (/^https?:\/\//i.test(repo)) throw new Error("Remote URLs are unsupported; select an authorized local directory.");
  return { repo, out };
}

async function main() {
  const { graph, manifest, directory } = await ingestRepository(argumentsForScan(process.argv.slice(2)));
  process.stdout.write(`Graph saved: ${directory}/graph.json\nManifest saved: ${directory}/manifest.json\nScanned files: ${manifest.sourceCounts.scannedFiles}; extracted nodes: ${graph.nodes.length}; extracted edges: ${graph.edges.length}; warnings: ${graph.warnings.length}\n`);
}
main().catch((error: unknown) => { const message = error instanceof Error ? error.message : "Unknown scan error"; process.stderr.write(`Repository ingestion failed: ${message}\n`); process.exitCode = 1; });
