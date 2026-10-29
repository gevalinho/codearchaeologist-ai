import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceNavigation, workspaceSections } from "../src/app/architecture/workspace-navigation";

describe("workspace activity navigation", () => {
  it("exposes five named keyboard-accessible section buttons and the active location", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceNavigation, { active: "architecture", onSelect: () => {}, busy: false }));
    expect(workspaceSections.map(section => section.label)).toEqual(["Repository", "Overview", "Architecture", "Workflows", "Evidence"]);
    expect(markup.match(/<button/g)).toHaveLength(5);
    expect(markup).toContain('aria-label="Architecture" aria-current="page"');
    expect(markup).toContain('aria-label="Evidence"');
    expect(markup).toContain('title="Modules, components, and relationships"');
  });

  it("announces an active scan on the repository item without changing navigation", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceNavigation, { active: "workflows", onSelect: () => {}, busy: true }));
    expect(markup).toContain('role="status" aria-label="Analysis in progress"');
    expect(markup).toContain('aria-label="Workflows" aria-current="page"');
  });

  it("routes a section button through its selection callback", () => {
    const selected: string[] = [];
    const nav = WorkspaceNavigation({ active: "repository", onSelect: section => selected.push(section), busy: false });
    const buttons = (nav.props.children as ReactElement<{ onClick: () => void }>[][])[0];
    buttons[3].props.onClick();
    buttons[4].props.onClick();
    expect(selected).toEqual(["workflows", "evidence"]);
  });
});
