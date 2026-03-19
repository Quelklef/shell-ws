import { describe, expect, it } from "vitest";

import { layoutSelectedNodes } from "./layout";
import type { WorkspaceNode } from "./types";

describe("layoutSelectedNodes", () => {
  it("places upstream nodes left of downstream nodes", () => {
    const positions = layoutSelectedNodes(
      ["a", "b", "c"],
      [
        {
          id: "a",
          kind: "text",
          title: "A",
          comment: "",
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          shell: "bash",
          text: "a",
        },
        {
          id: "b",
          kind: "script",
          title: "B",
          comment: "",
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          shell: "bash",
          script: "cat",
        },
        {
          id: "c",
          kind: "passthru",
          title: "C",
          comment: "",
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          shell: "bash",
        },
      ],
      [
        {
          id: "e1",
          from: { nodeId: "a", port: "stdout" },
          to: { nodeId: "b", port: "stdin" },
          buffering: "line_or_1024",
        },
        {
          id: "e2",
          from: { nodeId: "b", port: "stdout" },
          to: { nodeId: "c", port: "stdin" },
          buffering: "line_or_1024",
        },
      ],
    );

    expect(positions.get("a")!.x).toBeLessThan(positions.get("b")!.x);
    expect(positions.get("b")!.x).toBeLessThan(positions.get("c")!.x);
  });
});


it("preserves the selection center while relaying out nodes", () => {
  const nodes: WorkspaceNode[] = [
    {
      id: "a",
      kind: "text",
      title: "A",
      comment: "",
      position: { x: 400, y: 300 },
      size: { width: 120, height: 80 },
      shell: "bash",
      text: "a",
    },
    {
      id: "b",
      kind: "script",
      title: "B",
      comment: "",
      position: { x: 700, y: 500 },
      size: { width: 160, height: 100 },
      shell: "bash",
      script: "cat",
    },
  ];
  const beforeCenter = {
    x: (400 + (700 + 160)) / 2,
    y: (300 + (500 + 100)) / 2,
  };
  const positions = layoutSelectedNodes(
    ["a", "b"],
    nodes,
    [{ id: "e1", from: { nodeId: "a", port: "stdout" }, to: { nodeId: "b", port: "stdin" }, buffering: "line_or_1024" }],
  );
  const afterCenter = {
    x: (Math.min(positions.get("a")!.x, positions.get("b")!.x) + Math.max(positions.get("a")!.x + 120, positions.get("b")!.x + 160)) / 2,
    y: (Math.min(positions.get("a")!.y, positions.get("b")!.y) + Math.max(positions.get("a")!.y + 80, positions.get("b")!.y + 100)) / 2,
  };

  expect(afterCenter.x).toBe(beforeCenter.x);
  expect(afterCenter.y).toBe(beforeCenter.y);
});
