import type { NodeKind, PortKind } from "./types";

export function nodeHasInputPort(kind: NodeKind) {
  return kind !== "text" && kind !== "cat";
}

export function nodePreviewTabs(kind: NodeKind): PortKind[] {
  const tabs: PortKind[] = ["stdout", "stderr"];
  if (nodeHasInputPort(kind)) {
    tabs.unshift("stdin");
  }
  return tabs;
}
