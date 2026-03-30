import type {
  ExecutionPlanNodeMatval,
  ExecutionPlanState,
  ExecutionRequest,
  MatOutId,
  PortRef,
  Workspace,
  WorkspaceEdge,
  WorkspaceNode,
} from "./types";
import { nodeHasArgvPort, nodeHasInputPort } from "./nodePorts";
import { outputPortsForKind } from "./portSchema";
import { inputPortRefForKey, outputPortRefForKey, portRefKey } from "./portRefs";

function sortedUnique(values: Iterable<string>) {
  return Array.from(new Set(values)).sort();
}

function cloneNodeForExecutionPlan(node: WorkspaceNode): WorkspaceNode {
  return {
    ...node,
    materialized: {
      inputs: {},
      outputs: {},
      lastExitCode: null,
    },
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
    executableNodeIds: request.graph.nodes.map((node) => node.id).sort(),
    edgeIds: request.graph.edges.map((edge) => edge.id).sort(),
    providedMatoutIds: sortedUnique(
      request.activeMatouts
        .map((key) => request.matouts[key])
        .filter((value): value is MatOutId => Boolean(value)),
    ),
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
  const scopedNodeIds = new Set(plan.executableNodeIds);
  const participatingPortKeys = new Set<string>();
  for (const edge of workspace.edges) {
    if (!selectedEdgeIds.has(edge.id)) {
      continue;
    }
    participatingPortKeys.add(portRefKey(edge.from));
    participatingPortKeys.add(portRefKey(edge.to));
  }
  // The UI may keep extra matout state around while the user edits a plan.
  // Kernel requests must be pruned back down to the nodes, wires, and materialized
  // ports currently in scope.
  const scopedWorkspace: Workspace = {
    ...workspace,
    nodes: workspace.nodes
      .filter((node) => scopedNodeIds.has(node.id))
      .map(cloneNodeForExecutionPlan),
    edges: workspace.edges.filter((edge) => selectedEdgeIds.has(edge.id)),
    tuckspace: [],
  };
  for (const node of workspace.nodes) {
    if (!scopedNodeIds.has(node.id)) {
      continue;
    }
    participatingPortKeys.add(portRefKey({ nodeId: node.id, port: "stdin" }));
    participatingPortKeys.add(portRefKey({ nodeId: node.id, port: "stdout" }));
    participatingPortKeys.add(portRefKey({ nodeId: node.id, port: "stderr" }));
    for (const key of Object.keys(node.materialized?.inputs ?? {})) {
      const ref = inputPortRefForKey(node.id, key);
      if (ref) {
        participatingPortKeys.add(portRefKey(ref));
      }
    }
  }
  const includedIds = new Set(plan.providedMatoutIds);
  const matouts: Record<string, MatOutId> = {};
  const activeMatouts = new Set<string>();
  const addPortMatout = (ref: PortRef | null, id: MatOutId | undefined) => {
    if (!ref || !id) {
      return;
    }
    const key = portRefKey(ref);
    if (!participatingPortKeys.has(key) && !scopedNodeIds.has(ref.nodeId)) {
      return;
    }
    matouts[key] = id;
    if (includedIds.has(id) && participatingPortKeys.has(key)) {
      activeMatouts.add(key);
    }
  };
  for (const node of workspace.nodes) {
    for (const [key, id] of Object.entries(node.materialized?.inputs ?? {})) {
      addPortMatout(inputPortRefForKey(node.id, key), id);
    }
    for (const [key, id] of Object.entries(node.materialized?.outputs ?? {})) {
      addPortMatout(outputPortRefForKey(node.id, key), id);
    }
  }
  return {
    graph: scopedWorkspace,
    matouts,
    activeMatouts: Array.from(activeMatouts).sort(),
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

function localPortKey(ref: PortRef) {
  if (ref.port === "argv") {
    return `argv-${ref.slot ?? 1}`;
  }
  return ref.port;
}

export function executionPlanPortKeysForNode(
  node: WorkspaceNode,
  argvSlots: number[] | undefined,
  plan: ExecutionPlanState,
  edges: WorkspaceEdge[],
  matvals: ExecutionPlanNodeMatval[] = executionPlanMatvalsForNode(node, plan),
): string[] {
  const portKeys = new Set<string>();
  if (plan.executableNodeIds.includes(node.id)) {
    if (nodeHasInputPort(node.kind)) {
      portKeys.add("stdin");
    }
    if (nodeHasArgvPort(node.kind)) {
      for (const slot of argvSlots?.length ? argvSlots : [1]) {
        portKeys.add(`argv-${slot}`);
      }
    }
    for (const port of outputPortsForKind(node.kind)) {
      portKeys.add(port);
    }
  }
  const includedEdgeIds = new Set(plan.edgeIds);
  for (const edge of edges) {
    if (!includedEdgeIds.has(edge.id)) {
      continue;
    }
    if (edge.from.nodeId === node.id) {
      portKeys.add(localPortKey(edge.from));
    }
    if (edge.to.nodeId === node.id) {
      portKeys.add(localPortKey(edge.to));
    }
  }
  for (const entry of matvals) {
    if (entry.included) {
      portKeys.add(entry.key);
    }
  }
  return Array.from(portKeys).sort();
}
