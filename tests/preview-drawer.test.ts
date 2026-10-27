import { describe, expect, it } from "vitest";
import { focusTrapTarget, initialPreviewDrawerState, reducePreviewDrawer } from "../src/lib/architecture/preview-drawer";
import { initialPromotionDemoState, reducePromotionDemo } from "../src/lib/architecture/promotion-demo";

const promotionKey = "preview:promotion:nextjs-layered-v1:snapshot-1";

describe("preview drawer state", () => {
  it("opens, closes, expands, and preserves compatible preview state", () => {
    let drawer = reducePreviewDrawer(initialPreviewDrawerState(), { type: "open", previewKey: promotionKey });
    let demo = reducePromotionDemo(initialPromotionDemoState(), { type: "source", id: "demo-class-1" });
    demo = reducePromotionDemo(demo, { type: "toggle", id: "demo-student-01" });
    drawer = reducePreviewDrawer(drawer, { type: "toggle-expand" });
    expect(drawer).toMatchObject({ open: true, expanded: true });
    drawer = reducePreviewDrawer(drawer, { type: "close" });
    expect(drawer).toMatchObject({ open: false, expanded: true, previewKey: promotionKey });
    drawer = reducePreviewDrawer(drawer, { type: "open", previewKey: promotionKey });
    expect(drawer).toMatchObject({ open: true, expanded: true });
    expect(demo.selectedStudentIds).toEqual(["demo-student-01"]);
  });
  it("closes and resets presentation state on incompatible or unsupported features", () => {
    const open = reducePreviewDrawer(initialPreviewDrawerState(), { type: "open", previewKey: promotionKey });
    expect(reducePreviewDrawer(open, { type: "feature-change", previewKey: null })).toEqual({ open: false, expanded: false, previewKey: null });
    expect(reducePreviewDrawer(open, { type: "feature-change", previewKey: "preview:other:target:snapshot-1" })).toMatchObject({ open: false, expanded: false });
    expect(reducePreviewDrawer(open, { type: "feature-change", previewKey: promotionKey })).toEqual(open);
  });
});

describe("dialog focus target", () => {
  const first = {} as HTMLElement, middle = {} as HTMLElement, last = {} as HTMLElement;
  const focusables = [first, middle, last];
  it("wraps Tab and Shift+Tab at the dialog boundary", () => {
    expect(focusTrapTarget(focusables, last, false)).toBe(first);
    expect(focusTrapTarget(focusables, first, true)).toBe(last);
  });
  it("returns focus to the first or last dialog control if focus escapes", () => {
    expect(focusTrapTarget(focusables, null, false)).toBe(first);
    expect(focusTrapTarget(focusables, null, true)).toBe(last);
    expect(focusTrapTarget(focusables, middle, false)).toBeNull();
    expect(focusTrapTarget([], null, false)).toBeNull();
  });
});
