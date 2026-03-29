import type { PortRef } from "./types";

export function portRefKey(ref: PortRef) {
  return JSON.stringify({
    nodeId: ref.nodeId,
    port: ref.port,
    slot: ref.slot ?? null,
  });
}

export function inputKeyForPortRef(ref: PortRef) {
  if (ref.port === "stdin") {
    return "stdin";
  }
  if (ref.port === "argv") {
    return `argv-${ref.slot ?? 1}`;
  }
  return null;
}

export function inputPortRefForKey(nodeId: string, key: string): PortRef | null {
  if (key === "stdin") {
    return { nodeId, port: "stdin" };
  }
  if (key.startsWith("argv-")) {
    const slot = Number.parseInt(key.slice("argv-".length), 10);
    if (Number.isFinite(slot) && slot > 0) {
      return { nodeId, port: "argv", slot };
    }
  }
  return null;
}

export function outputPortRefForKey(nodeId: string, key: string): PortRef | null {
  if (key === "stdout" || key === "stderr") {
    return { nodeId, port: key };
  }
  return null;
}
