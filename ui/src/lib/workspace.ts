import type { AutoRunConfig, ExecArg, MaterializedValue, NodeMaterialized, TuckedSubgraph, Workspace, WorkspaceEdge, WorkspaceNode } from "./types";
import { normalizeWorkspaceUi } from "./workspaceUi";

type LegacyMaterializedNode = WorkspaceNode & {
  materializedInputs?: Record<string, MaterializedValue> | null;
  materializedOutputs?: Record<string, MaterializedValue> | null;
  materializedValues?: Record<string, MaterializedValue> | null;
  lastExitCode?: number | null;
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


function normalizeAutoRun(autoRun: WorkspaceNode["autoRun"]): AutoRunConfig | null | undefined {
  if (!autoRun) {
    return autoRun;
  }
  if (autoRun.mode === ("push" as never)) {
    return { ...autoRun, mode: "rerun_push" };
  }
  if (autoRun.mode === ("pull" as never)) {
    return { ...autoRun, mode: "pull_run" };
  }
  return autoRun;
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

function sanitizeNodesAndEdges(nodesInput: WorkspaceNode[], edgesInput: WorkspaceEdge[]) {
  const nodes = nodesInput
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
    nodes: nodes.map((node) => {
      const migrated = migrateLegacyPreviews(node.uiState?.previews);
      // Older workspaces persisted materialized inputs and outputs separately.
      const legacyNode = node as LegacyMaterializedNode;
      const materialized = ({
        inputs: { ...(node.materialized?.inputs ?? {}) },
        outputs: { ...(node.materialized?.outputs ?? {}) },
        values:
          node.materialized?.values && Object.keys(node.materialized.values).length > 0
            ? node.materialized.values
            : legacyNode.materializedValues && Object.keys(legacyNode.materializedValues).length > 0
              ? legacyNode.materializedValues
              : {
                  ...(legacyNode.materializedInputs ?? {}),
                  ...(legacyNode.materializedOutputs ?? {}),
                  ...migrated,
                },
        lastExitCode: node.materialized?.lastExitCode ?? legacyNode.lastExitCode ?? null,
      } satisfies NodeMaterialized);
      return {
        ...node,
        autoRun: normalizeAutoRun(node.autoRun),
        args: normalizeExecArgs(node.args),
        materialized,
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
    edges: edgesInput.filter(
      (edge) =>
        !(edge.to.port === "argv" && edge.to.slot == null) &&
        validNodeIds.has(edge.from.nodeId) &&
        validNodeIds.has(edge.to.nodeId),
    ),
  };
}

function sanitizeTuckedSubgraph(item: TuckedSubgraph): TuckedSubgraph {
  const sanitized = sanitizeNodesAndEdges(item.nodes ?? [], item.edges ?? []);
  return {
    ...item,
    name: item.name ?? "Untitled subgraph",
    userNamed: item.userNamed ?? false,
    nodes: sanitized.nodes,
    edges: sanitized.edges,
    topologyPreview: {
      nodes: item.topologyPreview?.nodes ?? [],
      edges: item.topologyPreview?.edges ?? [],
    },
  };
}

export function sanitizeWorkspace(workspace: Workspace): Workspace {
  const sanitized = sanitizeNodesAndEdges(workspace.nodes ?? [], workspace.edges ?? []);
  return {
    ...workspace,
    createdAt: workspace.createdAt ?? 0,
    sortOrder: workspace.sortOrder ?? workspace.createdAt ?? 0,
    cwd: workspace.cwd ?? "",
    openaiApiKey: workspace.openaiApiKey ?? "",
    ui: normalizeWorkspaceUi(workspace.ui),
    nodes: sanitized.nodes,
    edges: sanitized.edges,
    tuckspace: (workspace.tuckspace ?? []).map(sanitizeTuckedSubgraph),
  };
}
