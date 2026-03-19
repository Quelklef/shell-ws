import { describe, expect, it } from "vitest";

import { collectAiScriptSamples } from "./aiScript";
import type { FlowEdge, NodeRuntimeState } from "./types";

function edge(targetHandle: string): FlowEdge {
  return {
    id: `edge-${targetHandle}`,
    source: "text-1",
    target: "ai-1",
    sourceHandle: "stdout",
    targetHandle,
    type: "workspace",
    data: { buffering: "line_or_1024" },
  } as FlowEdge;
}

describe("collectAiScriptSamples", () => {
  it("returns direct stdin and argv samples for connected inputs", () => {
    const runtime: NodeRuntimeState = {
      running: false,
      portActivity: {},
      previews: {
        stdin: { bytes: new TextEncoder().encode("stdin sample"), completed: true },
        "argv-2": { bytes: new TextEncoder().encode("second"), completed: true },
        "argv-1": { bytes: new TextEncoder().encode("first"), completed: true },
      },
    };

    const result = collectAiScriptSamples("ai-1", runtime, [
      edge("stdin"),
      edge("argv-2"),
      edge("argv-1"),
    ]);

    expect(result.stdinSample).toBe("stdin sample");
    expect(result.argvSamples).toEqual([
      { slot: 1, value: "first" },
      { slot: 2, value: "second" },
    ]);
  });

  it("omits samples for disconnected ports", () => {
    const runtime: NodeRuntimeState = {
      running: false,
      portActivity: {},
      previews: {
        stdin: { bytes: new TextEncoder().encode("stdin sample"), completed: true },
        "argv-1": { bytes: new TextEncoder().encode("first"), completed: true },
      },
    };

    const result = collectAiScriptSamples("ai-1", runtime, []);

    expect(result.stdinSample).toBeUndefined();
    expect(result.argvSamples).toEqual([]);
  });
});
