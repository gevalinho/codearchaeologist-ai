"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clearLauncherPosition, defaultLauncherPosition, moveLauncherKey, moveLauncherPointer, readLauncherPosition, resolveLauncherPosition, saveLauncherPosition, type LauncherBounds, type LauncherPosition, type LauncherSize } from "../../lib/architecture/preview-launcher-position";

type Props = { featureTitle: string; assistantOpen: boolean; onOpen: () => void };
type Drag = { pointerId: number; pointerStart: LauncherPosition; widgetStart: LauncherPosition; moved: boolean };

export default function PreviewLauncher({ featureTitle, assistantOpen, onOpen }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const savedRef = useRef<LauncherPosition | null>(null);
  const positionRef = useRef<LauncherPosition | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [position, setPosition] = useState<LauncherPosition | null>(null);
  const [status, setStatus] = useState("");
  const storage = () => { try { return window.localStorage; } catch { return null; } };
  const viewport = (): LauncherBounds => {
    const visual = window.visualViewport;
    return visual ? { width: visual.width, height: visual.height, left: visual.offsetLeft, top: visual.offsetTop } : { width: window.innerWidth, height: window.innerHeight };
  };
  const size = (): LauncherSize => ({ width: rootRef.current?.offsetWidth || 190, height: rootRef.current?.offsetHeight || 62 });
  const update = (next: LauncherPosition) => { positionRef.current = next; setPosition(next); };

  useEffect(() => {
    savedRef.current = readLauncherPosition(storage());
    const frame = requestAnimationFrame(() => update(resolveLauncherPosition(savedRef.current, viewport(), size(), assistantOpen)));
    return () => cancelAnimationFrame(frame);
    // Initial storage is read once; later updates use savedRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const adjust = () => { if (!dragRef.current) update(resolveLauncherPosition(savedRef.current, viewport(), size(), assistantOpen)); };
    const frame = requestAnimationFrame(adjust);
    window.addEventListener("resize", adjust);
    window.visualViewport?.addEventListener("resize", adjust);
    window.visualViewport?.addEventListener("scroll", adjust);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", adjust); window.visualViewport?.removeEventListener("resize", adjust); window.visualViewport?.removeEventListener("scroll", adjust); };
    // Browser geometry is read in the scheduled callback.
  }, [assistantOpen]);

  function pointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0 || !positionRef.current) return;
    dragRef.current = { pointerId: event.pointerId, pointerStart: { x: event.clientX, y: event.clientY }, widgetStart: positionRef.current, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.pointerStart.x, event.clientY - drag.pointerStart.y) >= 3) drag.moved = true;
    if (drag.moved) update(moveLauncherPointer(drag.widgetStart, drag.pointerStart, { x: event.clientX, y: event.clientY }, viewport(), size()));
  }
  function pointerEnd(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type === "pointercancel") { update(drag.widgetStart); return; }
    if (drag.moved && positionRef.current) {
      const next = resolveLauncherPosition(positionRef.current, viewport(), size(), assistantOpen);
      update(next); savedRef.current = next; saveLauncherPosition(storage(), next);
      setStatus("Preview App position saved.");
    }
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Home") { event.preventDefault(); reset(); return; }
    const current = positionRef.current ?? defaultLauncherPosition(viewport(), size(), assistantOpen);
    const next = moveLauncherKey(current, event.key, event.shiftKey, viewport(), size(), assistantOpen);
    if (!next) return;
    event.preventDefault();
    update(next); savedRef.current = next; saveLauncherPosition(storage(), next);
    setStatus("Preview App position saved.");
  }
  function reset() {
    clearLauncherPosition(storage()); savedRef.current = null;
    update(defaultLauncherPosition(viewport(), size(), assistantOpen));
    setStatus("Preview App position reset.");
  }

  return <div ref={rootRef} className="preview-launcher" style={{ left: position?.x, top: position?.y, visibility: position ? "visible" : "hidden" }}>
    <button type="button" className="preview-launcher-open" data-preview-launcher onClick={onOpen} aria-label={`Open interactive preview for ${featureTitle}`}><span aria-hidden="true">◇</span><span><strong>Preview App</strong><small>Interactive proposal</small></span><b aria-hidden="true">↗</b></button>
    <div className="preview-launcher-controls"><button type="button" className="preview-launcher-handle" aria-label="Move Preview App widget" title="Drag to move; arrow keys reposition; Home resets" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={() => { dragRef.current = null; }} onKeyDown={keyDown}>⠿</button><button type="button" className="preview-launcher-reset" onClick={reset} aria-label="Reset Preview App position" title="Reset position">↺</button></div>
    <span className="sr-only" role="status">{status}</span>
  </div>;
}
