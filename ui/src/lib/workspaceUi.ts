import type { PreviewControlsLocation, Workspace } from "./types";

const SIDEBAR_STORAGE_KEY = "shell-ws.sidebar-ui";

export type SidebarId = "workspaces" | "settings" | "nodes" | "tuckspace";

export interface SidebarUiState {
  width: number;
  collapsed: boolean;
}

export interface WorkspaceSidebars {
  workspaces: SidebarUiState;
  settings: SidebarUiState;
  nodes: SidebarUiState;
  tuckspace: SidebarUiState;
}

export const COLLAPSED_SIDEBAR_WIDTH = 42;

export const SIDEBAR_DEFAULTS: WorkspaceSidebars = {
  workspaces: { width: 220, collapsed: false },
  settings: { width: 220, collapsed: false },
  nodes: { width: 190, collapsed: false },
  tuckspace: { width: 280, collapsed: false },
};

export const SIDEBAR_MIN_WIDTH: Record<SidebarId, number> = {
  workspaces: 100,
  settings: 100,
  nodes: 100,
  tuckspace: 100,
};

export function loadGlobalSidebarState(): WorkspaceSidebars {
  if (typeof window === "undefined") {
    return normalizeWorkspaceSidebars(undefined);
  }
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (!raw) {
      return normalizeWorkspaceSidebars(undefined);
    }
    return normalizeWorkspaceSidebars(JSON.parse(raw) as Partial<WorkspaceSidebars>);
  } catch {
    return normalizeWorkspaceSidebars(undefined);
  }
}

export function saveGlobalSidebarState(sidebars: WorkspaceSidebars) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(sidebars));
}

export function normalizeWorkspaceUi(ui: { viewportX?: number; viewportY?: number; zoom?: number; sidebars?: Partial<WorkspaceSidebars>; previewControlsLocation?: PreviewControlsLocation } | undefined): Workspace["ui"] {
  return {
    viewportX: typeof ui?.viewportX === "number" ? ui.viewportX : 0,
    viewportY: typeof ui?.viewportY === "number" ? ui.viewportY : 0,
    zoom: typeof ui?.zoom === "number" ? ui.zoom : 1,
    sidebars: normalizeWorkspaceSidebars(ui?.sidebars),
    previewControlsLocation: normalizePreviewControlsLocation(ui?.previewControlsLocation),
  };
}

export function normalizeWorkspaceSidebars(
  sidebars: Partial<WorkspaceSidebars> | undefined,
): WorkspaceSidebars {
  return {
    workspaces: normalizeSidebarState("workspaces", sidebars?.workspaces),
    settings: normalizeSidebarState("settings", sidebars?.settings),
    nodes: normalizeSidebarState("nodes", sidebars?.nodes),
    tuckspace: normalizeSidebarState("tuckspace", sidebars?.tuckspace),
  };
}

function normalizeSidebarState(
  id: SidebarId,
  state: Partial<SidebarUiState> | undefined,
): SidebarUiState {
  return {
    width: Math.max(SIDEBAR_MIN_WIDTH[id], Math.round(state?.width ?? SIDEBAR_DEFAULTS[id].width)),
    collapsed: state?.collapsed ?? SIDEBAR_DEFAULTS[id].collapsed,
  };
}

export function normalizePreviewControlsLocation(value: PreviewControlsLocation | undefined): PreviewControlsLocation {
  return "floating";
}
