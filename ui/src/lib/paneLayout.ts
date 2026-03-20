import type { NodeUiState } from "./types";

export const MIN_NODE_WIDTH = 260;

const DEFAULT_PANE_HEIGHTS: Record<string, number> = {
  "ai-prompt": 72,
  formula: 96,
  html: 160,
  script: 132,
  text: 112,
};

export function previewPaneId(port: string) {
  return `preview-${port}`;
}

export function defaultPaneHeight(paneId: string) {
  if (paneId.startsWith("preview-")) {
    return 112;
  }
  return DEFAULT_PANE_HEIGHTS[paneId] ?? 112;
}

export function paneHeight(uiState: NodeUiState | null | undefined, paneId: string) {
  const persisted = uiState?.paneSizes?.[paneId]?.height;
  if (typeof persisted === "number" && Number.isFinite(persisted) && persisted > 0) {
    return Math.round(persisted);
  }
  return defaultPaneHeight(paneId);
}

export function nextPaneSizes(
  uiState: NodeUiState | null | undefined,
  paneId: string,
  height: number,
): NodeUiState {
  return {
    ...(uiState ?? {}),
    paneSizes: {
      ...(uiState?.paneSizes ?? {}),
      [paneId]: {
        ...(uiState?.paneSizes?.[paneId] ?? {}),
        height,
      },
    },
  };
}
