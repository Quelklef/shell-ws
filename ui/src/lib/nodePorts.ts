import type { NodeKind, PortKind } from "./types";
import { nodeHasArgvPort, nodeHasInputPort, previewOutputPortsForKind, nodePreviewTabs } from "./portSchema";

export { nodeHasArgvPort, nodeHasInputPort, nodePreviewTabs } from "./portSchema";

export function nodeArgvSlots(
  nodeId: string,
  kind: NodeKind,
  edges: { target: string; targetHandle?: string | null }[],
  parseHandleId: (handleId: string | null | undefined) => { port: PortKind; slot?: number },
) {
  if (!nodeHasArgvPort(kind)) {
    return undefined;
  }
  const usedSlots = edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => parseHandleId(edge.targetHandle))
    .filter((entry) => entry.port === "argv")
    .map((entry) => entry.slot ?? 1);
  if (usedSlots.length === 0) {
    return [1];
  }
  const maxSlot = Math.max(...usedSlots);
  return Array.from({ length: maxSlot + 1 }, (_, index) => index + 1);
}

export function nodePreviewTabsForNode(
  nodeId: string,
  kind: NodeKind,
  edges: { target: string; targetHandle?: string | null }[],
  parseHandleId: (handleId: string | null | undefined) => { port: PortKind; slot?: number },
) {
  const tabs: string[] = [];
  const inputs = edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => parseHandleId(edge.targetHandle));
  if (nodeHasInputPort(kind) && inputs.some((entry) => entry.port === "stdin")) {
    tabs.push("stdin");
  }
  if (nodeHasArgvPort(kind)) {
    const argvSlots = Array.from(
      new Set(
        inputs
          .filter((entry) => entry.port === "argv" && entry.slot != null)
          .map((entry) => entry.slot as number),
      ),
    ).sort((a, b) => a - b);
    tabs.push(...argvSlots.map((slot) => `argv-${slot}`));
  }
  tabs.push(...previewOutputPortsForKind(kind));
  return tabs;
}
