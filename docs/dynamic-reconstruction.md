# Dynamic reconstruction foundation (Phase 6.1)

## Architecture decision

The existing `1.0.0` graph is unchanged. It carries nodes, edges, source references, and optional deterministic rule evidence. Older artifacts without `rules` remain readable, but cannot support a new dynamic preview. Feature candidates are name-based groups; the Student Promotion preview is a dedicated synthetic demonstration and remains available through its existing template.

`classifyFeature` combines observed anchor components, attached rule patterns, and observed operational edges. It separates business workflow candidates from technical controllers, shared utilities, data-access components, and uncertain candidates. Every classification includes the cited source references, evidence strength, and explicit uncertainty. A controller name alone does not establish a business workflow.

`planReconstruction` requires a business workflow classification and source-backed rule evidence. It returns either a structured unavailable result or a bounded, neutral review-form proposal. The proposal never assigns a legacy business meaning to a field, numeric calculation, option, or state transition. Its only transition changes browser-local synthetic state from draft to submitted. The planner validates its output against the versioned `ReconstructionSpec` schema and the source graph. A future AI-assisted planner would have to produce the same declarative format and pass the same validation; it would not gain permission to execute code or call an endpoint from the renderer.

The generic renderer accepts the validated specification, renders text, number, and select controls, checks required fields and constrained values, and shows a read-only synthetic summary. It uses React text rendering, fixed controls, and local state only. The existing Preview drawer retains keyboard focus handling and the Student Promotion component. The Feature Workspace shows classification evidence and an explanation when preview support is unavailable.

## Limits and security

This phase does not infer field names, domain-specific validation, business outcomes, or actual runtime transitions from source. Rule patterns are single-line static observations and may miss behavior. The proposed form is a review aid, not a reproduction. No repository code runs in the renderer, and no source content is sent to an external AI service. Repository selection, ingestion limits, GitHub authorization, and Docker isolation remain unchanged. Specifications reject extra properties, unsupported field types and actions, unknown evidence IDs, invalid source references, and oversized structures.
