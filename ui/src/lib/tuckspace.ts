import type { FlowEdge } from "./types";
import type { TuckedSubgraph, TopologyPreviewNode, Workspace, WorkspaceEdge, WorkspaceNode } from "./types";
import { encodeId } from "./utils";

export function isClosedSelection(selectedNodeIds: ReadonlySet<string>, edges: readonly Pick<FlowEdge, "source" | "target">[]) {
  if (selectedNodeIds.size === 0) {
    return false;
  }
  return edges.every((edge) => selectedNodeIds.has(edge.source) === selectedNodeIds.has(edge.target));
}

export function defaultTuckedName(tuckspace: readonly TuckedSubgraph[]) {
  let next = tuckspace.length + 1;
  const taken = new Set(tuckspace.map((item) => item.name));
  while (taken.has(`Subgraph ${next}`)) {
    next += 1;
  }
  return `Subgraph ${next}`;
}

export function buildTuckedSubgraph(name: string, nodes: WorkspaceNode[], edges: WorkspaceEdge[]): TuckedSubgraph {
  return {
    id: encodeId("tuck"),
    name,
    nodes,
    edges,
    topologyPreview: buildTopologyPreview(nodes, edges),
  };
}

export function buildTopologyPreview(nodes: WorkspaceNode[], edges: WorkspaceEdge[]) {
  const centers = nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    x: node.position.x + node.size.width / 2,
    y: node.position.y + node.size.height / 2,
  }));
  if (centers.length === 0) {
    return { nodes: [], edges: [] };
  }
  const minX = Math.min(...centers.map((node) => node.x));
  const maxX = Math.max(...centers.map((node) => node.x));
  const minY = Math.min(...centers.map((node) => node.y));
  const maxY = Math.max(...centers.map((node) => node.y));
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const previewNodes: TopologyPreviewNode[] = centers.map((node) => ({
    ...node,
    x: 10 + (80 * (node.x - minX)) / spanX,
    y: 10 + (52 * (node.y - minY)) / spanY,
  }));
  return {
    nodes: previewNodes,
    edges: edges.map((edge) => ({
      id: edge.id,
      fromNodeId: edge.from.nodeId,
      toNodeId: edge.to.nodeId,
    })),
  };
}

export function renameTuckedSubgraph(workspace: Workspace, tuckId: string, name: string): Workspace {
  return {
    ...workspace,
    tuckspace: workspace.tuckspace.map((item) => (item.id === tuckId ? { ...item, name } : item)),
  };
}


export function reorderTuckspace(items: readonly TuckedSubgraph[], draggedId: string, targetId: string) {
  if (draggedId === targetId) {
    return [...items];
  }
  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (draggedIndex === -1 || targetIndex === -1) {
    return [...items];
  }
  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, dragged);
  return next;
}
