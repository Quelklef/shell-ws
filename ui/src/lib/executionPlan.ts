import type {
  ExecutionPlanNodeMatval,
  ExecutionPlanState,
  ExecutionRequest,
  MatOutId,
  Workspace,
  WorkspaceNode,
} from "./types";

function sortedUnique(values: Iterable<string>) {
  return Array.from(new Set(values)).sort();
}

function cloneNodeForExecutionPlan(node: WorkspaceNode): WorkspaceNode {
  return {
    ...node,
    materialized: node.materialized
      ? {
          inputs: { ...(node.materialized.inputs ?? {}) },
          outputs: { ...(node.materialized.outputs ?? {}) },
          lastExitCode: node.materialized.lastExitCode ?? null,
        }
      : node.materialized,
  };
}

export function emptyExecutionPlan(): ExecutionPlanState {
  return {
    targetNodeIds: [],
    providedMatoutIds: [],
    blockedNodeIds: [],
  };
}

export function executionPlanForTargetNodeIds(nodeIds: Iterable<string>): ExecutionPlanState {
  return {
    targetNodeIds: sortedUnique(nodeIds),
    providedMatoutIds: [],
    blockedNodeIds: [],
  };
}

export function executionPlanFromRequest(request: ExecutionRequest): ExecutionPlanState {
  return {
    targetNodeIds: request.workspace.nodes.map((node) => node.id).sort(),
    providedMatoutIds: [...request.providedMatoutIds].sort(),
    blockedNodeIds: [...request.blockedNodeIds].sort(),
  };
}

function nodeIdsAreSuperset(current: string[], candidate: string[]) {
  const currentIds = new Set(current);
  return candidate.every((id) => currentIds.has(id));
}

export function mergeExecutionPlans(
  current: ExecutionPlanState,
  computed: ExecutionPlanState,
  additive: boolean,
): ExecutionPlanState {
  if (!additive) {
    return {
      targetNodeIds: [...computed.targetNodeIds].sort(),
      providedMatoutIds: [...computed.providedMatoutIds].sort(),
      blockedNodeIds: [...computed.blockedNodeIds].sort(),
    };
  }

  const subtract = nodeIdsAreSuperset(current.targetNodeIds, computed.targetNodeIds);
  const combine = (left: string[], right: string[]) =>
    subtract
      ? left.filter((value) => !new Set(right).has(value))
      : sortedUnique([...left, ...right]);

  return {
    targetNodeIds: combine(current.targetNodeIds, computed.targetNodeIds),
    providedMatoutIds: combine(current.providedMatoutIds, computed.providedMatoutIds),
    blockedNodeIds: combine(current.blockedNodeIds, computed.blockedNodeIds),
  };
}

export function trimExecutionPlan(
  plan: ExecutionPlanState,
  workspace: Workspace,
  availableMatoutIds: Iterable<MatOutId>,
): ExecutionPlanState {
  const nodeIds = new Set(workspace.nodes.map((node) => node.id));
  const matoutIds = new Set(availableMatoutIds);
  return {
    targetNodeIds: plan.targetNodeIds.filter((id) => nodeIds.has(id)),
    providedMatoutIds: plan.providedMatoutIds.filter((id) => matoutIds.has(id)),
    blockedNodeIds: plan.blockedNodeIds.filter((id) => nodeIds.has(id)),
  };
}

export function buildExecutionRequestFromPlan(
  workspace: Workspace,
  plan: ExecutionPlanState,
): ExecutionRequest {
  const targetNodeIds = new Set(plan.targetNodeIds);
  // The UI may keep extra seed/blocked/matout state around while the user edits a plan.
  // Kernel requests must be pruned back down to the targeted subgraph before execution.
  const scopedWorkspace: Workspace = {
    ...workspace,
    nodes: workspace.nodes
      .filter((node) => targetNodeIds.has(node.id))
      .map(cloneNodeForExecutionPlan),
    edges: workspace.edges.filter(
      (edge) => targetNodeIds.has(edge.from.nodeId) && targetNodeIds.has(edge.to.nodeId),
    ),
    tuckspace: [],
  };
  const referencedIds = new Set<MatOutId>();
  for (const node of scopedWorkspace.nodes) {
    for (const id of Object.values(node.materialized?.inputs ?? {})) {
      referencedIds.add(id);
    }
    for (const id of Object.values(node.materialized?.outputs ?? {})) {
      referencedIds.add(id);
    }
  }
  return {
    workspace: scopedWorkspace,
    blockedNodeIds: plan.blockedNodeIds.filter((id) => targetNodeIds.has(id)).sort(),
    providedMatoutIds: plan.providedMatoutIds.filter((id) => referencedIds.has(id)).sort(),
  };
}

export function executionPlanMatvalsForNode(
  node: WorkspaceNode,
  plan: ExecutionPlanState,
): ExecutionPlanNodeMatval[] {
  const included = new Set(plan.providedMatoutIds);
  const matvals: ExecutionPlanNodeMatval[] = [];
  for (const [key, id] of Object.entries(node.materialized?.inputs ?? {})) {
    matvals.push({ id, key, source: "input", included: included.has(id) });
  }
  for (const [key, id] of Object.entries(node.materialized?.outputs ?? {})) {
    if (!id) {
      continue;
    }
    matvals.push({ id, key, source: "output", included: included.has(id) });
  }
  return matvals.sort((left, right) => {
    if (left.source !== right.source) {
      return left.source.localeCompare(right.source);
    }
    return left.key.localeCompare(right.key);
  });
}
