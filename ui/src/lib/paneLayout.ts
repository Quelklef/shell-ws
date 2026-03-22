import type { NodeUiState } from "./types";

export const MIN_RESIZABLE_PANE_WIDTH = 150;
export const DEFAULT_PREVIEW_PANE_WIDTH = 240;

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

export function defaultPaneWidth(paneId: string, fallback: number) {
  if (paneId.startsWith("preview-")) {
    return DEFAULT_PREVIEW_PANE_WIDTH;
  }
  return Math.round(Math.max(MIN_RESIZABLE_PANE_WIDTH, fallback));
}

export function paneWidth(uiState: NodeUiState | null | undefined, paneId: string, fallback: number) {
  const persisted = uiState?.paneSizes?.[paneId]?.width;
  if (typeof persisted === "number" && Number.isFinite(persisted) && persisted > 0) {
    return Math.round(Math.max(MIN_RESIZABLE_PANE_WIDTH, persisted));
  }
  return defaultPaneWidth(paneId, fallback);
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
  size: { width?: number; height?: number },
): NodeUiState {
  return {
    ...(uiState ?? {}),
    paneSizes: {
      ...(uiState?.paneSizes ?? {}),
      [paneId]: {
        ...(uiState?.paneSizes?.[paneId] ?? {}),
        ...(typeof size.width === "number" ? { width: size.width } : {}),
        ...(typeof size.height === "number" ? { height: size.height } : {}),
      },
    },
  };
}
