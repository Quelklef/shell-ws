import { describe, expect, it } from "vitest";
import { applyNodeOutputEvent } from "./runtimeEvents";

const enc = new TextEncoder();
const dec = new TextDecoder();
const PROCESS_OUTPUT_READ_CHUNK_SIZE = 1024;

function b64(value: string) {
  return Buffer.from(enc.encode(value)).toString("base64");
}

describe("applyNodeOutputEvent", () => {
  it("accumulates multi-chunk node output after an initial reset", () => {
    // Keep this aligned with kernel PROCESS_OUTPUT_READ_CHUNK_SIZE.
    const first = applyNodeOutputEvent(undefined, {
      type: "node_output",
      node_id: "b",
      port: "stdout",
      data_base64: b64("x".repeat(PROCESS_OUTPUT_READ_CHUNK_SIZE)),
      reset: true,
      timestamp: 1,
    });
    const second = applyNodeOutputEvent(first, {
      type: "node_output",
      node_id: "b",
      port: "stdout",
      data_base64: b64("x".repeat(15)),
      reset: false,
      timestamp: 2,
    });

    expect(dec.decode(second.stdout?.bytes)).toBe("x".repeat(PROCESS_OUTPUT_READ_CHUNK_SIZE + 15));
  });
});
