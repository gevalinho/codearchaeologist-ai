"use client";

import { useEffect, useRef, useState } from "react";
import type { SourceRef } from "../../lib/archaeology/scanner";
import type { EvidencePacket } from "../../lib/architecture/ai-evidence";
import { parseAiResponseEnvelope, type AiClaim, type AiInterpretation } from "../../lib/architecture/ai-interpretation";
import { parseChatAnswer, type ChatAnswer, type ChatTurn } from "../../lib/architecture/ai-chat";
import { sourceReference } from "../../lib/architecture/graph";

export default function AiInterpretationPanel({ packet, artifactId, onFocusEvidence, onOpenPreview, previewAvailable }: { packet: EvidencePacket | null; artifactId?: string | null; onFocusEvidence: (ref: SourceRef) => void; onOpenPreview: () => void; previewAvailable: boolean }) {
  const [consent, setConsent] = useState(false), [question, setQuestion] = useState(""), [history, setHistory] = useState<ChatTurn[]>([]), [chatAnswers, setChatAnswers] = useState<{ question: string; answer: ChatAnswer }[]>([]);
  const [result, setResult] = useState<AiInterpretation | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  async function analyze() {
    if (!packet || !consent || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setError(""); setResult(null); setHistory([]); setChatAnswers([]); setLoading(true);
    try {
      const response = await fetch("/api/feature-interpretation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packet, consent: true, ...(artifactId ? { artifactId } : {}) }), cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (!response.ok) {
        const category = typeof body.diagnostic?.category === "string" && /^(?:provider_(?:config|http|timeout|malformed|network|incomplete)|invalid_interpretation)$/.test(body.diagnostic.category) ? body.diagnostic.category.replaceAll("_", " ") : "";
        const upstream = Number.isInteger(body.diagnostic?.upstreamStatus) && body.diagnostic.upstreamStatus >= 400 && body.diagnostic.upstreamStatus <= 599 ? ` · upstream HTTP ${body.diagnostic.upstreamStatus}` : "";
        const finish = ["stop", "length", "content_filter", "tool_calls"].includes(body.diagnostic?.finishReason) ? ` · finish ${body.diagnostic.finishReason}` : "";
        const output = Number.isSafeInteger(body.diagnostic?.outputTokens) && body.diagnostic.outputTokens >= 0 ? ` · output ${body.diagnostic.outputTokens} tokens` : "";
        const reasoning = Number.isSafeInteger(body.diagnostic?.reasoningTokens) && body.diagnostic.reasoningTokens >= 0 ? ` · reasoning ${body.diagnostic.reasoningTokens} tokens` : "";
        throw new Error(`${typeof body.error === "string" ? body.error : "AI interpretation failed."}${category ? ` (${category}${upstream}${finish}${output}${reasoning})` : ""}`);
      }
      const parsed = parseAiResponseEnvelope(body, packet);
      if (!controller.signal.aborted) setResult(parsed);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "AI interpretation failed."); }
    finally { if (pending.current === controller) { pending.current = null; setLoading(false); } }
  }
  async function ask() {
    if (!packet || !consent || !result || !question.trim() || pending.current) return;
    const asked = question.trim();
    const controller = new AbortController(); pending.current = controller; setLoading(true); setError("");
    try {
      const response = await fetch("/api/feature-interpretation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packet, consent: true, question: asked, history: history.slice(-6), ...(artifactId ? { artifactId } : {}) }), cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "AI answer failed. Retry shortly.");
      if (body.featureId !== packet.featureId || body.snapshotId !== packet.snapshotId) throw new Error("AI answer belongs to a different investigation.");
      const answer = parseChatAnswer(body.answer, packet);
      if (!controller.signal.aborted) { setChatAnswers(previous => [...previous, { question: asked, answer }]); setHistory(previous => [...previous, { role: "user" as const, text: asked }, { role: "assistant" as const, text: answer.answer, evidenceIds: answer.evidenceIds }].slice(-6)); setQuestion(""); }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "AI answer failed."); }
    finally { if (pending.current === controller) { pending.current = null; setLoading(false); } }
  }
  const evidence = new Map(packet?.items.map(item => [item.id, item]) ?? []);
  function claims(title: string, values: AiClaim[]) {
    if (!values.length) return null;
    return <section className="feature-ai-group"><h4>{title}</h4>{values.map((claim, index) => <article key={`${title}:${index}`}><p>{claim.text}</p><div>{claim.evidenceIds.map(id => { const item = evidence.get(id); return item ? <button key={id} type="button" title={item.label} onClick={() => onFocusEvidence(item.source)}>{id} · {sourceReference(item.source)} · {item.certainty}</button> : null; })}</div></article>)}</section>;
  }
  return <section className="feature-ai" aria-label="AI feature interpretation">
    <div className="feature-ai-notice"><strong>AI interpretation · review required</strong><p>AI can suggest meaning from cited static evidence. Citations show where a pattern was recorded; they do not prove that an interpretation is correct or that code ran.</p></div>
    {!packet ? <p role="status">This candidate has no safe, bounded evidence packet for AI analysis.</p> : <>
      <p className="feature-ai-origin">Evidence origin: {packet.origin.replaceAll("-", " ")}. {packet.items.length} bounded references. Source bodies and excerpts are unavailable and will not be sent.</p>
      {packet.sourceCoverage?.partial && <p className="feature-ai-origin" role="status">Partial source analysis: {packet.sourceCoverage.eligibleFiles} eligible, {packet.sourceCoverage.selectedFiles} selected, {packet.sourceCoverage.omittedFiles} omitted, {packet.sourceCoverage.analyzedFiles} analyzed. Missing features or relationships cannot be ruled out.</p>}
      <details className="feature-disclosure"><summary>Review the evidence that would be sent</summary><p>The packet includes component and relationship labels, generic rule patterns, source paths and line ranges, classification, and a deterministic proposal summary when available. It excludes source bodies, credentials, and environment variables.</p>{packet.items.map(item => <code key={item.id}>{item.id} · {item.label} · {sourceReference(item.source)} · {item.certainty}</code>)}</details>
      <label className="feature-ai-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> I agree to send this bounded evidence metadata to the server-configured external AI provider. {packet.origin === "private-github" ? "This includes private repository paths and line references." : "This may include repository paths and line references."}</label>
      <button type="button" onClick={() => void analyze()} disabled={!consent || loading}>{loading ? "Analyzing evidence…" : result ? "Retry analysis" : "Analyze with AI"}</button>
      {loading && <p role="status">Interpreting the selected feature’s bounded evidence…</p>}
      {error && <p role="alert" className="feature-ai-error">{error}</p>}
      {result && <div className="feature-ai-result" role="status"><h4>Proposed purpose · evidence-supported interpretation</h4>{packet.sourceCoverage?.partial && <p>Partial source analysis · omitted files may contain additional evidence.</p>}<p>{result.purpose.text}</p>{claims("Possible actors and responsibilities", result.actors)}{claims("Possible workflow steps", result.steps)}{claims("Relevant rule interpretations", result.businessRules)}{claims("Data inputs and outputs", result.dataFlows)}{claims("Dependencies", result.dependencies)}{claims("Modernization suggestions · speculative", result.modernization)}{claims("Open questions", result.openQuestions)}<details className="feature-disclosure"><summary>Uncertainty and evidence limitations</summary>{[...result.uncertainty, ...packet.limitations].map((item, index) => <p key={`${index}:${item}`}>{item}</p>)}</details>{previewAvailable && <button type="button" onClick={onOpenPreview}>Open existing synthetic preview ↗</button>}<div className="feature-ai-chat" aria-label="AI follow-up conversation">{chatAnswers.map(({ question: asked, answer }, index) => <article key={`${index}:${asked}`}><strong>{asked}</strong><p>{answer.answer}</p>{packet.sourceCoverage?.partial && <small>Partial source analysis · omitted files may contain additional evidence.</small>}<small>Uncertainty: {answer.uncertainty}</small><div>{answer.evidenceIds.map(id => { const item = evidence.get(id); return item && <button key={id} type="button" onClick={() => onFocusEvidence(item.source)}>{id} · {sourceReference(item.source)}</button>; })}</div></article>)}<form onSubmit={event => { event.preventDefault(); void ask(); }}><label>Ask about rules, dependencies, architecture, or modernization<input value={question} maxLength={300} onChange={event => setQuestion(event.target.value)} disabled={loading} /></label><button disabled={loading || !consent || !question.trim()}>Ask AI</button></form></div></div>}
    </>}
  </section>;
}
