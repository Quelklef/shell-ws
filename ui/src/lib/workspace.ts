import type { NodeMaterialized, TuckedSubgraph, Workspace, WorkspaceEdge, WorkspaceNode } from "./types";
import { normalizeWorkspaceUi } from "./workspaceUi";

function sanitizeNodeMaterialized(materialized: WorkspaceNode["materialized"]): NodeMaterialized {
  return {
    inputs: { ...(materialized?.inputs ?? {}) },
    outputs: { ...(materialized?.outputs ?? {}) },
    lastExitCode: materialized?.lastExitCode ?? null,
  };
}

function sanitizeNodesAndEdges(nodesInput: WorkspaceNode[], edgesInput: WorkspaceEdge[]) {
  const validNodeIds = new Set(nodesInput.map((node) => node.id));

  return {
    nodes: nodesInput.map((node) => ({
      ...node,
      materialized: sanitizeNodeMaterialized(node.materialized),
      uiState: node.uiState
        ? {
            ...node.uiState,
            openPreviewTabs: [...(node.uiState.openPreviewTabs ?? [])],
            paneSizes: { ...(node.uiState.paneSizes ?? {}) },
          }
        : node.uiState,
    })),
    edges: edgesInput.filter(
      (edge) => validNodeIds.has(edge.from.nodeId) && validNodeIds.has(edge.to.nodeId),
    ),
  };
}

function sanitizeTuckedSubgraph(item: TuckedSubgraph): TuckedSubgraph {
  const sanitized = sanitizeNodesAndEdges(item.nodes ?? [], item.edges ?? []);
  return {
    ...item,
    name: item.name ?? "Untitled subgraph",
    userNamed: item.userNamed ?? false,
    nodes: sanitized.nodes,
    edges: sanitized.edges,
    topologyPreview: {
      nodes: item.topologyPreview?.nodes ?? [],
      edges: item.topologyPreview?.edges ?? [],
    },
  };
}

export function sanitizeWorkspace(workspace: Workspace): Workspace {
  const sanitized = sanitizeNodesAndEdges(workspace.nodes ?? [], workspace.edges ?? []);
  return {
    ...workspace,
    createdAt: workspace.createdAt ?? 0,
    sortOrder: workspace.sortOrder ?? workspace.createdAt ?? 0,
    cwd: workspace.cwd ?? "",
    openaiApiKey: workspace.openaiApiKey ?? "",
    ui: normalizeWorkspaceUi(workspace.ui),
    nodes: sanitized.nodes,
    edges: sanitized.edges,
    tuckspace: (workspace.tuckspace ?? []).map(sanitizeTuckedSubgraph),
  };
}
