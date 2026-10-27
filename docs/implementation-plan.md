# Implementation plan

## Phase 1 — Engineering foundation

Define types and runtime validation; inventory the included JavaScript fixture with bounds and exclusions; extract line-accurate evidence; add Vitest coverage; run `next typegen`, TypeScript, ESLint, tests, and production build. No model calls or execution of source code occur in this phase.

## Phase 2 — Meta investigation

Implemented: verified Meta's documented Chat Completions contract; added a typed server-only provider, bounded retries and timeouts, usage and latency metrics, deterministic mock, three-call investigation flow, validated references, model-assisted support review, trace, and failure states. `tests/investigation.test.ts` runs the complete original fixture workflow in explicit `MOCK` mode. Live mode needs a valid `MODEL_API_KEY` and has not been exercised against an account. A future phase should add a trusted fixture registry and syntax-aware entry-point indexing.

Phase 2.1 adds a separate Baseten Model APIs adapter, explicit live provider selection, deterministic HTTP boundary tests, and an opt-in live smoke test against the same fixture. Public documentation confirms the endpoint and public Muse Spark Open slug; the user confirmed the hackathon-specific `-1026` slug from onboarding, and it is the default. No paid call is part of normal tests. See [environment configuration](environment.md).

## Phase 3 — Executable verification

Implemented: reviewed declarative pricing templates with boundary cases for loyalty, promotion precedence, rounding, shipping, and invalid subtotals; strict rule-to-template and source-hash matching; an opt-in `investigateAndVerify` workflow; and a server-only Docker runner with no network, read-only source, non-root identity, dropped capabilities, seccomp, CPU, memory, process, and time limits. The runner compares actual outputs with explicit expectations and reports `VERIFIED`, `FAILED`, `BLOCKED`, or `NOT_TESTED` locally, with case inputs, observations, and reasons. Deterministic tests cover success, mismatch, unsupported claims, missing isolation, timeout, and malformed output. An opt-in local Docker integration test executes the fixture without a model call.

Limitations: only exact reviewed claims for the pinned fixture can be verified. Other model phrasings remain `NOT_TESTED`. The results establish behavior for the recorded cases, not a universal proof of the rule. The local `node:22-bookworm-slim` image and a Docker daemon with seccomp are prerequisites.

## Phase 4 — Demonstration

Expose only registered fixtures through an investigation API. Build a compact flow for selection, progress, rules, evidence, tests, and results. Test the end-to-end workflow with a live Meta model and a configured sandbox, then document a reproducible three-minute demonstration.

Each phase ends with type generation, type checking, linting, relevant automated tests, and production build. No commit, push, merge, or deployment occurs without user approval.
