"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FeatureInvestigation } from "../../lib/architecture/features";
import type { ModernizationBlueprint } from "../../lib/architecture/blueprint";
import type { ModernizationPreview } from "../../lib/architecture/preview";
import type { ReconstructionSpec } from "../../lib/architecture/reconstruction-spec";
import { focusTrapTarget } from "../../lib/architecture/preview-drawer";
import ModernPreview from "./modern-preview";
import ReconstructionRenderer from "./reconstruction-renderer";
import PreviewLauncher from "./preview-launcher";

type Props = { preview: ModernizationPreview | null; reconstruction: ReconstructionSpec | null; feature: FeatureInvestigation | undefined; blueprint: ModernizationBlueprint | null; open: boolean; expanded: boolean; assistantOpen: boolean; onOpen: () => void; onClose: () => void; onToggleExpanded: () => void };
const focusSelector = "button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export default function PreviewDrawer({ preview, reconstruction, feature, blueprint, open, expanded, assistantOpen, onOpen, onClose, onToggleExpanded }: Props) {
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLElement>(null), closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPortalRoot(document.body));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!open || !preview && !reconstruction) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>(focusSelector)].filter(item => !item.hasAttribute("inert") && item.getClientRects().length > 0);
      const target = focusTrapTarget(focusables, document.activeElement, event.shiftKey);
      if (target) { event.preventDefault(); target.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      const fallback = document.querySelector<HTMLElement>("[data-preview-launcher]") ?? document.querySelector<HTMLElement>("[data-feature-tabs] button");
      if (previousFocus?.isConnected) previousFocus.focus(); else fallback?.focus();
    };
  }, [open, preview, reconstruction]);
  if (!portalRoot || !feature || !blueprint || !preview && !reconstruction) return null;
  return createPortal(<>
    {!open && <PreviewLauncher featureTitle={feature.title} assistantOpen={assistantOpen} onOpen={onOpen} />}
    {open && <button className="preview-drawer-backdrop" aria-label="Close preview drawer" onClick={onClose} tabIndex={-1} />}
    <section ref={dialogRef} className={`preview-drawer ${open ? "is-open" : ""} ${expanded ? "is-expanded" : ""}`} role="dialog" aria-modal={open || undefined} aria-labelledby="preview-drawer-title" aria-describedby="preview-drawer-subtitle" aria-hidden={!open} inert={!open}>
      <header className="preview-drawer-header"><div className="preview-drawer-heading"><span className="preview-drawer-mark">◇</span><div><h2 id="preview-drawer-title">Modern App Preview</h2><p id="preview-drawer-subtitle">{feature.title} <span>· PROPOSAL / DEMO</span></p></div></div><div className="preview-drawer-actions"><button onClick={onToggleExpanded} aria-label={expanded ? "Collapse preview drawer" : "Expand preview drawer"} title={expanded ? "Collapse" : "Expand"}>{expanded ? "↘" : "↖"}</button><button ref={closeRef} onClick={onClose} aria-label="Close preview drawer" title="Close">×</button></div></header>
      <div className="preview-drawer-body">{preview ? <ModernPreview preview={preview} feature={feature} blueprint={blueprint} /> : reconstruction && <ReconstructionRenderer key={reconstruction.id} specification={reconstruction} />}</div>
    </section>
  </>, portalRoot);
}
