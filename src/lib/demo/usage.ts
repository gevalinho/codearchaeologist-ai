import type { ModelTrace } from "../../types/investigation";

export const isBoundedUsage = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 3_000_000;
export const boundedUsage = (value: unknown): string => isBoundedUsage(value) ? String(value) : "unavailable";

export function formatUsageSummary(model: ModelTrace | undefined): string {
  return `Model calls: ${boundedUsage(model?.calls)}\nInput tokens: ${boundedUsage(model?.inputTokens)}\nOutput tokens: ${boundedUsage(model?.outputTokens)}\nReasoning tokens: ${boundedUsage(model?.reasoningTokens)}\n`;
}
