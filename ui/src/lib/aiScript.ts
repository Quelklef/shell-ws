import type { FlowEdge, NodeRuntimeState } from "./types";

const MAX_SAMPLE_CHARS = 4_096;

export interface AiArgvSample {
  slot: number;
  value: string;
}

export function collectAiScriptSamples(
  nodeId: string,
  runtime: NodeRuntimeState | undefined,
  edges: FlowEdge[],
): { stdinSample?: string; argvSamples: AiArgvSample[] } {
  const incoming = edges.filter((edge) => edge.target === nodeId);
  const stdinConnected = incoming.some((edge) => parseHandleId(edge.targetHandle).port === "stdin");
  const stdinBytes = runtime?.previews?.stdin?.bytes;
  const stdinSample = stdinConnected && stdinBytes && stdinBytes.length > 0
    ? decodeSample(stdinBytes)
    : undefined;

  const argvSlots = Array.from(
    new Set(
      incoming
        .map((edge) => parseHandleId(edge.targetHandle))
        .filter((handle) => handle.port === "argv" && handle.slot != null)
        .map((handle) => handle.slot as number),
    ),
  ).sort((left, right) => left - right);

  const argvSamples = argvSlots
    .map((slot) => {
      const bytes = runtime?.previews?.[`argv-${slot}`]?.bytes;
      if (!bytes || bytes.length === 0) {
        return null;
      }
      return { slot, value: decodeSample(bytes) };
    })
    .filter((sample): sample is AiArgvSample => sample !== null);

  return { stdinSample, argvSamples };
}

function decodeSample(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  const truncated = text.slice(0, MAX_SAMPLE_CHARS);
  return text.length > MAX_SAMPLE_CHARS ? `${truncated}\n[truncated]` : truncated;
}

function parseHandleId(handleId: string | null | undefined): {
  port: string;
  slot?: number;
} {
  if (!handleId) {
    return { port: "stdout" };
  }
  const match = /^(stdin|argv|stdout|stderr)-(\d+)$/.exec(handleId);
  if (match) {
    return {
      port: match[1],
      slot: Number(match[2]),
    };
  }
  return { port: handleId };
}
