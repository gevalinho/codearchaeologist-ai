import { createLiveModelProvider } from "../../../lib/ai/provider-selection";
import { allowDevelopmentAi, createAiInterpretationHandler } from "../../../lib/architecture/ai-service";
import { currentSession } from "../../../lib/github-ingestion/session";
import { sharedQuotas } from "../../../lib/github-ingestion/quota-store";

const origin = process.env.FEATURE_AI_ORIGIN;
// Production remains closed until authenticated sessions and a shared rate limiter are available.
const developmentAccess = allowDevelopmentAi(process.env.NODE_ENV, process.env.ENABLE_DEV_FEATURE_AI, origin);
const handle = createAiInterpretationHandler({ enabled: process.env.ENABLE_FEATURE_AI === "1" && developmentAccess, origin, developmentAccess, maxOutputTokens: process.env.FEATURE_AI_MAX_OUTPUT_TOKENS, createProvider: createLiveModelProvider, privateAuthorized: request => !!currentSession(request), quota: sharedQuotas, subject: request => currentSession(request)?.id ?? "development-local" });
export async function POST(request: Request): Promise<Response> { return handle(request); }
