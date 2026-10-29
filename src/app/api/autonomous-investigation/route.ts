import { createLiveModelProvider } from "../../../lib/ai/provider-selection";
import { allowDevelopmentAi, allowProductionAi } from "../../../lib/architecture/ai-service";
import { createAutonomousInvestigationHandler } from "../../../lib/architecture/autonomous-service";
import { currentSession } from "../../../lib/github-ingestion/session";
import { sharedQuotas } from "../../../lib/github-ingestion/quota-store";
import { verifiedGitHubSession } from "../../../lib/github-ingestion/production-auth";
import { authorizedGitHubGraph } from "../../../lib/architecture/ai-artifact-authorization";

const origin = process.env.FEATURE_AI_ORIGIN;
const production = process.env.NODE_ENV === "production";
const enabled = process.env.ENABLE_FEATURE_AI === "1" && allowDevelopmentAi(process.env.NODE_ENV, process.env.ENABLE_DEV_FEATURE_AI, origin) || allowProductionAi(process.env.NODE_ENV, process.env.ENABLE_FEATURE_AI, process.env.ENABLE_PRODUCTION_AI, origin, process.env.GITHUB_APP_ORIGIN);
const handle = createAutonomousInvestigationHandler({ enabled, origin, createProvider: createLiveModelProvider, privateAuthorized: request => !!currentSession(request), quota: sharedQuotas, subject: request => currentSession(request)?.id ?? "development-local", ...(production ? { authenticate: verifiedGitHubSession, resolveGraph: authorizedGitHubGraph } : {}) });
export async function POST(request: Request): Promise<Response> { return handle(request); }
