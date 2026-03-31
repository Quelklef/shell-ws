import { describe, expect, it } from "vitest";

import { compileExecutionRequest } from "./compileExecutionRequest";
import { portRefKey } from "./portRefs";
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
      nextDrawOrder: 0,
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

function nodeIds(request: ReturnType<typeof compileExecutionRequest>) {
  return request.graph.nodes.map((item) => item.id);
}

function edgeIds(request: ReturnType<typeof compileExecutionRequest>) {
  return request.graph.edges.map((item) => item.id);
}

describe("compileExecutionRequest", () => {
  it("compiles pull_inputs to the upstream closure without making the target executable", () => {
    const a = node("a", "text");
    const b = node("b", "script");
    b.materialized = {
      inputs: { stdin: "old-b-in" },
      outputs: { stdout: "old-b-out", stderr: "old-b-err" },
      lastExitCode: 0,
    };
    const request = compileExecutionRequest(
      workspace(
        [a, b],
        [
          {
            id: "e1",
            from: { nodeId: "a", port: "stdout" },
            to: { nodeId: "b", port: "stdin" },
            buffering: "line_or_1024",
          },
        ],
      ),
      "b",
      "pull_inputs",
    );

    expect(nodeIds(request)).toEqual(["a"]);
    expect(edgeIds(request)).toEqual(["e1"]);
    expect(request.matouts).toEqual({
      [portRefKey({ nodeId: "b", port: "stdin" })]: "old-b-in",
      [portRefKey({ nodeId: "b", port: "stdout" })]: "old-b-out",
      [portRefKey({ nodeId: "b", port: "stderr" })]: "old-b-err",
    });
    expect(request.activeMatouts).toEqual([
      portRefKey({ nodeId: "b", port: "stderr" }),
      portRefKey({ nodeId: "b", port: "stdin" }),
      portRefKey({ nodeId: "b", port: "stdout" }),
    ]);
    expect(request.graph.nodes.find((item) => item.id === "a")?.materialized).toEqual({
      inputs: {},
      outputs: {},
      lastExitCode: null,
    });
  });

  it("compiles pull_run to the upstream closure with the target executable", () => {
    const a = node("a", "text");
    const b = node("b", "script");
    const request = compileExecutionRequest(
      workspace(
        [a, b],
        [
          {
            id: "e1",
            from: { nodeId: "a", port: "stdout" },
            to: { nodeId: "b", port: "stdin" },
            buffering: "line_or_1024",
          },
        ],
      ),
      "b",
      "pull_run",
    );

    expect(nodeIds(request)).toEqual(["a", "b"]);
    expect(edgeIds(request)).toEqual(["e1"]);
    expect(request.activeMatouts).toEqual([]);
    expect(request.matouts).toEqual({});
  });

  it("compiles rerun to a target-only graph with provided materialized inputs", () => {
    const source = node("source", "text");
    source.materialized = {
      inputs: {},
      outputs: { stdout: "source-out" },
      lastExitCode: 1,
    };
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

    expect(request.matouts).toEqual({
      [portRefKey({ nodeId: "target", port: "stdout" })]: "mat-out",
      [portRefKey({ nodeId: "target", port: "stdin" })]: "mat-in",
    });
    expect(request.activeMatouts).toEqual([
      portRefKey({ nodeId: "target", port: "stdin" }),
    ]);
    expect(request.graph.nodes.map((item) => item.id)).toEqual(["target"]);
    expect(request.graph.edges).toEqual([]);
    expect(request.graph.nodes[0].materialized?.inputs).toEqual({});
    expect(request.graph.nodes[0].materialized?.outputs).toEqual({});
  });

  it("compiles repush to a downstream graph with non-executable source and provided outputs", () => {
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

    expect(request.matouts).toEqual({
      [portRefKey({ nodeId: "source", port: "stdout" })]: "mat-stdout",
      [portRefKey({ nodeId: "source", port: "stderr" })]: "mat-stderr",
    });
    expect(request.activeMatouts).toEqual([
      portRefKey({ nodeId: "source", port: "stdout" }),
    ]);
    expect(request.graph.nodes.map((item) => item.id)).toEqual(["source", "sink"]);
  });

  it("prunes repush downstream nodes that are missing sibling inputs", () => {
    const source = node("source", "script");
    source.materialized = {
      inputs: {},
      outputs: { stdout: "source-out" },
      lastExitCode: 0,
    };
    const sibling = node("sibling", "text");
    const sink = node("sink", "script");
    const request = compileExecutionRequest(
      workspace(
        [source, sibling, sink],
        [
          {
            id: "e1",
            from: { nodeId: "source", port: "stdout" },
            to: { nodeId: "sink", port: "argv", slot: 1 },
            buffering: "line_or_1024",
          },
          {
            id: "e2",
            from: { nodeId: "sibling", port: "stdout" },
            to: { nodeId: "sink", port: "argv", slot: 2 },
            buffering: "line_or_1024",
          },
        ],
      ),
      "source",
      "repush",
    );

    expect(nodeIds(request)).toEqual(["source"]);
    expect(edgeIds(request)).toEqual([]);
    expect(request.matouts).toEqual({
      [portRefKey({ nodeId: "source", port: "stdout" })]: "source-out",
    });
    expect(request.activeMatouts).toEqual([
      portRefKey({ nodeId: "source", port: "stdout" }),
    ]);
  });

  it("keeps repush downstream nodes when cached sibling inputs are available", () => {
    const source = node("source", "script");
    source.materialized = {
      inputs: {},
      outputs: { stdout: "source-out" },
      lastExitCode: 0,
    };
    const sibling = node("sibling", "text");
    const sink = node("sink", "script");
    sink.materialized = {
      inputs: { "argv-2": "cached-sibling" },
      outputs: {},
      lastExitCode: null,
    };
    const request = compileExecutionRequest(
      workspace(
        [source, sibling, sink],
        [
          {
            id: "e1",
            from: { nodeId: "source", port: "stdout" },
            to: { nodeId: "sink", port: "argv", slot: 1 },
            buffering: "line_or_1024",
          },
          {
            id: "e2",
            from: { nodeId: "sibling", port: "stdout" },
            to: { nodeId: "sink", port: "argv", slot: 2 },
            buffering: "line_or_1024",
          },
        ],
      ),
      "source",
      "repush",
    );

    expect(nodeIds(request)).toEqual(["source", "sink"]);
    expect(edgeIds(request)).toEqual(["e1"]);
    expect(request.matouts).toEqual({
      [portRefKey({ nodeId: "source", port: "stdout" })]: "source-out",
      [portRefKey({ nodeId: "sink", port: "argv", slot: 2 })]: "cached-sibling",
    });
    expect(request.activeMatouts).toEqual([
      portRefKey({ nodeId: "sink", port: "argv", slot: 2 }),
      portRefKey({ nodeId: "source", port: "stdout" }),
    ]);
  });

  it("prunes rerun_push downstream nodes that are missing sibling inputs", () => {
    const a = node("a", "text");
    const b = node("b", "text");
    b.materialized = {
      inputs: {},
      outputs: { stdout: "mat-b" },
      lastExitCode: 0,
    };
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

    expect(nodeIds(request)).toEqual(["b"]);
    expect(edgeIds(request)).toEqual([]);
    expect(request.matouts).toEqual({
      [portRefKey({ nodeId: "b", port: "stdout" })]: "mat-b",
    });
    expect(request.activeMatouts).toEqual([]);
  });

  it("keeps rerun_push downstream nodes when cached sibling inputs are available", () => {
    const a = node("a", "text");
    const b = node("b", "text");
    b.materialized = {
      inputs: {},
      outputs: { stdout: "mat-b" },
      lastExitCode: 0,
    };
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

    expect(nodeIds(request)).toEqual(["b", "c"]);
    expect(edgeIds(request)).toEqual(["e2"]);
    expect(request.matouts).toEqual({
      [portRefKey({ nodeId: "b", port: "stdout" })]: "mat-b",
      [portRefKey({ nodeId: "c", port: "argv", slot: 1 })]: "mat-a",
    });
    expect(request.activeMatouts).toEqual([
      portRefKey({ nodeId: "c", port: "argv", slot: 1 }),
    ]);
  });
});
