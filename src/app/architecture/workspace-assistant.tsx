"use client";

import { useEffect, useRef, useState } from "react";
import type { SourceRef } from "../../lib/archaeology/scanner";
import type { Graph } from "../../lib/archaeology/scanner";
import type { EvidenceOrigin } from "../../lib/architecture/ai-evidence";
import type { InvestigationEvent, InvestigationReport } from "../../lib/architecture/autonomous-investigation";
import type { EvidencePacket } from "../../lib/architecture/ai-evidence";
import type { RepositoryEvidencePacket } from "../../lib/architecture/ai-repository-evidence";
import { parseChatAnswer } from "../../lib/architecture/ai-chat";
import { parseRepositoryAnswer } from "../../lib/architecture/ai-repository-chat";
import { appendAssistantAnswer, assistantContextId, assistantNeedsConsent, emptyAssistantThread, type AssistantScope, type AssistantThread } from "../../lib/architecture/assistant-context";
import { sourceReference } from "../../lib/architecture/graph";

type Props = { open: boolean; onClose: () => void; repositoryName: string; graph: Graph | null; origin: EvidenceOrigin | null; repositoryPacket: RepositoryEvidencePacket | null; featurePacket: EvidencePacket | null; featureName: string | null; onFocusEvidence: (ref: SourceRef) => void };

