import type { BrowserIngestion, BrowserScanPhase, BrowserScanProgress } from "./browser-ingestion";

type WorkerMessage = { type: "phase"; phase: BrowserScanPhase } | { type: "progress"; progress: BrowserScanProgress } | { type: "complete"; result: BrowserIngestion } | { type: "error"; message: string };

export function scanInWorker(files: File[], filesReceived: number, signal: AbortSignal, onPhase: (phase: BrowserScanPhase) => void, onProgress: (progress: BrowserScanProgress) => void): Promise<BrowserIngestion> {
  if (signal.aborted) return Promise.reject(new Error("Repository scan cancelled."));
  if (typeof Worker === "undefined") return Promise.reject(new Error("This browser does not support background scanning. Use the local CLI."));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module" });
    const finish = () => { signal.removeEventListener("abort", cancel); worker.terminate(); };
    const cancel = () => { finish(); reject(new Error("Repository scan cancelled.")); };
    signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "phase") onPhase(message.phase);
      else if (message.type === "progress") onProgress(message.progress);
      else if (message.type === "complete") { finish(); resolve(message.result); }
      else if (message.type === "error") { finish(); reject(new Error(message.message)); }
    };
    worker.onerror = () => { finish(); reject(new Error("Background scanner failed. Try the local CLI or a smaller repository.")); };
    worker.onmessageerror = () => { finish(); reject(new Error("Browser could not transfer scanner results from the worker.")); };
    try { worker.postMessage({ files: files.map(file => ({ webkitRelativePath: file.webkitRelativePath, size: file.size, blob: file })), filesReceived }); } catch { finish(); reject(new Error("Could not pass selected files to the background scanner.")); }
  });
}
