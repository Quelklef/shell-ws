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


export function isTuckspaceShell(item: TuckedSubgraph) {
  return item.nodes.length === 0 && item.edges.length === 0;
}

export function shouldKeepShellOnRestore(item: TuckedSubgraph) {
  return Boolean(item.userNamed);
}

export function storeTuckedSubgraph(
  items: readonly TuckedSubgraph[],
  nodes: WorkspaceNode[],
  edges: WorkspaceEdge[],
  targetShellId?: string,
) {
  const topologyPreview = buildTopologyPreview(nodes, edges);
  if (!targetShellId) {
    return [
      ...items,
      {
        id: encodeId("tuck"),
        name: defaultTuckedName(items),
        userNamed: false,
        nodes,
        edges,
        topologyPreview,
      },
    ];
  }
  return items.map((item) =>
    item.id === targetShellId
      ? {
          ...item,
          nodes,
          edges,
          topologyPreview,
        }
      : item,
  );
}

export function emptyTuckedSubgraph(item: TuckedSubgraph): TuckedSubgraph {
  return {
    ...item,
    nodes: [],
    edges: [],
    topologyPreview: { nodes: [], edges: [] },
  };
}

export function recenterTuckedNodes(
  nodes: readonly WorkspaceNode[],
  center: { x: number; y: number },
): WorkspaceNode[] {
  if (nodes.length === 0) {
    return [];
  }
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + node.size.width));
  const maxY = Math.max(...nodes.map((node) => node.position.y + node.size.height));
  const currentCenterX = (minX + maxX) / 2;
  const currentCenterY = (minY + maxY) / 2;
  const dx = center.x - currentCenterX;
  const dy = center.y - currentCenterY;
  return nodes.map((node) => ({
    ...node,
    position: {
      x: node.position.x + dx,
      y: node.position.y + dy,
    },
  }));
}


export function reorderTuckspaceWithPlacement(
  items: readonly TuckedSubgraph[],
  draggedId: string,
  targetId: string,
  position: "before" | "after",
) {
  if (draggedId === targetId) {
    return [...items];
  }
  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  if (draggedIndex === -1) {
    return [...items];
  }
  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  const targetIndex = next.findIndex((item) => item.id === targetId);
  if (targetIndex === -1) {
    return [...items];
  }
  const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
  next.splice(insertIndex, 0, dragged);
  return next;
}
