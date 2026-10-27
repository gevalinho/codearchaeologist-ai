import { createHash } from "node:crypto";
import type { CandidateBusinessRule, RepositoryInventory, VerificationCase } from "../../types/investigation";
import { validateEvidence } from "../schemas/investigation";

/** Reviewed against tests/fixtures/legacy-pricing/pricing.js at checkpoint 4e0211d. */
export const PRICING_SOURCE_SHA256 = "cd939c5790b61cc0dfafbe4bff1d70d235e6aa72984c043edd5d7931aea84452";

export interface PricingTemplate {
  id: string;
  explanation: string;
  precondition: string;
  outcome: string;
  requiredLines: number[];
  cases: readonly VerificationCase[];
}

export const PRICING_TEMPLATES: readonly PricingTemplate[] = [
  {
    id: "loyalty-discount",
    explanation: "Customers with at least five years receive a 15% discount",
    precondition: "customerYears >= 5",
    outcome: "discountPercent becomes 15",
    requiredLines: [5],
    cases: [
      { id: "loyalty-boundary-below", description: "Four years gets no loyalty discount", input: { subtotalCents: 10000, customerYears: 4, promoCode: null }, expected: { kind: "return", value: 10000 } },
      { id: "loyalty-boundary-at", description: "Five years gets a 15 percent discount", input: { subtotalCents: 10000, customerYears: 5, promoCode: null }, expected: { kind: "return", value: 8500 } },
    ],
  },
  {
    id: "welcome-promotion",
    explanation: "New customers using WELCOME receive a 10% discount",
    precondition: "customerYears < 5 and promoCode === WELCOME",
    outcome: "discountPercent becomes 10",
    requiredLines: [5, 6],
    cases: [
      { id: "welcome-applied", description: "WELCOME gives a 10 percent discount below loyalty threshold", input: { subtotalCents: 10000, customerYears: 0, promoCode: "WELCOME" }, expected: { kind: "return", value: 9000 } },
      { id: "welcome-absent", description: "Unrecognized promotion gives no discount", input: { subtotalCents: 10000, customerYears: 0, promoCode: "OTHER" }, expected: { kind: "return", value: 10000 } },
    ],
  },
  {
    id: "loyalty-precedence",
    explanation: "Loyalty discount takes precedence over WELCOME promotion",
    precondition: "customerYears >= 5 and promoCode === WELCOME",
    outcome: "Only the 15% loyalty discount applies",
    requiredLines: [5, 6],
    cases: [
      { id: "precedence-both", description: "Eligible loyalty and WELCOME do not stack", input: { subtotalCents: 10000, customerYears: 5, promoCode: "WELCOME" }, expected: { kind: "return", value: 8500 } },
      { id: "precedence-promo-only", description: "WELCOME alone applies 10 percent", input: { subtotalCents: 10000, customerYears: 4, promoCode: "WELCOME" }, expected: { kind: "return", value: 9000 } },
    ],
  },
  {
    id: "rounding",
    explanation: "Discounted cents are rounded to the nearest integer",
    precondition: "a percentage discount produces fractional cents",
    outcome: "Math.round determines the discounted cent amount before shipping",
    requiredLines: [7, 8],
    cases: [
      { id: "round-down", description: "90.9 cents rounds to 91", input: { subtotalCents: 101, customerYears: 0, promoCode: "WELCOME" }, expected: { kind: "return", value: 890 } },
      { id: "round-half-up", description: "94.5 cents rounds to 95", input: { subtotalCents: 105, customerYears: 0, promoCode: "WELCOME" }, expected: { kind: "return", value: 894 } },
    ],
  },
  {
    id: "shipping-threshold",
    explanation: "Shipping is free when discounted subtotal reaches 5000 cents",
    precondition: "discounted subtotal >= 5000 cents",
    outcome: "Shipping is 0 at or above threshold and 799 below it",
    requiredLines: [7, 8],
    cases: [
      { id: "shipping-below", description: "4999 discounted cents incurs shipping", input: { subtotalCents: 4999, customerYears: 0, promoCode: null }, expected: { kind: "return", value: 5798 } },
      { id: "shipping-at", description: "5000 discounted cents gets free shipping", input: { subtotalCents: 5000, customerYears: 0, promoCode: null }, expected: { kind: "return", value: 5000 } },
      { id: "shipping-after-discount", description: "Promotion can move subtotal below threshold", input: { subtotalCents: 5000, customerYears: 0, promoCode: "WELCOME" }, expected: { kind: "return", value: 5299 } },
    ],
  },
  {
    id: "invalid-subtotal",
    explanation: "Negative or fractional subtotals are rejected",
    precondition: "subtotalCents is negative or not an integer",
    outcome: "invoiceTotal throws Invalid subtotal",
    requiredLines: [3],
    cases: [
      { id: "negative-subtotal", description: "Negative subtotal throws", input: { subtotalCents: -1, customerYears: 0, promoCode: null }, expected: { kind: "throw", message: "Invalid subtotal" } },
      { id: "fractional-subtotal", description: "Fractional subtotal throws", input: { subtotalCents: 1.5, customerYears: 0, promoCode: null }, expected: { kind: "throw", message: "Invalid subtotal" } },
    ],
  },
] as const;

