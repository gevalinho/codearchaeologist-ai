"use client";

import { useEffect, useRef, useState } from "react";
import type { SourceRef } from "../../lib/archaeology/scanner";
import type { ChatTurn } from "../../lib/architecture/ai-chat";
import { parseRepositoryAnswer, type RepositoryAnswer } from "../../lib/architecture/ai-repository-chat";
import type { RepositoryEvidencePacket } from "../../lib/architecture/ai-repository-evidence";
import { sourceReference } from "../../lib/architecture/graph";

export default function RepositoryAiPanel({ packet, onFocusEvidence, onSelectedFeature }: { packet: RepositoryEvidencePacket | null; onFocusEvidence: (ref: SourceRef) => void; onSelectedFeature: () => void }) {
  const [consent, setConsent] = useState(false), [question, setQuestion] = useState(""), [history, setHistory] = useState<ChatTurn[]>([]);
  const [answers, setAnswers] = useState<{ question: string; answer: RepositoryAnswer }[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  async function ask(initial = false) {
    if (!packet || !consent || pending.current) return;
    const asked = initial ? "What does this repository appear to do based on the submitted structural evidence?" : question.trim();
    if (!asked) return;
    const controller = new AbortController(); pending.current = controller; setLoading(true); setError("");
    try {
      const response = await fetch("/api/feature-interpretation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packet, consent: true, question: asked, history: history.slice(-6) }), cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (!response.ok) {
        const code = body.diagnostic?.category === "invalid_interpretation" && typeof body.diagnostic?.validationCategory === "string" ? body.diagnostic.validationCategory : null;
        const explanations: Record<string, string> = { structure: "The AI response did not match the required structure.", classification: "The AI used an unsupported answer classification.", unsafe_text: "The AI response included an unsupported source reference or unsafe text.", citation_limit: "The AI supplied too many or repeated citations.", citation_unknown: "The AI cited evidence outside this packet.", citation_missing: "The AI answer had no supporting citation.", candidate_anchor: "A named candidate lacked its supporting anchor.", purpose_anchors: "The inference lacked two independent candidate anchors.", insufficient_evidence: "The insufficient-evidence answer was not structured correctly." };
        const field = body.diagnostic?.field === "answer" || body.diagnostic?.field === "uncertainty" ? body.diagnostic.field : null;
        const rule = ["control_character", "html_delimiter", "unsafe_url", "source_reference"].includes(body.diagnostic?.rule) ? body.diagnostic.rule : null;
        const detail = code === "unsafe_text" && field && rule ? ` (${field}: ${rule.replaceAll("_", " ")})` : code ? ` (${code})` : "";
        throw new Error(code && explanations[code] ? `${explanations[code]}${detail} Retry or ask a narrower question.` : typeof body.error === "string" ? body.error : "Repository AI answer failed. Retry shortly.");
      }
      if (body.scope !== "repository" || body.snapshotId !== packet.snapshotId) throw new Error("AI answer belongs to a different repository snapshot.");
      const answer = parseRepositoryAnswer(body.answer, packet);
      if (!controller.signal.aborted) {
        setAnswers(previous => [...previous, { question: asked, answer }]);
        setHistory(previous => [...previous, { role: "user" as const, text: asked }, { role: "assistant" as const, text: answer.answer, evidenceIds: answer.evidenceIds }].slice(-6));
        setQuestion("");
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Repository AI answer failed."); }
    finally { if (pending.current === controller) { pending.current = null; setLoading(false); } }
  }
  const evidence = new Map(packet?.items.map(item => [item.id, item]) ?? []);
  return <section className="feature-ai repository-ai" aria-label="Repository overview AI investigation">
    <div className="ai-scope" aria-label="AI investigation scope"><span aria-current="true">Repository overview</span><button type="button" onClick={onSelectedFeature}>Selected feature →</button></div>
    <div className="feature-ai-notice"><strong>Repository overview · structural evidence</strong><p>Candidate names suggest possible capabilities; they do not verify working features or runtime behavior. AI suggestions require source review.</p></div>
    {!packet ? <p role="status">This snapshot has no safe repository-wide evidence packet.</p> : <>
      <p className="feature-ai-origin">{packet.coverage.candidateGroupsRepresented} of {packet.coverage.candidateGroupsFound} candidate groups and {packet.coverage.referencesRepresented} representative references · {packet.coverage.analyzedFiles} analyzed files. {packet.coverage.truncated ? `${packet.coverage.omittedCandidateGroups} candidate groups omitted; other graph evidence was also sampled.` : "No candidate groups omitted."} Source bodies are excluded.</p>
      {packet.sourceCoverage?.partial && <p className="feature-ai-origin" role="status">Partial source analysis: {packet.sourceCoverage.eligibleFiles} eligible, {packet.sourceCoverage.selectedFiles} selected, {packet.sourceCoverage.omittedFiles} omitted, {packet.sourceCoverage.analyzedFiles} analyzed. Missing features or relationships cannot be ruled out.</p>}
      <details className="feature-disclosure"><summary>Review repository metadata before sharing</summary><p>Origin: {packet.origin.replaceAll("-", " ")}. Name-based candidates: {packet.candidates.map(candidate => `${candidate.title} (${candidate.classification.replaceAll("-", " ")})`).join(", ") || "none"}. Languages evidenced: {packet.indicators.map(item => item.language).join(", ") || "none"}. Framework and repository purpose are not asserted without evidence.</p>{packet.items.map(item => <code key={item.id}>{item.id} · {item.label} · {sourceReference(item.source)} · {item.certainty}</code>)}</details>
      <label className="feature-ai-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> I agree to send this broader, bounded repository metadata to the server-configured external AI provider. {packet.origin === "private-github" ? "Private repository paths and line references are included." : "Repository paths and line references are included."}</label>
      <button type="button" disabled={!consent || loading} onClick={() => void ask(true)}>{loading ? "Analyzing repository…" : answers.length ? "Analyze repository again" : "Analyze repository with AI"}</button>
      {loading && <p role="status">Interpreting bounded repository evidence…</p>}
      {error && <p role="alert" className="feature-ai-error">{error}</p>}
      {answers.length > 0 && <div className="feature-ai-chat" aria-label="Repository AI conversation">{answers.map(({ question: asked, answer }, index) => <article key={`${index}:${asked}`}><strong>{asked}</strong><p><em>{answer.status.replaceAll("-", " ")} · </em>{answer.answer}</p>{packet.sourceCoverage?.partial && <small>Partial source analysis · omitted files may contain additional evidence.</small>}<small>Uncertainty: {answer.uncertainty}</small><div>{answer.evidenceIds.map(id => { const item = evidence.get(id); return item && <button key={id} type="button" title={item.label} onClick={() => onFocusEvidence(item.source)}>{id} · {sourceReference(item.source)}</button>; })}</div></article>)}<form onSubmit={event => { event.preventDefault(); void ask(); }}><label>Ask about repository capabilities, architecture, dependencies, or modernization<input value={question} maxLength={300} onChange={event => setQuestion(event.target.value)} disabled={loading} /></label><button disabled={loading || !consent || !question.trim()}>Ask AI</button></form></div>}
      <details className="feature-disclosure"><summary>Coverage and uncertainty</summary>{packet.limitations.map(item => <p key={item}>{item}</p>)}</details>
    </>}
  </section>;
}
