import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  GitHubJobManager,
  type JobDependencies,
  type WorkerHandoff,
} from "../src/lib/github-ingestion/jobs";
import { SqliteDispatchStore } from "../src/lib/github-ingestion/dispatch-store";
import {
  acknowledgedClaim,
  claimDispatch,
  isCancelled,
  publishResult,
  publishWorkerHeartbeat,
  readClaimReceipt,
  type SpoolOwners,
  type SpoolRoots,
} from "../src/lib/github-ingestion/spool";
import { parseGraph } from "../src/lib/architecture/graph";
import type { UserSession } from "../src/lib/github-ingestion/session";
import demoGraph from "./fixtures/architecture/demo-graph.json";

vi.mock("server-only", () => ({}));
let root: string,
  roots: SpoolRoots,
  owners: SpoolOwners,
  handoff: WorkerHandoff,
  allow: boolean;
const user: UserSession = {
  id: "42",
  login: "alice",
  token: "private-token",
  nonce: "n".repeat(43),
  expiresAt: Date.now() + 60_000,
};
const authorized = {
  id: 11,
  owner: "example",
  name: "repo",
  private: true,
  installationId: 7,
};
const sources = [
  { path: "application/controllers/Demo.php", bytes: Buffer.alloc(110, 65) },
  {
    path: "application/controllers/DemoPromotion.php",
    bytes: Buffer.alloc(110, 66),
  },
];
const handoffGraph = structuredClone(demoGraph);

for (const item of [...handoffGraph.nodes, ...handoffGraph.edges]) {
  if (item.source.path === "assets/js/demo.js") {
    item.source.path = "application/controllers/Demo.php";
  }
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-handoff-"));
  for (const dir of [
    "artifacts",
    "staging",
    "inbox",
    "snapshots",
    "claims",
    "outbox",
  ])
    mkdirSync(path.join(root, dir), {
      mode:
        dir === "inbox" || dir === "snapshots" || dir === "outbox"
          ? 0o750
          : 0o700,
    });
  roots = {
    inbox: path.join(root, "inbox"),
    snapshots: path.join(root, "snapshots"),
    claims: path.join(root, "claims"),
    outbox: path.join(root, "outbox"),
  };
  const uid = process.getuid!(),
    gid = process.getgid!();
  owners = {
    webUid: uid,
    workerUid: uid,
    workerGid: gid,
    inboxGid: gid,
    outboxGid: gid,
  };
  handoff = { roots, owners };
  allow = true;
  process.env.CODEARCH_DB_PATH = path.join(root, "state.sqlite");
  process.env.CODEARCH_ARTIFACT_DIR = path.join(root, "artifacts");
  process.env.CODEARCH_STAGING_DIR = path.join(root, "staging");
});
afterEach(() => {
  delete process.env.CODEARCH_DB_PATH;
  delete process.env.CODEARCH_ARTIFACT_DIR;
  delete process.env.CODEARCH_STAGING_DIR;
  rmSync(root, { recursive: true, force: true });
});

function deps(): JobDependencies {
  return {
    available: vi.fn(async () => {
      throw new Error("Web Docker path was called.");
    }),
    scan: vi.fn(async () => {
      throw new Error("Web scanner was called.");
    }),
    temporary: async () =>
      mkdtempSync(path.join(root, "staging", "codearchaeologist-github-")),
    cleanup: async (dir) => rmSync(dir, { recursive: true, force: true }),
    now: Date.now,
    authorize: async () => (allow ? authorized : null),
    token: async () => "installation-token",
    acquire: async (_repo, destination) => {
      for (const file of sources) {
        mkdirSync(path.dirname(path.join(destination, file.path)), {
          recursive: true,
          mode: 0o755,
        });
        writeFileSync(path.join(destination, file.path), file.bytes, {
          mode: 0o644,
        });
      }
      return {
        sourceFiles: 2,
        eligibleFiles: 2,
        omittedFiles: 0,
        sourceBytes: 220,
        skippedFiles: 0,
        treeEntries: 2,
        commitSha: "a".repeat(40),
      };
    },
  };
}
function mockWorker(
  jobId: string,
  generation: string,
  stage: "claim" | "result" | "crash",
  output = JSON.stringify(handoffGraph),
) {
  if (stage === "claim") {
    claimDispatch(roots, owners, jobId, generation);
    return;
  }
  if (stage === "crash") {
    publishWorkerHeartbeat(
      roots,
      owners,
      jobId,
      generation,
      Date.now() - 20_000,
    );
    return;
  }
  const receipt = readClaimReceipt(roots, owners, jobId, generation);
  expect(acknowledgedClaim(roots, owners, jobId, generation, receipt)).toBe(
    true,
  );
  publishResult(roots, owners, jobId, generation, output);
}

