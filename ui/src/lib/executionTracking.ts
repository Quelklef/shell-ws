export interface TrackedExecution {
  clientRequestId: string;
  execId?: string;
  originNodeId?: string;
  nodeIds: string[];
  startedNodeIds: string[];
  succeededNodeIds: string[];
  failedNodeIds: string[];
  outcome?: "completed" | "stopped" | "failed";
}

export function createTrackedExecution(clientRequestId: string, nodeIds: string[], originNodeId?: string): TrackedExecution {
  return {
    clientRequestId,
    execId: undefined,
    originNodeId,
    nodeIds: [...nodeIds].sort(),
    startedNodeIds: [],
    succeededNodeIds: [],
    failedNodeIds: [],
    outcome: undefined,
  };
}

export function upsertExecutionStarted(
  executions: readonly TrackedExecution[],
  {
    clientRequestId,
    execId,
    nodeId,
  }: {
    clientRequestId?: string;
    execId: string;
    nodeId: string;
  },
) {
  let matched = false;
  const nextExecutions = executions.map((execution) => {
    const matches = execution.execId === execId || (clientRequestId != null && execution.clientRequestId === clientRequestId);
    if (!matches) {
      return execution;
    }
    matched = true;
    return {
      ...execution,
      execId,
      outcome: undefined,
      startedNodeIds: execution.startedNodeIds.includes(nodeId)
        ? execution.startedNodeIds
        : [...execution.startedNodeIds, nodeId].sort(),
    };
  });
  if (matched) {
    return nextExecutions;
  }
  return [
    ...nextExecutions,
    {
      clientRequestId: clientRequestId ?? execId,
      execId,
      originNodeId: nodeId,
      nodeIds: [nodeId],
      startedNodeIds: [nodeId],
      succeededNodeIds: [],
      failedNodeIds: [],
      outcome: undefined,
    },
  ];
}

export function upsertExecutionFinished(
  executions: readonly TrackedExecution[],
  execId: string,
  nodeId: string,
  success: boolean,
) {
  return executions.map((execution) => {
    if (execution.execId !== execId) {
      return execution;
    }
    return {
      ...execution,
      outcome: execution.outcome,
      startedNodeIds: execution.startedNodeIds.includes(nodeId)
        ? execution.startedNodeIds
        : [...execution.startedNodeIds, nodeId].sort(),
      succeededNodeIds: success
        ? (execution.succeededNodeIds.includes(nodeId) ? execution.succeededNodeIds : [...execution.succeededNodeIds, nodeId].sort())
        : execution.succeededNodeIds,
      failedNodeIds: success
        ? execution.failedNodeIds
        : (execution.failedNodeIds.includes(nodeId) ? execution.failedNodeIds : [...execution.failedNodeIds, nodeId].sort()),
    };
  });
}

export function finishTrackedExecution(
  executions: readonly TrackedExecution[],
  execId: string,
  outcome: "completed" | "stopped" | "failed",
) {
  let finished: TrackedExecution | undefined;
  const next = executions.map((execution) => {
    if (execution.execId !== execId) {
      return execution;
    }
    finished = {
      ...execution,
      outcome,
    };
    return finished;
  });
  return { next, finished };
}

export function removeTrackedExecution(
  executions: readonly TrackedExecution[],
  execKey: string,
) {
  let removed: TrackedExecution | undefined;
  const remaining = executions.filter((execution) => {
    if ((execution.execId ?? execution.clientRequestId) !== execKey) {
      return true;
    }
    removed = execution;
    return false;
  });
  return { remaining, removed };
}

export function removePendingTrackedExecution(executions: readonly TrackedExecution[], clientRequestId: string) {
  let removed: TrackedExecution | undefined;
  const remaining = executions.filter((execution) => {
    if (execution.clientRequestId !== clientRequestId) {
      return true;
    }
    removed = execution;
    return false;
  });
  return { remaining, removed };
}

export function removeTerminalTrackedExecutions(executions: readonly TrackedExecution[]) {
  const removed: TrackedExecution[] = [];
  const remaining = executions.filter((execution) => {
    if (!execution.outcome) {
      return true;
    }
    removed.push(execution);
    return false;
  });
  return { remaining, removed };
}

export function summarizeTrackedExecution(execution: TrackedExecution) {
  const succeeded = new Set(execution.succeededNodeIds);
  const failed = new Set(execution.failedNodeIds);
  let runningCount = 0;
  let waitingCount = 0;
  for (const nodeId of execution.nodeIds) {
    if (succeeded.has(nodeId) || failed.has(nodeId)) {
      continue;
    }
    if (execution.startedNodeIds.includes(nodeId)) {
      runningCount += 1;
    } else {
      waitingCount += 1;
    }
  }
  return {
    targetCount: execution.nodeIds.length,
    runningCount,
    waitingCount,
    succeededCount: execution.succeededNodeIds.length,
    failedCount: execution.failedNodeIds.length,
  };
}
