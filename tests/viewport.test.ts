import { describe, expect, it } from "vitest";
import { canStartCanvasDrag, fitNodes, MAX_ZOOM, MIN_ZOOM, NODE_SIZE, panFromDrag, RESET_VIEW, zoomAt } from "../src/lib/architecture/viewport";

describe("architecture viewport", () => {
  it("pans by screen distance from the captured start point", () => {
    expect(panFromDrag({ x: 50, y: -20, scale: 2 }, { x: 100, y: 100 }, { x: 130, y: 60 })).toEqual({ x: 80, y: -60, scale: 2 });
  });
  it("keeps the graph location under the pointer during zoom", () => {
    const before = { x: -100, y: 40, scale: 1.5 }, pointer = { x: 220, y: 180 };
    const after = zoomAt(before, pointer, 2.4);
    expect((pointer.x - before.x) / before.scale).toBeCloseTo((pointer.x - after.x) / after.scale);
    expect((pointer.y - before.y) / before.scale).toBeCloseTo((pointer.y - after.y) / after.scale);
  });
  it("clamps wheel and button zoom to usable limits", () => {
    expect(zoomAt(RESET_VIEW, { x: 0, y: 0 }, .01).scale).toBe(MIN_ZOOM);
    expect(zoomAt(RESET_VIEW, { x: 0, y: 0 }, 100).scale).toBe(MAX_ZOOM);
  });
  it("fits actual node rectangles inside the viewport and centers them", () => {
    const size = { width: 800, height: 500 }, points = [{ x: 100, y: 100 }, { x: 800, y: 600 }];
    const fit = fitNodes(points, size);
    for (const point of points) {
      expect(point.x * fit.scale + fit.x - NODE_SIZE.width / 2 * fit.scale).toBeGreaterThanOrEqual(39);
      expect(point.x * fit.scale + fit.x + NODE_SIZE.width / 2 * fit.scale).toBeLessThanOrEqual(size.width - 39);
      expect(point.y * fit.scale + fit.y - NODE_SIZE.height / 2 * fit.scale).toBeGreaterThanOrEqual(39);
      expect(point.y * fit.scale + fit.y + NODE_SIZE.height / 2 * fit.scale).toBeLessThanOrEqual(size.height - 39);
    }
    expect(fitNodes([], size)).toEqual(RESET_VIEW);
    expect({ ...RESET_VIEW }).toEqual({ x: 0, y: 0, scale: 1 });
  });
  it("recovers a full 36-node focused view on a narrow canvas", () => {
    const points = Array.from({ length: 36 }, (_, i) => ({ x: 150 + (i % 4) * 230, y: 100 + Math.floor(i / 4) * 135 }));
    const fit = fitNodes(points, { width: 400, height: 420 });
    const last = points.at(-1)!;
    expect(fit.scale).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(last.x * fit.scale + fit.x + NODE_SIZE.width / 2 * fit.scale).toBeLessThanOrEqual(360);
    expect(last.y * fit.scale + fit.y + NODE_SIZE.height / 2 * fit.scale).toBeLessThanOrEqual(380);
  });
  it("starts a drag only on background, preserving node and edge selection", () => {
    const background = { closest: () => null } as unknown as Element;
    const interactive = { closest: () => ({ dataset: { graphInteractive: "" } }) } as unknown as Element;
    expect(canStartCanvasDrag(background)).toBe(true);
    expect(canStartCanvasDrag(interactive)).toBe(false);
  });
});
