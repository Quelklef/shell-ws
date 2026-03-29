import type {
  ExecutionAction,
  ExecutionRequest,
  MaterializedOutputPort,
  Workspace,
  WorkspaceEdge,
  WorkspaceNode,
} from "./types";
import { outputPortsForKind } from "./portSchema";
import {
  inputKeyForPortRef,
  inputPortRefForKey,
  outputPortRefForKey,
  portRefKey,
} from "./portRefs";

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

function executableRoots(edges: WorkspaceEdge[], executableNodeIds: Set<string>) {
  return new Set(
    Array.from(executableNodeIds).filter(
      (nodeId) =>
        !edges.some(
          (edge) =>
            executableNodeIds.has(edge.to.nodeId)
            && executableNodeIds.has(edge.from.nodeId)
            && edge.to.nodeId === nodeId,
        ),
    ),
  );
}

function connectedInputKeys(edges: WorkspaceEdge[], nodeId: string) {
  const keys = new Set<string>();
  for (const edge of incomingEdges(edges, nodeId)) {
    const key = inputKeyForPortRef(edge.to);
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

function requestNode(node: WorkspaceNode): WorkspaceNode {
  return {
    ...node,
    materialized: {
      inputs: {},
      outputs: {},
      lastExitCode: null,
    },
  };
}

function addNodeInputMatouts(node: WorkspaceNode, matouts: Record<string, string>) {
  for (const [key, id] of Object.entries(node.materialized?.inputs ?? {})) {
    setMatout(matouts, inputPortRefForKey(node.id, key), id);
  }
}

function addNodeOutputMatouts(
  node: WorkspaceNode,
  ports: Iterable<MaterializedOutputPort>,
  matouts: Record<string, string>,
) {
  for (const port of ports) {
    setMatout(matouts, outputPortRefForKey(node.id, port), node.materialized?.outputs?.[port]);
  }
}

function filterWorkspaceToScope(
  workspace: Workspace,
  executableNodeIds: Set<string>,
  includedEdgeIds: Set<string>,
): Workspace {
  return {
    ...workspace,
    nodes: workspace.nodes
      .filter((node) => executableNodeIds.has(node.id))
      .map(requestNode),
    edges: workspace.edges.filter((edge) => includedEdgeIds.has(edge.id)),
    tuckspace: [],
  };
}

function setMatout(
  matouts: Record<string, string>,
  portRef: ReturnType<typeof inputPortRefForKey> | ReturnType<typeof outputPortRefForKey>,
  id: string | undefined | null,
) {
  if (!portRef || !id) {
    return;
  }
  matouts[portRefKey(portRef)] = id;
}

function addAllNodeMatouts(node: WorkspaceNode, matouts: Record<string, string>) {
  addNodeInputMatouts(node, matouts);
  addNodeOutputMatouts(node, ["stdout", "stderr"], matouts);
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
      const missingExternalInput = deps.some((edge) => {
        if (included.has(edge.from.nodeId)) {
          return false;
        }
        const key = inputKeyForPortRef(edge.to);
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

function addExternalDependencyMatouts(
  workspace: Workspace,
  scopeNodeIds: Set<string>,
  matouts: Record<string, string>,
) {
  for (const node of workspace.nodes) {
    if (!scopeNodeIds.has(node.id)) {
      continue;
    }
    for (const edge of incomingEdges(workspace.edges, node.id)) {
      if (scopeNodeIds.has(edge.from.nodeId)) {
        continue;
      }
      const key = inputKeyForPortRef(edge.to);
      setMatout(matouts, inputPortRefForKey(node.id, key ?? ""), key ? node.materialized?.inputs?.[key] : null);
    }
  }
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

  let participatingNodeIds: Set<string>;
  let executableNodeIds = new Set<string>();
  let includedEdgeIds = new Set<string>();
  const activeMatouts: Record<string, string> = {};

  if (action === "pull_inputs" || action === "pull_run") {
    participatingNodeIds = upstreamClosure(workspace.edges, nodeId);
    includedEdgeIds = new Set(
      workspace.edges
        .filter((edge) => participatingNodeIds.has(edge.from.nodeId) && participatingNodeIds.has(edge.to.nodeId))
        .map((edge) => edge.id),
    );
    executableNodeIds = new Set(
      Array.from(participatingNodeIds).filter((id) => action === "pull_run" || id !== nodeId),
    );
  } else if (action === "rerun") {
    participatingNodeIds = new Set([nodeId]);
    executableNodeIds = new Set([nodeId]);
    for (const key of connectedInputKeys(workspace.edges, nodeId)) {
      setMatout(activeMatouts, inputPortRefForKey(nodeId, key), target.materialized?.inputs?.[key]);
    }
  } else if (action === "rerun_push") {
    participatingNodeIds = pushRunnableScope(workspace, nodeId);
    includedEdgeIds = new Set(
      workspace.edges
        .filter((edge) => participatingNodeIds.has(edge.from.nodeId) && participatingNodeIds.has(edge.to.nodeId))
        .map((edge) => edge.id),
    );
    executableNodeIds = new Set(participatingNodeIds);
  } else {
    participatingNodeIds = pushRunnableScope(workspace, nodeId);
    includedEdgeIds = new Set(
      workspace.edges
        .filter((edge) => participatingNodeIds.has(edge.from.nodeId) && participatingNodeIds.has(edge.to.nodeId))
        .map((edge) => edge.id),
    );
    const allowedOutputPorts = connectedOutputPorts(
      workspace.edges.filter(
        (edge) => participatingNodeIds.has(edge.from.nodeId) && participatingNodeIds.has(edge.to.nodeId),
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
    const hasOutputs = Array.from(allowedOutputPorts).some((port) => Boolean(target.materialized?.outputs?.[port]));
    executableNodeIds = new Set(
      Array.from(participatingNodeIds).filter((id) => hasOutputs || id !== nodeId),
    );
    for (const port of allowedOutputPorts) {
      setMatout(activeMatouts, outputPortRefForKey(nodeId, port), target.materialized?.outputs?.[port]);
    }
  }
  if (action === "pull_run") {
    for (const node of workspace.nodes.filter((candidate) => participatingNodeIds.has(candidate.id))) {
      addNodeInputMatouts(node, activeMatouts);
    }
    const roots = executableRoots(
      workspace.edges.filter((edge) => includedEdgeIds.has(edge.id)),
      executableNodeIds,
    );
    for (const node of workspace.nodes.filter((candidate) => executableNodeIds.has(candidate.id) && !roots.has(candidate.id))) {
      addNodeOutputMatouts(node, ["stdout", "stderr"], activeMatouts);
    }
  }
  if (action === "pull_inputs") {
    for (const node of workspace.nodes.filter((candidate) => executableNodeIds.has(candidate.id))) {
      addNodeInputMatouts(node, activeMatouts);
    }
    for (const key of connectedInputKeys(workspace.edges, nodeId)) {
      setMatout(activeMatouts, inputPortRefForKey(nodeId, key), target.materialized?.inputs?.[key]);
    }
    addNodeOutputMatouts(target, ["stdout", "stderr"], activeMatouts);
  }
  if (action === "rerun") {
    addNodeInputMatouts(target, activeMatouts);
  }
  if (action === "rerun_push") {
    for (const node of workspace.nodes.filter((candidate) => participatingNodeIds.has(candidate.id))) {
      addNodeInputMatouts(node, activeMatouts);
    }
    const roots = executableRoots(
      workspace.edges.filter((edge) => includedEdgeIds.has(edge.id)),
      executableNodeIds,
    );
    for (const node of workspace.nodes.filter((candidate) => executableNodeIds.has(candidate.id) && !roots.has(candidate.id))) {
      addNodeOutputMatouts(node, ["stdout", "stderr"], activeMatouts);
    }
  }
  if (action === "repush") {
    for (const node of workspace.nodes.filter((candidate) => participatingNodeIds.has(candidate.id))) {
      if (node.id === nodeId) {
        addNodeInputMatouts(node, activeMatouts);
        const ports = connectedOutputPorts(workspace.edges, nodeId);
        if (ports.size === 0) {
          for (const port of outputPortsForKind(node.kind)) {
            if (port === "stdout" || port === "stderr") {
              ports.add(port);
            }
          }
        }
        addNodeOutputMatouts(node, ports, activeMatouts);
      } else {
        addNodeInputMatouts(node, activeMatouts);
        addNodeOutputMatouts(node, ["stdout", "stderr"], activeMatouts);
      }
    }
  }

  const requestWorkspace = filterWorkspaceToScope(workspace, executableNodeIds, includedEdgeIds);
  const matouts: Record<string, string> = {};
  for (const node of workspace.nodes.filter((candidate) => executableNodeIds.has(candidate.id))) {
    addAllNodeMatouts(node, matouts);
  }
  Object.assign(matouts, activeMatouts);

  return {
    graph: requestWorkspace,
    matouts,
    activeMatouts: Object.keys(activeMatouts).sort(),
  };
}
