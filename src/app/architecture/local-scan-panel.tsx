import type { BrowserScanPhase, BrowserScanProgress } from "../../lib/archaeology/browser-ingestion";

export type LocalScanPhase = "idle" | "awaiting-picker" | "selected" | BrowserScanPhase | "ready" | "failed";

const stages = [
  ["selected", "Repository selected"],
  ["validating-selection", "Validating selection"],
  ["reading-files", "Reading eligible files"],
  ["extracting-graph", "Extracting graph"],
  ["validating-artifact", "Validating artifact"],
  ["ready", "Investigation ready"],
] as const;

export function localScanBusy(phase: LocalScanPhase): boolean {
  return phase !== "idle" && phase !== "ready" && phase !== "failed";
}

export default function LocalScanPanel({ phase, repositoryName, progress, error, onCancel }: {
  phase: LocalScanPhase;
  repositoryName?: string;
  progress: BrowserScanProgress | null;
  error?: string;
  onCancel: () => void;
}) {
  if (phase === "idle") return null;
  const busy = localScanBusy(phase);
  const stageIndex = stages.findIndex(([key]) => key === phase);
  const title = phase === "awaiting-picker" ? "Waiting for folder selection" : phase === "failed" ? "Scan stopped" : stages[stageIndex]?.[1];
  return <section className={`arch-local-scan ${busy ? "is-active" : phase === "ready" ? "is-ready" : "is-failed"}`} aria-label="Local repository scan">
    <div className="arch-local-scan-head">
      <span className="arch-local-scan-orbit" aria-hidden="true"><span /></span>
      <div><small>LOCAL REPOSITORY SCAN</small><h2>{repositoryName ?? "Selected repository"}</h2><p role="status" aria-live="polite" aria-atomic="true">{title}</p></div>
      <strong className="arch-local-scan-state">{busy ? "SCANNING" : phase === "ready" ? "READY" : "STOPPED"}</strong>
    </div>
    <div className="arch-local-scan-track" role="progressbar" aria-label="Local scan progress" aria-valuetext={title}><span /></div>
    <div className="arch-local-scan-metrics" aria-live="off">
      {progress ? <><span><strong>{progress.filesReceived.toLocaleString()}</strong> files discovered</span><span><strong>{progress.eligibleFiles.toLocaleString()}</strong> eligible · {(progress.filesReceived - progress.eligibleFiles).toLocaleString()} excluded by path or type</span><span><strong>{progress.filesRead.toLocaleString()}</strong> read · {progress.bytesRead.toLocaleString()} bytes</span><span><strong>{progress.processedFiles.toLocaleString()}</strong> processed · {progress.processedBytes.toLocaleString()} bytes{phase === "ready" && progress.eligibleFiles > progress.processedFiles ? ` · ${progress.eligibleFiles - progress.processedFiles} unreadable or changed` : ""}</span></> : <span>Browser folder enumeration is in progress; file counts are not available yet.</span>}
    </div>
    {phase === "failed" && error && <p className="arch-local-scan-error" role="alert">{error}</p>}
    <ol className="arch-local-scan-stages" aria-label="Scan stages">{stages.map(([key, label], index) => <li key={key} className={phase === key ? "current" : stageIndex > index ? "done" : ""} aria-current={phase === key ? "step" : undefined}><span aria-hidden="true">{stageIndex > index ? "✓" : String(index + 1).padStart(2, "0")}</span>{label}</li>)}</ol>
    {busy && phase !== "awaiting-picker" && <button type="button" className="arch-local-scan-cancel" onClick={onCancel}>Cancel scan</button>}
  </section>;
}
