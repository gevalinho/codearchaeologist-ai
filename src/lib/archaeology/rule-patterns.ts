import type { BusinessRuleEvidence, SourceRef } from "./scanner";

export type RuleLexicalState = { blockComment: boolean; quote?: "'" | '"' | "`" };

export function codeOnLine(line: string, state: RuleLexicalState): string {
  let output = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i], next = line[i + 1];
    if (state.blockComment) { if (char === "*" && next === "/") { state.blockComment = false; i++; } continue; }
    if (state.quote) {
      if (char === "\\") { i++; continue; }
      if (char === state.quote) state.quote = undefined;
      continue;
    }
    if (char === "/" && next === "*") { state.blockComment = true; i++; continue; }
    if (char === "/" && next === "/" || char === "#") break;
    if (char === "'" || char === '"' || char === "`") { state.quote = char; output += "''"; continue; }
    output += char;
  }
  return output;
}

/** Conservative, single-line source patterns. Descriptions never copy literal source values. */
export function rulePatterns(line: string, ownerNodeId: string, source: SourceRef, state: RuleLexicalState = { blockComment: false }): BusinessRuleEvidence[] {
  const code = codeOnLine(line, state).trim();
  if (!code) return [];
  const kinds: { kind: BusinessRuleEvidence["kind"]; description: string }[] = [];
  const conditional = /\b(?:if|elseif|else\s+if)\s*\((.+)\)/.exec(code);
  if (conditional) {
    const condition = conditional[1];
    if (/\b(?:hasPermission|canAccess|isAuthorized|isAdmin|hasRole)\s*\(/i.test(condition) || /(?:\$|\b)(?:userRole|role|permission|authorized|is_admin|access_level)\b/i.test(condition) && /(?:===?|!==?|>=?|<=?)/.test(condition)) {
      kinds.push({ kind: "authorization", description: "Checks an access-related condition before continuing." });
    } else if (/\b(?:empty|isset|is_numeric|filter_var|strlen|validate\w*)\s*\(/i.test(condition)) {
      kinds.push({ kind: "validation", description: "Validates input in a conditional branch." });
    } else if (/(?:\$[A-Za-z_]\w*|\b[A-Za-z_]\w*(?:\.|->)[A-Za-z_]\w*)\s*(?:===?|!==?|>=?|<=?)\s*(?:\$[A-Za-z_]\w*|\b[A-Za-z_]\w*|\d+)/.test(condition)) {
      kinds.push({ kind: "condition", description: "Branches on a source-level comparison." });
    }
  }
  if (/(?:->|\.)(?:status|state|phase)\s*=\s*(?:''|\$[A-Za-z_]\w*|[A-Za-z_]\w*)\s*;/.test(code)) {
    kinds.push({ kind: "state-transition", description: "Assigns a status, state, or phase field; the prior state is not established." });
  }
  if (/(?:\$[A-Za-z_]\w*|\b[A-Za-z_]\w*(?:\.|->)[A-Za-z_]\w*)\s*=\s*(?:\$[A-Za-z_]\w*|\d+(?:\.\d+)?)\s*[+*\/%-]\s*(?:\$[A-Za-z_]\w*|\d+(?:\.\d+)?)/.test(code)) {
    kinds.push({ kind: "calculation", description: "Assigns a value calculated with an arithmetic operator." });
  }
  return kinds.map(({ kind, description }) => ({ id: `rule:${source.path}:${source.startLine}:${kind}`, kind, description, ownerNodeId, source, certainty: "observed", method: "deterministic-rule-pattern-v1" }));
}
