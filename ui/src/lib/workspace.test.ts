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

  it("keeps display nodes as display nodes", () => {
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

    expect(sanitizeWorkspace(workspace).nodes[0]?.kind).toBe("display");
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


it("migrates legacy active preview tabs to open preview tab arrays", () => {
  const workspace = {
    id: "w",
    name: "w",
    ui: { viewportX: 0, viewportY: 0, zoom: 1 },
    cwd: "",
    openaiApiKey: "",
    nodes: [
      {
        id: "x",
        kind: "text",
        title: "",
        comment: "",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
        uiState: { activePreviewTab: "stdout" },
      },
    ],
    edges: [],
  } as unknown as Workspace;

  const sanitized = sanitizeWorkspace(workspace);
  expect(sanitized.nodes[0]?.uiState?.openPreviewTabs).toEqual(["stdout"]);
});


it("migrates legacy preview bytes into materialized inputs and outputs", () => {
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
          previews: {
            stdin: { dataBase64: "aGVsbG8=", completed: true },
            stdout: { dataBase64: "d29ybGQ=", completed: true },
          },
        },
      },
    ],
    edges: [],
  } as unknown as Workspace;

  const sanitized = sanitizeWorkspace(workspace);
  expect(sanitized.nodes[0]?.materializedValues).toEqual({
    stdin: { dataBase64: "aGVsbG8=" },
    stdout: { dataBase64: "d29ybGQ=" },
  });
});


it("merges legacy materialized input and output maps", () => {
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
        materializedInputs: {
          stdin: { dataBase64: "aGVsbG8=" },
        },
        materializedOutputs: {
          stdout: { dataBase64: "d29ybGQ=" },
        },
      },
    ],
    edges: [],
  } as unknown as Workspace;

  const sanitized = sanitizeWorkspace(workspace);
  expect(sanitized.nodes[0]?.materializedValues).toEqual({
    stdin: { dataBase64: "aGVsbG8=" },
    stdout: { dataBase64: "d29ybGQ=" },
  });
});

it("normalizes legacy exec arg strings into literal arg objects", () => {
  const workspace = {
    id: "w",
    name: "w",
    ui: { viewportX: 0, viewportY: 0, zoom: 1 },
    cwd: "",
    openaiApiKey: "",
    nodes: [
      {
        id: "x",
        kind: "exec",
        title: "",
        comment: "",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
        args: ["--flag", "value"],
      },
    ],
    edges: [],
  } as unknown as Workspace;

  const sanitized = sanitizeWorkspace(workspace);
  expect(sanitized.nodes[0]?.args).toEqual([
    { source: "literal", value: "--flag" },
    { source: "literal", value: "value" },
  ]);
});
