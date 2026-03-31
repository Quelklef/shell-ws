import type { WorkspaceNode } from "./types";

type DrawOrderEntry = {
  id: string;
  drawOrder: number;
};

export function nodeDrawOrder(node: Pick<WorkspaceNode, "uiState"> | { uiState?: { drawOrder?: number | null } | null }) {
  return typeof node.uiState?.drawOrder === "number" ? node.uiState.drawOrder : 0;
}

export function normalizeWorkspaceNodeDrawOrders(nodes: WorkspaceNode[]) {
  let nextDrawOrder = 0;
  let changed = false;

  const normalizedNodes = nodes.map((node, index) => {
    const drawOrder = typeof node.uiState?.drawOrder === "number" ? node.uiState.drawOrder : index;
    nextDrawOrder = Math.max(nextDrawOrder, drawOrder + 1);
    if (node.uiState?.drawOrder === drawOrder) {
      return node;
    }
    changed = true;
    return {
      ...node,
      uiState: {
        ...(node.uiState ?? {}),
        drawOrder,
      },
    };
  });

  return {
    nodes: changed ? normalizedNodes : nodes,
    nextDrawOrder,
  };
}

export function allocateBumpedDrawOrders(
  entries: readonly DrawOrderEntry[],
  ids: Iterable<string>,
  nextDrawOrder: number,
) {
  const targetIds = new Set(ids);
  if (targetIds.size === 0) {
    return {
      drawOrderById: new Map<string, number>(),
      nextDrawOrder,
    };
  }

  const bumpedEntries = entries
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => targetIds.has(entry.id))
    .sort((a, b) => a.drawOrder - b.drawOrder || a.index - b.index);
  if (bumpedEntries.length === 0) {
    return {
      drawOrderById: new Map<string, number>(),
      nextDrawOrder,
    };
  }

  const cursorStart = Math.max(
    nextDrawOrder,
    entries.reduce((max, entry) => Math.max(max, entry.drawOrder + 1), 0),
  );
  const drawOrderById = new Map<string, number>();
  for (const [offset, entry] of bumpedEntries.entries()) {
    drawOrderById.set(entry.id, cursorStart + offset);
  }
  return {
    drawOrderById,
    nextDrawOrder: cursorStart + bumpedEntries.length,
  };
}
