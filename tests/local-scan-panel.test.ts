import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LocalScanPanel, { localScanBusy, type LocalScanPhase } from "../src/app/architecture/local-scan-panel";

const progress = { filesReceived: 7766, eligibleFiles: 64, filesRead: 40, bytesRead: 123456, processedFiles: 38, processedBytes: 120000 };
const render = (phase: LocalScanPhase, measured = progress) => renderToStaticMarkup(createElement(LocalScanPanel, { phase, repositoryName: "seolad_portal_legacy_code", progress: measured, onCancel: () => undefined }));

describe("local scan presentation", () => {
  it("shows the picker state without inventing progress", () => {
    const html = renderToStaticMarkup(createElement(LocalScanPanel, { phase: "awaiting-picker", progress: null, onCancel: () => undefined }));
    expect(html).toContain("Waiting for folder selection");
    expect(html).toContain("file counts are not available yet");
    expect(html).not.toContain("aria-valuenow");
  });
  it("shows real counts and every current worker stage", () => {
    for (const [phase, label] of [["selected", "Repository selected"], ["validating-selection", "Validating selection"], ["reading-files", "Reading eligible files"], ["extracting-graph", "Extracting graph"], ["validating-artifact", "Validating artifact"]] as const) {
      const html = render(phase);
      expect(html).toContain(label);
      expect(html).toContain("seolad_portal_legacy_code");
      expect(html).toContain("7,766");
      expect(html).toContain("123,456 bytes");
      expect(html).toContain('aria-live="polite"');
      expect(localScanBusy(phase)).toBe(true);
    }
  });
  it("keeps success and failure visible without active animation or cancel action", () => {
    expect(render("ready")).toContain("Investigation ready");
    expect(render("ready")).toContain("7,702 excluded by path or type");
    expect(render("ready")).toContain("26 unreadable or changed");
    expect(render("failed")).toContain("Scan stopped");
    const failed = renderToStaticMarkup(createElement(LocalScanPanel, { phase: "failed", progress, error: "Could not read a selected file. Check browser file permissions.", onCancel: () => undefined }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Could not read a selected file. Check browser file permissions.");
    expect(render("ready")).not.toContain("Cancel scan");
    expect(render("failed")).not.toContain("Cancel scan");
    expect(localScanBusy("ready")).toBe(false);
    expect(localScanBusy("failed")).toBe(false);
    expect(render("idle")).toBe("");
  });
});
