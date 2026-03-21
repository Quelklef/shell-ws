import { describe, expect, it } from "vitest";

import { buildTopologyPreview, defaultTuckedName, isClosedSelection, reorderTuckspace } from "./tuckspace";

describe("tuckspace helpers", () => {
  it("detects closed selections", () => {
    expect(
      isClosedSelection(new Set(["a", "b"]), [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
      ]),
    ).toBe(true);
    expect(
      isClosedSelection(new Set(["a"]), [{ source: "a", target: "b" }]),
    ).toBe(false);
  });

  it("generates the next untaken default name", () => {
    expect(defaultTuckedName([{ id: "1", name: "Subgraph 1", nodes: [], edges: [], topologyPreview: { nodes: [], edges: [] } }])).toBe("Subgraph 2");
  });


  it("reorders tucked items by id", () => {
    const items = [
      { id: "a", name: "A", nodes: [], edges: [], topologyPreview: { nodes: [], edges: [] } },
      { id: "b", name: "B", nodes: [], edges: [], topologyPreview: { nodes: [], edges: [] } },
      { id: "c", name: "C", nodes: [], edges: [], topologyPreview: { nodes: [], edges: [] } },
    ];
    expect(reorderTuckspace(items, "c", "a").map((item) => item.id)).toEqual(["c", "a", "b"]);
  });

  it("normalizes topology preview coordinates", () => {
    const preview = buildTopologyPreview(
      [
        { id: "a", kind: "text", title: "", comment: "", position: { x: 0, y: 0 }, size: { width: 100, height: 50 } },
        { id: "b", kind: "script", title: "", comment: "", position: { x: 300, y: 150 }, size: { width: 100, height: 50 } },
      ] as never,
      [
        { id: "e", from: { nodeId: "a", port: "stdout" }, to: { nodeId: "b", port: "stdin" }, buffering: "unbuffered" },
      ] as never,
    );
    expect(preview.nodes).toHaveLength(2);
    expect(preview.nodes.every((node) => node.x >= 10 && node.x <= 90 && node.y >= 10 && node.y <= 62)).toBe(true);
    expect(preview.edges).toEqual([{ id: "e", fromNodeId: "a", toNodeId: "b" }]);
  });
});
