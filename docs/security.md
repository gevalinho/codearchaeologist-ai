# Security boundaries

## Implemented in Phase 1

- Inventory callers must select a trusted fixture root server-side. No HTTP endpoint accepts filesystem paths.
- Relative paths reject traversal, absolute paths, backslashes, empty segments, and drive prefixes. Symlink entries are skipped.
- Hidden directories, dependencies, generated directories, test files, and non-source extensions are excluded. UTF-8 decoding rejects malformed text; NUL bytes reject binary-like source.
- Limits cap file count, individual file size, and total accepted bytes. The inventory fails closed when a limit is exceeded.
- Evidence is bound to inventoried files and valid inclusive line ranges; supplied excerpts must exactly match source.
- Source content is data and must never become an instruction to the future model or a command to a shell.

## Boundaries still required

The inventory function receives a root from trusted code. Before any external ingestion, add a fixture registry and prevent concurrent file mutation during reads, including symlink swaps; a pre-open `stat` alone is insufficient for a hostile writable directory. Phase 1 fixtures are checked-in and trusted for read access.

Phase 2 must keep Meta credentials server-side, bound requests by time and tokens, validate model output, and record provider failures without synthetic responses. Phase 3 must run code only in a separate hardened container with no network, limited CPU and memory, read-only inputs, and restricted privileges. If that backend is unavailable, verification must return `BLOCKED`. Neither source code nor generated tests may execute inside the Next.js process.
