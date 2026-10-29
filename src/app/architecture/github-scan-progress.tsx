"use client";

import { useEffect, useState } from "react";
import type { GitHubJobPhase, GitHubJobStatus } from "../../lib/github-ingestion/jobs";

const stages: { phase: GitHubJobPhase | "preparing-workspace" | "identifying-candidates"; label: string; event: string }[] = [
  { phase: "validating-repository-url", label: "Validating repository", event: "Repository validation started" },
  { phase: "preparing-isolated-scanner", label: "Preparing sandbox", event: "Repository validated · sandbox verification started" },
  { phase: "fetching-repository", label: "Acquiring source", event: "Sandbox security verified · source acquisition started" },
  { phase: "scanning-supported-source-files", label: "Scanning source files", event: "Source acquisition completed · isolated scan started" },
  { phase: "generating-architecture-graph", label: "Building architecture graph", event: "Source scan completed · architecture extraction started" },
  { phase: "validating-graph", label: "Validating graph artifact", event: "Architecture extraction completed · graph validation started" },
  { phase: "preparing-workspace", label: "Preparing investigation workspace", event: "Graph artifact ready" },
  { phase: "identifying-candidates", label: "Identifying feature candidates", event: "Feature candidates identified" },
];
const backendPhases = new Set<GitHubJobPhase>(["validating-repository-url", "preparing-isolated-scanner", "fetching-repository", "scanning-supported-source-files", "generating-architecture-graph", "validating-graph", "ready", "failed", "cancelled"]);
export function appendObservedPhase(previous: GitHubJobPhase[], phase: GitHubJobPhase): GitHubJobPhase[] {
  if (!backendPhases.has(phase) || previous.at(-1) === phase) return previous;
  const order: GitHubJobPhase[] = ["validating-repository-url", "preparing-isolated-scanner", "fetching-repository", "scanning-supported-source-files", "generating-architecture-graph", "validating-graph", "ready"];
  const last = previous.at(-1);
  if (last && order.includes(last) && order.includes(phase) && order.indexOf(phase) < order.indexOf(last)) return previous;
  return [...previous, phase].slice(-6);
}
export function githubProgressState(job: GitHubJobStatus | null, submitting: boolean, error: string, workspaceReady: boolean, observed: GitHubJobPhase[]) {
  const failed = !!error || job?.phase === "failed" || job?.phase === "cancelled";
  const complete = !!job && job.phase === "ready" && workspaceReady && !failed;
  const activePhase = complete ? "identifying-candidates" : job?.phase === "ready" ? "preparing-workspace" : job?.phase === "failed" || job?.phase === "cancelled" ? [...observed].reverse().find(phase => !["failed", "cancelled", "ready"].includes(phase)) ?? "validating-repository-url" : job?.phase ?? "validating-repository-url";
  const activeIndex = Math.max(0, stages.findIndex(stage => stage.phase === activePhase));
  return { failed, complete, activeIndex, activeLabel: stages[activeIndex].label, busy: submitting && !failed && !complete };
}
const elapsed = (startedAt: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export default function GitHubScanProgress({ repository, startedAt, submitting, job, error, observed, workspaceReady, featureCount, onCancel, onRetry, compact = false }: {
  repository: string; startedAt: number; submitting: boolean; job: GitHubJobStatus | null; error: string; observed: GitHubJobPhase[]; workspaceReady: boolean; featureCount?: number; onCancel: () => void; onRetry: () => void; compact?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!submitting) return; const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, [submitting]);
  const state = githubProgressState(job, submitting, error, workspaceReady, observed);
  const summary = job?.summary;
  const diagnostics = job?.diagnostics;
  const activeServerJob = !!job && !["ready", "failed", "cancelled"].includes(job.phase);
  const retryable = state.failed && (!job || job.phase === "failed" || job.phase === "cancelled");
  const feed = observed.filter(phase => !["failed", "cancelled"].includes(phase)).map(phase => phase === "ready" ? "Graph artifact ready" : stages.find(stage => stage.phase === phase)?.event).filter((value): value is string => !!value).slice(-4);
  if (workspaceReady && state.complete) feed.push("Feature candidates identified");
  return <section className={`github-progress ${state.busy ? "is-active" : state.failed ? "is-failed" : "is-ready"}${compact ? " is-compact" : ""}`} aria-label="GitHub repository investigation progress">
    <div className="github-progress-head"><span className="github-progress-orbit" aria-hidden="true"><span /></span><div><small>GITHUB INVESTIGATION</small><h2>{job?.repository ?? repository}</h2><p role="status" aria-live="polite" aria-atomic="true">{state.failed ? `Stopped during ${state.activeLabel.toLowerCase()}` : state.complete ? "Investigation workspace ready" : job ? state.activeLabel : "Submitting repository analysis"}</p></div><strong>{state.failed ? "STOPPED" : state.complete ? "READY" : "SCANNING"}</strong></div>
    {!compact && <>
      <div className="github-progress-track" role="progressbar" aria-label="Repository investigation progress" aria-valuetext={state.failed ? "Scan stopped" : state.complete ? "Investigation ready" : state.activeLabel}><span /></div>
      <div className="github-progress-metrics" aria-live="off"><span><b>{elapsed(startedAt, now)}</b> elapsed</span>{summary && <>{summary.eligibleFiles !== undefined && <span><b>{summary.eligibleFiles.toLocaleString()}</b> eligible files</span>}{summary.selectedFiles !== undefined && <span><b>{summary.selectedFiles.toLocaleString()}</b> selected files</span>}{summary.omittedFiles !== undefined && <span><b>{summary.omittedFiles.toLocaleString()}</b> omitted files</span>}<span><b>{summary.scannedFiles.toLocaleString()}</b> analyzed files</span><span><b>{summary.skippedFiles.toLocaleString()}</b> skipped or excluded</span><span><b>{summary.nodes.toLocaleString()}</b> components</span><span><b>{summary.edges.toLocaleString()}</b> relationships</span>{featureCount !== undefined && <span><b>{featureCount.toLocaleString()}</b> feature candidates</span>}</>}</div>
      {diagnostics && <details className="github-progress-diagnostics"><summary>Acquisition diagnostics</summary><p>{diagnostics.selectedBlobs} selected blobs · {diagnostics.completedBlobs} completed · {diagnostics.failedBlobs} failed</p><p>{([[
        "Docker readiness", diagnostics.dockerReadinessMs], ["Metadata and commit", diagnostics.metadataCommitMs], ["Tree validation", diagnostics.treeMs], ["File selection", diagnostics.selectionMs], ["Blob acquisition", diagnostics.blobAcquisitionMs], ["Sandbox scan", diagnostics.sandboxScanMs], ["Graph validation", diagnostics.graphValidationMs],
      ] as [string, number | undefined][]).filter((entry): entry is [string, number] => entry[1] !== undefined).map(([label, ms]) => `${label}: ${ms} ms`).join(" · ")}</p></details>}
      <div className="github-progress-body"><ol className="github-progress-stages" aria-label="Investigation stages">{stages.map((stage, index) => {
        const status = state.failed && index === state.activeIndex ? "failed" : state.complete || index < state.activeIndex ? "done" : index === state.activeIndex ? "current" : "pending";
        return <li key={stage.phase} className={status} aria-current={status === "current" ? "step" : undefined}><span aria-hidden="true">{status === "done" ? "✓" : status === "failed" ? "!" : String(index + 1).padStart(2, "0")}</span>{stage.label}</li>;
      })}</ol><div className="github-progress-feed"><h3>Activity</h3>{feed.length ? <ol>{feed.map((event, index) => <li key={`${index}:${event}`}>{event}</li>)}</ol> : <p>Waiting for the first server status.</p>}</div></div>
      {summary && <p className="github-progress-coverage">{summary.coverage === "partial-supported-source" ? "Partial supported-source assessment; missing features cannot be ruled out" : "Complete supported-source assessment"} · Counts reflect the completed graph, not live file-by-file progress.</p>}
      {state.failed && <p className="github-progress-error" role="alert">{error || job?.error || "GitHub analysis stopped."}</p>}
      <div className="github-progress-actions">{activeServerJob && <button type="button" onClick={onCancel}>{state.failed ? "Cancel server job" : "Cancel analysis"}</button>}{retryable && <button type="button" onClick={onRetry}>Retry analysis</button>}{state.failed && activeServerJob ? <small>Server status is uncertain. Cancel this job before starting another.</small> : state.busy ? <small>Leaving this page does not cancel the server job. Use Cancel analysis to stop it.</small> : null}</div>
    </>}
  </section>;
}
