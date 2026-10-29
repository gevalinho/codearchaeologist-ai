"use client";

import { useState } from "react";
import type { Graph, Node } from "../../lib/archaeology/scanner";
import { discoverBusinessWorkflows, searchBusinessWorkflows } from "../../lib/architecture/business-rules";
import { sourceReference } from "../../lib/architecture/graph";

export default function BusinessRulesExplorer({ graph, onSelectNode }: { graph: Graph; onSelectNode: (node: Node) => void }) {
  const [query, setQuery] = useState("");
  const workflows = discoverBusinessWorkflows(graph);
  const matches = searchBusinessWorkflows(workflows, graph, query);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  return <section className="business-rules-explorer" aria-label="Business Rules Explorer">
    <header><div><small>REPOSITORY INTELLIGENCE / SOURCE EVIDENCE</small><h2>Business Rules Explorer</h2><p>Observed source patterns are grouped into candidate workflows. Groupings suggest places to inspect; they do not establish runtime behavior or business intent.</p></div><strong>{graph.rules?.length ?? 0} RULE PATTERNS · {workflows.length} GROUPS</strong></header>
    <label className="business-rules-search">Search rules, components, or paths<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="e.g. validation, status, controller" /></label>
    {!graph.rules && <p className="business-rules-empty">This graph artifact predates rule evidence. Rescan the repository to populate this explorer.</p>}
    {graph.rules && workflows.length === 0 && <p className="business-rules-empty">No supported business-rule patterns were found in the scanned source. This does not prove the repository has no business rules.</p>}
    {workflows.length > 0 && matches.length === 0 && <p className="business-rules-empty">No rule groups match this search.</p>}
    <div className="business-rules-list">{matches.map(workflow => <details key={workflow.id}><summary><span><strong>{workflow.title}</strong><small>Inferred grouping · {workflow.rules.length} observed rule{workflow.rules.length === 1 ? "" : "s"} · {workflow.componentIds.length} component{workflow.componentIds.length === 1 ? "" : "s"}</small></span><span aria-hidden="true">⌄</span></summary><div className="business-rules-detail"><h3>Observed rules</h3>{workflow.rules.map(rule => <article key={rule.id}><span>{rule.kind.replaceAll("-", " ")} · observed pattern</span><p>{rule.description}</p><code>{sourceReference(rule.source)}</code><button type="button" onClick={() => { const node = nodes.get(rule.ownerNodeId); if (node) onSelectNode(node); }}>Inspect {nodes.get(rule.ownerNodeId)?.name ?? "component"} ↗</button></article>)}<h3>Related components</h3><div className="business-rules-components">{workflow.componentIds.map(id => { const node = nodes.get(id); return node ? <button type="button" key={id} onClick={() => onSelectNode(node)}>{node.name} <code>{sourceReference(node.source)}</code></button> : null; })}</div>{workflow.connectingEdges.length > 0 && <p className="business-rules-caveat">Grouping uses recorded call edges, including inferred targets. Review the cited call sites: {workflow.connectingEdges.map(edge => sourceReference(edge.source)).join(", ")}.</p>}</div></details>)}</div>
  </section>;
}
