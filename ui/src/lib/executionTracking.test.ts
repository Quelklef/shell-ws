import { describe, expect, it } from "vitest";

import {
  createTrackedExecution,
  finishTrackedExecution,
  removePendingTrackedExecution,
  removeTrackedExecution,
  removeTerminalTrackedExecutions,
  summarizeTrackedExecution,
  upsertExecutionFinished,
  upsertExecutionStarted,
} from "./executionTracking";

describe("executionTracking", () => {
  it("tracks waiting, running, and finished counts by exec", () => {
    let executions = [createTrackedExecution("req-1", ["a", "b", "c"], "a")];
    executions = upsertExecutionStarted(executions, { clientRequestId: "req-1", execId: "exec-1", nodeId: "a" });
    executions = upsertExecutionStarted(executions, { execId: "exec-1", nodeId: "b" });
    executions = upsertExecutionFinished(executions, "exec-1", "a", true);
    executions = upsertExecutionFinished(executions, "exec-1", "b", false);

    expect(summarizeTrackedExecution(executions[0]!)).toEqual({
      targetCount: 3,
      runningCount: 0,
      waitingCount: 1,
      succeededCount: 1,
      failedCount: 1,
    });
  });

  it("removes pending requests by client request id", () => {
    const { remaining, removed } = removePendingTrackedExecution([
      createTrackedExecution("req-1", ["a"]),
      createTrackedExecution("req-2", ["b"]),
    ], "req-1");

    expect(removed?.clientRequestId).toBe("req-1");
    expect(remaining.map((execution) => execution.clientRequestId)).toEqual(["req-2"]);
  });

  it("removes running executions by exec id", () => {
    const { remaining, removed } = removeTrackedExecution([
      { ...createTrackedExecution("req-1", ["a"]), execId: "exec-1" },
      { ...createTrackedExecution("req-2", ["b"]), execId: "exec-2" },
    ], "exec-2");

    expect(removed?.clientRequestId).toBe("req-2");
    expect(remaining.map((execution) => execution.execId)).toEqual(["exec-1"]);
  });

  it("marks executions terminal without removing them", () => {
    const { next, finished } = finishTrackedExecution([
      { ...createTrackedExecution("req-1", ["a"]), execId: "exec-1" },
    ], "exec-1", "completed");

    expect(finished?.outcome).toBe("completed");
    expect(next[0]?.outcome).toBe("completed");
  });

  it("removes only terminal executions on new starts", () => {
    const { remaining, removed } = removeTerminalTrackedExecutions([
      { ...createTrackedExecution("req-1", ["a"]), execId: "exec-1", outcome: "completed" },
      { ...createTrackedExecution("req-2", ["b"]), execId: "exec-2" },
      { ...createTrackedExecution("req-3", ["c"]), execId: "exec-3", outcome: "failed" },
    ]);

    expect(remaining.map((execution) => execution.execId)).toEqual(["exec-2"]);
    expect(removed.map((execution) => execution.execId)).toEqual(["exec-1", "exec-3"]);
  });
});
