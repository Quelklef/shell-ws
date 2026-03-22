import type {
  DisplayState,
  FlowEdge,
  MaterializedOutputStore,
  NodeRuntimeState,
  PortKind,
  WorkspaceNode,
} from "./types";
import { outputPortsForKind } from "./portSchema";
import { resolveNodeMaterializedValue } from "./materializedOutputs";

export function isInputPreviewKey(key: string) {
  return key === "stdin" || /^argv-\d+$/.test(key);
}

export function isOutputPreviewKey(key: string) {
  return key === "stdout" || key === "stderr";
}

export function runtimePreviewsFromNode(node: WorkspaceNode, store: MaterializedOutputStore) {
  const previews: Record<string, DisplayState> = {};
  const keys = new Set<string>([
    ...Object.keys(node.materialized?.inputs ?? {}),
    ...Object.keys(node.materialized?.outputs ?? {}),
  ]);
  for (const key of keys) {
    const resolved = resolveNodeMaterializedValue(node, key, store);
    if (resolved) {
      previews[key] = { bytes: resolved, completed: true };
    }
  }
  return Object.keys(previews).length > 0 ? previews : undefined;
}

export function connectedInputKeys(
  nodeId: string,
  edges: FlowEdge[],
  parseHandleId: (handleId: string | null | undefined) => { port: PortKind; slot?: number },
) {
  const keys = new Set<string>();
  for (const edge of edges) {
    if (edge.target !== nodeId) {
      continue;
    }
    const parsed = parseHandleId(edge.targetHandle);
    if (parsed.port === "stdin") {
      keys.add("stdin");
    }
    if (parsed.port === "argv") {
      keys.add(`argv-${parsed.slot ?? 1}`);
    }
  }
  return Array.from(keys).sort();
}

export function missingConnectedInputs(
  node: WorkspaceNode,
  edges: FlowEdge[],
  runtime: NodeRuntimeState | undefined,
  parseHandleId: (handleId: string | null | undefined) => { port: PortKind; slot?: number },
) {
  const previews = runtime?.previews ?? {};
  return connectedInputKeys(node.id, edges, parseHandleId).filter((key) => !(key in previews));
}

export function missingOutputs(node: WorkspaceNode, runtime: NodeRuntimeState | undefined) {
  const previews = runtime?.previews ?? {};
  return outputPortsForKind(node.kind).filter((port) => !(port in previews));
}
