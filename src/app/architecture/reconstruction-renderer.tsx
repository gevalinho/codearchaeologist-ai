"use client";

import { useState } from "react";
import { sourceReference } from "../../lib/architecture/graph";
import { initialReconstructionState, parseReconstructionSpec, submitReconstruction, updateReconstructionField, type ReconstructionSpec } from "../../lib/architecture/reconstruction-spec";

export default function ReconstructionRenderer({ specification }: { specification: ReconstructionSpec }) {
  const spec = parseReconstructionSpec(specification);
  const [state, setState] = useState(() => initialReconstructionState(spec));
  const screen = spec.screens.find(item => item.state === state.screen)!;
  const draft = spec.screens.find(item => item.state === "draft")!;
  const update = (fieldId: string, value: string | number) => setState(current => updateReconstructionField(current, fieldId, value));
  return <div className="reconstruction-preview" aria-label="Synthetic reconstruction preview">
    <div className="reconstruction-banner"><strong>SYNTHETIC PROPOSAL · NOT A VERIFIED REPRODUCTION</strong><p>All inputs and results stay in this browser tab. This form does not call a server, write data, or execute repository code.</p></div>
    <h3>{screen.title}</h3><p>{screen.description}</p>
    {state.screen === "draft" ? <form onSubmit={event => { event.preventDefault(); setState(current => submitReconstruction(spec, current)); }} noValidate>
      {screen.fields.map(field => <label key={field.id}>{field.label}{field.type === "select" ? <select value={String(state.values[field.id] ?? "")} required={field.required} onChange={event => update(field.id, event.target.value)}><option value="">Select a synthetic option</option>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input type={field.type} value={state.values[field.id] ?? ""} required={field.required} min={field.min} max={field.max} onChange={event => update(field.id, field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />}</label>)}
      {state.error && <p role="alert" className="reconstruction-error">{state.error}</p>}
      <button type="submit">{screen.action!.label}</button>
    </form> : <div className="reconstruction-result" role="status"><h4>Read-only synthetic summary</h4><dl>{draft.fields.map(field => <div key={field.id}><dt>{field.label}</dt><dd>{String(state.values[field.id] ?? "Not entered")}</dd></div>)}</dl><button type="button" onClick={() => setState(initialReconstructionState(spec))}>Reset synthetic preview</button></div>}
    <details><summary>Evidence and uncertainty</summary><p>Observed source patterns: {spec.evidence.ruleIds.length}. The UI design and transition are proposed.</p>{spec.evidence.sourceRefs.map(ref => <code key={sourceReference(ref)}>{sourceReference(ref)}</code>)}<ul>{[...spec.assumptions, ...spec.uncertainty].map(item => <li key={item}>{item}</li>)}</ul></details>
  </div>;
}
