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

function inputKeyForEdge(edge: WorkspaceEdge) {
  if (edge.to.port === "stdin") {
    return "stdin";
  }
  if (edge.to.port === "argv") {
    return `argv-${edge.to.slot ?? 1}`;
  }
  return null;
}

function connectedInputKeys(edges: WorkspaceEdge[], nodeId: string) {
  const keys = new Set<string>();
  for (const edge of incomingEdges(edges, nodeId)) {
    const key = inputKeyForEdge(edge);
    if (key) {
      keys.add(key);
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
  allowedOutputPorts: Set<MaterializedOutputPort> | null,
): WorkspaceNode {
  const inputs = { ...(node.materialized?.inputs ?? {}) };
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
  includedEdgeIds: Set<string>,
  targetNodeId: string | null,
  allowedOutputPorts: Set<MaterializedOutputPort> | null,
): Workspace {
  return {
    ...workspace,
    nodes: workspace.nodes
      .filter((node) => scopeNodeIds.has(node.id))
      .map((node) =>
        prepareNodeMaterialized(
          node,
          node.id === targetNodeId ? allowedOutputPorts : null,
        ),
      ),
    edges: workspace.edges.filter(
      (edge) =>
        includedEdgeIds.has(edge.id)
        && scopeNodeIds.has(edge.from.nodeId)
        && scopeNodeIds.has(edge.to.nodeId),
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

function pushRunnableScope(workspace: Workspace, startNodeId: string) {
  const fullDownstream = Array.from(downstreamClosure(workspace.edges, startNodeId)).sort();
  const included = new Set<string>([startNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidateId of fullDownstream) {
      if (included.has(candidateId)) {
        continue;
      }
      const candidate = workspace.nodes.find((node) => node.id === candidateId);
      if (!candidate) {
        continue;
      }
      const deps = incomingEdges(workspace.edges, candidateId);
      if (!deps.some((edge) => included.has(edge.from.nodeId))) {
        continue;
      }
      // Push-style requests only keep downstream nodes whose omitted sibling inputs
      // can be satisfied from cached materialized refs carried in the request.
      const missingExternalInput = deps.some((edge) => {
        if (included.has(edge.from.nodeId)) {
          return false;
        }
        const key = inputKeyForEdge(edge);
        return key ? !candidate.materialized?.inputs?.[key] : false;
      });
      if (!missingExternalInput) {
        included.add(candidateId);
        changed = true;
      }
    }
  }
  return included;
}

function idsForExternalDependencies(workspace: Workspace, scopeNodeIds: Set<string>) {
  const ids = new Set<MatOutId>();
  for (const node of workspace.nodes) {
    if (!scopeNodeIds.has(node.id)) {
      continue;
    }
    for (const edge of incomingEdges(workspace.edges, node.id)) {
      if (scopeNodeIds.has(edge.from.nodeId)) {
        continue;
      }
      const key = inputKeyForEdge(edge);
      const id = key ? node.materialized?.inputs?.[key] : null;
      if (id) {
        ids.add(id);
      }
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
  let executableNodeIds: string[] = [];
  const providedMatoutIds = new Set<MatOutId>();
  let includedEdgeIds = new Set<string>();
  let allowedOutputPorts: Set<MaterializedOutputPort> | null = null;

  if (action === "pull_inputs" || action === "pull_run") {
    scopeNodeIds = upstreamClosure(workspace.edges, nodeId);
    includedEdgeIds = new Set(
      workspace.edges
        .filter((edge) => scopeNodeIds.has(edge.from.nodeId) && scopeNodeIds.has(edge.to.nodeId))
        .map((edge) => edge.id),
    );
    executableNodeIds = Array.from(scopeNodeIds)
      .filter((id) => action === "pull_run" || id !== nodeId)
      .sort();
  } else if (action === "rerun") {
    scopeNodeIds = new Set([nodeId]);
    executableNodeIds = [nodeId];
    for (const id of idsForInputKeys(target, connectedInputKeys(workspace.edges, nodeId))) {
      providedMatoutIds.add(id);
    }
  } else if (action === "rerun_push") {
    scopeNodeIds = pushRunnableScope(workspace, nodeId);
    includedEdgeIds = new Set(
      workspace.edges
        .filter((edge) => scopeNodeIds.has(edge.from.nodeId) && scopeNodeIds.has(edge.to.nodeId))
        .map((edge) => edge.id),
    );
    executableNodeIds = Array.from(scopeNodeIds).sort();
    for (const id of idsForExternalDependencies(workspace, scopeNodeIds)) {
      providedMatoutIds.add(id);
    }
  } else {
    scopeNodeIds = pushRunnableScope(workspace, nodeId);
    includedEdgeIds = new Set(
      workspace.edges
        .filter((edge) => scopeNodeIds.has(edge.from.nodeId) && scopeNodeIds.has(edge.to.nodeId))
        .map((edge) => edge.id),
    );
    executableNodeIds = Array.from(scopeNodeIds)
      .filter((id) => id !== nodeId)
      .sort();
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
    for (const id of idsForExternalDependencies(workspace, scopeNodeIds)) {
      providedMatoutIds.add(id);
    }
  }
  return {
    workspace: filterWorkspaceToScope(
      workspace,
      scopeNodeIds,
      includedEdgeIds,
      nodeId,
      allowedOutputPorts,
    ),
    executableNodeIds,
    edgeIds: Array.from(includedEdgeIds).sort(),
    providedMatoutIds: Array.from(providedMatoutIds).sort(),
  };
}
