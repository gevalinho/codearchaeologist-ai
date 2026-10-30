# B5.2 handoff status: production remains fail closed

This iteration adds an additive SQLite dispatch table and a worker claim receipt/web acknowledgement protocol, but **does not activate a scanner worker**. The current production scan route still returns HTTP 503 before creating a job. The existing development scanner remains in-process. No new process receives GitHub tokens or database access.

## Implemented contract

- Schema version 4 adds `scanner_dispatches`, keyed by the existing job ID, with dispatch generation, existing job lease ID, manifest hash, deadline, acknowledgement, heartbeat, result hash, and cancellation flag. `SqliteDispatchStore` is web-side only. Its create, acknowledgement, heartbeat, result, and cancellation operations use conditional SQLite updates against current job and lease state. A second generation or duplicate acknowledgement cannot overwrite the first.
- The worker-private claim directory remains 0700. A worker claim now produces a bounded receipt in the worker-owned outbox. The web can read this receipt without opening the private claim directory, compare it with the web-owned dispatch, perform the SQLite compare-and-swap, and publish a bounded acknowledgement in the web-owned inbox. A worker must observe the matching acknowledgement before result publication. Missing or mismatched acknowledgements fail closed.
- The receipt and acknowledgement contain only generated IDs and a manifest SHA-256. Neither includes a database path, credential, Docker argument, image, or arbitrary filesystem path. The source manifest and snapshot checks from B5.1 remain in force.

## Remaining blockers before worker execution

`GitHubJobManager.run` still calls `scannerAvailable` and `runIsolatedScanner` in the web process. Production calls are blocked by the route and Docker guards. Moving acquisition to the spool needs a bounded, no-follow transfer from the acquired staging tree to `publishSnapshot`, with the acquisition coverage metadata retained in web-owned SQLite. A worker runtime needs a worker-owned copy of the verified snapshot: it cannot stage trusted runner files into the web-owned read-only snapshot. It must reverify hashes after copying and before Docker, poll cancellation/deadline, and stop the container on abort. The web must reconcile a validated result with the exact acknowledged SQLite generation and current quota lease, recheck installation permission, then call the existing private artifact publisher. Restart recovery must fail ambiguous jobs without rerunning Docker.

The production Docker guard also cannot be relaxed by an environment flag. Separate service UIDs, filesystem ACL/group checks, and worker-only Docker socket access must be tested on the target host before any production activation. The worker must have no route to the web-owned SQLite database or credential files. A rootful Docker socket gives host-equivalent power, so this separation requires an OS-level daemon boundary, such as a verified worker-only rootless Docker daemon.

No scanner runtime, production activation, systemd unit, AWS configuration, or paid provider call was added in this iteration.
