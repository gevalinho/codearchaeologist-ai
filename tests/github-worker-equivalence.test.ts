import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));
import { scanRepository } from "../src/lib/archaeology/scanner";
import { createManifest } from "../src/lib/archaeology/manifest";
import { runWorkerJob, type WorkerConfig } from "../src/lib/github-ingestion/scanner-worker";
import {
  publishClaimAcknowledgement,
  publishSnapshot,
  readClaimReceipt,
  readResult,
} from "../src/lib/github-ingestion/spool";

/** Same bytes feed the local scan and the worker handoff; outputs must match exactly. */
const fixture = [
  {
    path: "application/controllers/Gallery.php",
    content: "<?php class Gallery extends CI_Controller { public function index() { $this->load->model('photo_model'); $this->photo_model->all(); } }\n",
  },
  {
    path: "application/models/Photo_model.php",
    content: "<?php class Photo_model extends CI_Model { public function all() { return $this->db->get('photos')->result(); } }\n",
  },
  {
    path: "assets/js/gallery.js",
    content: "export function renderGallery(items) { return items.map(item => `<li>${item.title}</li>`).join(\"\"); }\n",
  },
];
const scannedAt = new Date("2026-11-04T00:00:00.000Z");

let root: string, config: WorkerConfig, job: string, generation: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-worker-equivalence-"));
  job = randomUUID();
  generation = randomUUID();
  const roots = { inbox: path.join(root, "inbox"), snapshots: path.join(root, "snapshots"), claims: path.join(root, "claims"), outbox: path.join(root, "outbox") };
  for (const dir of Object.values(roots)) mkdirSync(dir, { mode: 0o750 });
  chmodSync(roots.claims, 0o700);
  const scanRoot = path.join(root, "worker-private");
  mkdirSync(scanRoot, { mode: 0o700 });
  const uid = process.getuid!(), gid = process.getgid!();
  config = { roots, scanRoot, owners: { webUid: uid, workerUid: uid, workerGid: gid, inboxGid: gid, outboxGid: gid } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("local and worker scan equivalence", () => {
  it("produces identical graphs and manifests from shared source bytes", async () => {
    const localRoot = path.join(root, "local-repo");
    for (const file of fixture) {
      const target = path.join(localRoot, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    const localGraph = await scanRepository(localRoot);
    const localGraphJson = JSON.stringify(localGraph);
    const localManifestJson = JSON.stringify(createManifest(localGraph, "shared-fixture", scannedAt));

    const files = fixture.map(file => ({ path: file.path, bytes: Buffer.from(file.content) }));
    publishSnapshot(config.roots, config.owners, job, generation, files, Date.now() + 60_000);
    const image = `sha256:${"b".repeat(64)}`;
    const scan = vi.fn(async (scanRoot: string) => JSON.stringify(await scanRepository(path.join(scanRoot, "repo"))));
    await runWorkerJob(config, job, generation, {
      available: async () => image,
      scan,
      now: Date.now,
      sleep: async () => {
        publishClaimAcknowledgement(config.roots, config.owners, job, generation, readClaimReceipt(config.roots, config.owners, job, generation));
      },
    });
    expect(scan).toHaveBeenCalledOnce();
    const workerGraphJson = readResult(config.roots, config.owners, job, generation);
    expect(workerGraphJson).toBe(localGraphJson);
    const workerManifestJson = JSON.stringify(createManifest(JSON.parse(workerGraphJson), "shared-fixture", scannedAt));
    expect(workerManifestJson).toBe(localManifestJson);
  });
});
