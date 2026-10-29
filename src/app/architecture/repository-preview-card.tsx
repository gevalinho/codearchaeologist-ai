"use client";

import Image from "next/image";
import { useState } from "react";
import type { ReturnTypePreview } from "./repository-preview-types";

export default function RepositoryPreviewCard({ preview }: { preview: ReturnTypePreview }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  return <article className="repository-preview" aria-label="Repository preview">
    <div className="repository-preview-top"><div className="repository-preview-avatar">{preview.avatarUrl && !avatarFailed ? <Image src={preview.avatarUrl} alt={`${preview.owner} GitHub owner avatar`} width={72} height={72} unoptimized onError={() => setAvatarFailed(true)} /> : <span aria-label="Repository placeholder" role="img">GH</span>}</div><div><small>{preview.kind === "public" ? "PUBLIC GITHUB REPOSITORY" : preview.kind === "private" ? "PRIVATE GITHUB ANALYSIS" : preview.kind === "local" ? "LOCAL REPOSITORY" : "IMPORTED ARTIFACT"}</small><h2>{preview.name}</h2>{preview.owner && <p>Owned by {preview.owner}</p>}</div></div>
    {preview.avatarUrl && !avatarFailed && <p className="repository-preview-note">GitHub owner avatar · not a repository logo</p>}
    {preview.repositoryUrl && <a className="repository-preview-link" href={preview.repositoryUrl} target="_blank" rel="noopener noreferrer">View public repository on GitHub ↗</a>}
    {preview.commit && <div className="repository-preview-commit"><span>Analyzed commit</span><code title="Shortened commit SHA">{preview.commit}</code></div>}
    <div className="repository-preview-coverage"><div><strong>Source coverage</strong>{preview.coverage?.partial && <span className="repository-preview-partial">PARTIAL ANALYSIS</span>}</div>
      {preview.coverage ? <><div className="repository-preview-counts"><span><b>{preview.coverage.eligible}</b> Eligible</span><span><b>{preview.coverage.selected}</b> Selected</span><span><b>{preview.coverage.analyzed}</b> Analyzed</span><span><b>{preview.coverage.omitted}</b> Omitted</span></div>{preview.coverage.percent !== null && <div className="repository-preview-meter" role="progressbar" aria-label="Eligible source files analyzed" aria-valuemin={0} aria-valuemax={preview.coverage.eligible} aria-valuenow={preview.coverage.analyzed}><span style={{ width: `${preview.coverage.percent}%` }} /></div>}{preview.coverage.partial && <p>Findings may omit relationships or feature candidates in files outside this analysis.</p>}</> : <p>{preview.analyzed} analyzed files. Eligible and omitted counts are unavailable for this snapshot.</p>}
    </div>
  </article>;
}
