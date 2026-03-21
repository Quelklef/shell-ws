import type { Workspace } from "./types";

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
  workspaces: 180,
  settings: 180,
  nodes: 160,
  tuckspace: 220,
};

export function normalizeWorkspaceUi(ui: { viewportX?: number; viewportY?: number; zoom?: number; sidebars?: Partial<WorkspaceSidebars> } | undefined): Workspace["ui"] {
  return {
    viewportX: typeof ui?.viewportX === "number" ? ui.viewportX : 0,
    viewportY: typeof ui?.viewportY === "number" ? ui.viewportY : 0,
    zoom: typeof ui?.zoom === "number" ? ui.zoom : 1,
    sidebars: normalizeWorkspaceSidebars(ui?.sidebars),
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
