import type { ExecArg, MaterializedValue, Workspace, WorkspaceNode } from "./types";

type LegacyMaterializedNode = WorkspaceNode & {
  materializedInputs?: Record<string, MaterializedValue> | null;
  materializedOutputs?: Record<string, MaterializedValue> | null;
};

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

function normalizeExecArgs(args: unknown): ExecArg[] | null | undefined {
  if (args == null) {
    return args as null | undefined;
  }
  if (!Array.isArray(args)) {
    return [];
  }
  return args.map((arg) => {
    if (typeof arg === "string") {
      return { source: "literal", value: arg } satisfies ExecArg;
    }
    if (arg && typeof arg === "object" && "source" in arg) {
      const candidate = arg as { source?: unknown; value?: unknown; slot?: unknown };
      if (candidate.source === "argv") {
        return {
          source: "argv",
          slot: Math.max(1, Number(candidate.slot) || 1),
        } satisfies ExecArg;
      }
      return {
        source: "literal",
        value: typeof candidate.value === "string" ? candidate.value : "",
      } satisfies ExecArg;
    }
    return { source: "literal", value: "" } satisfies ExecArg;
  });
}

function migrateLegacyPreviews(previews?: Record<string, { dataBase64: string }> | null) {
  const materializedValues: Record<string, MaterializedValue> = {};
  for (const [key, value] of Object.entries(previews ?? {})) {
    if (isInputKey(key) || isOutputKey(key)) {
      materializedValues[key] = { dataBase64: value.dataBase64 };
    }
  }
  return materializedValues;
}

export function sanitizeWorkspace(workspace: Workspace): Workspace {
  const nodes = workspace.nodes
    .map((node) => ({
      ...node,
      kind:
        node.kind === ("cat" as typeof node.kind)
          ? "file"
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
      // Older workspaces persisted materialized inputs and outputs separately.
      const legacyNode = node as LegacyMaterializedNode;
      const materializedValues =
        node.materializedValues && Object.keys(node.materializedValues).length > 0
          ? node.materializedValues
          : {
              ...(legacyNode.materializedInputs ?? {}),
              ...(legacyNode.materializedOutputs ?? {}),
              ...migrated,
            };
      return {
        ...node,
        autoRun:
          node.autoRun && node.autoRun.mode === ("push" as never)
            ? { ...node.autoRun, mode: "rerun_push" }
            : node.autoRun && node.autoRun.mode === ("pull" as never)
              ? { ...node.autoRun, mode: "pull_run" }
              : node.autoRun,
        args: normalizeExecArgs(node.args),
        materializedValues,
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