export default function WorkspaceAssistant({ open, onClose, repositoryName, graph, origin, repositoryPacket, featurePacket, featureName, onFocusEvidence }: Props) {
  const [mode, setMode] = useState<"chat" | "investigate">("chat");
  const [investigationReview, setInvestigationReview] = useState(false), [investigationConsent, setInvestigationConsent] = useState(false);
  const [investigationEvents, setInvestigationEvents] = useState<Extract<InvestigationEvent, { type: "tool" }>[]>([]), [investigationReport, setInvestigationReport] = useState<InvestigationReport | null>(null);
  const [investigationError, setInvestigationError] = useState(""), [investigationLoading, setInvestigationLoading] = useState(false);
  const [scope, setScope] = useState<AssistantScope>("repository");
  const [draft, setDraft] = useState(""), [pendingQuestion, setPendingQuestion] = useState<{ id: string; text: string } | null>(null);
  const [reviewAccepted, setReviewAccepted] = useState(false), [consents, setConsents] = useState<Set<string>>(() => new Set());
  const [threads, setThreads] = useState<Record<string, AssistantThread>>({}), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null), requestRef = useRef<AbortController | null>(null), contextRef = useRef<string | null>(null);
  const packet = scope === "repository" ? repositoryPacket : featurePacket;
  const id = assistantContextId(scope, packet);
  const thread = id ? threads[id] ?? emptyAssistantThread() : emptyAssistantThread();
  const consented = !!id && consents.has(id);
  const reviewPending = pendingQuestion?.id === id && !consented;
  function close() { onClose(); requestAnimationFrame(() => document.getElementById("workspace-assistant-launcher")?.focus()); }
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { contextRef.current = id; }, [id]);
  useEffect(() => { if (!open) return; const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { onClose(); requestAnimationFrame(() => document.getElementById("workspace-assistant-launcher")?.focus()); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [open, onClose]);
  useEffect(() => () => { requestRef.current?.abort(); }, []);
  useEffect(() => { return () => { requestRef.current?.abort(); }; }, [id]);
  async function investigate(authorized = investigationConsent) {
    const goal = draft.trim();
    if (!graph || !origin || !repositoryPacket || !goal || goal.length > 300 || requestRef.current) return;
    if (!authorized) { setInvestigationReview(true); setReviewAccepted(false); return; }
    const controller = new AbortController(); requestRef.current = controller;
    setInvestigationLoading(true); setInvestigationError(""); setInvestigationEvents([]); setInvestigationReport(null); setInvestigationReview(false);
    try {
      const response = await fetch("/api/autonomous-investigation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal, graph, origin, consent: true }), cache: "no-store", signal: controller.signal });
      if (!response.ok) { const body = await response.json(); throw new Error(typeof body.error === "string" ? body.error : "Investigation request failed."); }
      if (!response.body) throw new Error("Investigation stream unavailable.");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = "", completed = false;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 70_000) throw new Error("Investigation response exceeded its limit.");
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            let event: InvestigationEvent | { type: "error"; category: string; rule?: string; field?: string; textRule?: string; answerRule?: string; stage?: string; tool?: string; argumentRule?: string };
            try { event = JSON.parse(line) as InvestigationEvent | { type: "error"; category: string; rule?: string; field?: string; textRule?: string; answerRule?: string; stage?: string; tool?: string; argumentRule?: string }; } catch { throw new Error("Invalid investigation event."); }
            if (event.type === "tool") setInvestigationEvents(previous => [...previous, event].slice(-3));
            else if (event.type === "complete") { setInvestigationReport(event.report); completed = true; }
            else if (event.type === "error") { const rule = typeof event.rule === "string" && /^[a-z_]{1,40}$/.test(event.rule) ? ` · ${event.rule.replaceAll("_", " ")}` : ""; const field = event.field === "answer" || event.field === "uncertainty" ? ` in ${event.field}` : ""; const textRule = typeof event.textRule === "string" && /^(?:control_character|html_delimiter|unsafe_url|source_reference)$/.test(event.textRule) ? ` · ${event.textRule.replaceAll("_", " ")}` : ""; const answerRule = event.rule === "insufficient_evidence" && /^(?:citations_present|answer_prefix)$/.test(event.answerRule ?? "") ? ` · ${event.answerRule?.replaceAll("_", " ")}` : ""; const tool = event.rule === "tool_arguments" && /^(?:search_components|trace_relationships|inspect_rule_patterns|find_feature_candidates|check_coverage)$/.test(event.tool ?? "") ? ` · ${event.tool}` : ""; const argumentRule = event.rule === "tool_arguments" && /^[a-z_]{1,40}$/.test(event.argumentRule ?? "") ? ` · ${event.argumentRule}` : ""; throw new Error(`Investigation stopped: ${event.category.replaceAll("_", " ")}${rule}${field}${textRule}${answerRule}${tool}${argumentRule}. Retry or narrow the goal.`); }
            newline = pending.indexOf("\n");
          }
        }
      } finally { reader.releaseLock(); }
      if (!completed && !controller.signal.aborted) throw new Error("Investigation ended without a validated report.");
      if (!controller.signal.aborted) setDraft("");
    } catch (cause) { if (!controller.signal.aborted) setInvestigationError(cause instanceof Error ? cause.message : "Investigation failed."); }
    finally { if (requestRef.current === controller) { requestRef.current = null; setInvestigationLoading(false); } }
  }
  function approveInvestigation() {
    if (!reviewAccepted) return;
    setInvestigationConsent(true); setInvestigationReview(false);
    void investigate(true);
  }
  function cancelInvestigation() { requestRef.current?.abort(); requestRef.current = null; setInvestigationLoading(false); setInvestigationError("Investigation cancelled."); }

  async function submit(question: string, contextId: string, authorized: boolean) {
    if (!packet || !authorized || !contextId || requestRef.current || question.length < 1 || question.length > 300) return;
    const controller = new AbortController(); requestRef.current = controller; setLoading(true); setError("");
    try {
      const current = threads[contextId] ?? emptyAssistantThread();
      const response = await fetch("/api/feature-interpretation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packet, consent: true, question, history: current.history.slice(-6) }), cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "AI request failed. Retry shortly.");
      if (body.snapshotId !== packet.snapshotId || (scope === "repository" ? body.scope !== "repository" : body.featureId !== (packet as EvidencePacket).featureId)) throw new Error("AI answer belongs to a different investigation.");
      const answer = scope === "repository" ? parseRepositoryAnswer(body.answer, packet as RepositoryEvidencePacket) : parseChatAnswer(body.answer, packet as EvidencePacket);
      if (controller.signal.aborted || contextRef.current !== contextId) return;
      const message = { answer: answer.answer, evidenceIds: answer.evidenceIds, uncertainty: answer.uncertainty, status: "status" in answer ? String(answer.status) : "feature interpretation" };
      setThreads(previous => ({ ...previous, [contextId]: appendAssistantAnswer(previous[contextId] ?? emptyAssistantThread(), question, message) }));
      setDraft(""); setPendingQuestion(null);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "AI request failed."); }
    finally { if (requestRef.current === controller) { requestRef.current = null; setLoading(false); } }
  }
  function send() {
    const question = draft.trim();
    if (!id || !packet || !question || loading) return;
    if (assistantNeedsConsent(id, consents)) { setPendingQuestion({ id, text: question }); setReviewAccepted(false); setError(""); return; }
    void submit(question, id, true);
  }
  function approveAndSend() {
    if (!id || !pendingQuestion || pendingQuestion.id !== id || !reviewAccepted) return;
    setConsents(previous => new Set(previous).add(id));
    void submit(pendingQuestion.text, id, true);
  }
  function selectScope(next: AssistantScope) {
    if (next === "feature" && !featurePacket) return;
    requestRef.current?.abort(); requestRef.current = null;
    setLoading(false); setError(""); setPendingQuestion(null); setReviewAccepted(false); setDraft(""); setScope(next);
  }
  const evidence = new Map(packet?.items.map(item => [item.id, item]) ?? []);
  return <aside id="workspace-assistant" className={`workspace-assistant${open ? " open" : ""}`} aria-label="AI investigation assistant" aria-hidden={!open} inert={!open}>
    <header><div><small>MUSE SPARK · INVESTIGATION</small><h2>AI assistant</h2></div><button type="button" onClick={close} aria-label="Close AI assistant">×</button></header>
    <div className="workspace-assistant-body">
      <p className="workspace-assistant-identity"><strong>Repository:</strong> {repositoryName || "No repository loaded"}</p>
      <div className="workspace-assistant-modes" aria-label="AI assistant mode"><button type="button" aria-pressed={mode === "chat"} disabled={investigationLoading} onClick={() => setMode("chat")}>Chat</button><button type="button" aria-pressed={mode === "investigate"} disabled={investigationLoading} onClick={() => setMode("investigate")}>Investigate</button></div>
      {mode === "investigate" ? <>
        <p className="workspace-assistant-hint">The agent can search components, trace up to two graph hops, inspect rule patterns, compare feature hypotheses, and check coverage. Up to three read-only actions; at most 40 references go to the external provider.</p>
        {graph?.sourceCoverage?.partial && <p className="workspace-assistant-hint" role="status">Partial analysis: {graph.sourceCoverage.eligibleFiles} eligible, {graph.sourceCoverage.analyzedFiles} analyzed, {graph.sourceCoverage.omittedFiles} omitted. Missing features cannot be ruled out.</p>}
        {investigationReview && <div className="workspace-assistant-review" role="group" aria-label="Review autonomous investigation consent"><strong>Review investigation sharing scope</strong><p>Repository: {repositoryName}. The app server receives the validated graph artifact (up to 5 MB) to run read-only tools. Muse Spark may receive bounded graph-derived component names and types, relationship labels, rule-pattern labels, feature hypotheses, source paths and line references, coverage counts, and your goal. The agent may choose up to three tools and share at most 40 references in a 16 KB provider packet. Source bodies, credentials, and executable code are excluded.</p><p>{graph?.sourceCoverage?.partial ? "This is a partial scan; omitted eligible files may contain additional evidence." : "Coverage is limited to analyzed supported source files."}</p><label><input type="checkbox" checked={reviewAccepted} onChange={event => setReviewAccepted(event.target.checked)} /> I consent to share this investigation metadata with the external AI provider.</label><button type="button" disabled={!reviewAccepted} onClick={approveInvestigation}>Consent and start investigation</button></div>}
        {investigationLoading && <p role="status" className="workspace-assistant-hint">Investigating validated graph metadata… <button type="button" onClick={cancelInvestigation}>Cancel investigation</button></p>}
        {investigationEvents.length > 0 && <ol className="workspace-investigation-timeline" aria-label="Completed investigation actions">{investigationEvents.map((event, index) => <li key={`${index}:${event.tool}`}><strong>{event.tool.replaceAll("_", " ")}{event.query ? ` · ${event.query}` : ""}{event.targetRef ? ` · ${event.targetRef}` : ""}</strong><span>{event.summary}</span></li>)}</ol>}
        {investigationError && <p role="alert" className="workspace-assistant-error">{investigationError}</p>}
        {investigationReport && <section className="workspace-investigation-report" aria-label="Investigation report"><h3>Investigation report</h3><p><strong>Goal:</strong> {investigationReport.goal}</p><h4>{investigationReport.answer.status === "insufficient-evidence" ? "Investigation outcome" : "Evidence-backed finding"}</h4><p><strong>{investigationReport.answer.status.replaceAll("-", " ")}:</strong> {investigationReport.answer.answer}</p><h4>Relevant structural metadata</h4><p>Representative components: {investigationReport.items.filter(item => item.kind === "component").slice(0, 6).map(item => item.label).join("; ") || "none found"}.</p><p>Relationships: {investigationReport.items.filter(item => item.kind === "relationship").slice(0, 6).map(item => `${item.label} (${item.certainty})`).join("; ") || "none represented"}.</p><p>Rule patterns: {investigationReport.items.filter(item => item.kind === "rule").slice(0, 4).map(item => item.label).join("; ") || "none represented"}.</p><h4>Uncertainty and coverage</h4><p>{investigationReport.answer.uncertainty}</p>{investigationReport.sourceCoverage?.partial && <p>Partial source analysis · {investigationReport.sourceCoverage.omittedFiles} eligible files omitted. Missing features and relationships cannot be ruled out.</p>}<h4>Supporting evidence</h4>{investigationReport.answer.evidenceIds.map(evidenceId => { const item = investigationReport.items.find(entry => entry.id === evidenceId); return item && <button type="button" key={evidenceId} onClick={() => onFocusEvidence(item.source)}>{item.label} · {sourceReference(item.source)} · {item.certainty}</button>; })}<h4>Next inspection</h4><p>Review cited source locations, resolve inferred relationships, and verify behavior with tests or runtime observation.</p><h4>Modernization considerations</h4><p>Prioritize changes only after source review and behavior verification; static metadata alone cannot establish implementation risk.</p></section>}
        {!graph && <p className="workspace-assistant-empty">Analyze or import a repository before starting an investigation.</p>}
      </> : <>
      <fieldset className="workspace-assistant-scopes"><legend>Investigation scope</legend><label><input type="radio" name="assistant-scope" checked={scope === "repository"} onChange={() => selectScope("repository")} /> Repository overview</label><label><input type="radio" name="assistant-scope" checked={scope === "feature"} disabled={!featurePacket} onChange={() => selectScope("feature")} /> Selected feature</label></fieldset>
      {!featurePacket && <p className="workspace-assistant-hint">Select a feature in Workflows to enable feature scope.</p>}
      <p className="workspace-assistant-hint">Current scope: {scope === "repository" ? "Repository overview" : `Selected feature · ${featureName ?? "Unknown"}`}. {packet ? `${packet.items.length} bounded references. Source bodies are excluded.` : "No safe evidence packet is available."}</p>
      {packet && "coverage" in packet && <p className="workspace-assistant-hint">Coverage: {packet.coverage.candidateGroupsRepresented} of {packet.coverage.candidateGroupsFound} candidate groups; {packet.coverage.referencesRepresented} references. {packet.coverage.truncated ? `${packet.coverage.omittedCandidateGroups} groups omitted; other evidence sampled.` : "No candidate groups omitted."}</p>}
      {packet?.sourceCoverage?.partial && <p className="workspace-assistant-hint" role="status">Partial source analysis: {packet.sourceCoverage.eligibleFiles} eligible, {packet.sourceCoverage.selectedFiles} selected, {packet.sourceCoverage.omittedFiles} omitted, {packet.sourceCoverage.analyzedFiles} analyzed. Missing features cannot be ruled out.</p>}
      {!packet ? <div className="workspace-assistant-empty" role="status">{repositoryName ? "This investigation has no safe bounded AI evidence." : "Analyze or import a repository to ask questions."}</div> : <>
        <div className="workspace-assistant-messages" aria-live="polite">{thread.messages.length === 0 && <p className="workspace-assistant-empty">Ask a question about the current scope. A consent review appears before the first provider request.</p>}{thread.messages.map((message, index) => <article key={`${index}:${message.question}`}><div className="workspace-assistant-question"><strong>You</strong><p>{message.question}</p></div><div className="workspace-assistant-answer"><strong>AI · {message.status.replaceAll("-", " ")}</strong><p>{message.answer}</p>{packet.sourceCoverage?.partial && <small>Partial source analysis · omitted files may contain additional evidence.</small>}<small>Uncertainty: {message.uncertainty}</small><div>{message.evidenceIds.map(evidenceId => { const item = evidence.get(evidenceId); return item && <button type="button" key={evidenceId} onClick={() => onFocusEvidence(item.source)} title={item.label}>{evidenceId} · {sourceReference(item.source)}</button>; })}</div></div></article>)}</div>
        {reviewPending && <div className="workspace-assistant-review" role="group" aria-label="Review AI evidence and consent"><strong>Review before sending</strong><p>Your question is pending. The external provider will receive this {scope === "repository" ? "repository overview" : "selected feature"} packet, its source paths and line references, and up to three previous exchanges. It will not receive source bodies or credentials.</p><details><summary>Show exact evidence metadata</summary>{packet.items.map(item => <code key={item.id}>{item.id} · {item.label} · {sourceReference(item.source)} · {item.certainty}</code>)}</details><label><input type="checkbox" checked={reviewAccepted} onChange={event => setReviewAccepted(event.target.checked)} /> I consent to share this bounded metadata with the external AI provider.</label><button type="button" disabled={!reviewAccepted || loading} onClick={approveAndSend}>Consent and send question</button></div>}
        {error && <p className="workspace-assistant-error" role="alert">{error} <button type="button" onClick={send}>Retry</button></p>}
        {loading && <p role="status" className="workspace-assistant-hint">Waiting for AI response…</p>}
      </>}
      </>}
    </div>
    <form onSubmit={event => { event.preventDefault(); if (mode === "investigate") void investigate(); else send(); }}><label htmlFor="workspace-assistant-question">{mode === "investigate" ? "Investigation goal" : `Ask about ${scope === "repository" ? "the repository" : "this feature"}`}</label><div><input ref={inputRef} id="workspace-assistant-question" value={draft} onChange={event => setDraft(event.target.value)} maxLength={300} disabled={mode === "investigate" ? !graph || investigationLoading : !packet || loading} placeholder={mode === "investigate" ? "Investigate authentication…" : "Ask a question…"} /><button type="submit" disabled={mode === "investigate" ? !graph || !draft.trim() || investigationLoading : !packet || !draft.trim() || loading}>{mode === "investigate" ? "Investigate" : "Send"}</button></div></form>
  </aside>;
}
