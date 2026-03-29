import { describe, expect, it } from "vitest";

import {
  buildExecutionRequestFromPlan,
  emptyExecutionPlan,
  executionPlanForSelection,
  executionPlanFromRequest,
  executionPlanMatvalsForNode,
  mergeExecutionPlans,
  participatingNodeIdsForPlan,
} from "./executionPlan";
import type { ExecutionRequest, Workspace, WorkspaceNode } from "./types";

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

describe("executionPlan", () => {
  it("starts empty", () => {
    expect(emptyExecutionPlan()).toEqual({
      executableNodeIds: [],
      edgeIds: [],
      providedMatoutIds: [],
    });
  });

  it("derives a plan snapshot from an execution request", () => {
    const request: ExecutionRequest = {
      workspace: workspace(
        [node("a", "text"), node("b", "script"), node("c", "display")],
        [
          {
            id: "e1",
            from: { nodeId: "a", port: "stdout" },
            to: { nodeId: "b", port: "stdin" },
            buffering: "line_or_1024",
          },
        ],
      ),
      executableNodeIds: ["b"],
      edgeIds: ["e1"],
      providedMatoutIds: ["out-1"],
    };

    expect(executionPlanFromRequest(request)).toEqual({
      executableNodeIds: ["b"],
      edgeIds: ["e1"],
      providedMatoutIds: ["out-1"],
    });
  });

  it("creates a selection plan from node and edge ids", () => {
    expect(executionPlanForSelection(["b", "a", "a"], ["e2", "e1", "e2"])).toEqual({
      executableNodeIds: ["a", "b"],
      edgeIds: ["e1", "e2"],
      providedMatoutIds: [],
    });
  });

  it("shift-add unions computed plans when the current plan is not a superset", () => {
    expect(
      mergeExecutionPlans(
        {
          executableNodeIds: ["a"],
          edgeIds: ["e1"],
          providedMatoutIds: ["mat-a"],
        },
        {
          executableNodeIds: ["b"],
          edgeIds: ["e2"],
          providedMatoutIds: ["mat-b"],
        },
        true,
      ),
    ).toEqual({
      executableNodeIds: ["a", "b"],
      edgeIds: ["e1", "e2"],
      providedMatoutIds: ["mat-a", "mat-b"],
    });
  });

  it("shift-click subtracts a computed plan when the current plan is a superset", () => {
    expect(
      mergeExecutionPlans(
        {
          executableNodeIds: ["a", "b"],
          edgeIds: ["e1", "e2"],
          providedMatoutIds: ["mat-a", "mat-b"],
        },
        {
          executableNodeIds: ["b"],
          edgeIds: ["e2"],
          providedMatoutIds: ["mat-b"],
        },
        true,
      ),
    ).toEqual({
      executableNodeIds: ["a"],
      edgeIds: ["e1"],
      providedMatoutIds: ["mat-a"],
    });
  });

  it("derives participating nodes from executable nodes and included wires", () => {
    const plan = {
      executableNodeIds: ["b"],
      edgeIds: ["e1"],
      providedMatoutIds: [],
    };
    const ids = participatingNodeIdsForPlan(
      plan,
      [
        {
          id: "e1",
          from: { nodeId: "a", port: "stdout" },
          to: { nodeId: "b", port: "stdin" },
          buffering: "line_or_1024",
        },
      ],
    );
    expect(ids).toEqual(["a", "b"]);
  });

  it("builds a pruned request from the current plan", () => {
    const a = node("a", "text");
    a.materialized = {
      inputs: {},
      outputs: { stdout: "a-out" },
      lastExitCode: 0,
    };
    const b = node("b", "script");
    b.materialized = {
      inputs: { stdin: "a-out" },
      outputs: { stdout: "b-out" },
      lastExitCode: 0,
    };
    const c = node("c", "display");

    const request = buildExecutionRequestFromPlan(
      workspace(
        [a, b, c],
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
      ),
      {
        executableNodeIds: ["c"],
        edgeIds: ["e2", "missing"],
        providedMatoutIds: ["a-out", "b-out", "dangling"],
      },
    );

    expect(request.workspace.nodes.map((item) => item.id)).toEqual(["b", "c"]);
    expect(request.workspace.edges.map((item) => item.id)).toEqual(["e2"]);
    expect(request.executableNodeIds).toEqual(["c"]);
    expect(request.edgeIds).toEqual(["e2"]);
    expect(request.providedMatoutIds).toEqual(["a-out", "b-out"]);
  });

  it("reports node matvals and whether they are included", () => {
    const current = node("current", "script");
    current.materialized = {
      inputs: { stdin: "stdin-id" },
      outputs: { stdout: "stdout-id" },
      lastExitCode: 0,
    };

    expect(
      executionPlanMatvalsForNode(current, {
        executableNodeIds: ["current"],
        edgeIds: [],
        providedMatoutIds: ["stdout-id"],
      }),
    ).toEqual([
      { id: "stdin-id", key: "stdin", source: "input", included: false },
      { id: "stdout-id", key: "stdout", source: "output", included: true },
    ]);
  });
});
