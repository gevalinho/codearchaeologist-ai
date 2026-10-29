import { investigateFixture } from "../../../lib/agents/investigation-orchestrator";
import { createLiveModelProvider } from "../../../lib/ai/provider-selection";
import { FIXTURE_ID, FIXTURE_ROOT } from "../../../lib/demo/fixture";
import { handleInvestigationRequest } from "../../../lib/demo/investigation-api";
import { sharedQuotas } from "../../../lib/github-ingestion/quota-store";

export async function POST(request: Request): Promise<Response> {
  return handleInvestigationRequest(request, {
    enabled: process.env.NODE_ENV === "development" && process.env.ENABLE_LIVE_INVESTIGATION_HTTP === "1",
    createProvider: createLiveModelProvider,
    investigate: (provider) => investigateFixture({ fixtureId: FIXTURE_ID, fixtureRoot: FIXTURE_ROOT, provider }),
    quota: sharedQuotas,
  });
}
