import type {
  DisplayState,
  FlowEdge,
  MaterializedValue,
  NodeKind,
  NodeRuntimeState,
  PortKind,
  WorkspaceNode,
} from "./types";

export function isInputPreviewKey(key: string) {
  return key === "stdin" || /^argv-\d+$/.test(key);
}

export function isOutputPreviewKey(key: string) {
  return key === "stdout" || key === "stderr";
}

export function deserializeMaterializedValue(value?: MaterializedValue | null): DisplayState | undefined {
  if (!value) {
    return undefined;
  }
  return {
    bytes: fromBase64(value.dataBase64),
    completed: true,
  };
}

export function serializeMaterializedValue(state?: { bytes: Uint8Array }): MaterializedValue | undefined {
  if (!state) {
    return undefined;
  }
  return {
    dataBase64: toBase64(state.bytes),
  };
}

export function runtimePreviewsFromNode(node: WorkspaceNode) {
  const previews: Record<string, DisplayState> = {};
  for (const [key, value] of Object.entries(node.materializedInputs ?? {})) {
    const deserialized = deserializeMaterializedValue(value);
    if (deserialized) {
      previews[key] = deserialized;
    }
  }
  for (const [key, value] of Object.entries(node.materializedOutputs ?? {})) {
    const deserialized = deserializeMaterializedValue(value);
    if (deserialized) {
      previews[key] = deserialized;
    }
  }
  return Object.keys(previews).length > 0 ? previews : undefined;
}

export function splitMaterializedFromRuntime(previews?: Record<string, DisplayState>) {
  const materializedInputs: Record<string, MaterializedValue> = {};
  const materializedOutputs: Record<string, MaterializedValue> = {};
  for (const [key, state] of Object.entries(previews ?? {})) {
    const serialized = serializeMaterializedValue(state);
    if (!serialized) {
      continue;
    }
    if (isInputPreviewKey(key)) {
      materializedInputs[key] = serialized;
    } else if (isOutputPreviewKey(key)) {
      materializedOutputs[key] = serialized;
    }
  }
  return { materializedInputs, materializedOutputs };
}

export function outputPortsForKind(kind: NodeKind): PortKind[] {
  switch (kind) {
    case "script":
    case "ai_script":
    case "exec":
    case "file":
      return ["stdout", "stderr"];
    case "text":
    case "passthru":
      return ["stdout"];
    case "html":
      return [];
  }
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

function toBase64(bytes: Uint8Array) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary);
}

function fromBase64(value: string) {
  if (!value) {
    return new Uint8Array();
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
