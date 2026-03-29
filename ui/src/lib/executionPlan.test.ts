import { describe, expect, it } from "vitest";

import {
  buildExecutionRequestFromPlan,
  emptyExecutionPlan,
  executionPlanForTargetNodeIds,
  executionPlanFromRequest,
  executionPlanMatvalsForNode,
  mergeExecutionPlans,
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
      targetNodeIds: [],
      providedMatoutIds: [],
      seedNodeIds: [],
      blockedNodeIds: [],
    });
  });

  it("derives a plan snapshot from an execution request", () => {
    const request: ExecutionRequest = {
      workspace: workspace([node("a", "text"), node("b", "script")], []),
      seedNodeIds: ["a"],
      providedMatoutIds: ["out-1"],
      blockedNodeIds: ["b"],
    };

    expect(executionPlanFromRequest(request)).toEqual({
      targetNodeIds: ["a", "b"],
      seedNodeIds: ["a"],
      providedMatoutIds: ["out-1"],
      blockedNodeIds: ["b"],
    });
  });

  it("creates a target-only execution plan from node ids", () => {
    expect(executionPlanForTargetNodeIds(["b", "a", "a"])).toEqual({
      targetNodeIds: ["a", "b"],
      providedMatoutIds: [],
      seedNodeIds: [],
      blockedNodeIds: [],
    });
  });

  it("shift-add unions computed plans when the current target is not a superset", () => {
    expect(
      mergeExecutionPlans(
        {
          targetNodeIds: ["a"],
          providedMatoutIds: ["mat-a"],
          seedNodeIds: ["a"],
          blockedNodeIds: [],
        },
        {
          targetNodeIds: ["b"],
          providedMatoutIds: ["mat-b"],
          seedNodeIds: [],
          blockedNodeIds: ["b"],
        },
        true,
      ),
    ).toEqual({
      targetNodeIds: ["a", "b"],
      providedMatoutIds: ["mat-a", "mat-b"],
      seedNodeIds: ["a"],
      blockedNodeIds: ["b"],
    });
  });

  it("shift-click subtracts a computed plan when the current target is a superset", () => {
    expect(
      mergeExecutionPlans(
        {
          targetNodeIds: ["a", "b"],
          providedMatoutIds: ["mat-a", "mat-b"],
          seedNodeIds: ["a", "b"],
          blockedNodeIds: ["b"],
        },
        {
          targetNodeIds: ["b"],
          providedMatoutIds: ["mat-b"],
          seedNodeIds: ["b"],
          blockedNodeIds: ["b"],
        },
        true,
      ),
    ).toEqual({
      targetNodeIds: ["a"],
      providedMatoutIds: ["mat-a"],
      seedNodeIds: ["a"],
      blockedNodeIds: [],
    });
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
        targetNodeIds: ["b", "c"],
        providedMatoutIds: ["a-out", "b-out", "dangling"],
        seedNodeIds: ["b", "z"],
        blockedNodeIds: ["a", "c"],
      },
    );

    expect(request.workspace.nodes.map((item) => item.id)).toEqual(["b", "c"]);
    expect(request.workspace.edges.map((item) => item.id)).toEqual(["e2"]);
    expect(request.providedMatoutIds).toEqual(["a-out", "b-out"]);
    expect(request.seedNodeIds).toEqual(["b"]);
    expect(request.blockedNodeIds).toEqual(["c"]);
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
        targetNodeIds: ["current"],
        providedMatoutIds: ["stdout-id"],
        seedNodeIds: [],
        blockedNodeIds: [],
      }),
    ).toEqual([
      { id: "stdin-id", key: "stdin", source: "input", included: false },
      { id: "stdout-id", key: "stdout", source: "output", included: true },
    ]);
  });
});
