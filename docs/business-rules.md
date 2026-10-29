# Business rule discovery: architecture and rollout

## Evidence audit

The `1.0.0` graph recorded components, relationships, and source line references. Its `guards` edges were limited to a few school-oriented tokens and did not preserve the condition, so they could not establish a general business rule. Feature and module views grouped names and edges; Student Promotion operator notes remained unverified. Existing artifacts contain no rule evidence and remain readable.

## Phases

1. **Implemented:** Add optional, bounded `rules` evidence to new `1.0.0` graphs. Detect only recognizable single-line conditions, validation calls, access checks, state-field assignments, and arithmetic assignments. Each rule points to a scanned source line and owning graph component. No source is executed or sent to an external service.
2. **Implemented:** Group rule-owning components by recorded call edges, label the grouping inferred, and provide a searchable explorer with source references. Empty and older artifacts state their coverage limits.
3. **Future review:** Compare findings with real source and tests before supporting multi-line expressions, dynamic calls, data-flow claims, or named business workflows. Extend patterns only with positive and negative fixtures from additional domains.

The scanner retains its existing source selection and file/byte limits. Rule evidence is capped at 1,000 findings; reaching the cap adds an explicit limitation. Descriptions identify syntax, not an inferred business outcome. The graph snapshot identifier remains based on source content, and the optional field preserves older artifacts without migration.
