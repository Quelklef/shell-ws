import { describe, expect, it } from "vitest";

import { layoutSelectedNodes } from "./layout";

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
          kind: "display",
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
