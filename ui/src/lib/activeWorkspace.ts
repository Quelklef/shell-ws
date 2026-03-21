import type { WorkspaceSummary } from "./types";

const ACTIVE_WORKSPACE_STORAGE_KEY = "shell-ws.active-workspace";
const WORKSPACE_PARAM = "workspace";

export function loadGlobalActiveWorkspaceId() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
}

export function saveGlobalActiveWorkspaceId(workspaceId: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
}

export function readWorkspaceIdFromUrl() {
  if (typeof window === "undefined") {
    return null;
  }
  return new URL(window.location.href).searchParams.get(WORKSPACE_PARAM);
}

export function writeWorkspaceIdToUrl(workspaceId: string) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set(WORKSPACE_PARAM, workspaceId);
  window.history.replaceState(null, "", url);
}

export function chooseInitialWorkspaceId(
  summaries: WorkspaceSummary[],
  urlWorkspaceId: string | null,
  storedWorkspaceId: string | null,
) {
  const ids = new Set(summaries.map((workspace) => workspace.id));
  if (urlWorkspaceId && ids.has(urlWorkspaceId)) {
    return urlWorkspaceId;
  }
  if (storedWorkspaceId && ids.has(storedWorkspaceId)) {
    return storedWorkspaceId;
  }
  return summaries[0]?.id ?? null;
}
