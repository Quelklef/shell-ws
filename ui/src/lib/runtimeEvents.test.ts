import { describe, expect, it } from "vitest";
import { applyNodeOutputEvent } from "./runtimeEvents";

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(value: string) {
  return Buffer.from(enc.encode(value)).toString("base64");
}

describe("applyNodeOutputEvent", () => {
  it("accumulates multi-chunk node output after an initial reset", () => {
    const first = applyNodeOutputEvent(undefined, {
      type: "node_output",
      node_id: "b",
      port: "stdout",
      data_base64: b64("x".repeat(1024)),
      reset: true,
      timestamp: 1,
    });
    const second = applyNodeOutputEvent(first, {
      type: "node_output",
      node_id: "b",
      port: "stdout",
      data_base64: b64("x".repeat(8)),
      reset: false,
      timestamp: 2,
    });

    expect(dec.decode(second.stdout?.bytes)).toBe("x".repeat(1032));
  });
});
