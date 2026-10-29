"use client";

import { useState } from "react";
import Link from "next/link";
import type { InvestigationReport, VerificationStatus } from "../types/investigation";
import { STATUS_LABEL, statusTone } from "../lib/demo/status";
import { boundedUsage } from "../lib/demo/usage";

type View = { report: InvestigationReport; origin: "LIVE" | "OPERATOR"; execution: "ISOLATED_DOCKER" | "NOT_EXECUTED" };
type Stage = "idle" | "investigating" | "loading" | "ready" | "error";
const observation = (value: { kind: "return"; value: number } | { kind: "throw"; message: string } | undefined) => value ? value.kind === "return" ? `${value.value} cents` : `Throws “${value.message}”` : "No observation";

export default function Dashboard({ source }: { source: string }) {
  const [view, setView] = useState<View | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState("");
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const lines = source.trimEnd().split("\n");
  const busy = stage === "investigating" || stage === "loading";

  async function runInvestigation() {
    setStage("investigating"); setError("");
    try {
      const response = await fetch("/api/investigate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fixtureId: "legacy-pricing" }), cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Investigation failed.");
      setView({ report: body.report, origin: "LIVE", execution: "NOT_EXECUTED" });
      setStage("ready");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Investigation failed."); setStage("error"); }
  }
  async function loadReport() {
    setStage("loading"); setError("");
    try {
      const response = await fetch("/api/demo-report", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Report unavailable.");
      setView({ report: body.report, origin: "OPERATOR", execution: body.execution });
      setStage("ready");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Report unavailable."); setStage("error"); }
  }

  const report = view?.report;
  const count = (status: VerificationStatus) => report?.rules.filter((rule) => rule.verificationStatus === status).length ?? 0;
  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark" aria-hidden="true">⌁</span><div><strong>CodeArchaeologist <em>AI</em></strong><small>LEGACY PRICING EXAMPLE</small></div></div><div className="topbar-right"><span className="topbar-dot"/> Trusted fixture workspace <span className="topbar-phase">EXAMPLE INVESTIGATION</span></div></header>
    <div className="page-grid"><aside className="sidebar" aria-label="Workspace overview"><div className="sidebar-section-label">WORKSPACE</div><div className="sidebar-active"><span>◇</span> Legacy Pricing <small>EXAMPLE</small></div><Link className="sidebar-item" href="/"><span>⌘</span> Repository Intelligence <small>HOME</small></Link><div className="sidebar-item"><span>✓</span> Verification <small>03</small></div><div className="sidebar-rule"/><div className="sidebar-section-label">TRUSTED TARGET</div><div className="fixture-mini"><div className="fixture-icon">JS</div><div><strong>legacy-pricing</strong><small>pricing.js · {lines.length} lines</small></div></div><div className="sidebar-foot"><span className="status-light"/> Local source only<br/><small>No external repository access</small></div></aside>
      <div className="content"><section className="hero"><div className="eyebrow"><span/> EXAMPLE INVESTIGATION / LEGACY PRICING</div><h1>Find the rules<br/><em>hidden in the code.</em></h1><p>Trace undocumented pricing behavior to exact source lines, then compare hypotheses with isolated execution results.</p><div className="hero-meta"><span><b>01</b> TRUSTED FIXTURE</span><i/><span><b>03</b> MODEL STEPS MAX</span><i/><span><b>00</b> AUTOMATIC EXECUTIONS</span></div></section>
      <section className="workbench" aria-label="Investigation controls"><div><div className="section-kicker">CONTROL DESK</div><h2>Legacy pricing investigation</h2><p>AI reads only the checked-in pricing fixture. Verification runs separately through the operator CLI.</p></div><div className="control-actions"><button className="button-primary" onClick={runInvestigation} disabled={busy}>{stage === "investigating" ? "Investigating…" : "Run AI investigation"}<span aria-hidden="true">↗</span></button><button className="button-secondary" onClick={loadReport} disabled={busy}>{stage === "loading" ? "Loading…" : "Load local report"}</button></div></section>
      {stage === "error" && <div className="notice error-notice" role="alert"><strong>Action needed</strong><span>{error}</span></div>}
      {busy && <div className="notice progress-notice" role="status"><span className="pulse"/>{stage === "investigating" ? "Selecting evidence, reviewing claims, and assembling source references…" : "Checking the local report and its provenance…"}</div>}
      <div className="main-columns"><section className="panel source-panel" aria-label="Trusted source code"><div className="panel-heading"><div><div className="section-kicker">01 / SOURCE MATERIAL</div><h2>Original fixture</h2></div><span className="panel-tag">READ ONLY</span></div><div className="file-tab"><span className="js-square">JS</span><strong>pricing.js</strong><span>tests/fixtures/legacy-pricing</span></div><div className="code-scroll"><pre><code>{lines.map((line, index) => <div key={index} id={`line-${index + 1}`} className={`code-line ${selectedLine === index + 1 ? "selected" : ""}`}><span className="line-number">{String(index + 1).padStart(2, "0")}</span><span>{line || " "}</span></div>)}</code></pre></div><div className="panel-foot">Evidence references resolve to these exact lines. Source is displayed as data.</div></section>
      <section className="results-panel" aria-label="Investigation results"><div className="panel-heading"><div><div className="section-kicker">02 / FINDINGS</div><h2>Business rules</h2></div><span className="count-badge">{report?.rules.length ?? "—"}</span></div>{!report ? <div className="empty-state"><div className="empty-symbol">⌁</div><h3>No investigation loaded</h3><p>Run a live investigation to inspect source-backed hypotheses, or load a report created by the trusted operator workflow.</p><div className="empty-steps"><span>01 <b>Inspect</b></span><span>→</span><span>02 <b>Review</b></span><span>→</span><span>03 <b>Report</b></span></div></div> : <><div className="result-origin"><span className={view?.execution === "ISOLATED_DOCKER" ? "origin-dot verified-dot" : "origin-dot"}/><div><strong>{view?.origin === "LIVE" ? "Live AI investigation" : "Operator-generated report"}</strong><small>{view?.execution === "ISOLATED_DOCKER" ? "Includes actual isolated Docker execution" : "No executable verification recorded"}</small></div></div><div className="status-strip"><span className="tone-verified">{count("VERIFIED")} verified</span><span className="tone-failed">{count("FAILED")} failed</span><span className="tone-blocked">{count("BLOCKED")} blocked</span><span className="tone-untested">{count("NOT_TESTED")} not tested</span></div>{report.rules.length === 0 ? <div className="empty-state compact"><h3>No supported rules found</h3><p>The model did not produce a claim supported by the inspected source. No result was invented.</p></div> : <div className="rule-list">{report.rules.map((rule, index) => <article className="rule-card" key={`${rule.id}-${index}`}><div className="rule-top"><span className="rule-number">RULE {String(index + 1).padStart(2, "0")}</span><span className={`status-pill ${statusTone(rule.verificationStatus)}`}>{STATUS_LABEL[rule.verificationStatus]}</span></div><h3>{rule.explanation}</h3><p className="rule-behavior">{rule.expectedBehavior.description}</p><div className="evidence-list">{rule.evidence.map((evidence, n) => <a key={n} href={`#line-${evidence.startLine}`} onClick={() => setSelectedLine(evidence.startLine)} className="evidence-link">↳ {evidence.path}:{evidence.startLine}{evidence.endLine !== evidence.startLine ? `–${evidence.endLine}` : ""}</a>)}</div>{rule.verification?.reason && <p className="rule-reason">{rule.verification.reason}</p>}{rule.verification?.cases && <details className="case-details"><summary>{rule.verification.cases.length} verification cases <span>⌄</span></summary><div className="case-list">{rule.verification.cases.map((item) => <div className="case" key={item.id}><div><strong>{item.id}</strong><span className={item.passed ? "case-pass" : "case-fail"}>{item.passed ? "PASS" : "FAIL"}</span></div><dl><dt>Input</dt><dd><code>{JSON.stringify(item.input)}</code></dd><dt>Expected</dt><dd>{observation(item.expected)}</dd><dt>Observed</dt><dd>{observation(item.observed)}</dd></dl></div>)}</div></details>}</article>)}</div>}</>}</section></div>
      {report && <section className="report-footer"><div><div className="section-kicker">RUN METADATA</div><h2>Trace &amp; limitations</h2><div className="metadata-grid"><div><small>FILE SELECTION</small><strong>{report.selection?.method === "DETERMINISTIC_SINGLE_FILE" ? "Deterministic · sole source" : report.selection?.method === "MODEL" ? "AI selected · validated" : "—"}</strong></div><div><small>PROVIDER</small><strong>{report.model?.provider ?? "—"}</strong></div><div><small>MODEL</small><strong>{report.model?.model ?? "—"}</strong></div><div><small>MODEL CALLS</small><strong>{boundedUsage(report.model?.calls)}</strong></div><div><small>INPUT TOKENS</small><strong>{boundedUsage(report.model?.inputTokens)}</strong></div><div><small>OUTPUT TOKENS</small><strong>{boundedUsage(report.model?.outputTokens)}</strong></div><div><small>REASONING TOKENS</small><strong>{boundedUsage(report.model?.reasoningTokens)}</strong></div><div><small>MODEL LATENCY</small><strong>{report.model?.latencyMs !== undefined ? `${Math.round(report.model.latencyMs)} ms` : "—"}</strong></div><div><small>EXECUTION</small><strong>{report.rules.reduce((sum, rule) => sum + (rule.verification?.durationMs ?? 0), 0).toFixed(0)} ms</strong></div></div>{report.rejectedHypotheses?.length ? <p className="rejected-note">{report.rejectedHypotheses.length} unsupported hypothesis{report.rejectedHypotheses.length === 1 ? " was" : "es were"} rejected during review.</p> : null}</div><div className="limitations"><strong>Known limits</strong><ul>{report.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div></section>}
      <footer className="site-foot"><span>CODEARCHAEOLOGIST AI · META GLOBAL AI DEVELOPER HACKATHON 2026</span><span>Evidence first. Execution separate.</span></footer></div></div>
  </main>;
}
