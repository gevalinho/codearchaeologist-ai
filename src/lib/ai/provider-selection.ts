import "server-only";
import { BasetenModelProvider } from "./baseten-provider";
import { MetaModelProvider } from "./meta-provider";
import { ModelProviderError, type ModelProvider } from "./model-provider";

/** Live selection is explicit. MockModelProvider is only injected by tests. */
export function createLiveModelProvider(selection = process.env.INVESTIGATION_PROVIDER): ModelProvider {
  if (selection === "baseten") return new BasetenModelProvider({ reasoningEffort: "low" });
  if (selection === "meta") return new MetaModelProvider();
  throw new ModelProviderError("CONFIG", "INVESTIGATION_PROVIDER must be 'baseten' or 'meta'");
}
