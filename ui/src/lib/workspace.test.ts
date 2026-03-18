import { describe, expect, it } from "vitest";

import type { Workspace } from "./types";
import { sanitizeWorkspace } from "./workspace";

describe("sanitizeWorkspace", () => {
  it("renames legacy cat nodes to file nodes", () => {
    const workspace = {
      id: "w",
      name: "w",
      ui: { viewportX: 0, viewportY: 0, zoom: 1 },
      cwd: "",
      nodes: [
        {
          id: "cat-1",
          kind: "cat",
          title: "",
          comment: "",
          position: { x: 0, y: 0 },
          size: { width: 300, height: 200 },
        },
      ],
      edges: [],
    } as unknown as Workspace;

    expect(sanitizeWorkspace(workspace).nodes[0]?.kind).toBe("file");
  });

  it("drops legacy unslotted argv edges", () => {
    const workspace: Workspace = {
      id: "w",
      name: "w",
      ui: { viewportX: 0, viewportY: 0, zoom: 1 },
      cwd: "",
      nodes: [],
      edges: [
        {
          id: "old-argv",
          from: { nodeId: "a", port: "stdout" },
          to: { nodeId: "b", port: "argv" },
          buffering: "line_or_1024",
        },
        {
          id: "stdin",
          from: { nodeId: "a", port: "stdout" },
          to: { nodeId: "b", port: "stdin" },
          buffering: "line_or_1024",
        },
        {
          id: "new-argv",
          from: { nodeId: "c", port: "stdout" },
          to: { nodeId: "b", port: "argv", slot: 1 },
          buffering: "line_or_1024",
        },
      ],
    };

    expect(sanitizeWorkspace(workspace).edges.map((edge) => edge.id)).toEqual([
      "stdin",
      "new-argv",
    ]);
  });
});
