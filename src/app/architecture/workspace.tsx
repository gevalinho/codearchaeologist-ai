"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Edge, Graph, Node } from "../../lib/archaeology/scanner";
import { filterNodes, indexGraph, layout, MAX_ARTIFACT_BYTES, neighborhood, parseGraph, promotionInvestigation, sourceReference } from "../../lib/architecture/graph";
import { canStartCanvasDrag, fitNodes, panFromDrag, RESET_VIEW, zoomAt, type Point, type Viewport } from "../../lib/architecture/viewport";
import { discoverFeatures, type FeatureInvestigation } from "../../lib/architecture/features";
import FeatureWorkspace from "./feature-workspace";
import "./workspace.css";

const domains = ["school-management", "healthcare-legacy", "shared-infrastructure", "unknown"];
const kinds = ["file", "class", "method", "angular-module", "controller", "service", "factory", "table", "endpoint", "branch"];
const colors: Record<string, string> = { "school-management": "#5dd8be", "healthcare-legacy": "#b396ff", "shared-infrastructure": "#e9b766", unknown: "#8e9ba9" };
const shortName = (name: string) => name.length > 28 ? `…${name.slice(-27)}` : name;
export default function ArchitectureWorkspace() {
  const [graph, setGraph] = useState<Graph | null>(null), [error, setError] = useState(""), [query, setQuery] = useState("");
  const [domain, setDomain] = useState(""), [kind, setKind] = useState(""), [certainty, setCertainty] = useState("");
  const [focus, setFocus] = useState<string[]>([]), [depth, setDepth] = useState(1), [direction, setDirection] = useState<"both" | "incoming" | "outgoing">("both");
  const [selected, setSelected] = useState<{ type: "node" | "edge"; id: string } | null>(null), [featured, setFeatured] = useState(false);
  const [selectedFeatureId, setSelectedFeatureId] = useState("feature:promotion");
  const [viewport, setViewport] = useState<Viewport>(RESET_VIEW), [canvasSize, setCanvasSize] = useState({ width: 1000, height: 580 }), [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null), canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; origin: Point; start: Viewport } | null>(null);
  const index = useMemo(() => graph ? indexGraph(graph) : null, [graph]);
  const matches = useMemo(() => graph ? filterNodes(graph.nodes, { query, domains: new Set(domain ? [domain] : []), kinds: new Set(kind ? [kind] : []), certainties: new Set(certainty ? [certainty] : []) }) : [], [graph, query, domain, kind, certainty]);
  const promotion = useMemo(() => graph ? promotionInvestigation(graph) : null, [graph]);
  const features = useMemo(() => graph ? discoverFeatures(graph) : [], [graph]);
  const selectedFeature = features.find(feature => feature.id === selectedFeatureId) ?? features[0];
  const view = useMemo(() => graph ? neighborhood(graph, focus.length ? focus : matches.slice(0, 1).map(node => node.id), depth, direction) : null, [graph, focus, matches, depth, direction]);
  const positions = useMemo(() => layout(view?.nodes ?? []), [view]);
  useLayoutEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setCanvasSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    setCanvasSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, [graph]);
  useLayoutEffect(() => {
    if (!graph) return;
    const frame = requestAnimationFrame(() => setViewport(fitNodes(positions.values(), canvasSize)));
    return () => cancelAnimationFrame(frame);
  }, [graph, positions, canvasSize]);
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setViewport(current => zoomAt(current, point, current.scale * Math.exp(-event.deltaY * (event.ctrlKey ? .01 : .002))));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [graph]);
  const activeNode = selected?.type === "node" ? index?.nodes.get(selected.id) : undefined;
  const activeEdge = selected?.type === "edge" ? graph?.edges.find(edge => edge.id === selected.id) : undefined;
  const incoming = activeNode ? index?.incoming.get(activeNode.id) ?? [] : [], outgoing = activeNode ? index?.outgoing.get(activeNode.id) ?? [] : [];
  async function importFile(file?: File) {
    if (!file) return;
    setError("");
    try {
      if (file.size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the 5 MB limit.");
      const parsed = parseGraph(await file.text(), file.size);
      setGraph(parsed); setFocus([]); setSelected(null); setFeatured(false); setSelectedFeatureId("feature:promotion"); setQuery(""); setDomain(""); setKind(""); setCertainty(""); setViewport({ ...RESET_VIEW });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not import artifact."); }
    if (fileRef.current) fileRef.current.value = "";
  }
  function selectNode(node: Node) { setSelected({ type: "node", id: node.id }); setFocus([node.id]); setFeatured(false); }
  function focusFeatureNode(node: Node) { selectNode(node); canvasRef.current?.scrollIntoView({ block: "center" }); }
  function focusFeatureEdge(edge: Edge) { setSelected({ type: "edge", id: edge.id }); setFocus([edge.from, edge.to]); canvasRef.current?.scrollIntoView({ block: "center" }); }
  function selectFeature(feature: FeatureInvestigation) {
    setSelectedFeatureId(feature.id); setFeatured(feature.id === "feature:promotion");
    setFocus(feature.components.filter(component => component.association === "anchor").slice(0, 12).map(component => component.node.id));
    setSelected(null); setDepth(1); setDirection("both");
  }
  function investigate() { const feature = features.find(item => item.id === "feature:promotion"); if (feature) selectFeature(feature); }
  function beginDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !canStartCanvasDrag(event.target instanceof Element ? event.target : null)) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, origin: { x: event.clientX, y: event.clientY }, start: viewport };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    setViewport(panFromDrag(drag.current.start, drag.current.origin, { x: event.clientX, y: event.clientY }));
  }
  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function zoomButton(factor: number) { setViewport(current => zoomAt(current, { x: canvasSize.width / 2, y: canvasSize.height / 2 }, current.scale * factor)); }
  const selectedConnected = new Set(activeNode ? [...incoming, ...outgoing].map(edge => edge.id) : []);
  return <main className="architecture">
    <header className="arch-top"><div><Link href="/" className="arch-back">← WORKBENCH</Link><span className="arch-divider"/><strong><span className="arch-logo">⌘</span> CODEARCHAEOLOGIST <em>/ ARCHITECTURE</em></strong></div><div className="arch-top-right"><span className="arch-live">LOCAL ARTIFACT</span><button onClick={() => fileRef.current?.click()} className="arch-import">↥ &nbsp; Import graph JSON</button><input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => importFile(event.target.files?.[0])} /></div></header>
    <div className="arch-heading"><div><div className="arch-overline">REPOSITORY INTELLIGENCE <span>/</span> PHASE 5.2</div><h1>Living Architecture <i>Graph</i></h1><p>Explore source-derived structure, trace relationships, and inspect the evidence behind every connection.</p></div><div className="arch-summary"><div><span>SNAPSHOT</span><strong>{graph ? `${graph.snapshotId.slice(0, 12)}…` : "NOT LOADED"}</strong></div><div><span>NODES</span><strong>{graph?.nodes.length ?? "—"}</strong></div><div><span>EDGES</span><strong>{graph?.edges.length ?? "—"}</strong></div></div></div>
    {error && <div className="arch-error" role="alert">{error}</div>}
    {graph && selectedFeature && <section className="feature-intelligence" aria-label="Feature intelligence"><div className="feature-head"><div><small>04 / FEATURE INTELLIGENCE</small><h2>Feature workspace</h2><p>Browse architecture candidates, trace evidence, and review a clearly labeled modernization proposal.</p></div><span>{features.length} CANDIDATES</span></div><div className="feature-layout"><nav className="feature-catalog" aria-label="Discovered feature candidates">{features.map(feature => <button key={feature.id} className={selectedFeature.id === feature.id ? "active" : ""} onClick={() => selectFeature(feature)}><strong>{feature.title}</strong><small>{feature.components.length} candidates · {feature.relationships.length} edges</small></button>)}</nav><FeatureWorkspace feature={selectedFeature} snapshotId={graph.snapshotId} onFocusNode={focusFeatureNode} onFocusEdge={focusFeatureEdge} onOpenGraph={() => canvasRef.current?.scrollIntoView({ block: "center" })} /></div></section>}
    <div className="arch-grid"><aside className="arch-panel explorer"><div className="arch-panel-head"><small>01 / REPOSITORY EXPLORER</small><h2>Inventory <span>{graph?.nodes.length ?? 0}</span></h2></div>
      {!graph ? <div className="arch-side-empty">Import a local graph artifact to search its architecture inventory.</div> : <><label className="arch-search">⌕ <input value={query} onChange={event => { setQuery(event.target.value); setFocus([]); setFeatured(false); }} placeholder="Search symbols, paths, endpoints…" aria-label="Search architecture" /></label><div className="arch-filters"><select aria-label="Domain filter" value={domain} onChange={event => { setDomain(event.target.value); setFocus([]); }}><option value="">All domains</option>{domains.map(value => <option key={value}>{value}</option>)}</select><select aria-label="Node type filter" value={kind} onChange={event => { setKind(event.target.value); setFocus([]); }}><option value="">All node types</option>{kinds.map(value => <option key={value}>{value}</option>)}</select><select aria-label="Certainty filter" value={certainty} onChange={event => { setCertainty(event.target.value); setFocus([]); }}><option value="">All evidence</option><option>observed</option><option>inferred</option></select></div><button className="arch-feature" onClick={investigate}><span>FEATURED INVESTIGATION</span><strong>Investigate Student Promotion ↗</strong><small>Trace discovered components and their source references</small></button><div className="arch-list-title">MATCHING COMPONENTS <span>{matches.length}</span></div><div className="arch-inventory">{kinds.map(group => { const items = matches.filter(node => node.kind === group); return items.length ? <details key={group} open={!!query || group === "controller" || group === "method"}><summary>{group.toUpperCase()} <span>{items.length}</span></summary>{items.slice(0, 80).map(node => <button key={node.id} className={selected?.id === node.id ? "active" : ""} onClick={() => selectNode(node)} title={node.name}><span className="arch-node-dot" style={{ background: colors[node.domain] }}/><span>{node.name.split("/").pop()}</span><small>{node.certainty === "inferred" ? "◌" : "●"}</small></button>)}{items.length > 80 && <p>Showing first 80. Narrow your search.</p>}</details> : null; })}</div></>}
    </aside><section className="arch-panel canvas-panel"><div className="arch-canvas-head"><div><small>02 / RELATIONSHIP MAP</small><h2>{featured ? "Student promotion investigation" : graph ? "Architecture viewport" : "Awaiting artifact"}</h2></div>{graph && <span className="arch-subset">{view?.nodes.length ?? 0} / {graph.nodes.length} nodes in view</span>}</div>
      {!graph ? <div className="arch-blank"><div className="arch-blank-icon">⌁</div><span>LOCAL-FIRST WORKSPACE</span><h3>Your architecture starts here.</h3><p>Select <b>.local-archaeology/graph.json</b> from your computer. Parsing and exploration happen entirely in this browser tab.</p><button onClick={() => fileRef.current?.click()}>Import graph JSON ↗</button><small>No upload · No browser storage · No model calls</small></div> : <><div className="arch-toolbar"><div><button onClick={() => zoomButton(1.25)} aria-label="Zoom in">＋</button><button onClick={() => zoomButton(0.8)} aria-label="Zoom out">−</button><button onClick={() => setViewport(fitNodes(positions.values(), canvasSize))} aria-label="Fit view" title="Fit view">⌗</button><button onClick={() => setViewport({ ...RESET_VIEW })}>Reset view</button></div><div><button onClick={() => setDepth(value => Math.min(2, value + 1))}>Expand neighbors</button><select aria-label="Dependency direction" value={direction} onChange={event => setDirection(event.target.value as typeof direction)}><option value="both">Both directions</option><option value="incoming">Incoming</option><option value="outgoing">Outgoing</option></select></div></div><div ref={canvasRef} className={`arch-graph ${dragging ? "dragging" : ""}`} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}><svg role="img" aria-label="Focused architecture graph" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`} preserveAspectRatio="none"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#718394"/></marker></defs><g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>{view?.edges.map((edge: Edge) => { const from = positions.get(edge.from)!, to = positions.get(edge.to)!; return <g key={edge.id} data-graph-interactive onClick={() => setSelected({ type: "edge", id: edge.id })} tabIndex={0} role="button" aria-label={`${edge.kind}: ${index?.nodes.get(edge.from)?.name} to ${index?.nodes.get(edge.to)?.name}`} onKeyDown={event => { if (event.key === "Enter") setSelected({ type: "edge", id: edge.id }); }}><line className="edge-hit" x1={from.x} y1={from.y} x2={to.x} y2={to.y}/><line className={`graph-edge ${edge.certainty} ${selectedConnected.has(edge.id) || selected?.id === edge.id ? "highlight" : ""}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#arrow)"/></g>; })}{view?.nodes.map(node => { const point = positions.get(node.id)!; return <g key={node.id} className={`graph-node ${selected?.id === node.id ? "selected" : ""}`} data-graph-interactive transform={`translate(${point.x - 83} ${point.y - 31})`} role="button" tabIndex={0} aria-label={`Inspect ${node.name}`} onClick={() => selectNode(node)} onKeyDown={event => { if (event.key === "Enter") selectNode(node); }}><rect width="166" height="62" rx="10" fill="#162630" stroke={colors[node.domain]}/><rect width="4" height="42" x="0" y="10" rx="2" fill={colors[node.domain]}/><text x="14" y="24" className="graph-kind">{node.kind.toUpperCase()} · {node.certainty.toUpperCase()}</text><text x="14" y="44" className="graph-label">{shortName(node.name.split("/").pop() ?? node.name)}</text></g>; })}</g></svg></div><div className="arch-canvas-foot"><span>● observed extraction &nbsp; ◌ inferred relationship</span><span>Showing a focused subset. Select a component to explore.</span></div>{featured && <div className="arch-feature-note"><strong>Investigation coverage</strong><p>{promotion?.matches.length} matching components found. {promotion?.missing.length ? `Missing: ${promotion.missing.join(", ")}.` : "All named components found."} Only edges present in the artifact are drawn. Score entry is a separate component unless an edge connects it.</p></div>}</>}
    </section><aside className="arch-panel inspector"><div className="arch-panel-head"><small>03 / EVIDENCE INSPECTOR</small><h2>Source evidence</h2></div>{!graph ? <div className="arch-side-empty">Select an imported node or relationship to inspect its source reference.</div> : activeNode || activeEdge ? <div className="arch-evidence"><span className="arch-tag">{activeNode ? "COMPONENT" : "RELATIONSHIP"}</span><h3>{activeNode?.name ?? activeEdge?.kind}</h3><dl><dt>TYPE</dt><dd>{activeNode?.kind ?? activeEdge?.kind}</dd><dt>DOMAIN</dt><dd>{activeNode?.domain ?? "From connected components"}</dd><dt>CERTAINTY</dt><dd>{activeNode?.certainty ?? activeEdge?.certainty}</dd><dt>EXTRACTION METHOD</dt><dd>{activeNode?.method ?? activeEdge?.method}</dd></dl><div className="arch-source"><small>SOURCE REFERENCE</small><code>{sourceReference((activeNode ?? activeEdge)!.source)}</code><button onClick={() => navigator.clipboard.writeText(sourceReference((activeNode ?? activeEdge)!.source))}>Copy reference</button></div>{activeEdge && <div className="arch-relations"><h4>Directed relationship</h4><button onClick={() => selectNode(index!.nodes.get(activeEdge.from)!)}>{index?.nodes.get(activeEdge.from)?.name}</button><span>↓ {activeEdge.kind}</span><button onClick={() => selectNode(index!.nodes.get(activeEdge.to)!)}>{index?.nodes.get(activeEdge.to)?.name}</button></div>}{activeNode && <div className="arch-relations"><h4>Incoming dependencies · {incoming.length}</h4>{incoming.slice(0, 20).map(edge => <button key={edge.id} onClick={() => setSelected({ type: "edge", id: edge.id })}>{index?.nodes.get(edge.from)?.name} <small>→ {edge.kind}</small></button>)}<h4>Outgoing dependencies · {outgoing.length}</h4>{outgoing.slice(0, 20).map(edge => <button key={edge.id} onClick={() => setSelected({ type: "edge", id: edge.id })}>{index?.nodes.get(edge.to)?.name} <small>← {edge.kind}</small></button>)}</div>}</div> : <div className="arch-side-empty">Select a graph component or edge. Source references appear here; the artifact contains no source snippets.</div>}<div className="arch-trust"><strong>How to read this graph</strong><p>Observed means extracted from source patterns, not runtime verified. Inferred needs review. Domains are heuristic. Missing edges do not establish missing dependencies or dead code.</p></div></aside></div>

  </main>;
}
