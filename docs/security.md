# Security boundaries

## Implemented in Phase 4

- The dashboard accepts no repository path, upload, command, or code. The investigation POST route is disabled by default (`ENABLE_LIVE_INVESTIGATION_HTTP=1` enables it for a trusted local demo), checks same-origin requests, accepts only the fixed fixture identifier, limits request size, applies a 31-second route deadline, and permits one in-process request per minute. The existing provider factory requires explicit `baseten` or `meta`; errors are sanitized. This in-memory limit is not a distributed or durable rate limiter, so the route must remain limited to a trusted local environment.
- No HTTP route invokes the Docker sandbox. Verification is initiated only by the trusted operator CLI. The artifact path is fixed, ignored by Git, and written with owner-only permissions. The CLI strips raw runner output and generated test source before writing, and never prints provider error details or credentials.
- The report GET route reads only the fixed local artifact (100 KB maximum), validates the pinned fixture hash, exact source evidence, reviewed cases, and status/provenance consistency. `MOCK` provenance and fabricated `VERIFIED` cases are rejected. The artifact remains local and should be treated as operator-produced data, not a cryptographic proof against a malicious local file editor.

## Implemented in Phase 1

- Inventory callers must select a trusted fixture root server-side. No HTTP endpoint accepts filesystem paths.
- Relative paths reject traversal, absolute paths, backslashes, empty segments, and drive prefixes. Symlink entries are skipped.
- Hidden directories, dependencies, generated directories, test files, and non-source extensions are excluded. UTF-8 decoding rejects malformed text; NUL bytes reject binary-like source.
- Limits cap file count, individual file size, and total accepted bytes. The inventory fails closed when a limit is exceeded.
- Evidence is bound to inventoried files and valid inclusive line ranges; supplied excerpts must exactly match source.
- Source content is data and must never become an instruction to the future model or a command to a shell.

## Implemented in Phase 2

- The Meta adapter imports `server-only`; credentials are read from server environment or constructor injection and are never logged or returned. Its endpoint must be HTTPS.
- The orchestrator allows three model calls, three inspected files, 8,000 selected source characters, five rules, three references per rule, 12 lines per reference, and a 30-second overall deadline. Each request caps output at 1,500 tokens. The provider caps request time at 12 seconds and retries transient errors twice with backoff.
- The sole eligible file in a one-file inventory is selected deterministically and recorded as such. Multi-file model selections are constrained to an explicit inventory allowlist and validated for nonempty, unique, safe paths; invalid selections fail without repair. Citations are validated against inspected files. Source excerpts are extracted locally, never accepted from model text. Comments and strings are explicitly framed as untrusted data; there is no tool-execution interface.
- A second model call reviews semantic support. This can reject contradictory claims but is not a proof of behavior. Accepted claims remain `NOT_TESTED` and reports describe the uncertainty. Malformed responses and provider failures fail explicitly.
- Baseten uses an independent server-only adapter and `BASETEN_API_KEY`. Provider selection is explicit; the live factory rejects mock or missing selection. The paid smoke test is opt-in and sends only the trusted legacy-pricing fixture.

## Implemented in Phase 3

- Verification accepts only the pinned `legacy-pricing` fixture and exact reviewed rule templates. It never executes model-generated code, commands, paths, or test cases. Unsupported and rejected claims cannot become `VERIFIED`.
- The Next.js process does not import or execute the fixture. The server-only verifier invokes only fixed Docker CLI arguments. The container has no network, no capabilities, `no-new-privileges`, a non-root user, read-only root and source mounts, local immutable image ID, process, memory, CPU, and wall-clock limits, and no application environment variables or secrets. Missing Docker, seccomp, or local image returns `BLOCKED`.
- The container runner emits bounded JSON observations. The verifier checks IDs and value types, compares every observed result against a reviewed expectation, and records failed cases. Container stderr is not copied into reports because runtime errors may contain source text.
- After an ambiguous Docker CLI termination, the verifier checks the uniquely named container, attempts bounded forced removal if needed, and confirms absence before returning a failure result. If Docker cannot establish absence, verification is `BLOCKED`; a removal command's exit status alone is never treated as proof of cleanup.

## Boundaries still required

The inventory function receives a root from trusted code. Before external ingestion, add a fixture registry and prevent concurrent file mutation during reads, including symlink swaps; a pre-open `stat` alone is insufficient for a hostile writable directory. Phase 1 fixtures are checked-in and trusted for read access. A model can still misunderstand or obey hostile source text despite instruction hierarchy; semantic review is advisory, not verification.

Phase 3 verification is limited to the original trusted pricing fixture and its reviewed templates. It is not a general sandbox for external repositories. Docker daemon access itself remains privileged and must be restricted to trusted server operators. A passing case proves only the tested inputs and assertions, not all possible inputs or semantic correctness of a model claim. The local Node image must be installed in advance; verification never pulls an image automatically.
