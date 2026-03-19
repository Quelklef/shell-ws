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
      openaiApiKey: "",
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

  it("renames legacy display nodes to passthru nodes", () => {
    const workspace = {
      id: "w",
      name: "w",
      ui: { viewportX: 0, viewportY: 0, zoom: 1 },
      cwd: "",
      openaiApiKey: "",
      nodes: [
        {
          id: "display-1",
          kind: "display",
          title: "",
          comment: "",
          position: { x: 0, y: 0 },
          size: { width: 300, height: 200 },
        },
      ],
      edges: [],
    } as unknown as Workspace;

    expect(sanitizeWorkspace(workspace).nodes[0]?.kind).toBe("passthru");
  });

  it("drops legacy unslotted argv edges", () => {
    const workspace: Workspace = {
      id: "w",
      name: "w",
      ui: { viewportX: 0, viewportY: 0, zoom: 1 },
      cwd: "",
      openaiApiKey: "",
      nodes: [
        { id: "a", kind: "text", title: "", comment: "", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
        { id: "b", kind: "script", title: "", comment: "", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
        { id: "c", kind: "text", title: "", comment: "", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
      ],
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


it("drops legacy removed node kinds and their edges", () => {
  const workspace = {
    id: "w",
    name: "w",
    ui: { viewportX: 0, viewportY: 0, zoom: 1 },
    cwd: "",
    nodes: [
      { id: "t", kind: "tee", title: "", comment: "", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
      { id: "x", kind: "text", title: "", comment: "", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
    ],
    edges: [
      { id: "e", from: { nodeId: "x", port: "stdout" }, to: { nodeId: "t", port: "stdin" }, buffering: "line_or_1024" },
    ],
  } as unknown as Workspace;

  const sanitized = sanitizeWorkspace(workspace);
  expect(sanitized.nodes.map((node) => node.id)).toEqual(["x"]);
  expect(sanitized.edges).toEqual([]);
});
