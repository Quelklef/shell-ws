import type { MaterializedValue, Workspace } from "./types";

const REMOVED_NODE_KINDS = new Set([
  "tee",
  "merge_concat",
  "merge_line",
  "merge_byte",
  "merge_shell",
]);

const INPUT_PORT_KEYS = new Set(["stdin"]);

function isOutputKey(key: string) {
  return key === "stdout" || key === "stderr";
}

function isInputKey(key: string) {
  return INPUT_PORT_KEYS.has(key) || /^argv-\d+$/.test(key);
}

function migrateLegacyPreviews(previews?: Record<string, { dataBase64: string }> | null) {
  const materializedInputs: Record<string, MaterializedValue> = {};
  const materializedOutputs: Record<string, MaterializedValue> = {};
  for (const [key, value] of Object.entries(previews ?? {})) {
    if (isInputKey(key)) {
      materializedInputs[key] = { dataBase64: value.dataBase64 };
    } else if (isOutputKey(key)) {
      materializedOutputs[key] = { dataBase64: value.dataBase64 };
    }
  }
  return { materializedInputs, materializedOutputs };
}

export function sanitizeWorkspace(workspace: Workspace): Workspace {
  const nodes = workspace.nodes
    .map((node) => ({
      ...node,
      kind:
        node.kind === ("cat" as typeof node.kind)
          ? "file"
          : node.kind === ("display" as typeof node.kind)
            ? "passthru"
            : node.kind,
    }))
    .filter((node) => !REMOVED_NODE_KINDS.has(node.kind as string));
  const validNodeIds = new Set(nodes.map((node) => node.id));

  return {
    ...workspace,
    cwd: workspace.cwd ?? "",
    openaiApiKey: workspace.openaiApiKey ?? "",
    nodes: nodes.map((node) => {
      const migrated = migrateLegacyPreviews(node.uiState?.previews);
      return {
        ...node,
        autoRun:
          node.autoRun && node.autoRun.mode === ("push" as never)
            ? { ...node.autoRun, mode: "rerun_push" }
            : node.autoRun && node.autoRun.mode === ("pull" as never)
              ? { ...node.autoRun, mode: "pull_run" }
              : node.autoRun,
        materializedInputs:
          node.materializedInputs && Object.keys(node.materializedInputs).length > 0
            ? node.materializedInputs
            : migrated.materializedInputs,
        materializedOutputs:
          node.materializedOutputs && Object.keys(node.materializedOutputs).length > 0
            ? node.materializedOutputs
            : migrated.materializedOutputs,
        uiState: node.uiState
          ? {
              ...node.uiState,
              openPreviewTabs:
                node.uiState.openPreviewTabs ??
                (node.uiState.activePreviewTab ? [node.uiState.activePreviewTab] : []),
            }
          : node.uiState,
      };
    }),
    edges: workspace.edges.filter(
      (edge) =>
        !(edge.to.port === "argv" && edge.to.slot == null) &&
        validNodeIds.has(edge.from.nodeId) &&
        validNodeIds.has(edge.to.nodeId),
    ),
  };
}
