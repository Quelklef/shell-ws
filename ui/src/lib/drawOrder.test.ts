import { describe, expect, it } from "vitest";

import { allocateBumpedDrawOrders, normalizeWorkspaceNodeDrawOrders } from "./drawOrder";
import type { WorkspaceNode } from "./types";

function node(id: string, drawOrder?: number): WorkspaceNode {
  return {
    id,
    kind: "text",
    title: "",
    comment: "",
    position: { x: 0, y: 0 },
    size: { width: 240, height: 120 },
    text: "",
    materialized: { inputs: {}, outputs: {}, lastExitCode: null },
    uiState: drawOrder === undefined ? {} : { drawOrder },
  };
}

describe("normalizeWorkspaceNodeDrawOrders", () => {
  it("fills missing draw order values and advances nextDrawOrder", () => {
    const result = normalizeWorkspaceNodeDrawOrders([
      node("a"),
      node("b", 7),
      node("c"),
    ]);

    expect(result.nodes.map((entry) => entry.uiState?.drawOrder)).toEqual([0, 7, 2]);
    expect(result.nextDrawOrder).toBe(8);
  });
});

describe("allocateBumpedDrawOrders", () => {
  it("preserves relative order inside a bumped group", () => {
    const result = allocateBumpedDrawOrders([
      { id: "a", drawOrder: 2 },
      { id: "b", drawOrder: 5 },
      { id: "c", drawOrder: 3 },
    ], ["a", "c"], 6);

    expect(Array.from(result.drawOrderById.entries())).toEqual([
      ["a", 6],
      ["c", 7],
    ]);
    expect(result.nextDrawOrder).toBe(8);
  });

  it("guards against stale nextDrawOrder values", () => {
    const result = allocateBumpedDrawOrders([
      { id: "a", drawOrder: 9 },
      { id: "b", drawOrder: 4 },
    ], ["b"], 1);

    expect(result.drawOrderById.get("b")).toBe(10);
    expect(result.nextDrawOrder).toBe(11);
  });
});
