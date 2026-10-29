import type { SourceCoverage } from "../../lib/archaeology/scanner";

export default function SourceCoverageBanner({ coverage }: { coverage: SourceCoverage | undefined }) {
  if (!coverage) return null;
  return <div className={`source-coverage-banner${coverage.partial ? " partial" : ""}`} role="status" aria-label="Repository source coverage"><strong>{coverage.partial ? "Partial source analysis" : "Complete supported-source analysis"}</strong><span>{coverage.eligibleFiles.toLocaleString()} eligible · {coverage.selectedFiles.toLocaleString()} selected · {coverage.omittedFiles.toLocaleString()} omitted · {coverage.analyzedFiles.toLocaleString()} analyzed · {coverage.skippedFiles.toLocaleString()} excluded or unsupported</span>{coverage.partial && <small>Only selected source was analyzed. Missing components, relationships, and features cannot be treated as absent.</small>}</div>;
}
