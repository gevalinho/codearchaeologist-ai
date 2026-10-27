import { readFile } from "node:fs/promises";
import { REPORT_PATH } from "../../../lib/demo/fixture";
import { validateDemoArtifact } from "../../../lib/demo/report-artifact";

export async function GET(): Promise<Response> {
  try {
    const bytes = await readFile(REPORT_PATH);
    if (bytes.length > 100_000) throw new Error("oversized");
    const artifact = validateDemoArtifact(JSON.parse(bytes.toString("utf8")));
    return Response.json(artifact, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "No valid local verification report is available. Run the operator CLI first." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
