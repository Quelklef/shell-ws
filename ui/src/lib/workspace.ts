import type { Workspace } from "./types";

const REMOVED_NODE_KINDS = new Set([
  "tee",
  "merge_concat",
  "merge_line",
  "merge_byte",
  "merge_shell",
]);

export function sanitizeWorkspace(workspace: Workspace): Workspace {
  const nodes = workspace.nodes
    .map((node) => ({
      ...node,
      kind:
        node.kind === ("cat" as typeof node.kind)
          ? "file"
          : node.kind === ("display" as typeof node.kind)
            ? "passthru"
            : node.kind,
    }))
    .filter((node) => !REMOVED_NODE_KINDS.has(node.kind as string));
  const validNodeIds = new Set(nodes.map((node) => node.id));

  return {
    ...workspace,
    cwd: workspace.cwd ?? "",
    openaiApiKey: workspace.openaiApiKey ?? "",
    nodes: nodes.map((node) => ({
      ...node,
      uiState: node.uiState
        ? {
            ...node.uiState,
            openPreviewTabs:
              node.uiState.openPreviewTabs ??
              (node.uiState.activePreviewTab ? [node.uiState.activePreviewTab] : []),
          }
        : node.uiState,
    })),
    edges: workspace.edges.filter(
      (edge) =>
        !(edge.to.port === "argv" && edge.to.slot == null) &&
        validNodeIds.has(edge.from.nodeId) &&
        validNodeIds.has(edge.to.nodeId),
    ),
  };
}
