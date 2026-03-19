import type { Workspace } from "./types";

export function sanitizeWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    cwd: workspace.cwd ?? "",
    nodes: workspace.nodes.map((node) => ({
      ...node,
      kind:
        node.kind === ("cat" as typeof node.kind)
          ? "file"
          : node.kind === ("display" as typeof node.kind)
            ? "passthru"
            : node.kind,
    })),
    edges: workspace.edges.filter(
      (edge) => !(edge.to.port === "argv" && edge.to.slot == null),
    ),
  };
}
