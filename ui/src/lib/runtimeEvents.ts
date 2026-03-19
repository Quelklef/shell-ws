import type { DisplayState, ServerEvent } from "./types";

export function applyNodeOutputEvent(
  previews: Record<string, DisplayState> | undefined,
  event: Extract<ServerEvent, { type: "node_output" }>,
): Record<string, DisplayState> {
  const nextBytes = fromBase64(event.data_base64);
  const previous = event.reset
    ? new Uint8Array()
    : previews?.[event.port]?.bytes ?? new Uint8Array();
  return {
    ...(previews ?? {}),
    [event.port]: {
      bytes: concatBytes(previous, nextBytes),
      completed: false,
    },
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array) {
  const bytes = new Uint8Array(left.length + right.length);
  bytes.set(left, 0);
  bytes.set(right, left.length);
  return bytes;
}

function fromBase64(value: string) {
  if (!value) {
    return new Uint8Array();
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
