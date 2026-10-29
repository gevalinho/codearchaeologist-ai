import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PreviewLauncher from "../src/app/architecture/preview-launcher";
import { clampLauncherPosition, clearLauncherPosition, defaultLauncherPosition, moveLauncherKey, moveLauncherPointer, parseLauncherPosition, PREVIEW_LAUNCHER_STORAGE_KEY, readLauncherPosition, resolveLauncherPosition, saveLauncherPosition } from "../src/lib/architecture/preview-launcher-position";

const desktop = { width: 1440, height: 900 };
const mobile = { width: 360, height: 640 };
const size = { width: 205, height: 62 };

describe("Preview App launcher position", () => {
  it("starts inside the viewport and stays clear of the desktop assistant input", () => {
    expect(defaultLauncherPosition(desktop, size, false)).toEqual({ x: 1209, y: 756 });
    expect(defaultLauncherPosition(desktop, size, true)).toEqual({ x: 863, y: 72 });
    expect(resolveLauncherPosition({ x: 1209, y: 756 }, desktop, size, true)).toEqual({ x: 863, y: 72 });
    expect(resolveLauncherPosition({ x: 1209, y: 756 }, desktop, size, false)).toEqual({ x: 1209, y: 756 });
  });

  it("clamps pointer movement and resized mobile viewports with a visible margin", () => {
    expect(moveLauncherPointer({ x: 100, y: 100 }, { x: 10, y: 10 }, { x: 300, y: 900 }, desktop, size)).toEqual({ x: 390, y: 826 });
    expect(moveLauncherPointer({ x: 100, y: 100 }, { x: 10, y: 10 }, { x: -900, y: -900 }, desktop, size)).toEqual({ x: 12, y: 12 });
    expect(clampLauncherPosition({ x: 1200, y: 800 }, mobile, { width: 190, height: 62 })).toEqual({ x: 158, y: 566 });
    expect(defaultLauncherPosition(mobile, { width: 190, height: 62 }, true)).toEqual({ x: 12, y: 132 });
  });

  it("supports bounded keyboard repositioning and ignores non-position keys", () => {
    expect(moveLauncherKey({ x: 100, y: 100 }, "ArrowRight", false, desktop, size, false)).toEqual({ x: 116, y: 100 });
    expect(moveLauncherKey({ x: 100, y: 100 }, "ArrowUp", true, desktop, size, false)).toEqual({ x: 100, y: 52 });
    expect(moveLauncherKey({ x: 12, y: 12 }, "ArrowLeft", false, desktop, size, false)).toEqual({ x: 12, y: 12 });
    expect(moveLauncherKey({ x: 100, y: 100 }, "Enter", false, desktop, size, false)).toBeNull();
  });

  it("validates stored coordinates and handles disabled storage", () => {
    for (const invalid of [null, "", "not-json", "{}", '{"x":-1,"y":20}', '{"x":null,"y":20}', '{"x":"12","y":20}', '{"x":1e100,"y":20}', '{"x":1,"y":100001}']) expect(parseLauncherPosition(invalid)).toBeNull();
    expect(parseLauncherPosition('{"x":300,"y":400}')).toEqual({ x: 300, y: 400 });
    const entries = new Map<string, string>();
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
    saveLauncherPosition(storage, { x: 300, y: 400 });
    expect(entries.get(PREVIEW_LAUNCHER_STORAGE_KEY)).toBe('{"x":300,"y":400}');
    expect(readLauncherPosition(storage)).toEqual({ x: 300, y: 400 });
    clearLauncherPosition(storage);
    expect(readLauncherPosition(storage)).toBeNull();
    expect(readLauncherPosition({ getItem: () => { throw new Error("disabled"); } })).toBeNull();
    expect(() => saveLauncherPosition({ setItem: () => { throw new Error("full"); } }, { x: 1, y: 2 })).not.toThrow();
    expect(() => clearLauncherPosition({ removeItem: () => { throw new Error("disabled"); } })).not.toThrow();
  });

  it("keeps preview activation separate from the drag handle and exposes keyboard controls", () => {
    const markup = renderToStaticMarkup(createElement(PreviewLauncher, { featureTitle: "Login", assistantOpen: false, onOpen: () => undefined }));
    expect(markup).toContain('data-preview-launcher="true"');
    expect(markup).toContain('aria-label="Open interactive preview for Login"');
    expect(markup).toContain('aria-label="Move Preview App widget"');
    expect(markup).toContain('arrow keys reposition; Home resets');
    expect(markup).toContain('aria-label="Reset Preview App position"');
    expect(markup.match(/<button/g)).toHaveLength(3);
  });
});
