import { describe, expect, it } from "vitest";

import { compileExecutionRequest } from "./compileExecutionRequest";
import type { Workspace, WorkspaceNode } from "./types";

function node(id: string, kind: WorkspaceNode["kind"]): WorkspaceNode {
  return {
    id,
    kind,
    title: "",
    comment: "",
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    materialized: { inputs: {}, outputs: {}, lastExitCode: null },
  };
}

function workspace(nodes: WorkspaceNode[], edges: Workspace["edges"]): Workspace {
  return {
    id: "w",
    name: "w",
    createdAt: 0,
    sortOrder: 0,
    cwd: "",
    openaiApiKey: "",
    nodes,
    edges,
    tuckspace: [],
    ui: {
      viewportX: 0,
      viewportY: 0,
      zoom: 1,
      sidebars: {
        workspaces: { width: 240, collapsed: false },
        settings: { width: 300, collapsed: false },
        nodes: { width: 280, collapsed: false },
        tuckspace: { width: 280, collapsed: false },
      },
      previewControlsLocation: "floating",
    },
  };
}

describe("compileExecutionRequest", () => {
  it("compiles rerun to a target-only graph with provided materialized inputs", () => {
    const source = node("source", "text");
    const target = node("target", "script");
    target.materialized = {
      inputs: { stdin: "mat-in" },
      outputs: { stdout: "mat-out" },
      lastExitCode: 0,
    };
    const request = compileExecutionRequest(
      workspace(
        [source, target],
        [
          {
            id: "e1",
            from: { nodeId: "source", port: "stdout" },
            to: { nodeId: "target", port: "stdin" },
            buffering: "line_or_1024",
          },
        ],
      ),
      "target",
      "rerun",
    );

    expect(request.seedNodeIds).toEqual(["target"]);
    expect(request.blockedNodeIds).toEqual([]);
    expect(request.providedMatoutIds).toEqual(["mat-in"]);
    expect(request.workspace.nodes.map((item) => item.id)).toEqual(["target"]);
    expect(request.workspace.edges).toEqual([]);
    expect(request.workspace.nodes[0].materialized?.inputs).toEqual({ stdin: "mat-in" });
    expect(request.workspace.nodes[0].materialized?.outputs).toEqual({ stdout: "mat-out" });
  });

  it("compiles repush to a downstream graph with blocked target and provided outputs", () => {
    const source = node("source", "script");
    source.materialized = {
      inputs: {},
      outputs: { stdout: "mat-stdout", stderr: "mat-stderr" },
      lastExitCode: 1,
    };
    const sink = node("sink", "script");
    const request = compileExecutionRequest(
      workspace(
        [source, sink],
        [
          {
            id: "e1",
            from: { nodeId: "source", port: "stdout" },
            to: { nodeId: "sink", port: "stdin" },
            buffering: "line_or_1024",
          },
        ],
      ),
      "source",
      "repush",
    );

    expect(request.seedNodeIds).toEqual(["source"]);
    expect(request.blockedNodeIds).toEqual(["source"]);
    expect(request.providedMatoutIds).toEqual(["mat-stdout"]);
    expect(request.workspace.nodes.map((item) => item.id)).toEqual(["source", "sink"]);
    expect(request.workspace.edges.map((item) => item.id)).toEqual(["e1"]);
    expect(request.workspace.nodes[0].materialized?.outputs).toEqual({ stdout: "mat-stdout" });
  });

  it("prunes rerun_push downstream nodes that are missing sibling inputs", () => {
    const a = node("a", "text");
    const b = node("b", "text");
    const c = node("c", "script");
    const request = compileExecutionRequest(
      workspace(
        [a, b, c],
        [
          {
            id: "e1",
            from: { nodeId: "a", port: "stdout" },
            to: { nodeId: "c", port: "argv", slot: 1 },
            buffering: "line_or_1024",
          },
          {
            id: "e2",
            from: { nodeId: "b", port: "stdout" },
            to: { nodeId: "c", port: "argv", slot: 2 },
            buffering: "line_or_1024",
          },
        ],
      ),
      "b",
      "rerun_push",
    );

    expect(request.workspace.nodes.map((item) => item.id)).toEqual(["b"]);
    expect(request.workspace.edges).toEqual([]);
    expect(request.providedMatoutIds).toEqual([]);
  });

  it("keeps rerun_push downstream nodes when cached sibling inputs are available", () => {
    const a = node("a", "text");
    const b = node("b", "text");
    const c = node("c", "script");
    c.materialized = {
      inputs: { "argv-1": "mat-a" },
      outputs: {},
      lastExitCode: null,
    };
    const request = compileExecutionRequest(
      workspace(
        [a, b, c],
        [
          {
            id: "e1",
            from: { nodeId: "a", port: "stdout" },
            to: { nodeId: "c", port: "argv", slot: 1 },
            buffering: "line_or_1024",
          },
          {
            id: "e2",
            from: { nodeId: "b", port: "stdout" },
            to: { nodeId: "c", port: "argv", slot: 2 },
            buffering: "line_or_1024",
          },
        ],
      ),
      "b",
      "rerun_push",
    );

    expect(request.workspace.nodes.map((item) => item.id)).toEqual(["b", "c"]);
    expect(request.workspace.edges.map((item) => item.id)).toEqual(["e2"]);
    expect(request.providedMatoutIds).toEqual(["mat-a"]);
    expect(request.workspace.nodes.find((item) => item.id === "c")?.materialized?.inputs).toEqual({
      "argv-1": "mat-a",
    });
  });
});
