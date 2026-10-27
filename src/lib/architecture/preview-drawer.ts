export type PreviewDrawerState = { open: boolean; expanded: boolean; previewKey: string | null };
export type PreviewDrawerAction = { type: "open"; previewKey: string } | { type: "close" } | { type: "toggle-expand" } | { type: "feature-change"; previewKey: string | null };
export const initialPreviewDrawerState = (): PreviewDrawerState => ({ open: false, expanded: false, previewKey: null });

export function reducePreviewDrawer(state: PreviewDrawerState, action: PreviewDrawerAction): PreviewDrawerState {
  if (action.type === "open") return { open: true, expanded: state.previewKey === action.previewKey ? state.expanded : false, previewKey: action.previewKey };
  if (action.type === "close") return { ...state, open: false };
  if (action.type === "toggle-expand") return state.open ? { ...state, expanded: !state.expanded } : state;
  if (action.type === "feature-change") return state.previewKey === action.previewKey ? state : { open: false, expanded: false, previewKey: action.previewKey };
  return state;
}

export function focusTrapTarget(focusables: readonly HTMLElement[], active: Element | null, backwards: boolean): HTMLElement | null {
  if (!focusables.length) return null;
  if (backwards && active === focusables[0]) return focusables[focusables.length - 1];
  if (!backwards && active === focusables[focusables.length - 1]) return focusables[0];
  if (!focusables.some(item => item === active)) return backwards ? focusables[focusables.length - 1] : focusables[0];
  return null;
}
