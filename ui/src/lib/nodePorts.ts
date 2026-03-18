import type { NodeKind, PortKind } from "./types";

export function nodeHasInputPort(kind: NodeKind) {
  return kind !== "text" && kind !== "cat";
}

export function nodeHasArgvPort(kind: NodeKind) {
  return kind === "script" || kind === "exec";
}

export function nodePreviewTabs(kind: NodeKind): PortKind[] {
  const tabs: PortKind[] = ["stdout", "stderr"];
  if (nodeHasInputPort(kind)) {
    tabs.unshift("stdin");
  }
  return tabs;
}

export function nodeArgvSlots(nodeId: string, kind: NodeKind, edges: { target: string; targetHandle?: string | null }[], parseHandleId: (handleId: string | null | undefined) => { port: PortKind; slot?: number; }) {
  if (!nodeHasArgvPort(kind)) {
    return undefined;
  }
  const usedSlots = edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => parseHandleId(edge.targetHandle))
    .filter((entry) => entry.port === "argv")
    .map((entry) => entry.slot ?? 1);
  const maxSlot = Math.max(1, ...usedSlots);
  return Array.from({ length: maxSlot + 1 }, (_, index) => index + 1);
}
