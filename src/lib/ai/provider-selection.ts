import "server-only";
import { BasetenModelProvider } from "./baseten-provider";
import { MetaModelProvider } from "./meta-provider";
import { ModelProviderError, type ModelProvider } from "./model-provider";
import { sharedQuotas } from "../github-ingestion/quota-store";

/** Live selection is explicit. MockModelProvider is only injected by tests. */
export function createLiveModelProvider(selection = process.env.INVESTIGATION_PROVIDER): ModelProvider {
  if (selection === "baseten") return new BasetenModelProvider({ reasoningEffort: "low", quota: sharedQuotas() });
  if (selection === "meta") return new MetaModelProvider({ quota: sharedQuotas() });
  throw new ModelProviderError("CONFIG", "INVESTIGATION_PROVIDER must be 'baseten' or 'meta'");
}
