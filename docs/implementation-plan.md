# Implementation plan

## Phase 1 — Engineering foundation

Define types and runtime validation; inventory the included JavaScript fixture with bounds and exclusions; extract line-accurate evidence; add Vitest coverage; run `next typegen`, TypeScript, ESLint, tests, and production build. No model calls or execution of source code occur in this phase.

## Phase 2 — Meta investigation

First confirm the current Meta Model API endpoint, authentication, request format, response format, and usage fields from provider documentation or account configuration. Implement a typed server-only provider with timeout, bounded retry, latency and usage metrics, and explicit errors. Add a deterministic mock. Build an explicit step-limited orchestrator that chooses evidence from the inventory, validates every source reference, records trace actions, and fails when budget or provider limits are reached. Add tests for invented evidence, malformed output, retry exhaustion, and budget exhaustion.

## Phase 3 — Executable verification

Constrain generated tests to a documented fixture contract. Implement a hardened container runner with network disabled, read-only input, limited privileges, CPU, memory, and execution time. Capture actual exit code, output, and duration. Return `BLOCKED` when the backend is absent. Test pass, fail, blocked, and timeout behavior.

## Phase 4 — Demonstration

Expose only registered fixtures through an investigation API. Build a compact flow for selection, progress, rules, evidence, tests, and results. Test the end-to-end workflow with a live Meta model and a configured sandbox, then document a reproducible three-minute demonstration.

Each phase ends with type generation, type checking, linting, relevant automated tests, and production build. No commit, push, merge, or deployment occurs without user approval.
