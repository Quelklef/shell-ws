import { describe, expect, it } from "vitest";

import { nodeArgvSlots, nodePreviewTabsForNode } from "./nodePorts";
import { nodeHasArgvPort, nodeHasInputPort, nodePortSchema, nodePreviewTabs, outputPortsForKind, previewOutputPortsForKind } from "./portSchema";

describe("node port affordances", () => {
  it("matches previews to each node's actual input and output ports", () => {
    expect(nodePreviewTabs("text")).toEqual(["stdout"]);
    expect(nodePreviewTabs("file")).toEqual(["stdout", "stderr"]);
    expect(nodePreviewTabs("passthru")).toEqual(["stdin", "stdout"]);
    expect(nodePreviewTabs("display")).toEqual(["stdin", "stdout"]);
    expect(nodePreviewTabs("html")).toEqual(["stdin"]);
    expect(nodePreviewTabs("script")).toEqual(["stdin", "stdout", "stderr"]);
  });

  it("matches stdin affordance to node kind", () => {
    expect(nodeHasInputPort("text")).toBe(false);
    expect(nodeHasInputPort("file")).toBe(false);
    expect(nodeHasInputPort("script")).toBe(true);
    expect(nodeHasInputPort("ai_script")).toBe(true);
    expect(nodeHasInputPort("passthru")).toBe(true);
    expect(nodeHasInputPort("display")).toBe(true);
    expect(nodeHasInputPort("html")).toBe(true);
  });

  it("adds argv ports only to command nodes", () => {
    expect(nodeHasArgvPort("script")).toBe(true);
    expect(nodeHasArgvPort("ai_script")).toBe(true);
    expect(nodeHasArgvPort("exec")).toBe(true);
    expect(nodeHasArgvPort("passthru")).toBe(false);
    expect(nodeHasArgvPort("display")).toBe(false);
    expect(nodeHasArgvPort("file")).toBe(false);
  });

  it("shows a single initial argv slot before any connections exist", () => {
    expect(
      nodeArgvSlots("script-1", "script", [], () => ({ port: "stdout" })),
    ).toEqual([1]);
  });

  it("shows only connected input previews plus unconditional outputs", () => {
    expect(
      nodePreviewTabsForNode(
        "script-1",
        "script",
        [
          { target: "script-1", targetHandle: "stdin" },
          { target: "script-1", targetHandle: "argv-2" },
        ],
        (handleId) => {
          const match = /^(stdin|argv|stdout|stderr)-(\d+)$/.exec(handleId ?? "");
          return match
            ? { port: match[1] as any, slot: Number(match[2]) }
            : { port: (handleId ?? "stdout") as any };
        },
      ),
    ).toEqual(["stdin", "argv-2", "stdout", "stderr"]);
  });
});


describe("node port schema", () => {
  it("centralizes port exposure per node kind", () => {
    expect(nodePortSchema("display")).toEqual({
      stdin: true,
      argv: false,
      sourceOutputs: [],
      previewOutputs: ["stdout"],
    });
    expect(nodePortSchema("formula")).toEqual({
      stdin: false,
      argv: true,
      sourceOutputs: ["stdout", "stderr"],
      previewOutputs: ["stdout", "stderr"],
    });
  });

  it("derives output and preview ports from the schema", () => {
    expect(outputPortsForKind("display")).toEqual([]);
    expect(previewOutputPortsForKind("display")).toEqual(["stdout"]);
    expect(outputPortsForKind("script")).toEqual(["stdout", "stderr"]);
  });
});
