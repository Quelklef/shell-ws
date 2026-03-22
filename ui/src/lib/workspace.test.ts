import { describe, expect, it } from "vitest";

import type { Workspace } from "./types";
import { sanitizeWorkspace } from "./workspace";

describe("sanitizeWorkspace", () => {
  it("preserves current materialized refs", () => {
    const workspace = {
      id: "w",
      name: "w",
      ui: { viewportX: 0, viewportY: 0, zoom: 1 },
      cwd: "",
      openaiApiKey: "",
      nodes: [
        {
          id: "x",
          kind: "script",
          title: "",
          comment: "",
          position: { x: 0, y: 0 },
          size: { width: 10, height: 10 },
          materialized: {
            inputs: { stdin: "matout-in" },
            outputs: { stdout: "matout-out" },
            lastExitCode: 7,
          },
        },
      ],
      edges: [],
      tuckspace: [],
    } as unknown as Workspace;

    expect(sanitizeWorkspace(workspace).nodes[0]?.materialized).toEqual({
      inputs: { stdin: "matout-in" },
      outputs: { stdout: "matout-out" },
      lastExitCode: 7,
    });
  });

  it("drops edges that reference missing nodes", () => {
    const workspace = {
      id: "w",
      name: "w",
      ui: { viewportX: 0, viewportY: 0, zoom: 1 },
      cwd: "",
      openaiApiKey: "",
      nodes: [
        { id: "a", kind: "text", title: "", comment: "", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
      ],
      edges: [
        {
          id: "e1",
          from: { nodeId: "a", port: "stdout" },
          to: { nodeId: "missing", port: "stdin" },
          buffering: "line_or_1024",
        },
      ],
      tuckspace: [],
    } as unknown as Workspace;

    expect(sanitizeWorkspace(workspace).edges).toEqual([]);
  });

  it("preserves persisted pane sizes", () => {
    const workspace = {
      id: "w",
      name: "w",
      ui: { viewportX: 0, viewportY: 0, zoom: 1 },
      cwd: "",
      openaiApiKey: "",
      nodes: [
        {
          id: "x",
          kind: "script",
          title: "",
          comment: "",
          position: { x: 0, y: 0 },
          size: { width: 10, height: 10 },
          uiState: {
            paneSizes: {
              script: { height: 180 },
              "preview-stdout": { height: 144 },
            },
          },
        },
      ],
      edges: [],
      tuckspace: [],
    } as unknown as Workspace;

    expect(sanitizeWorkspace(workspace).nodes[0]?.uiState?.paneSizes).toEqual({
      script: { height: 180 },
      "preview-stdout": { height: 144 },
    });
  });

  it("defaults tuckspace and sidebar ui state", () => {
    const workspace = {
      id: "w",
      name: "w",
      ui: { viewportX: 0, viewportY: 0, zoom: 1 },
      cwd: "",
      openaiApiKey: "",
      nodes: [],
      edges: [],
    } as unknown as Workspace;

    const sanitized = sanitizeWorkspace(workspace);
    expect(sanitized.tuckspace).toEqual([]);
    expect(sanitized.ui.sidebars.workspaces.width).toBeGreaterThan(0);
    expect(sanitized.ui.sidebars.tuckspace.collapsed).toBe(false);
  });
});
