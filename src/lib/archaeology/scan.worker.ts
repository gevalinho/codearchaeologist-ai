import { scanSelectedDirectory, type BrowserScanProgress, type BrowserScanPhase, type BrowserIngestion, type DirectoryFile } from "./browser-ingestion";

type Request = { files: { webkitRelativePath: string; size: number; blob: Blob }[]; filesReceived: number };
type Response = { type: "phase"; phase: BrowserScanPhase } | { type: "progress"; progress: BrowserScanProgress } | { type: "complete"; result: BrowserIngestion } | { type: "error"; message: string };
const send = (message: Response) => self.postMessage(message);

self.onmessage = (event: MessageEvent<Request>) => {
  const { files, filesReceived } = event.data;
  const selected: DirectoryFile[] = files.map(file => ({ webkitRelativePath: file.webkitRelativePath, size: file.size, arrayBuffer: () => file.blob.arrayBuffer() }));
  void scanSelectedDirectory(selected, {
    onPhase: phase => send({ type: "phase", phase }),
    onProgress: progress => send({ type: "progress", progress: { ...progress, filesReceived } }),
  }).then(result => send({ type: "complete", result })).catch((error: unknown) => send({ type: "error", message: error instanceof Error ? error.message : "Repository scan failed." }));
};
