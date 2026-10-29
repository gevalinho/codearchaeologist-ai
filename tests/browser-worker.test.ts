import { afterEach, describe, expect, it, vi } from "vitest";
import { scanInWorker } from "../src/lib/archaeology/worker-client";

class FakeWorker {
  static latest: FakeWorker;
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  message: unknown;
  terminated = false;
  constructor() { FakeWorker.latest = this; }
  postMessage(message: unknown) { this.message = message; }
  terminate() { this.terminated = true; }
  emit(message: unknown) { this.onmessage?.({ data: message } as MessageEvent); }
}

afterEach(() => vi.unstubAllGlobals());
describe("background browser scanner handoff", () => {
  it("passes selected relative paths explicitly and forwards measured progress", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const file = Object.assign(new Blob(["<?php"]), { webkitRelativePath: "demo/application/A.php" }) as File;
    const phases: string[] = [], progress: number[] = [];
    const pending = scanInWorker([file], 7700, new AbortController().signal, phase => phases.push(phase), update => progress.push(update.filesRead));
    expect((FakeWorker.latest.message as { files: { webkitRelativePath: string }[]; filesReceived: number }).files[0].webkitRelativePath).toBe("demo/application/A.php");
    expect((FakeWorker.latest.message as { filesReceived: number }).filesReceived).toBe(7700);
    FakeWorker.latest.emit({ type: "phase", phase: "reading-files" });
    FakeWorker.latest.emit({ type: "progress", progress: { filesReceived: 7700, eligibleFiles: 1, filesRead: 1, bytesRead: 5, processedFiles: 1, processedBytes: 5 } });
    const result = { graph: { snapshotId: "synthetic" } };
    FakeWorker.latest.emit({ type: "complete", result });
    await expect(pending).resolves.toBe(result);
    expect(phases).toEqual(["reading-files"]); expect(progress).toEqual([1]);
    expect(FakeWorker.latest.terminated).toBe(true);
  });
  it("terminates the worker on cancellation and returns a handled error", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new AbortController();
    const pending = scanInWorker([], 0, controller.signal, () => undefined, () => undefined);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(FakeWorker.latest.terminated).toBe(true);
  });
});
