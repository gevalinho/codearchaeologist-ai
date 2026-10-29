import type { Node } from "../archaeology/scanner";

export type GraphNodeLabel = { lines: readonly string[]; fullName: string };
const MAX_LINE = 20;
const trim = (value: string) => value.length > MAX_LINE ? `${value.slice(0, MAX_LINE - 1)}…` : value;
const basename = (value: string) => value.split("/").at(-1) ?? value;

/** Only display text is shortened; graph identity and source references stay intact. */
export function graphNodeLabel(node: Pick<Node, "kind" | "name">): GraphNodeLabel {
  const fullName = node.name;
  const name = basename(fullName);
  if (name.includes("#")) {
    const separator = name.lastIndexOf("#");
    return { fullName, lines: [trim(name.slice(0, separator)), trim(name.slice(separator + 1))] };
  }
  if (node.kind === "branch") {
    const separator = name.lastIndexOf(":");
    if (separator > 0) return { fullName, lines: [trim(name.slice(0, separator)), trim(`line ${name.slice(separator + 1)}`)] };
  }
  return { fullName, lines: [trim(name)] };
}