const normalized = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

// Only these reviewed, equivalent claims may use the empty-precondition path.
// Matching both fields prevents a line citation or error-string mention alone
// from selecting executable cases.
const subtotalValidationExplanations = new Set([
  "subtotalCents must be an integer >= 0 or throws 'Invalid subtotal'",
  "negative or fractional subtotalCents values throw 'Invalid subtotal'",
].map(normalized));
const subtotalValidationOutcomes = new Set([
  "function enforces validation on subtotalCents input",
  "invoiceTotal rejects negative and fractional subtotalCents with 'Invalid subtotal'",
].map(normalized));

export function isTrustedPricingInventory(inventory: RepositoryInventory): boolean {
  if (inventory.fixtureId !== "legacy-pricing" || inventory.files.length !== 1 || inventory.files[0]?.path !== "pricing.js") return false;
  return createHash("sha256").update(inventory.files[0].content).digest("hex") === PRICING_SOURCE_SHA256;
}

export function matchPricingTemplate(rule: CandidateBusinessRule, inventory: RepositoryInventory): PricingTemplate | undefined {
  if (!isTrustedPricingInventory(inventory) || rule.supportStatus !== "SUPPORTED" || rule.verificationStatus !== "NOT_TESTED" || rule.verification || rule.test) return undefined;
  try { rule.evidence.forEach((evidence) => validateEvidence(inventory, evidence)); } catch { return undefined; }
  const strictMatch = rule.preconditions.length === 1 ? PRICING_TEMPLATES.find((template) =>
    normalized(rule.explanation) === normalized(template.explanation) &&
    normalized(rule.preconditions[0].description) === normalized(template.precondition) &&
    normalized(rule.expectedBehavior.description) === normalized(template.outcome) &&
    template.requiredLines.every((line) => rule.evidence.some((e) => e.path === "pricing.js" && e.startLine <= line && e.endLine >= line && e.excerpt === inventory.files[0].content.split("\n").slice(e.startLine - 1, e.endLine).join("\n")))
  ) : undefined;
  if (strictMatch) return strictMatch;
  if (rule.preconditions.length !== 0 || rule.verificationCases !== undefined ||
      !subtotalValidationExplanations.has(normalized(rule.explanation)) ||
      !subtotalValidationOutcomes.has(normalized(rule.expectedBehavior.description)) ||
      !rule.evidence.some((e) => e.path === "pricing.js" && e.startLine <= 3 && e.endLine >= 3)) return undefined;
  return PRICING_TEMPLATES.find((template) => template.id === "invalid-subtotal");
}
