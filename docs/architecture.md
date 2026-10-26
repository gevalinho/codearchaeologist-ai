# Architecture

CodeArchaeologist AI reconstructs business behavior from source and eventually verifies hypotheses by executing constrained tests. Phase 1 provides the deterministic input boundary and domain contracts; it does not run an investigation agent.

## Data flow

1. A trusted server configuration selects an included fixture. The browser will never supply a filesystem path.
2. The repository inventory reads supported JavaScript and TypeScript files under that fixture, applies limits and exclusions, and records exact paths, content, byte counts, and line counts.
3. Evidence extraction resolves a file and inclusive line range against the inventory. Rule validation rejects unknown files, invalid ranges, and excerpts that differ from source.
4. In Phase 2, a bounded orchestrator will supply selected source as untrusted data to a typed Meta model provider, validate structured hypotheses, and record each action. A mock provider will support deterministic tests.
5. In Phase 3, a constrained test generator will produce verification candidates. A separate isolated runner will execute them and return observed status and output; unavailable isolation yields `BLOCKED`.
6. The report builder will distinguish source-supported hypotheses from experimentally verified findings.

The current fixture, `tests/fixtures/legacy-pricing/pricing.js`, includes loyalty and promotion precedence, rounding, and a shipping threshold. The inventory does not parse syntax yet; module and function indexing is planned for Phase 2.

## Domain contracts

`src/types/investigation.ts` defines investigation lifecycle, inventory, evidence, actions, rules, tests, results, and reports. `src/lib/schemas/investigation.ts` validates evidence and the minimal candidate rule shape at runtime. A verification status means only what its corresponding execution record demonstrates; a model cannot assign `VERIFIED` by inference alone.
