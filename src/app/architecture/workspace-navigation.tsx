"use client";

export type WorkspaceSection = "repository" | "overview" | "architecture" | "workflows" | "evidence";

export const workspaceSections: { id: WorkspaceSection; label: string; icon: string; description: string }[] = [
  { id: "repository", label: "Repository", icon: "▣", description: "Scan and load a repository" },
  { id: "overview", label: "Overview", icon: "▦", description: "Snapshot and investigation shortcuts" },
  { id: "architecture", label: "Architecture", icon: "◇", description: "Modules, components, and relationships" },
  { id: "workflows", label: "Workflows", icon: "⇄", description: "Rules, features, and proposals" },
  { id: "evidence", label: "Evidence", icon: "⌕", description: "Source references and relationships" },
];

export function WorkspaceNavigation({ active, onSelect, busy, assistantOpen, onToggleAssistant }: { active: WorkspaceSection; onSelect: (section: WorkspaceSection) => void; busy: boolean; assistantOpen?: boolean; onToggleAssistant?: () => void }) {
  return <nav className="workspace-activity" aria-label="Repository intelligence sections">
    {workspaceSections.map(section => <button key={section.id} type="button" title={section.description} aria-label={section.label} aria-current={active === section.id ? "page" : undefined} className={active === section.id ? "active" : ""} onClick={() => onSelect(section.id)}>
      <span className="workspace-activity-icon" aria-hidden="true">{section.icon}</span><span className="workspace-activity-label">{section.label}</span>{section.id === "repository" && busy && <span className="workspace-activity-busy" role="status" aria-label="Analysis in progress" />}
    </button>)}
    {onToggleAssistant && <button id="workspace-assistant-launcher" type="button" className={`workspace-assistant-launcher${assistantOpen ? " active" : ""}`} title="Open AI investigation assistant" aria-label={assistantOpen ? "Close AI assistant" : "Open AI assistant"} aria-expanded={!!assistantOpen} aria-controls="workspace-assistant" onClick={onToggleAssistant}><span className="workspace-activity-icon" aria-hidden="true">✦</span><span className="workspace-activity-label">Assistant</span></button>}
  </nav>;
}
