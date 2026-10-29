export type LauncherPosition = { x: number; y: number };
export type LauncherBounds = { width: number; height: number; left?: number; top?: number };
export type LauncherSize = { width: number; height: number };

export const PREVIEW_LAUNCHER_STORAGE_KEY = "codearchaeologist.previewLauncherPosition.v1";
const MARGIN = 12;

export function parseLauncherPosition(value: string | null): LauncherPosition | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { x, y } = parsed as Record<string, unknown>;
    return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100_000 && typeof y === "number" && Number.isFinite(y) && y >= 0 && y <= 100_000 ? { x, y } : null;
  } catch { return null; }
}

export function readLauncherPosition(storage: Pick<Storage, "getItem"> | null): LauncherPosition | null {
  try { return parseLauncherPosition(storage?.getItem(PREVIEW_LAUNCHER_STORAGE_KEY) ?? null); }
  catch { return null; }
}

export function saveLauncherPosition(storage: Pick<Storage, "setItem"> | null, position: LauncherPosition): void {
  try { storage?.setItem(PREVIEW_LAUNCHER_STORAGE_KEY, JSON.stringify(position)); }
  catch { /* Storage may be disabled or full. */ }
}

export function clearLauncherPosition(storage: Pick<Storage, "removeItem"> | null): void {
  try { storage?.removeItem(PREVIEW_LAUNCHER_STORAGE_KEY); }
  catch { /* Storage may be disabled. */ }
}

export function clampLauncherPosition(position: LauncherPosition, viewport: LauncherBounds, size: LauncherSize): LauncherPosition {
  const left = viewport.left ?? 0, top = viewport.top ?? 0;
  const xMin = left + MARGIN, yMin = top + MARGIN;
  return {
    x: Math.round(Math.min(Math.max(position.x, xMin), Math.max(xMin, left + viewport.width - size.width - MARGIN))),
    y: Math.round(Math.min(Math.max(position.y, yMin), Math.max(yMin, top + viewport.height - size.height - MARGIN))),
  };
}

export function defaultLauncherPosition(viewport: LauncherBounds, size: LauncherSize, assistantOpen: boolean): LauncherPosition {
  const left = viewport.left ?? 0, top = viewport.top ?? 0;
  if (assistantOpen) {
    const drawerWidth = viewport.width <= 700 ? Math.min(viewport.width, 380) : viewport.width <= 1000 ? 320 : 360;
    return clampLauncherPosition({ x: viewport.width <= 700 ? left + MARGIN : left + viewport.width - drawerWidth - size.width - MARGIN, y: top + (viewport.width <= 700 ? 132 : 72) }, viewport, size);
  }
  return clampLauncherPosition({ x: left + viewport.width - size.width - (viewport.width <= 700 ? 15 : 26), y: top + viewport.height - size.height - (viewport.width <= 700 ? 18 : 82) }, viewport, size);
}

export function resolveLauncherPosition(stored: LauncherPosition | null, viewport: LauncherBounds, size: LauncherSize, assistantOpen: boolean): LauncherPosition {
  const position = stored ? clampLauncherPosition(stored, viewport, size) : defaultLauncherPosition(viewport, size, assistantOpen);
  if (!assistantOpen) return position;
  const left = viewport.left ?? 0, top = viewport.top ?? 0;
  const drawerWidth = viewport.width <= 700 ? Math.min(viewport.width, 380) : viewport.width <= 1000 ? 320 : 360;
  const inputTop = top + viewport.height - 110;
  return position.x + size.width > left + viewport.width - drawerWidth && position.y + size.height > inputTop
    ? defaultLauncherPosition(viewport, size, true)
    : position;
}

export function moveLauncherPointer(start: LauncherPosition, pointerStart: LauncherPosition, pointerNow: LauncherPosition, viewport: LauncherBounds, size: LauncherSize): LauncherPosition {
  return clampLauncherPosition({ x: start.x + pointerNow.x - pointerStart.x, y: start.y + pointerNow.y - pointerStart.y }, viewport, size);
}

export function moveLauncherKey(current: LauncherPosition, key: string, shift: boolean, viewport: LauncherBounds, size: LauncherSize, assistantOpen: boolean): LauncherPosition | null {
  const delta = shift ? 48 : 16;
  const offsets: Record<string, LauncherPosition> = { ArrowLeft: { x: -delta, y: 0 }, ArrowRight: { x: delta, y: 0 }, ArrowUp: { x: 0, y: -delta }, ArrowDown: { x: 0, y: delta } };
  const offset = offsets[key];
  return offset ? resolveLauncherPosition({ x: current.x + offset.x, y: current.y + offset.y }, viewport, size, assistantOpen) : null;
}
