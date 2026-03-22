import type { WorkspaceEdge, WorkspaceNode } from "./types";

const COLUMN_GAP = 140;
const ROW_GAP = 40;

function boundsCenter(nodes: WorkspaceNode[], positions?: Map<string, { x: number; y: number }>) {
  const left = Math.min(
    ...nodes.map((node) => positions?.get(node.id)?.x ?? node.position.x),
  );
  const top = Math.min(
    ...nodes.map((node) => positions?.get(node.id)?.y ?? node.position.y),
  );
  const right = Math.max(
    ...nodes.map(
      (node) => (positions?.get(node.id)?.x ?? node.position.x) + node.size.width,
    ),
  );
  const bottom = Math.max(
    ...nodes.map(
      (node) => (positions?.get(node.id)?.y ?? node.position.y) + node.size.height,
    ),
  );
  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
  };
}

export function layoutSelectedNodes(
  selectedNodeIds: string[],
  nodes: WorkspaceNode[],
  edges: WorkspaceEdge[],
) {
  const selected = new Set(selectedNodeIds);
  const selectedNodes = nodes.filter((node) => selected.has(node.id));
  const selectedEdges = edges.filter(
    (edge) => selected.has(edge.from.nodeId) && selected.has(edge.to.nodeId),
  );
  const incomingCount = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of selectedNodes) {
    incomingCount.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of selectedEdges) {
    incomingCount.set(edge.to.nodeId, (incomingCount.get(edge.to.nodeId) ?? 0) + 1);
    outgoing.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }

  const queue = selectedNodes
    .filter((node) => (incomingCount.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const depth = new Map<string, number>();
  for (const nodeId of queue) {
    depth.set(nodeId, 0);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of outgoing.get(current) ?? []) {
      const nextDepth = Math.max(depth.get(next) ?? 0, (depth.get(current) ?? 0) + 1);
      depth.set(next, nextDepth);
      incomingCount.set(next, (incomingCount.get(next) ?? 1) - 1);
      if ((incomingCount.get(next) ?? 0) <= 0) {
        queue.push(next);
      }
    }
  }

  let fallbackDepth = 0;
  for (const node of selectedNodes) {
    if (!depth.has(node.id)) {
      depth.set(node.id, fallbackDepth);
      fallbackDepth += 1;
    }
  }

  const columns = new Map<number, WorkspaceNode[]>();
  for (const node of selectedNodes) {
    const nodeDepth = depth.get(node.id) ?? 0;
    const column = columns.get(nodeDepth) ?? [];
    column.push(node);
    columns.set(nodeDepth, column);
  }

  const nextPositions = new Map<string, { x: number; y: number }>();
  let currentX = 140;
  for (const [, columnNodes] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    columnNodes.sort((left, right) => left.position.y - right.position.y);
    let currentY = 100;
    let maxColumnWidth = 0;
    for (const node of columnNodes) {
      nextPositions.set(node.id, {
        x: currentX,
        y: currentY,
      });
      currentY += node.size.height + ROW_GAP;
      maxColumnWidth = Math.max(maxColumnWidth, node.size.width);
    }
    currentX += maxColumnWidth + COLUMN_GAP;
  }

  const originalCenter = boundsCenter(selectedNodes);
  const layoutCenter = boundsCenter(selectedNodes, nextPositions);
  const offsetX = originalCenter.x - layoutCenter.x;
  const offsetY = originalCenter.y - layoutCenter.y;

  for (const node of selectedNodes) {
    const position = nextPositions.get(node.id);
    if (position) {
      nextPositions.set(node.id, {
        x: position.x + offsetX,
        y: position.y + offsetY,
      });
    }
  }

  return nextPositions;
}
