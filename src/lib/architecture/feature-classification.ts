import type { BusinessRuleEvidence, Graph, SourceRef } from "../archaeology/scanner";
import type { FeatureInvestigation } from "./features";

export type FeatureCategory = "business-workflow" | "technical-controller" | "shared-utility" | "data-access" | "uncertain";
export type FeatureClassification = { category: FeatureCategory; strength: "strong" | "moderate" | "limited"; explanation: string; uncertainty: string[]; sourceRefs: SourceRef[]; ruleIds: string[]; edgeIds: string[] };

const technicalName = /(?:^|[/#_.-])(?:auth|login|config|utils?|helpers?|logger|router|bootstrap|middleware|dashboard)(?:$|[/#_.-])/i;
const dataName = /(?:^|[/#_.-])(?:models?|repositories?|dao|database|db)(?:$|[/#_.-])/i;
const operationalEdge = new Set(["calls-endpoint", "references-table", "calls-model-method"]);
const refKey = (ref: SourceRef) => `${ref.path}:${ref.startLine}:${ref.endLine}`;

export function classifyFeature(graph: Graph, feature: FeatureInvestigation): FeatureClassification {
  const anchors = feature.components.filter(item => item.association === "anchor" && item.node.certainty === "observed");
  const anchorIds = new Set(anchors.map(item => item.node.id));
  const edges = feature.relationships.filter(edge => edge.certainty === "observed" && operationalEdge.has(edge.kind) && (anchorIds.has(edge.from) || anchorIds.has(edge.to)));
  const eligibleOwners = new Set([...anchorIds, ...edges.flatMap(edge => [edge.from, edge.to])]);
  const rules: BusinessRuleEvidence[] = (graph.rules ?? []).filter(rule => eligibleOwners.has(rule.ownerNodeId) && (rule.kind === "validation" || rule.kind === "authorization" || rule.kind === "state-transition" || rule.kind === "calculation" || rule.kind === "condition"));
  const names = anchors.map(item => item.node.name.replace(/([a-z])([A-Z])/g, "$1-$2"));
  const allTechnical = names.length > 0 && names.every(name => technicalName.test(name));
  const allData = names.length > 0 && names.every(name => dataName.test(name));
  const editSubjects = new Set(anchors.map(item => item.node.name.match(/(?:^|#)edit([A-Z][A-Za-z0-9_]*)$/)?.[1]?.toLowerCase()).filter(Boolean));
  const genericEditGroup = feature.id === "feature:edit" && editSubjects.size > 1;
  let category: FeatureCategory = "uncertain", explanation = "Names and graph links do not yet establish a business workflow.", strength: FeatureClassification["strength"] = "limited";
  if (allData) { category = "data-access"; explanation = "Observed anchor paths or names identify data-access components; no user workflow is established."; strength = "moderate"; }
  else if (allTechnical) { category = "shared-utility"; explanation = "Observed anchor paths or names identify shared technical concerns."; strength = "moderate"; }
  else if (genericEditGroup) { category = "technical-controller"; explanation = "The Edit candidate combines edit methods for different subjects. Their rule patterns and data-access edges do not establish one business workflow."; }
  else if (rules.length > 0 && edges.length > 0 && anchors.length > 0) {
    category = "business-workflow"; strength = rules.length >= 2 && edges.length >= 2 ? "strong" : "moderate";
    explanation = `${rules.length} observed source rule pattern${rules.length === 1 ? "" : "s"} and ${edges.length} observed operational relationship${edges.length === 1 ? "" : "s"} support a workflow candidate. Runtime behavior remains unverified.`;
  } else if (anchors.some(item => item.node.kind === "controller") && rules.length === 0) {
    category = "technical-controller"; explanation = "A controller is present, but no supported rule evidence establishes business behavior.";
  }
  const sourceRefs = [...new Map([...anchors.map(item => item.node.source), ...rules.map(rule => rule.source), ...edges.map(edge => edge.source)].map(ref => [refKey(ref), ref])).values()].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  const uncertainty = ["Static source patterns and graph edges do not verify runtime behavior."];
  if (!graph.rules) uncertainty.push("This artifact predates business-rule extraction; rescan for rule evidence.");
  else if (!rules.length) uncertainty.push("No supported rule pattern is attached to this feature candidate.");
  if (!edges.length) uncertainty.push("No observed operational relationship connects the candidate components.");
  if (genericEditGroup) uncertainty.push("Review each edit method with its own subject-specific source evidence.");
  return { category, strength, explanation, uncertainty, sourceRefs, ruleIds: rules.map(rule => rule.id), edgeIds: edges.map(edge => edge.id) };
}
