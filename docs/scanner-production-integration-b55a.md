# B5.5a production application wiring

Production scan creation is **disabled by default**. The web route returns HTTP 503 unless `CODEARCH_PRODUCTION_SCANNING=1` and the handoff loader validates the configured filesystem and identities. Public scans additionally require the existing `ENABLE_GITHUB_INGESTION=1` gate. The web manager refuses its direct Docker path in production even if called outside the route.

## Web service configuration

Set these variables only in the web service's private environment file:

| Variable | Purpose |
| --- | --- |
| `CODEARCH_PRODUCTION_SCANNING` | Explicit production gate; exactly `1` enables configuration validation. Leave unset until host verification is complete. |
| `CODEARCH_SPOOL_ROOT` | Canonical absolute path to the private spool parent. |
| `CODEARCH_WEB_UID` | Numeric UID of the web service. Must match the running process and differ from worker UID. |
| `CODEARCH_WORKER_UID` | Numeric UID of the worker service. |
| `CODEARCH_WORKER_GID` | Numeric primary GID of the worker. |
| `CODEARCH_INBOX_GID` | Numeric dedicated read-only inbox group for the worker. |
| `CODEARCH_OUTBOX_GID` | Numeric dedicated read-only outbox group for the web service. |
| `CODEARCH_DB_PATH` | Web-private SQLite file outside the spool. |
| `CODEARCH_ARTIFACT_DIR` | Web-private 0700 directory outside the spool. |
| `CODEARCH_STAGING_DIR` | Web-private 0700 acquisition directory outside the spool. |
| `ENABLE_GITHUB_INGESTION` | Existing additional gate for public scans; exactly `1`. |

Existing GitHub App, session encryption, and origin variables remain web-only. The loader checks canonical spool roots, actual UID, root ownership/modes, and private web state paths. It does not create or repair directories. Scan creation fails closed when these checks fail.

## Dispatcher service configuration

Run `npm run scanner:dispatcher` as the worker UID from a dedicated readable code release with **no `.env.local` file**. The dispatcher itself needs only `CODEARCH_SPOOL_ROOT`, `CODEARCH_WORKER_SCAN_ROOT`, `CODEARCH_WORKER_APP_ROOT`, the five numeric UID/GID variables above, and a normal executable search path. `CODEARCH_WORKER_APP_ROOT` is the canonical code release path. `CODEARCH_WORKER_SCAN_ROOT` is worker-owned mode 0700. The dispatcher starts only `scripts/scanner-worker.ts` under the fixed Node executable and fixed runtime flags, with UUID job/generation arguments. It constructs the child environment from an explicit allowlist: production mode, fixed PATH/HOME/Docker configuration, the rootless Docker socket at `/run/user/<worker-uid>/docker.sock`, spool/scan roots, and numeric identities. It never forwards the parent environment, `.env.local`, web database path, GitHub credentials, or AI-provider credentials.

The dispatcher validates each bounded inbox marker and snapshot manifest, ignores expired/cancelled/invalid dispatches, and uses exclusive worker-private launch markers. It runs one child at a time. A failed worker attempt (nonzero exit with a categorized code, signal, supervision timeout, or launch failure) is logged as a structured worker outcome and does not terminate the dispatcher; its launch marker still prevents any retry of that dispatch. A dispatcher crash leaves the global launch lock and requires operator review before restarting dispatch; never delete it while a child could still be running. The worker also publishes an additive outbox failure record carrying one fixed category; web releases that read it fail fast with a terminal message instead of waiting for heartbeat expiry, while web release 3b34c45 ignores the file and keeps heartbeat-expiry behavior. The web's existing lease, deadline, heartbeat, private authorization recheck, result validation, and artifact publication remain authoritative.

## Intended single-host architecture and remaining verification

On Ubuntu 24.04 EC2, use separate `codearch-web` and `codearch-worker` service accounts and separate systemd environment files. The web account owns SQLite, artifacts, staging, inbox, and snapshots; it must have no Docker socket, Docker group, or Docker-capable sudo access. The worker account owns claims, outbox, and scan scratch space. Use dedicated inbox/outbox groups only for the narrow read access described in `scanner-spool-foundation.md`. Prefer a worker-only rootless Docker daemon; verify its actual socket ACLs, seccomp enforcement, fixed image, networkless container execution, and bind mounts under the real service identities. Keep the worker code release free of web secrets and unreadable web-private files. The dispatcher and worker must have no access to the web database or GitHub/provider environment files.

This phase does not create accounts, directories, daemon configuration, or systemd units. No production gate should be enabled until those OS checks and a separate-UID end-to-end scan have passed. Disable `CODEARCH_PRODUCTION_SCANNING` first for rollback; let active jobs expire or cancel them, and retain private artifacts for authorized users.

## Future work: separate queue-wait and execution budgets

The 90-second job deadline currently covers acquisition, dispatcher queue waiting, claim, acknowledgement, scanning, and result publication as one shared budget. A future improvement could split this into a queue-wait budget (creation to acknowledgement, keeping the existing 90-second value) plus a bounded post-acknowledgement execution budget derived from the existing worker supervision and Docker scan caps. That change requires a spool protocol revision (separate claim-by and done-by deadlines), matching worker and web wait-loop updates, and a synchronized web/dispatcher deployment. It is intentionally not part of the current dispatcher diagnostics patch.