describe("web to worker dispatch", () => {
  it("acquires, acknowledges a claim, validates result provenance, publishes owned artifacts, and releases the scan lease", async () => {
    let stage = 0,
      jobId = "";
    handoff.poll = async () => {
      const state = new SqliteDispatchStore(process.env.CODEARCH_DB_PATH!);
      const current = state.get(jobId);
      state.close();
      if (!current) return;
      if (stage++ === 0) mockWorker(jobId, current.generation, "claim");
      else if (stage === 2) mockWorker(jobId, current.generation, "result");
    };
    const dependencies = deps(),
      manager = new GitHubJobManager(dependencies, undefined, handoff);
    const job = await manager.createPrivate(user, 7, 11);
    jobId = job.id;
    await manager.wait(job.id);
    expect(dependencies.available).not.toHaveBeenCalled();
    expect(dependencies.scan).not.toHaveBeenCalled();
    expect(manager.get(job.id, user)?.phase).toBe("ready");
    const graph = parseGraph(
      (await manager.artifact(job.id, "graph.json", user))!,
    );
    expect(graph.githubSource?.visibility).toBe("private");
    const db = new DatabaseSync(process.env.CODEARCH_DB_PATH!);
    try {
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM quota_leases").get(),
      ).toMatchObject({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects private permission revocation before publication", async () => {
    let jobId = "",
      stage = 0;
    handoff.poll = async () => {
      const state = new SqliteDispatchStore(process.env.CODEARCH_DB_PATH!);
      const current = state.get(jobId);
      state.close();
      if (!current) return;
      if (stage++ === 0) mockWorker(jobId, current.generation, "claim");
      else if (stage === 2) {
        mockWorker(jobId, current.generation, "result");
        allow = false;
      }
    };
    const manager = new GitHubJobManager(deps(), undefined, handoff);
    const job = await manager.createPrivate(user, 7, 11);
    jobId = job.id;
    await manager.wait(job.id);
    expect(manager.get(job.id, user)?.phase).toBe("failed");
    expect(await manager.artifact(job.id, "graph.json", user)).toBeUndefined();
  });

  it("cancels after dispatch and rejects a late worker result", async () => {
    let jobId = "",
      generation = "";
    const manager = new GitHubJobManager(deps(), undefined, {
      ...handoff,
      poll: async () => {
        if (jobId) manager.cancel(jobId, user);
      },
    });
    const job = await manager.createPrivate(user, 7, 11);
    jobId = job.id;
    await manager.wait(job.id);
    const state = new SqliteDispatchStore(process.env.CODEARCH_DB_PATH!);
    generation = state.get(job.id)!.generation;
    state.close();
    expect(manager.get(job.id, user)?.phase).toBe("cancelled");
    expect(isCancelled(roots, owners, job.id, generation)).toBe(true);
    expect(() =>
      publishResult(roots, owners, job.id, generation, "{}"),
    ).toThrow();
  });

  it("fails closed on stale worker heartbeat", async () => {
    let jobId = "",
      stage = 0;
    handoff.poll = async () => {
      const state = new SqliteDispatchStore(process.env.CODEARCH_DB_PATH!);
      const current = state.get(jobId);
      state.close();
      if (!current) return;
      if (stage++ === 0) mockWorker(jobId, current.generation, "claim");
      else if (stage === 2) mockWorker(jobId, current.generation, "crash");
    };
    const manager = new GitHubJobManager(deps(), undefined, handoff);
    const job = await manager.createPrivate(user, 7, 11);
    jobId = job.id;
    await manager.wait(job.id);
    expect(manager.get(job.id, user)?.phase).toBe("failed");
  });
});

describe("restart reconciliation authorization", () => {
  async function interruptedJob() {
    const first = new GitHubJobManager(deps(), undefined, { ...handoff, poll: () => new Promise<void>(() => {}) });
    const job = await first.createPrivate(user, 7, 11);
    let dispatch: ReturnType<SqliteDispatchStore["get"]>;
    await vi.waitFor(() => {
      const store = new SqliteDispatchStore(process.env.CODEARCH_DB_PATH!);
      try { dispatch = store.get(job.id); expect(dispatch).toBeDefined(); }
      finally { store.close(); }
    });
    const recovered = new GitHubJobManager(deps(), undefined, handoff);
    return { job, dispatch: dispatch!, recovered };
  }
  const session = async () => user;

  it("publishes a private result after restart only with a fresh owning session and exact repository authorization", async () => {
    const { job, dispatch, recovered } = await interruptedJob();
    claimDispatch(roots, owners, job.id, dispatch.generation);
    await recovered.authorizedStatus(job.id, user, session);
    mockWorker(job.id, dispatch.generation, "result");
    expect((await recovered.authorizedStatus(job.id, user, session))?.phase).toBe("ready");
    expect(await recovered.artifact(job.id, "graph.json", user)).toBeDefined();
    const db = new DatabaseSync(process.env.CODEARCH_DB_PATH!);
    try { expect(db.prepare("SELECT COUNT(*) AS count FROM quota_leases").get()).toMatchObject({ count: 0 }); }
    finally { db.close(); }
  });

  it("fails closed and releases the lease when private permission is revoked before publication", async () => {
    const { job, dispatch, recovered } = await interruptedJob();
    claimDispatch(roots, owners, job.id, dispatch.generation);
    await recovered.authorizedStatus(job.id, user, session);
    mockWorker(job.id, dispatch.generation, "result");
    allow = false;
    expect(await recovered.authorizedStatus(job.id, user, session)).toBeUndefined();
    expect(await recovered.artifact(job.id, "graph.json", user)).toBeUndefined();
    const db = new DatabaseSync(process.env.CODEARCH_DB_PATH!);
    try { expect(db.prepare("SELECT COUNT(*) AS count FROM quota_leases").get()).toMatchObject({ count: 0 }); }
    finally { db.close(); }
  });

  it.each(["missing", "mismatched", "expired"])("denies %s current private session", async (kind) => {
    const { job, dispatch, recovered } = await interruptedJob();
    claimDispatch(roots, owners, job.id, dispatch.generation);
    const check = kind === "missing" ? async () => null : kind === "mismatched" ? async () => ({ ...user, nonce: "different" }) : async () => ({ ...user, expiresAt: Date.now() - 1 });
    expect(await recovered.authorizedStatus(job.id, user, check)).toBeUndefined();
    expect(await recovered.artifact(job.id, "graph.json", user)).toBeUndefined();
  });

  it.each(["cancelled", "expired"])("does not publish a %s dispatch", async (kind) => {
    const { job, dispatch, recovered } = await interruptedJob();
    if (kind === "cancelled") recovered.cancel(job.id, user);
    else {
      const db = new DatabaseSync(process.env.CODEARCH_DB_PATH!);
      try { db.prepare("UPDATE scanner_dispatches SET deadline_at=? WHERE job_id=?").run(Date.now() - 1, job.id); }
      finally { db.close(); }
    }
    expect((await recovered.authorizedStatus(job.id, user, session))?.phase).not.toBe("ready");
    expect(await recovered.artifact(job.id, "graph.json", user)).toBeUndefined();
    expect(isCancelled(roots, owners, job.id, dispatch.generation)).toBe(true);
  });
});
