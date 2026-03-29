import type {
  ExecutionPlanNodeMatval,
  ExecutionPlanState,
  ExecutionRequest,
  MatOutId,
  Workspace,
  WorkspaceEdge,
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
    executableNodeIds: [],
    edgeIds: [],
    providedMatoutIds: [],
  };
}

export function executionPlanForSelection(
  executableNodeIds: Iterable<string>,
  edgeIds: Iterable<string> = [],
): ExecutionPlanState {
  return {
    executableNodeIds: sortedUnique(executableNodeIds),
    edgeIds: sortedUnique(edgeIds),
    providedMatoutIds: [],
  };
}

export function executionPlanFromRequest(request: ExecutionRequest): ExecutionPlanState {
  return {
    executableNodeIds: [...request.executableNodeIds].sort(),
    edgeIds: [...request.edgeIds].sort(),
    providedMatoutIds: [...request.providedMatoutIds].sort(),
  };
}

function valuesAreSuperset(current: string[], candidate: string[]) {
  const currentIds = new Set(current);
  return candidate.every((id) => currentIds.has(id));
}

function planIsSuperset(current: ExecutionPlanState, candidate: ExecutionPlanState) {
  return (
    valuesAreSuperset(current.executableNodeIds, candidate.executableNodeIds)
    && valuesAreSuperset(current.edgeIds, candidate.edgeIds)
    && valuesAreSuperset(current.providedMatoutIds, candidate.providedMatoutIds)
  );
}

export function mergeExecutionPlans(
  current: ExecutionPlanState,
  computed: ExecutionPlanState,
  additive: boolean,
): ExecutionPlanState {
  if (!additive) {
    return {
      executableNodeIds: [...computed.executableNodeIds].sort(),
      edgeIds: [...computed.edgeIds].sort(),
      providedMatoutIds: [...computed.providedMatoutIds].sort(),
    };
  }

  const subtract = planIsSuperset(current, computed);
  const combine = (left: string[], right: string[]) =>
    subtract
      ? left.filter((value) => !new Set(right).has(value))
      : sortedUnique([...left, ...right]);

  return {
    executableNodeIds: combine(current.executableNodeIds, computed.executableNodeIds),
    edgeIds: combine(current.edgeIds, computed.edgeIds),
    providedMatoutIds: combine(current.providedMatoutIds, computed.providedMatoutIds),
  };
}

export function trimExecutionPlan(
  plan: ExecutionPlanState,
  workspace: Workspace,
  availableMatoutIds: Iterable<MatOutId>,
): ExecutionPlanState {
  const nodeIds = new Set(workspace.nodes.map((node) => node.id));
  const edgeIds = new Set(
    workspace.edges
      .filter((edge) => nodeIds.has(edge.from.nodeId) && nodeIds.has(edge.to.nodeId))
      .map((edge) => edge.id),
  );
  const matoutIds = new Set(availableMatoutIds);
  return {
    executableNodeIds: plan.executableNodeIds.filter((id) => nodeIds.has(id)),
    edgeIds: plan.edgeIds.filter((id) => edgeIds.has(id)),
    providedMatoutIds: plan.providedMatoutIds.filter((id) => matoutIds.has(id)),
  };
}

export function participatingNodeIdsForPlan(
  plan: ExecutionPlanState,
  edges: WorkspaceEdge[],
): string[] {
  const ids = new Set(plan.executableNodeIds);
  const includedEdges = new Set(plan.edgeIds);
  for (const edge of edges) {
    if (!includedEdges.has(edge.id)) {
      continue;
    }
    ids.add(edge.from.nodeId);
    ids.add(edge.to.nodeId);
  }
  return Array.from(ids).sort();
}

export function buildExecutionRequestFromPlan(
  workspace: Workspace,
  plan: ExecutionPlanState,
): ExecutionRequest {
  const selectedEdgeIds = new Set(plan.edgeIds);
  const scopedEdgeIds = workspace.edges
    .filter((edge) => selectedEdgeIds.has(edge.id))
    .map((edge) => edge.id);
  const scopedNodeIds = new Set(plan.executableNodeIds);
  for (const edge of workspace.edges) {
    if (!selectedEdgeIds.has(edge.id)) {
      continue;
    }
    scopedNodeIds.add(edge.from.nodeId);
    scopedNodeIds.add(edge.to.nodeId);
  }
  // The UI may keep extra matout state around while the user edits a plan.
  // Kernel requests must be pruned back down to the nodes and wires currently in scope.
  const scopedWorkspace: Workspace = {
    ...workspace,
    nodes: workspace.nodes
      .filter((node) => scopedNodeIds.has(node.id))
      .map(cloneNodeForExecutionPlan),
    edges: workspace.edges.filter(
      (edge) => selectedEdgeIds.has(edge.id) && scopedNodeIds.has(edge.from.nodeId) && scopedNodeIds.has(edge.to.nodeId),
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
    executableNodeIds: plan.executableNodeIds.filter((id) => scopedNodeIds.has(id)).sort(),
    edgeIds: scopedEdgeIds.sort(),
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
