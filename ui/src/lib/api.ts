import type { Workspace, WorkspaceSummary } from "./types";

function kernelOrigin() {
  if (typeof window === "undefined") {
    return "";
  }

  if (window.location.port === "5173") {
    return `${window.location.protocol}//${window.location.hostname}:4000`;
  }

  return window.location.origin;
}

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function listWorkspaces() {
  return request<WorkspaceSummary[]>(`${kernelOrigin()}/api/workspaces`);
}

export function getWorkspace(id: string) {
  return request<Workspace>(`${kernelOrigin()}/api/workspaces/${id}`);
}

export function createWorkspace() {
  return request<Workspace>(`${kernelOrigin()}/api/workspaces`, { method: "POST" });
}

export function saveWorkspace(workspace: Workspace) {
  return request<void>(`${kernelOrigin()}/api/workspaces/${workspace.id}`, {
    method: "PUT",
    body: JSON.stringify(workspace),
  });
}
