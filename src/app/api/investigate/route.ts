import { investigateFixture } from "../../../lib/agents/investigation-orchestrator";
import { createLiveModelProvider } from "../../../lib/ai/provider-selection";
import { FIXTURE_ID, FIXTURE_ROOT } from "../../../lib/demo/fixture";
import { handleInvestigationRequest } from "../../../lib/demo/investigation-api";

export async function POST(request: Request): Promise<Response> {
  return handleInvestigationRequest(request, {
    enabled: process.env.ENABLE_LIVE_INVESTIGATION_HTTP === "1",
    createProvider: createLiveModelProvider,
    investigate: (provider) => investigateFixture({ fixtureId: FIXTURE_ID, fixtureRoot: FIXTURE_ROOT, provider }),
  });
}
