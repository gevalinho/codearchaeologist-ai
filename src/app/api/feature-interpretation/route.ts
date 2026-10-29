import { createLiveModelProvider } from "../../../lib/ai/provider-selection";
import { allowDevelopmentAi, allowProductionAi, createAiInterpretationHandler } from "../../../lib/architecture/ai-service";
import { currentSession } from "../../../lib/github-ingestion/session";
import { sharedQuotas } from "../../../lib/github-ingestion/quota-store";
import { verifiedGitHubSession } from "../../../lib/github-ingestion/production-auth";
import { authorizedGitHubPacket } from "../../../lib/architecture/ai-artifact-authorization";

const origin = process.env.FEATURE_AI_ORIGIN;
const developmentAccess = allowDevelopmentAi(process.env.NODE_ENV, process.env.ENABLE_DEV_FEATURE_AI, origin);
const production = process.env.NODE_ENV === "production";
const enabled = process.env.ENABLE_FEATURE_AI === "1" && developmentAccess || allowProductionAi(process.env.NODE_ENV, process.env.ENABLE_FEATURE_AI, process.env.ENABLE_PRODUCTION_AI, origin, process.env.GITHUB_APP_ORIGIN);
const handle = createAiInterpretationHandler({ enabled, origin, developmentAccess, maxOutputTokens: process.env.FEATURE_AI_MAX_OUTPUT_TOKENS, createProvider: createLiveModelProvider, privateAuthorized: request => !!currentSession(request), quota: sharedQuotas, subject: request => currentSession(request)?.id ?? "development-local", ...(production ? { authenticate: verifiedGitHubSession, authorizeArtifact: authorizedGitHubPacket } : {}) });
export async function POST(request: Request): Promise<Response> { return handle(request); }
