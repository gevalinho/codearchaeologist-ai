export type Viewport = { x: number; y: number; scale: number };
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;
export const NODE_SIZE = { width: 166, height: 62 };
export const RESET_VIEW: Viewport = { x: 0, y: 0, scale: 1 };

export function panFromDrag(start: Viewport, origin: Point, current: Point): Viewport {
  return { ...start, x: start.x + current.x - origin.x, y: start.y + current.y - origin.y };
}

export function zoomAt(view: Viewport, pointer: Point, requestedScale: number): Viewport {
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, requestedScale));
  const ratio = scale / view.scale;
  return { scale, x: pointer.x - (pointer.x - view.x) * ratio, y: pointer.y - (pointer.y - view.y) * ratio };
}

export function fitNodes(points: Iterable<Point>, viewport: Size, padding = 40): Viewport {
  const locations = [...points];
  if (!locations.length || viewport.width <= 0 || viewport.height <= 0) return { ...RESET_VIEW };
  const left = Math.min(...locations.map(point => point.x - NODE_SIZE.width / 2));
  const right = Math.max(...locations.map(point => point.x + NODE_SIZE.width / 2));
  const top = Math.min(...locations.map(point => point.y - NODE_SIZE.height / 2));
  const bottom = Math.max(...locations.map(point => point.y + NODE_SIZE.height / 2));
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((viewport.width - 2 * padding) / (right - left), (viewport.height - 2 * padding) / (bottom - top))));
  return { scale, x: viewport.width / 2 - (left + right) / 2 * scale, y: viewport.height / 2 - (top + bottom) / 2 * scale };
}

export function canStartCanvasDrag(target: Element | null): boolean {
  return !target?.closest("[data-graph-interactive]");
}
