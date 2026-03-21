import { describe, expect, it } from "vitest";

import { buildTopologyPreview, defaultTuckedName, emptyTuckedSubgraph, isClosedSelection, isTuckspaceShell, recenterTuckedNodes, reorderTuckspace, reorderTuckspaceWithPlacement, shouldKeepShellOnRestore, storeTuckedSubgraph } from "./tuckspace";

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



  it("reorders tucked items by target position", () => {
    const items = [
      { id: "a", name: "A", nodes: [], edges: [], topologyPreview: { nodes: [], edges: [] } },
      { id: "b", name: "B", nodes: [], edges: [], topologyPreview: { nodes: [], edges: [] } },
      { id: "c", name: "C", nodes: [], edges: [], topologyPreview: { nodes: [], edges: [] } },
    ];
    expect(reorderTuckspaceWithPlacement(items, "a", "c", "after").map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(reorderTuckspaceWithPlacement(items, "c", "a", "before").map((item) => item.id)).toEqual(["c", "a", "b"]);
  });

  it("fills an existing shell without changing its identity", () => {
    const items = [
      { id: "shell-1", name: "Saved shell", nodes: [], edges: [], topologyPreview: { nodes: [], edges: [] } },
    ];
    const next = storeTuckedSubgraph(
      items,
      [{ id: "n1", kind: "text", title: "", comment: "", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } }] as never,
      [],
      "shell-1",
    );
    expect(next[0]?.id).toBe("shell-1");
    expect(next[0]?.name).toBe("Saved shell");
    expect(next[0]?.nodes).toHaveLength(1);
    expect(isTuckspaceShell(emptyTuckedSubgraph(next[0]!))).toBe(true);
  });

  it("recenters tucked nodes around a target point", () => {
    const nodes = recenterTuckedNodes([
      { id: "a", kind: "text", title: "", comment: "", position: { x: 0, y: 0 }, size: { width: 100, height: 50 } },
      { id: "b", kind: "script", title: "", comment: "", position: { x: 300, y: 150 }, size: { width: 100, height: 50 } },
    ] as never, { x: 500, y: 400 });
    expect(nodes.map((node) => node.position)).toEqual([
      { x: 300, y: 300 },
      { x: 600, y: 450 },
    ]);
  });


  it("only keeps named shells on restore", () => {
    expect(shouldKeepShellOnRestore({ id: "a", name: "A", userNamed: true, nodes: [], edges: [], topologyPreview: { nodes: [], edges: [] } })).toBe(true);
    expect(shouldKeepShellOnRestore({ id: "b", name: "Subgraph 1", userNamed: false, nodes: [], edges: [], topologyPreview: { nodes: [], edges: [] } })).toBe(false);
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
