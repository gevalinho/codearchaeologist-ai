import { createLiveModelProvider } from "../../../lib/ai/provider-selection";
import { allowDevelopmentAi } from "../../../lib/architecture/ai-service";
import { createAutonomousInvestigationHandler } from "../../../lib/architecture/autonomous-service";
import { currentSession } from "../../../lib/github-ingestion/session";

const origin = process.env.FEATURE_AI_ORIGIN;
// Production remains closed until authenticated sessions and a shared distributed rate limiter exist.
const enabled = process.env.ENABLE_FEATURE_AI === "1" && allowDevelopmentAi(process.env.NODE_ENV, process.env.ENABLE_DEV_FEATURE_AI, origin);
const handle = createAutonomousInvestigationHandler({ enabled, origin, createProvider: createLiveModelProvider, privateAuthorized: request => !!currentSession(request) });
export async function POST(request: Request): Promise<Response> { return handle(request); }
