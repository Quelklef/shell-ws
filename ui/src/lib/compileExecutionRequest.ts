import type {
  ExecutionAction,
  ExecutionRequest,
  MatOutId,
  MaterializedOutputPort,
  Workspace,
  WorkspaceEdge,
  WorkspaceNode,
} from "./types";
import { outputPortsForKind } from "./portSchema";

function incomingEdges(edges: WorkspaceEdge[], nodeId: string) {
  return edges.filter((edge) => edge.to.nodeId === nodeId);
}

function outgoingEdges(edges: WorkspaceEdge[], nodeId: string) {
  return edges.filter((edge) => edge.from.nodeId === nodeId);
}

function upstreamClosure(edges: WorkspaceEdge[], startNodeId: string) {
  const visited = new Set<string>();
  const queue = [startNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    for (const edge of incomingEdges(edges, nodeId)) {
      queue.push(edge.from.nodeId);
    }
  }
  return visited;
}

function downstreamClosure(edges: WorkspaceEdge[], startNodeId: string) {
  const visited = new Set<string>();
  const queue = [startNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    for (const edge of outgoingEdges(edges, nodeId)) {
      queue.push(edge.to.nodeId);
    }
  }
  return visited;
}

function rootNodeIds(scopeNodeIds: Set<string>, edges: WorkspaceEdge[]) {
  return Array.from(scopeNodeIds)
    .filter((nodeId) =>
      !edges.some((edge) => edge.to.nodeId === nodeId && scopeNodeIds.has(edge.from.nodeId)),
    )
    .sort();
}

function connectedInputKeys(edges: WorkspaceEdge[], nodeId: string) {
  const keys = new Set<string>();
  for (const edge of incomingEdges(edges, nodeId)) {
    if (edge.to.port === "stdin") {
      keys.add("stdin");
    }
    if (edge.to.port === "argv") {
      keys.add(`argv-${edge.to.slot ?? 1}`);
    }
  }
  return keys;
}

function connectedOutputPorts(edges: WorkspaceEdge[], nodeId: string) {
  const ports = new Set<MaterializedOutputPort>();
  for (const edge of outgoingEdges(edges, nodeId)) {
    if (edge.from.port === "stdout" || edge.from.port === "stderr") {
      ports.add(edge.from.port);
    }
  }
  return ports;
}

function prepareNodeMaterialized(
  node: WorkspaceNode,
  allowedInputKeys: Set<string> | null,
  allowedOutputPorts: Set<MaterializedOutputPort> | null,
): WorkspaceNode {
  const inputs =
    allowedInputKeys === null
      ? { ...(node.materialized?.inputs ?? {}) }
      : Object.fromEntries(
          Object.entries(node.materialized?.inputs ?? {}).filter(([key]) => allowedInputKeys.has(key)),
        );
  const outputs =
    allowedOutputPorts === null
      ? { ...(node.materialized?.outputs ?? {}) }
      : Object.fromEntries(
          Object.entries(node.materialized?.outputs ?? {}).filter(([key]) =>
            allowedOutputPorts.has(key as MaterializedOutputPort),
          ),
        );
  return {
    ...node,
    materialized: {
      inputs,
      outputs,
      lastExitCode: node.materialized?.lastExitCode ?? null,
    },
  };
}

function filterWorkspaceToScope(
  workspace: Workspace,
  scopeNodeIds: Set<string>,
  targetNodeId: string,
  allowedInputKeys: Set<string> | null,
  allowedOutputPorts: Set<MaterializedOutputPort> | null,
): Workspace {
  return {
    ...workspace,
    nodes: workspace.nodes
      .filter((node) => scopeNodeIds.has(node.id))
      .map((node) =>
        prepareNodeMaterialized(
          node,
          node.id === targetNodeId ? allowedInputKeys : null,
          node.id === targetNodeId ? allowedOutputPorts : null,
        ),
      ),
    edges: workspace.edges.filter(
      (edge) => scopeNodeIds.has(edge.from.nodeId) && scopeNodeIds.has(edge.to.nodeId),
    ),
    tuckspace: [],
  };
}

function idsForInputKeys(node: WorkspaceNode, keys: Set<string>) {
  const ids = new Set<MatOutId>();
  for (const key of keys) {
    const id = node.materialized?.inputs?.[key];
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function idsForOutputPorts(node: WorkspaceNode, ports: Set<MaterializedOutputPort>) {
  const ids = new Set<MatOutId>();
  for (const port of ports) {
    const id = node.materialized?.outputs?.[port];
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

export function compileExecutionRequest(
  workspace: Workspace,
  nodeId: string,
  action: ExecutionAction,
): ExecutionRequest {
  const target = workspace.nodes.find((node) => node.id === nodeId);
  if (!target) {
    throw new Error(`node ${nodeId} is unavailable`);
  }

  let scopeNodeIds: Set<string>;
  let seedNodeIds: string[];
  let blockedNodeIds: string[] = [];
  const providedMatoutIds = new Set<MatOutId>();
  let allowedInputKeys: Set<string> | null = null;
  let allowedOutputPorts: Set<MaterializedOutputPort> | null = null;

  if (action === "pull_inputs" || action === "pull_run") {
    scopeNodeIds = upstreamClosure(workspace.edges, nodeId);
    seedNodeIds = rootNodeIds(scopeNodeIds, workspace.edges);
    if (action === "pull_inputs") {
      blockedNodeIds = [nodeId];
    }
  } else if (action === "rerun") {
    scopeNodeIds = new Set([nodeId]);
    seedNodeIds = [nodeId];
    allowedInputKeys = connectedInputKeys(workspace.edges, nodeId);
    for (const id of idsForInputKeys(target, allowedInputKeys)) {
      providedMatoutIds.add(id);
    }
  } else if (action === "rerun_push") {
    scopeNodeIds = downstreamClosure(workspace.edges, nodeId);
    seedNodeIds = [nodeId];
    allowedInputKeys = connectedInputKeys(workspace.edges, nodeId);
    for (const id of idsForInputKeys(target, allowedInputKeys)) {
      providedMatoutIds.add(id);
    }
  } else {
    scopeNodeIds = downstreamClosure(workspace.edges, nodeId);
    seedNodeIds = [nodeId];
    blockedNodeIds = [nodeId];
    allowedOutputPorts = connectedOutputPorts(
      workspace.edges.filter(
        (edge) => scopeNodeIds.has(edge.from.nodeId) && scopeNodeIds.has(edge.to.nodeId),
      ),
      nodeId,
    );
    if (allowedOutputPorts.size === 0) {
      for (const port of outputPortsForKind(target.kind)) {
        if (port === "stdout" || port === "stderr") {
          allowedOutputPorts.add(port);
        }
      }
    }
    for (const id of idsForOutputPorts(target, allowedOutputPorts)) {
      providedMatoutIds.add(id);
    }
  }
  return {
    workspace: filterWorkspaceToScope(
      workspace,
      scopeNodeIds,
      nodeId,
      allowedInputKeys,
      allowedOutputPorts,
    ),
    seedNodeIds,
    providedMatoutIds: Array.from(providedMatoutIds).sort(),
    blockedNodeIds,
  };
}
