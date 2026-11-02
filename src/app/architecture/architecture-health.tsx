"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Graph, Node, SourceRef } from "../../lib/archaeology/scanner";
import {
  analyzeArchitectureHealth,
  type ArchitectureHealthFinding,
  type HealthCategory,
  type ReviewPriority,
} from "../../lib/architecture/architecture-health";
import { sourceReference } from "../../lib/architecture/graph";
import type { EvidenceOrigin } from "../../lib/architecture/ai-evidence";
import {
  advisorCitations,
  buildHealthAdvisorPacket,
  parseHealthAdvisorResponse,
} from "../../lib/architecture/ai-health-advisor";
import { readAiJsonResponse } from "../../lib/architecture/ai-http-response";
import type {
  HealthAdvisorEvidence,
  HealthAdvisorResponse,
} from "../../lib/architecture/ai-health-advisor";

const categoryOrder: HealthCategory[] = [
  "oversized-component",
  "method-concentration",
  "mixed-responsibility-signal",
  "dependency-concentration",
];
const categoryLabels: Record<HealthCategory, string> = {
  "oversized-component": "Large source spans",
  "method-concentration": "Method concentration",
  "mixed-responsibility-signal": "Mixed-topic signals",
  "dependency-concentration": "Dependency concentration",
};
const priorityOrder: ReviewPriority[] = ["high", "medium", "low"];
const priorityRank: Record<ReviewPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
const pageSize = 40;
export type ComponentHealthGroup = {
  component: Node;
  sourcePath: string | null;
  findings: ArchitectureHealthFinding[];
  highestPriority: ReviewPriority;
  structuralMetrics: ArchitectureHealthFinding["metrics"];
};

export function groupArchitectureHealthFindings(
  findings: ArchitectureHealthFinding[],
): ComponentHealthGroup[] {
  const groups = new Map<string, ComponentHealthGroup>();
  for (const finding of findings) {
    let group = groups.get(finding.component.id);
    if (!group) {
      group = {
        component: finding.component,
        sourcePath: finding.sourcePath,
        findings: [],
        highestPriority: finding.priority,
        structuralMetrics: [],
      };
      groups.set(finding.component.id, group);
    }
    group.findings.push(finding);
    if (priorityRank[finding.priority] < priorityRank[group.highestPriority]) {
      group.highestPriority = finding.priority;
    }
    for (const metric of finding.metrics) {
      if (!group.structuralMetrics.some((existing) =>
        existing.label === metric.label &&
        existing.value === metric.value &&
        existing.threshold === metric.threshold
      )) {
        group.structuralMetrics.push(metric);
      }
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      structuralMetrics: [...group.structuralMetrics].sort((left, right) =>
        left.label.localeCompare(right.label) ||
        String(left.value).localeCompare(String(right.value)),
      ),
    }))
    .sort((left, right) =>
      priorityRank[left.highestPriority] - priorityRank[right.highestPriority] ||
      right.findings.length - left.findings.length ||
      left.component.id.localeCompare(right.component.id),
    );
}

function DiagnosticCard({
  finding,
  onExploreComponent,
  onFocusEvidence,
}: {
  finding: ArchitectureHealthFinding;
  onExploreComponent: (component: Node) => void;
  onFocusEvidence: (source: SourceRef) => void;
}) {
  return (
    <article className={`health-finding health-priority-${finding.priority}`}>
      <header>
        <div>
          <small>
            {finding.categoryLabel} · {finding.priority} priority ·{" "}
            {finding.basis === "heuristic" ? "heuristic signal" : "measured structure"}
          </small>
          <h4>{finding.categoryLabel}</h4>
        </div>
        <span className={`health-priority-badge health-priority-badge-${finding.priority}`}>
          {finding.severity}
        </span>
      </header>
      <p>{finding.explanation}</p>
      <dl className="health-metrics">
        {finding.metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
            <small>
              Threshold {metric.threshold} ·{" "}
              {metric.basis === "heuristic" ? "heuristic" : "observed source structure"}
            </small>
          </div>
        ))}
      </dl>
      <p className="health-priority-explanation">{finding.priorityExplanation}</p>
      <details className="health-evidence">
        <summary>
          Supporting evidence · {finding.evidence.totalNodes} nodes,{" "}
          {finding.evidence.totalEdges} edges,{" "}
          {finding.evidence.totalSourceRefs} source references
        </summary>
        {finding.evidence.truncated && (
          <p>
            Evidence display is capped at 100 items per type; the totals above
            include all supporting items.
          </p>
        )}
        {finding.evidence.sourceRefs.length ? (
          <div className="health-source-refs">
            {finding.evidence.sourceRefs.slice(0, 8).map((source) => (
              <button
                type="button"
                key={sourceReference(source)}
                onClick={() => onFocusEvidence(source)}
              >
                {sourceReference(source)}
              </button>
            ))}
            {finding.evidence.totalSourceRefs > 8 && (
              <small>
                Showing 8 of {finding.evidence.totalSourceRefs} references
              </small>
            )}
          </div>
        ) : (
          <p>No usable source references were extracted for this finding.</p>
        )}
        <p>
          {finding.evidence.nodes.length} supporting graph nodes and{" "}
          {finding.evidence.edges.length} supporting relationships are attached
          to this finding.
        </p>
      </details>
      <div className="health-limitations">
        <strong>Limitations</strong>
        <ul>
          {finding.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </div>
      <div className="health-next-steps">
        <strong>Suggested next investigation</strong>
        <ul>
          {finding.nextSteps.map((step) => <li key={step}>{step}</li>)}
        </ul>
      </div>
      <button
        type="button"
        className="health-explore-button"
        onClick={() => onExploreComponent(finding.component)}
      >
        Explore component in relationship map →
      </button>
    </article>
  );
}

