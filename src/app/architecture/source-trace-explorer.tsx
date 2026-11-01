"use client";

import { useState } from "react";
import type { Graph, SourceRef } from "../../lib/archaeology/scanner";
import { discoverSourceTraces } from "../../lib/architecture/source-traces";
import { sourceReference } from "../../lib/architecture/graph";

export default function SourceTraceExplorer({ graph, onFocusEvidence }: {
  graph: Graph;
  onFocusEvidence: (source: SourceRef) => void;
}) {
  const [query, setQuery] = useState("");
  const traces = discoverSourceTraces(graph, query).slice(0, 8);
  return <section className="source-trace-explorer" aria-label="Source-backed cross-stack traces">
    <header>
      <div>
        <small>OBSERVED SOURCE · INFERRED LINKS LABELED</small>
        <h2>Cross-stack source traces</h2>
        <p>Follow recorded UI, request, route, dispatch, and model-call evidence. Static links do not prove runtime execution.</p>
      </div>
      <strong>{traces.length} TRACES</strong>
    </header>
    <label className="source-trace-search">Search endpoints or symbols
      <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="e.g. result, route, controller" />
    </label>
    {traces.length === 0 ? <p className="source-trace-empty">No recorded cross-stack trace matches this search. Missing graph evidence does not establish that no runtime relationship exists.</p> :
      <div className="source-trace-list">{traces.map(trace => <details key={trace.id}>
        <summary><span><strong>{trace.title}</strong><small>{trace.status.replaceAll("-", " ")} · {trace.steps.length} evidence stages</small></span><span aria-hidden="true">⌄</span></summary>
        <ol>{trace.steps.slice(0, 10).map((item, index) => <li key={`${trace.id}:${index}`}>
          <span className={`source-trace-certainty certainty-${item.certainty}`}>{item.certainty}</span>
          <p>{item.label}</p>
          <div className="source-trace-references">{item.sourceRefs.map(source =>
            <button type="button" key={sourceReference(source)} onClick={() => onFocusEvidence(source)}>{sourceReference(source)}</button>,
          )}</div>
        </li>)}</ol>
      </details>)}</div>}
  </section>;
}
