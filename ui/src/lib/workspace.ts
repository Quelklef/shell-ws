import type { Workspace } from "./types";

export function sanitizeWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    edges: workspace.edges.filter(
      (edge) => !(edge.to.port === "argv" && edge.to.slot == null),
    ),
  };
}