export default function ArchitectureHealth({
  graph,
  origin,
  artifactId,
  onExploreComponent,
  onFocusEvidence,
}: {
  graph: Graph;
  origin?: EvidenceOrigin | null;
  artifactId?: string | null;
  onExploreComponent: (component: Node) => void;
  onFocusEvidence: (source: SourceRef) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [advisorConsent, setAdvisorConsent] = useState(false);
  const [advisorReview, setAdvisorReview] = useState(false);
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [advisorError, setAdvisorError] = useState("");
  const [advisorResult, setAdvisorResult] = useState<HealthAdvisorResponse | null>(null);
  const [advisorEvidence, setAdvisorEvidence] = useState<HealthAdvisorEvidence[]>([]);
  const advisorRequest = useRef<AbortController | null>(null);
  const result = useMemo(() => analyzeArchitectureHealth(graph), [graph]);
  const advisorPacket = useMemo(
    () => buildHealthAdvisorPacket(graph, result),
    [graph, result],
  );
  const componentGroups = useMemo(
    () => groupArchitectureHealthFindings(result.findings),
    [result.findings],
  );
  useEffect(() => () => advisorRequest.current?.abort(), []);
  const findingComponents = graph.nodes.filter((node) =>
    ["class", "controller", "service", "factory", "component"].includes(node.kind),
  ).length;

  async function askAdvisor() {
    if (!origin || !advisorConsent || advisorLoading || advisorPacket.findings.length === 0) return;
    const controller = new AbortController();
    advisorRequest.current = controller;
    setAdvisorLoading(true);
    setAdvisorError("");
    try {
      const response = await fetch("/api/feature-interpretation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Architecture-Health-Advisor": "1",
        },
        body: JSON.stringify({
          mode: "architecture-health",
          graph,
          origin,
          consent: true,
          ...(artifactId ? { artifactId } : {}),
        }),
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await readAiJsonResponse(response);
      if (!response.ok) {
        throw new Error(typeof body.error === "string"
          ? body.error
          : "AI advisor request failed.");
      }
      if (body.scope !== "architecture-health" || body.snapshotId !== graph.snapshotId) {
        throw new Error("AI advice belongs to a different architecture snapshot.");
      }
      const advisor = parseHealthAdvisorResponse(
        body.advisor,
        advisorPacket,
      );
      if (!controller.signal.aborted) {
        setAdvisorResult(advisor);
        setAdvisorEvidence(advisorCitations(advisor, advisorPacket));
        setAdvisorReview(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setAdvisorError(cause instanceof Error ? cause.message : "AI advisor request failed.");
      }
    } finally {
      if (advisorRequest.current === controller) {
        advisorRequest.current = null;
        setAdvisorLoading(false);
      }
    }
  }

  const evidenceById = new Map(advisorEvidence.map((item) => [item.id, item]));
  const findingById = new Map(result.findings.map((finding) => [finding.id, finding]));
  function citedEvidence(ids: string[]) {
    return (
      <div className="health-advisor-citations">
        {ids.map((id) => {
          const item = evidenceById.get(id);
          if (!item) return null;
          return (
            <button
              type="button"
              key={id}
              disabled={!item.source}
              onClick={() => item.source && onFocusEvidence(item.source)}
              title={item.source ? sourceReference(item.source) : "Source reference unavailable"}
            >
              {item.id} · {item.label}{item.source ? ` · ${sourceReference(item.source)}` : " · no source reference"}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <section className="architecture-health" aria-label="Architecture health diagnostics">
      <header className="health-header">
        <div>
          <small>DETERMINISTIC GRAPH ANALYSIS · NO SOURCE BODIES SENT TO AI</small>
          <h2>Architecture health</h2>
          <p>
            Measured source structure and observed graph relationships are
            separated from low-confidence method-name heuristics. Findings are
            investigation prompts, not automatic design verdicts. Observed
            extraction is not runtime verification. Review thresholds (200
            lines, 15 declared methods, or 8 distinct neighboring nodes) are
            conservative triage defaults, not universal quality rules.
          </p>
        </div>
        <strong>
          {result.componentsRequiringAttention} COMPONENTS ·{" "}
          {result.totalFindings} FINDINGS
        </strong>
      </header>

      {result.limitMessage && !result.analysisSkipped && (
        <p className="health-limit-message" role="status">{result.limitMessage}</p>
      )}

      <div className="health-summary" aria-label="Findings by review priority">
        <div><strong>{result.componentsRequiringAttention}</strong><span>Components flagged</span></div>
        <div><strong>{result.totalFindings}</strong><span>Total findings</span></div>
        {priorityOrder.map((priority) => (
          <div key={priority}>
            <strong>{result.priorityCounts[priority]}</strong>
            <span>{priority} priority</span>
          </div>
        ))}
      </div>

      <section className="health-category-summary" aria-label="Findings by category">
        <h3>Findings by category</h3>
        <div>
          {categoryOrder.map((category) => (
            <article key={category}>
              <strong>{result.categoryCounts[category]}</strong>
              <span>{categoryLabels[category]}</span>
            </article>
          ))}
        </div>
      </section>

      {origin && !result.analysisSkipped && result.findings.length > 0 && (
        <section className="health-advisor" aria-label="AI Architecture Advisor">
          <div className="health-advisor-action">
            <div>
              <small>OPTIONAL AI INTERPRETATION · NOT A DIAGNOSTIC</small>
              <h3>Architecture Advisor</h3>
              <p>
                Ask for conservative explanations and investigation ideas based on these
                deterministic findings. The app server recomputes the findings from this
                graph; only bounded labels, measurements, relationships, and source
                references are sent to the configured AI provider. Source bodies are excluded.
              </p>
            </div>
            {!advisorReview && !advisorResult && (
              <button
                type="button"
                className="health-explore-button"
                onClick={() => { setAdvisorError(""); setAdvisorReview(true); }}
                disabled={advisorLoading}
              >
                Ask AI Advisor
              </button>
            )}
          </div>
          {advisorReview && (
            <div className="health-advisor-consent">
              <p>
                Review the scope: the browser sends the graph artifact to this app, which
                validates it and derives a bounded evidence packet. Component names,
                repository paths, measured health values, and cited graph metadata may be
                shared with the external provider. No source-code bodies are sent.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={advisorConsent}
                  onChange={(event) => setAdvisorConsent(event.target.checked)}
                />
                I agree to send this bounded Architecture Health evidence for AI advice.
              </label>
              <div>
                <button type="button" onClick={() => setAdvisorReview(false)} disabled={advisorLoading}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="health-explore-button"
                  onClick={() => void askAdvisor()}
                  disabled={!advisorConsent || advisorLoading}
                >
                  {advisorLoading ? "Reviewing findings…" : "Send findings for advice"}
                </button>
              </div>
            </div>
          )}
          {advisorLoading && <p className="health-advisor-status" role="status">Generating evidence-cited investigation guidance…</p>}
          {advisorError && <p className="health-advisor-error" role="alert">{advisorError}</p>}
          {advisorResult && (
            <div className="health-advisor-result" aria-live="polite">
              <header>
                <small>AI-GENERATED GUIDANCE · DETERMINISTIC FINDINGS ABOVE ARE UNCHANGED</small>
                <button type="button" onClick={() => { setAdvisorResult(null); setAdvisorEvidence([]); setAdvisorConsent(false); setAdvisorReview(true); }}>
                  Ask again
                </button>
              </header>
              <p className="health-advisor-disclaimer">
                These are hypotheses for investigation, not confirmed defects or safe refactoring plans.
                Inspect source and tests before making changes.
              </p>
              {advisorResult.observations.map((observation) => {
                const finding = findingById.get(observation.findingId);
                return (
                  <article className="health-advisor-item" key={`observation:${observation.findingId}`}>
                    <strong>{finding?.component.name ?? "Architecture finding"} · observed finding interpretation</strong>
                    <p>{observation.explanation}</p>
                    {citedEvidence(observation.evidenceIds)}
                    {finding && (
                      <button type="button" onClick={() => onExploreComponent(finding.component)}>
                        Explore affected component in relationship map →
                      </button>
                    )}
                  </article>
                );
              })}
              {advisorResult.recommendations.map((recommendation) => {
                const finding = findingById.get(recommendation.findingId);
                return (
                  <article className="health-advisor-item health-advisor-recommendation" key={`recommendation:${recommendation.findingId}`}>
                    <strong>{finding?.component.name ?? "Architecture finding"} · modernization hypothesis</strong>
                    <p>{recommendation.hypothesis}</p>
                    <ol>{recommendation.investigationSteps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}</ol>
                    {citedEvidence(recommendation.evidenceIds)}
                    {finding && (
                      <button type="button" onClick={() => onExploreComponent(finding.component)}>
                        Explore affected component in relationship map →
                      </button>
                    )}
                  </article>
                );
              })}
              <details className="health-limitations">
                <summary>AI uncertainty and evidence limitations</summary>
                <ul>
                  {advisorResult.uncertainty.map((item) => <li key={item}>{item}</li>)}
                  {advisorPacket.limitations.map((item) => <li key={`packet:${item}`}>{item}</li>)}
                </ul>
              </details>
            </div>
          )}
        </section>
      )}

      {result.limitations.length > 0 && (
        <details className="health-graph-limitations">
          <summary>Repository scan limitations ({result.limitations.length})</summary>
          <ul>{result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        </details>
      )}

      {result.analysisSkipped ? (
        <p className="health-empty" role="status">{result.limitMessage}</p>
      ) : result.findings.length === 0 ? (
        <p className="health-empty" role="status">
          {findingComponents === 0
            ? "This graph has no supported class, controller, service, factory, or component nodes to assess."
            : "No components crossed the current diagnostic thresholds. This does not prove that the architecture is free of risk."}
        </p>
      ) : (
        <>
          <div className="health-findings-heading">
            <h3>Components requiring attention</h3>
            <span>
              Showing {Math.min(visibleCount, componentGroups.length)} of{" "}
              {componentGroups.length} components · {result.findings.length}{" "}
              findings
            </span>
          </div>
          <div className="health-findings">
            {componentGroups.slice(0, visibleCount).map((group) => (
              <details
                className={`health-component-group health-priority-${group.highestPriority}`}
                key={group.component.id}
              >
                <summary>
                  <div className="health-component-summary">
                    <div className="health-component-identity">
                      <strong>{group.component.name}</strong>
                      <code>{group.sourcePath ?? "Source path unavailable"}</code>
                    </div>
                    <div className="health-component-count">
                      <strong>{group.findings.length}</strong>
                      <span>
                        {group.findings.length === 1 ? "finding" : "findings"}
                      </span>
                    </div>
                    <span
                      className={`health-priority-badge health-priority-badge-${group.highestPriority}`}
                    >
                      {group.highestPriority} priority
                    </span>
                  </div>
                </summary>
                {group.structuralMetrics.length > 0 && (
                  <dl className="health-component-metrics">
                    {group.structuralMetrics.map((metric) => (
                      <div key={`${metric.label}:${metric.value}`}>
                        <dt>{metric.label}</dt>
                        <dd>{metric.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <div className="health-component-findings">
                  {group.findings.map((finding) => (
                    <DiagnosticCard
                      key={finding.id}
                      finding={finding}
                      onExploreComponent={onExploreComponent}
                      onFocusEvidence={onFocusEvidence}
                    />
                  ))}
                </div>
              </details>
            ))}
          </div>
          {visibleCount < componentGroups.length && (
            <button
              type="button"
              className="health-show-more"
              onClick={() => setVisibleCount((count) => count + pageSize)}
            >
              Show next {Math.min(pageSize, componentGroups.length - visibleCount)} components
            </button>
          )}
        </>
      )}
    </section>
  );
}
