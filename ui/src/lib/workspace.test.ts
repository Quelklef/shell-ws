import { describe, expect, it } from "vitest";

import type { Workspace } from "./types";
import { sanitizeWorkspace } from "./workspace";

describe("sanitizeWorkspace", () => {
  it("drops legacy unslotted argv edges", () => {
    const workspace: Workspace = {
      id: "w",
      name: "w",
      ui: { viewportX: 0, viewportY: 0, zoom: 1 },
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
