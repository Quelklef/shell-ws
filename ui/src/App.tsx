import {
  Background,
  ConnectionLineType,
  ControlButton,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import "@xyflow/react/dist/style.css";

import ShellNode from "./components/ShellNode";
import WorkspaceEdgeView from "./components/WorkspaceEdge";
import {
  createWorkspace,
  deleteWorkspace,
  reorderWorkspaces,
  generateScript,
  getTuckspace,
  getWorkspace,
  listWorkspaces,
  pickFilePath,
  saveTuckspace,
  saveWorkspace,
} from "./lib/api";
import { collectAiScriptSamples } from "./lib/aiScript";
import { layoutSelectedNodes } from "./lib/layout";
import { chooseNodePosition } from "./lib/nodePlacement";
import { selectionRectToFlowRect } from "./lib/selectionRect";
import { nodeArgvSlots, nodeHasArgvPort, nodePreviewTabs, nodePreviewTabsForNode } from "./lib/nodePorts";
import type {
  AiGenerationState,
  AutoRunConfig,
  BufferingMode,
  ClientEvent,
  ExecutionAction,
  FlowEdge,
  FlowNode,
  NodeKind,
  NodeRuntimeState,
  NodeUiState,
  PortKind,
  Workspace,
  WorkspaceEdge,
  WorkspaceNode,
  TuckedSubgraph,
  WorkspaceSummary,
} from "./lib/types";
import { connectKernel } from "./lib/ws";
import { sanitizeWorkspace } from "./lib/workspace";
import { reorderItemsWithPlacement, useVerticalReorderDrag } from "./lib/reorderableList";
import { sortWorkspaceSummaries, upsertWorkspaceSummary } from "./lib/workspaceList";
import { chooseInitialWorkspaceId, loadGlobalActiveWorkspaceId, readWorkspaceIdFromUrl, saveGlobalActiveWorkspaceId, writeWorkspaceIdToUrl } from "./lib/activeWorkspace";
import {
  COLLAPSED_SIDEBAR_WIDTH,
  SIDEBAR_MIN_WIDTH,
  loadGlobalSidebarState,
  saveGlobalSidebarState,
  type SidebarId,
  type WorkspaceSidebars,
} from "./lib/workspaceUi";
import { missingConnectedInputs, missingOutputs, runtimePreviewsFromNode, materializedValuesFromRuntime } from "./lib/materialized";
import { outputPortsForKind, previewOutputPortsForKind } from "./lib/portSchema";
import { applyNodeOutputEvent } from "./lib/runtimeEvents";
import { nextPaneSizes } from "./lib/paneLayout";
import { emptyTuckedSubgraph, isClosedSelection, isTuckspaceShell, recenterTuckedNodes, reorderTuckspaceWithPlacement, shouldKeepShellOnRestore, storeTuckedSubgraph } from "./lib/tuckspace";
import { concatBytes, encodeId, fromBase64, toBase64 } from "./lib/utils";

const nodeTypes = {
  shell: ShellNode,
};

const edgeTypes = {
  workspace: WorkspaceEdgeView,
};


function makeNode(kind: NodeKind, count: number): WorkspaceNode {
  const previewOpenByDefault = kind === "formula" || kind === "text" ? [] : ["stdout"];
  return {
    id: encodeId(`node-${kind.replaceAll("_", "-")}`),
    kind,
    title: "",
    comment: "",
    position: { x: 140 + count * 30, y: 140 + count * 24 },
    size: { width: 320, height: ((kind === "html" || kind === "display") ? 300 : kind === "ai_script" ? 320 : kind === "formula" ? 280 : 230) + 156 },
    shell: "bash",
    script: kind === "script" ? "printf 'hello\n'" : kind === "ai_script" ? "" : null,
    description: kind === "ai_script" ? "" : null,
    includeSampleInputs: kind === "ai_script" ? true : null,
    path: kind === "exec" || kind === "file" ? "" : null,
    args: kind === "exec" ? [] : null,
    text: kind === "text" ? "" : null,
    formula: kind === "formula" ? "$1 + 1" : null,
    materializedValues: {},
    autoRun: null,
    uiState: { openPreviewTabs: previewOpenByDefault },
  };
}

function paletteGroups(): {
  label: string;
  items: { kind: NodeKind; label: string; icon: string; help: string }[];
}[] {
  return [
    {
      label: "sources",
      items: [
        { kind: "text", label: "text", icon: "T", help: "Emit literal text on stdout." },
        { kind: "file", label: "file", icon: "🗎", help: "Read a file path and emit its bytes." },
      ],
    },
    {
      label: "computers",
      items: [
        {
          kind: "script",
          label: "script",
          icon: ">_",
          help: "Run a shell snippet with the selected shell.",
        },
        {
          kind: "ai_script",
          label: "ai script",
          icon: ">_",
          help: "Generate and run a shell snippet with OpenAI.",
        },
        {
          kind: "exec",
          label: "exec",
          icon: ">_",
          help: "Exec a binary path with one argument per line.",
        },
        {
          kind: "formula",
          label: "formula",
          icon: "∑",
          help: "Evaluate a math expression from argv inputs.",
        },
        {
          kind: "passthru",
          label: "passthru",
          icon: "→",
          help: "Forward stdin to stdout with rich debug previews.",
        },
      ],
    },
    {
      label: "sinks",
      items: [
        {
          kind: "display",
          label: "display",
          icon: "⌕",
          help: "Show stdin as a sink with a persistent stdout preview.",
        },
        {
          kind: "html",
          label: "html",
          icon: "<>",
          help: "Render stdin as sandboxed HTML in the browser.",
        },
      ],
    },
  ];
}

function formatHandleId(port: PortKind, slot?: number | null) {
  return slot ? `${port}-${slot}` : port;
}

function parseHandleId(handleId: string | null | undefined): {
  port: PortKind;
  slot?: number;
} {
  if (!handleId) {
    return { port: "stdout" };
  }
  const match = /^(stdin|argv|stdout|stderr)-(\d+)$/.exec(handleId);
  if (match) {
    return {
      port: match[1] as PortKind,
      slot: Number(match[2]),
    };
  }
  return { port: handleId as PortKind };
}

function computeArgvSlots(nodeId: string, kind: NodeKind, edges: FlowEdge[]) {
  return nodeArgvSlots(nodeId, kind, edges, parseHandleId);
}

function computePreviewTabs(nodeId: string, kind: NodeKind, edges: FlowEdge[]) {
  return nodePreviewTabsForNode(nodeId, kind, edges, parseHandleId);
}

function syncNodeData(
  current: FlowNode[],
  runtime: Record<string, NodeRuntimeState>,
  generation: Record<string, AiGenerationState>,
  handlers: ShellNodeActions,
  edges: FlowEdge[],
  previewControlsLocation: Workspace["ui"]["previewControlsLocation"],
) {
  return current.map((node) => ({
    ...node,
    data: {
      ...node.data,
      model: node.data.model,
      runtime: runtime[node.id] ?? { running: false, portActivity: {} },
      generation: generation[node.id],
      selectionPreview: false,
      argvSlots: computeArgvSlots(node.id, node.data.model.kind, edges),
      previewTabs: computePreviewTabs(node.id, node.data.model.kind, edges),
      previewControlsLocation,
      onUpdate: handlers.onUpdate,
      onRun: handlers.onRun,
      getActionReason: handlers.getActionReason,
      onDelete: handlers.onDelete,
      onPickFile: handlers.onPickFile,
      onToggleAutorun: handlers.onToggleAutorun,
      onGenerate: handlers.onGenerate,
      onClearMaterialized: handlers.onClearMaterialized,
      onConvertKind: handlers.onConvertKind,
      onResizeWidth: handlers.onResizeWidth,
      onResizePaneHeight: handlers.onResizePaneHeight,
      onResizePaneWidth: handlers.onResizePaneWidth,
    },
  }));
}

function toFlowNode(
  node: WorkspaceNode,
  runtime: Record<string, NodeRuntimeState>,
  generation: Record<string, AiGenerationState>,
  handlers: Pick<
    ShellNodeActions,
    "onUpdate" | "onRun" | "getActionReason" | "onDelete" | "onPickFile" | "onToggleAutorun" | "onGenerate" | "onClearMaterialized" | "onConvertKind" | "onResizeWidth" | "onResizePaneHeight" | "onResizePaneWidth"
  >,
  edges: FlowEdge[],
  previewControlsLocation: Workspace["ui"]["previewControlsLocation"],
): FlowNode {
  return {
    id: node.id,
    type: "shell",
    position: node.position,
    data: {
      model: node,
      runtime: runtime[node.id] ?? { running: false, portActivity: {} },
      generation: generation[node.id],
      selectionPreview: false,
      argvSlots: computeArgvSlots(node.id, node.kind, edges),
      previewTabs: computePreviewTabs(node.id, node.kind, edges),
      previewControlsLocation,
      onUpdate: handlers.onUpdate,
      onRun: handlers.onRun,
      getActionReason: handlers.getActionReason,
      onDelete: handlers.onDelete,
      onPickFile: handlers.onPickFile,
      onToggleAutorun: handlers.onToggleAutorun,
      onGenerate: handlers.onGenerate,
      onClearMaterialized: handlers.onClearMaterialized,
      onConvertKind: handlers.onConvertKind,
      onResizeWidth: handlers.onResizeWidth,
      onResizePaneHeight: handlers.onResizePaneHeight,
      onResizePaneWidth: handlers.onResizePaneWidth,
    },
    // Width stays explicit so the important panes can share one horizontal source of truth.
    // Height is DOM-owned and persisted later from React Flow's measured snapshot.
    width: node.size.width,
    initialWidth: node.size.width,
    draggable: true,
    selectable: true,
    style: {
      width: node.size.width,
    },
  };
}

function toFlowEdge(
  edge: WorkspaceEdge,
  onDelete?: (edgeId: string) => void,
  onCycle?: (edgeId: string) => void,
): FlowEdge {
  return {
    id: edge.id,
    source: edge.from.nodeId,
    sourceHandle: formatHandleId(edge.from.port, edge.from.slot),
    target: edge.to.nodeId,
    targetHandle: formatHandleId(edge.to.port, edge.to.slot),
    type: "workspace",
    selectable: true,
    animated: edge.buffering === "unbuffered",
    data: { buffering: edge.buffering, onDelete, onCycle },
    label: edge.buffering.replaceAll("_", " "),
  };
}

function flowNodeToWorkspaceNode(node: FlowNode): WorkspaceNode {
  const model = node.data.model;
  return {
    ...model,
    position: node.position,
    // Persist the measured height as a snapshot for layout/save compatibility, but do not
    // feed it back into the rendered node. The browser owns live vertical layout now.
    size: {
      width: node.measured?.width ?? node.width ?? model.size.width,
      height: node.measured?.height ?? node.height ?? model.size.height,
    },
  };
}

function flowEdgeToWorkspaceEdge(edge: FlowEdge): WorkspaceEdge {
  return {
    id: edge.id,
    from: {
      nodeId: edge.source,
      ...parseHandleId(edge.sourceHandle as string | null | undefined),
    },
    to: {
      nodeId: edge.target,
      ...parseHandleId(edge.targetHandle as string | null | undefined),
    },
    buffering:
      (edge.data?.buffering as BufferingMode | undefined) ?? "unbuffered",
  };
}
function flowNodeToPersistedWorkspaceNode(
  node: FlowNode,
  runtime: Record<string, NodeRuntimeState>,
): WorkspaceNode {
  const model = flowNodeToWorkspaceNode(node);
  const runtimeState = runtime[node.id];
  const materializedValues = materializedValuesFromRuntime(runtimeState?.previews);
  return {
    ...model,
    materializedValues: runtimeState?.previews ? materializedValues : model.materializedValues,
  };
}


type ShellNodeActions = {
  onUpdate: (nodeId: string, patch: Partial<WorkspaceNode>) => void;
  onRun: (nodeId: string, action: ExecutionAction) => void;
  getActionReason: (nodeId: string, action: ExecutionAction) => string | null;
  onDelete: (nodeId: string) => void;
  onPickFile: (nodeId: string) => Promise<void>;
  onToggleAutorun: (nodeId: string, next: AutoRunConfig) => void;
  onGenerate: (nodeId: string) => Promise<void>;
  onClearMaterialized: (nodeId: string) => void;
  onConvertKind: (nodeId: string, kind: Extract<NodeKind, "display" | "passthru">) => void;
  onResizeWidth: (nodeId: string, width: number) => void;
  onResizePaneHeight: (nodeId: string, paneId: string, height: number) => void;
  onResizePaneWidth: (nodeId: string, paneId: string, width: number) => void;
};

type AutorunHandle = {
  signature: string;
  timerId: number;
};

function TuckspacePreview({ item }: { item: TuckedSubgraph }) {
  const layout = useMemo(() => {
    if (item.nodes.length === 0) {
      return { nodes: [], edges: [] };
    }
    const padding = 8;
    const innerWidth = 84;
    const innerHeight = 56;
    const minX = Math.min(...item.nodes.map((node) => node.position.x));
    const minY = Math.min(...item.nodes.map((node) => node.position.y));
    const maxX = Math.max(...item.nodes.map((node) => node.position.x + node.size.width));
    const maxY = Math.max(...item.nodes.map((node) => node.position.y + node.size.height));
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min(innerWidth / spanX, innerHeight / spanY);
    const nodes = item.nodes.map((node) => ({
      id: node.id,
      x: padding + (node.position.x - minX) * scale,
      y: padding + (node.position.y - minY) * scale,
      width: Math.max(8, node.size.width * scale),
      height: Math.max(8, node.size.height * scale),
    }));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges = item.edges.flatMap((edge) => {
      const from = nodeById.get(edge.from.nodeId);
      const to = nodeById.get(edge.to.nodeId);
      if (!from || !to) {
        return [];
      }
      const sourceOnRight = from.x + from.width / 2 <= to.x + to.width / 2;
      const startX = sourceOnRight ? from.x + from.width : from.x;
      const endX = sourceOnRight ? to.x : to.x + to.width;
      const startY = from.y + from.height / 2;
      const endY = to.y + to.height / 2;
      const midX = (startX + endX) / 2;
      return [{ id: edge.id, d: `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}` }];
    });
    return { nodes, edges };
  }, [item.edges, item.nodes]);

  return (
    <svg className="tuckspace-preview" viewBox="0 0 100 72" aria-hidden="true">
      {layout.edges.map((edge) => (
        <path key={edge.id} className="tuckspace-preview-edge" d={edge.d} />
      ))}
      {layout.nodes.map((node) => (
        <rect
          key={node.id}
          className="tuckspace-preview-node"
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          rx="4"
          ry="4"
        />
      ))}
    </svg>
  );
}


function TuckspaceCardBody({
  item,
  canPopulate,
  interactive,
  onRestore,
  onPopulate,
  onDeleteShell,
  onRename,
  onStartDrag,
}: {
  item: TuckedSubgraph;
  canPopulate: boolean;
  interactive: boolean;
  onRestore?: () => void;
  onPopulate?: () => void;
  onDeleteShell?: () => void;
  onRename?: (value: string) => void;
  onStartDrag?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const shell = isTuckspaceShell(item);
  return (
    <>
      {shell ? (
        <div className="tuckspace-shell-body" onPointerDown={interactive ? onStartDrag : undefined}>
          <button
            type="button"
            className="tuckspace-shell-action"
            onClick={onPopulate}
            disabled={!interactive || !canPopulate}
            title={canPopulate ? "Populate with subgraph" : "Select a closed subgraph first"}
          >
            →
          </button>
          <button
            type="button"
            className="tuckspace-shell-action tuckspace-shell-delete"
            onClick={onDeleteShell}
            disabled={!interactive}
            title="Delete tuckspace entry shell"
          >
            ×
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="tuckspace-restore"
          onPointerDown={interactive ? onStartDrag : undefined}
          onClick={onRestore}
          title="Move to workspace"
          disabled={!interactive}
        >
          <TuckspacePreview item={item} />
        </button>
      )}
      <span className="tuckspace-divider" aria-hidden="true" />
      <div className="tuckspace-footer">
        {interactive ? (
          <input
            className="tuckspace-name"
            value={item.name}
            onChange={(event) => onRename?.(event.target.value)}
            aria-label="tucked subgraph name"
          />
        ) : (
          <div className="tuckspace-name tuckspace-name-static">{item.name}</div>
        )}
      </div>
    </>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M10.9 2.1a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L6 13H3v-3l7.9-7.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m9.8 3.2 3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M1.5 8s2.3-4 6.5-4 6.5 4 6.5 4-2.3 4-6.5 4-6.5-4-6.5-4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3.5 4.5h9M6.2 2.5h3.6m-5 2 .5 8a1 1 0 0 0 1 .9h3.4a1 1 0 0 0 1-.9l.5-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6.7 6.4v4.2M9.3 6.4v4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SidebarPanel({
  id,
  label,
  collapsed,
  side,
  onToggle,
  onResizeStart,
  children,
}: {
  id: SidebarId;
  label: string;
  collapsed: boolean;
  side: "left" | "right";
  onToggle: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <aside className={`app-sidebar app-sidebar-${id}${collapsed ? " is-collapsed" : ""}`}>
      <button
        type="button"
        className="app-sidebar-header"
        onClick={onToggle}
        title={collapsed ? `expand ${label}` : `collapse ${label}`}
      >
        <span className="app-sidebar-title">{label}</span>
        <span className="app-sidebar-toggle" aria-hidden="true">
          {collapsed ? (side === "left" ? "›" : "‹") : side === "left" ? "‹" : "›"}
        </span>
      </button>
      {!collapsed && <div className="app-sidebar-body">{children}</div>}
      {!collapsed && (
        <div
          className={`app-sidebar-resizer app-sidebar-resizer-${side}`}
          onPointerDown={onResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label={`resize ${label}`}
        />
      )}
    </aside>
  );
}

function WorkspaceCanvas() {
  const [workspaceSummaries, setWorkspaceSummaries] = useState<WorkspaceSummary[]>([]);
  const [workspaceMeta, setWorkspaceMeta] = useState<Pick<
    Workspace,
    "id" | "name" | "createdAt" | "sortOrder" | "cwd" | "openaiApiKey" | "ui"
  > | null>(null);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const [sidebarUi, setSidebarUi] = useState<WorkspaceSidebars>(() => loadGlobalSidebarState());
  const [workspaceDeleteConfirmingId, setWorkspaceDeleteConfirmingId] = useState<string | null>(null);
  const [workspaceRenamingId, setWorkspaceRenamingId] = useState<string | null>(null);
  const [workspaceRenameDraft, setWorkspaceRenameDraft] = useState("");
  const [showOpenaiApiKey, setShowOpenaiApiKey] = useState(false);
  const [kernelConnected, setKernelConnected] = useState(false);
  const [generation, setGeneration] = useState<Record<string, AiGenerationState>>({});
  const [runtime, setRuntime] = useState<Record<string, NodeRuntimeState>>({});
  const [tuckspace, setTuckspace] = useState<TuckedSubgraph[]>([]);
  const [activeExecutions, setActiveExecutions] = useState<
    { execId: string; nodeId: string }[]
  >([]);
  const [tuckspaceQuery, setTuckspaceQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const socketRef = useRef<ReturnType<typeof connectKernel> | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const workspaceMetaRef = useRef<Pick<Workspace, "id" | "name" | "createdAt" | "sortOrder" | "cwd" | "openaiApiKey" | "ui"> | null>(
    null,
  );
  const handlersRef = useRef<ShellNodeActions | null>(null);
  const handlersFallback = useMemo<ShellNodeActions>(() => ({
    onUpdate: () => undefined,
    onRun: () => undefined,
    getActionReason: () => null,
    onDelete: () => undefined,
    onPickFile: async () => undefined,
    onToggleAutorun: () => undefined,
    onGenerate: async () => undefined,
    onClearMaterialized: () => undefined,
    onConvertKind: () => undefined,
    onResizeWidth: () => undefined,
    onResizePaneHeight: () => undefined,
    onResizePaneWidth: () => undefined,
  }), []);
  const sidebarUiRef = useRef<WorkspaceSidebars>(sidebarUi);
  const nodesRef = useRef<FlowNode[]>([]);
  const edgesRef = useRef<FlowEdge[]>([]);
  const autorunRef = useRef<Map<string, AutorunHandle>>(new Map());
  const runtimeRef = useRef<Record<string, NodeRuntimeState>>({});
  const persistTimerRef = useRef<number | null>(null);
  const layoutPersistTimerRef = useRef<number | null>(null);
  const generationRef = useRef<Record<string, AiGenerationState>>({});
  const tuckspaceRef = useRef<TuckedSubgraph[]>([]);
  const workspaceItemRefs = useRef(new Map<string, HTMLElement>());
  const tuckItemRefs = useRef(new Map<string, HTMLElement>());
  const runningStartedAtRef = useRef<Record<string, number>>({});
  const runningClearTimersRef = useRef<Map<string, number>>(new Map());

  const flow = useReactFlow<FlowNode, FlowEdge>();
  const userSelectionRect = useStore((store) => store.userSelectionRect);
  const userSelectionActive = useStore((store) => store.userSelectionActive);
  const viewportTransform = useStore((store) => store.transform);

  const [nodes, setNodes] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useEdgesState<FlowEdge>([]);

  useEffect(() => {
    workspaceMetaRef.current = workspaceMeta;
  }, [workspaceMeta]);

  useEffect(() => {
    if (!workspaceMeta?.id) {
      return;
    }
    saveGlobalActiveWorkspaceId(workspaceMeta.id);
    writeWorkspaceIdToUrl(workspaceMeta.id);
  }, [workspaceMeta?.id]);

  useEffect(() => {
    sidebarUiRef.current = sidebarUi;
  }, [sidebarUi]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  useEffect(() => {
    tuckspaceRef.current = tuckspace;
  }, [tuckspace]);

  useEffect(() => {
    const previewIds = userSelectionActive && userSelectionRect
      ? new Set(
          flow
            .getIntersectingNodes(
              selectionRectToFlowRect(userSelectionRect, viewportTransform),
              true,
              nodesRef.current,
            )
            .map((node) => node.id),
        )
      : null;
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const selectionPreview = previewIds?.has(node.id) ?? false;
        if (node.data.selectionPreview === selectionPreview) {
          return node;
        }
        changed = true;
        return {
          ...node,
          data: {
            ...node.data,
            selectionPreview,
          },
        };
      });
      return changed ? next : current;
    });
  }, [flow, setNodes, userSelectionActive, userSelectionRect, viewportTransform]);

  useEffect(() => {
    generationRef.current = generation;
  }, [generation]);

  useEffect(() => () => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    if (layoutPersistTimerRef.current !== null) {
      window.clearTimeout(layoutPersistTimerRef.current);
    }
  }, []);

  const buildWorkspace = useCallback(
    (
      nodesArg: FlowNode[] = nodesRef.current,
      edgesArg: FlowEdge[] = edgesRef.current,
      metaArg: Pick<
        Workspace,
        "id" | "name" | "createdAt" | "sortOrder" | "cwd" | "openaiApiKey" | "ui"
      > | null = workspaceMetaRef.current,
      runtimeArg: Record<string, NodeRuntimeState> = runtimeRef.current,
    ): Workspace | null => {
      if (!metaArg) {
        return null;
      }
      return {
        id: metaArg.id,
        name: metaArg.name,
        createdAt: metaArg.createdAt,
        sortOrder: metaArg.sortOrder,
        ui: metaArg.ui,
        cwd: metaArg.cwd,
        openaiApiKey: metaArg.openaiApiKey,
        nodes: nodesArg.map((node) => flowNodeToPersistedWorkspaceNode(node, runtimeArg)),
        edges: edgesArg.map(flowEdgeToWorkspaceEdge),
        tuckspace: [],
      };
    },
    [],
  );

  const persistSoon = useCallback(
    (nextNodes: FlowNode[], nextEdges: FlowEdge[]) => {
      const nextWorkspace = buildWorkspace(nextNodes, nextEdges);
      if (nextWorkspace) {
        saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
      }
    },
    [buildWorkspace],
  );

  const persistRuntimeSoon = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      const nextWorkspace = buildWorkspace();
      if (nextWorkspace) {
        saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
      }
      persistTimerRef.current = null;
    }, 150);
  }, [buildWorkspace]);

  const persistLayoutSoon = useCallback((nextNodes: FlowNode[], nextEdges: FlowEdge[]) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    if (layoutPersistTimerRef.current !== null) {
      window.clearTimeout(layoutPersistTimerRef.current);
    }
    layoutPersistTimerRef.current = window.setTimeout(() => {
      // Layout updates can arrive from multiple places in quick succession:
      // pane-height commits mutate `uiState.paneSizes`, while React Flow dimension
      // updates mutate measured node size. Persist from the latest refs so one
      // layout snapshot cannot clobber the other by racing as "last write wins".
      const nextWorkspace = buildWorkspace(nodesRef.current, edgesRef.current);
      if (nextWorkspace) {
        saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
      }
      layoutPersistTimerRef.current = null;
    }, 180);
  }, [buildWorkspace]);

  const updateWorkspaceApiKey = useCallback(
    (openaiApiKey: string) => {
      setWorkspaceMeta((current) => {
        if (!current) {
          return current;
        }
        const next = { ...current, openaiApiKey };
        const nextWorkspace = buildWorkspace(nodesRef.current, edgesRef.current, next);
        if (nextWorkspace) {
          saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
        }
        return next;
      });
    },
    [buildWorkspace],
  );


  const renameWorkspace = useCallback(
    async (workspaceId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        setWorkspaceRenamingId(null);
        setWorkspaceRenameDraft("");
        return;
      }
      if (workspaceMetaRef.current?.id === workspaceId) {
        setWorkspaceMeta((current) => {
          if (!current) {
            return current;
          }
          const next = { ...current, name: trimmed };
          const nextWorkspace = buildWorkspace(nodesRef.current, edgesRef.current, next);
          if (nextWorkspace) {
            saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
          }
          setWorkspaceSummaries((summaries) =>
            upsertWorkspaceSummary(summaries, { id: next.id, name: next.name, createdAt: next.createdAt, sortOrder: next.sortOrder }),
          );
          return next;
        });
      } else {
        try {
          const workspace = sanitizeWorkspace(await getWorkspace(workspaceId));
          const nextWorkspace = { ...workspace, name: trimmed };
          await saveWorkspace(nextWorkspace);
          setWorkspaceSummaries((summaries) =>
            upsertWorkspaceSummary(summaries, { id: workspaceId, name: trimmed, createdAt: workspace.createdAt, sortOrder: workspace.sortOrder }),
          );
        } catch (error) {
          setToast(String(error));
        }
      }
      setWorkspaceRenamingId(null);
      setWorkspaceRenameDraft("");
    },
    [buildWorkspace],
  );


  const updateSidebarUi = useCallback((updater: (sidebars: WorkspaceSidebars) => WorkspaceSidebars, persist = true) => {
    setSidebarUi((current) => {
      const next = updater(current);
      sidebarUiRef.current = next;
      if (persist) {
        saveGlobalSidebarState(next);
      }
      setWorkspaceMeta((currentMeta) => {
        if (!currentMeta) {
          return currentMeta;
        }
        return {
          ...currentMeta,
          ui: {
            ...currentMeta.ui,
            sidebars: next,
          },
        };
      });
      if (workspaceMetaRef.current) {
        workspaceMetaRef.current = {
          ...workspaceMetaRef.current,
          ui: {
            ...workspaceMetaRef.current.ui,
            sidebars: next,
          },
        };
      }
      return next;
    });
  }, []);

  const updateWorkspaceUi = useCallback(
    (
      updater: (ui: Workspace["ui"]) => Workspace["ui"],
      persist = false,
    ) => {
      setWorkspaceMeta((current) => {
        if (!current) {
          return current;
        }
        const next = { ...current, ui: updater(current.ui) };
        workspaceMetaRef.current = next;
        setNodes((nodesCurrent) =>
          syncNodeData(
            nodesCurrent,
            runtimeRef.current,
            generationRef.current,
            handlersRef.current ?? handlersFallback,
            edgesRef.current,
            next.ui.previewControlsLocation,
          ),
        );
        if (persist) {
          const nextWorkspace = buildWorkspace(nodesRef.current, edgesRef.current, next);
          if (nextWorkspace) {
            saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
          }
        }
        return next;
      });
    },
    [buildWorkspace, handlersFallback, setNodes],
  );

  const persistWorkspaceSnapshot = useCallback((
    nextNodes: FlowNode[],
    nextEdges: FlowEdge[],
    nextTuckspace: TuckedSubgraph[],
    nextRuntime: Record<string, NodeRuntimeState> = runtimeRef.current,
  ) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    tuckspaceRef.current = nextTuckspace;
    runtimeRef.current = nextRuntime;
    const nextWorkspace = buildWorkspace(nextNodes, nextEdges, workspaceMetaRef.current, nextRuntime);
    if (nextWorkspace) {
      saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
    }
    saveTuckspace(nextTuckspace).catch((error) => setToast(String(error)));
  }, [buildWorkspace]);

  const updateWorkspaceCwd = useCallback(
    (cwd: string) => {
      setWorkspaceMeta((current) => {
        if (!current) {
          return current;
        }
        const next = { ...current, cwd };
        const nextWorkspace = buildWorkspace(nodesRef.current, edgesRef.current, next);
        if (nextWorkspace) {
          saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
        }
        return next;
      });
    },
    [buildWorkspace],
  );

  const clearRunningTimer = useCallback((nodeId: string) => {
    const timerId = runningClearTimersRef.current.get(nodeId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      runningClearTimersRef.current.delete(nodeId);
    }
  }, []);

  // Keep nodes visually active for a short minimum duration so fast runs do not flicker.
  const scheduleRunningClear = useCallback((nodeId: string, execId: string) => {
    clearRunningTimer(nodeId);
    const startedAt = runningStartedAtRef.current[nodeId] ?? Date.now();
    const remaining = Math.max(0, 500 - (Date.now() - startedAt));
    if (remaining === 0) {
      return false;
    }
    const timerId = window.setTimeout(() => {
      setRuntime((current) => {
        const state = current[nodeId];
        if (!state || state.lastExecId !== execId) {
          return current;
        }
        return {
          ...current,
          [nodeId]: {
            ...state,
            running: false,
          },
        };
      });
      runningClearTimersRef.current.delete(nodeId);
    }, remaining);
    runningClearTimersRef.current.set(nodeId, timerId);
    return true;
  }, [clearRunningTimer]);

  const sendRunRequest = useCallback(
    (nodeId: string, action: ExecutionAction, silenceIfDisconnected = false) => {
      const workspace = buildWorkspace();
      if (!workspace) {
        return;
      }
      const event: ClientEvent = {
        type: "run_node",
        workspace,
        node_id: nodeId,
        action,
      };
      if (!socketRef.current?.ready) {
        if (!silenceIfDisconnected) {
          setToast("kernel websocket is not connected yet");
        }
        return;
      }
      socketRef.current.send(event);
    },
    [buildWorkspace],
  );

  const stopExecution = useCallback((execId: string) => {
    if (!socketRef.current?.ready) {
      setToast("kernel websocket is not connected yet");
      return;
    }
    socketRef.current.send({
      type: "stop_execution",
      exec_id: execId,
    });
  }, [persistRuntimeSoon]);

  const getActionReason = useCallback((nodeId: string, action: ExecutionAction) => {
    const node = nodesRef.current.find((item) => item.id === nodeId)?.data.model;
    if (!node) {
      return "node is unavailable";
    }
    if (action === "pull_inputs" || action === "pull_run") {
      return null;
    }
    if (action === "rerun" || action === "rerun_push") {
      const missing = missingConnectedInputs(
        node,
        edgesRef.current,
        runtimeRef.current[nodeId],
        parseHandleId,
      );
      return missing.length > 0 ? `missing materialized ${missing.join(", ")}` : null;
    }
    if (outputPortsForKind(node.kind).length === 0) {
      return "this node has no outputs to push";
    }
    const missing = missingOutputs(node, runtimeRef.current[nodeId]);
    return missing.length > 0 ? `missing materialized ${missing.join(", ")}` : null;
  }, []);

  const handlers: ShellNodeActions = useMemo(
    () => ({
      onUpdate: (nodeId, patch) => {
        setNodes((current) => {
          const next = current.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    model: {
                      ...node.data.model,
                      ...patch,
                    },
                  },
                  width: patch.size?.width ?? node.width,
                  style: {
                    ...node.style,
                    width: patch.size?.width ?? node.data.model.size.width,
                  },
                }
              : node,
          );
          persistSoon(next, edgesRef.current);
          return next;
        });
      },
      onRun: (nodeId, action) => {
        sendRunRequest(nodeId, action);
      },
      getActionReason,
      onDelete: (nodeId) => {
        setNodes((current) => {
          const next = current.filter((node) => node.id !== nodeId);
          const nextEdges = edgesRef.current.filter(
            (edge) => edge.source !== nodeId && edge.target !== nodeId,
          );
          setEdges(nextEdges);
          persistSoon(next, nextEdges);
          return next;
        });
      },
      onPickFile: async (nodeId) => {
        try {
          const result = await pickFilePath();
          setNodes((current) => {
            const next = current.map((node) =>
              node.id === nodeId
                ? {
                    ...node,
                    data: {
                      ...node.data,
                      model: {
                        ...node.data.model,
                        path: result.path,
                      },
                    },
                  }
                : node,
            );
            persistSoon(next, edgesRef.current);
            return next;
          });
        } catch (error) {
          setToast(String(error));
        }
      },
      onToggleAutorun: (nodeId, next) => {
        setNodes((current) => {
          const updated = current.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    model: {
                      ...node.data.model,
                      autoRun: next,
                    },
                  },
                }
              : node,
          );
          persistSoon(updated, edgesRef.current);
          return updated;
        });
      },
      onClearMaterialized: (nodeId) => {
        setRuntime((current) => ({
          ...current,
          [nodeId]: {
            ...(current[nodeId] ?? { running: false, portActivity: {} }),
            previews: {},
            livePreviews: undefined,
          },
        }));
        persistRuntimeSoon();
      },
      onConvertKind: (nodeId, kind) => {
        setNodes((current) => {
          let nextEdges = edgesRef.current;
          if (kind === "display") {
            nextEdges = edgesRef.current.filter((edge) => edge.source !== nodeId);
            setEdges(nextEdges);
          }
          const next = current.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    model: {
                      ...node.data.model,
                      kind,
                    },
                  },
                }
              : node,
          );
          persistSoon(next, nextEdges);
          return next;
        });
      },
      onResizeWidth: (nodeId, width) => {
        setNodes((current) => {
          const next = current.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  width,
                  style: {
                    ...node.style,
                    width,
                  },
                  data: {
                    ...node.data,
                    model: {
                      ...node.data.model,
                      size: {
                        ...node.data.model.size,
                        width,
                      },
                    },
                  },
                }
              : node,
          );
          persistLayoutSoon(next, edgesRef.current);
          return next;
        });
      },
      onResizePaneHeight: (nodeId, paneId, height) => {
        setNodes((current) => {
          const next = current.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    model: {
                      ...node.data.model,
                      uiState: nextPaneSizes(node.data.model.uiState, paneId, { height }),
                    },
                  },
                }
              : node,
          );
          persistLayoutSoon(next, edgesRef.current);
          return next;
        });
      },
      onResizePaneWidth: (nodeId, paneId, width) => {
        setNodes((current) => {
          const next = current.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    model: {
                      ...node.data.model,
                      uiState: nextPaneSizes(node.data.model.uiState, paneId, { width }),
                    },
                  },
                }
              : node,
          );
          persistLayoutSoon(next, edgesRef.current);
          return next;
        });
      },
      onGenerate: async (nodeId) => {
        const workspace = buildWorkspace();
        const node = nodesRef.current.find((item) => item.id === nodeId)?.data.model;
        if (!workspace || !node || node.kind !== "ai_script") {
          return;
        }
        setGeneration((current) => ({
          ...current,
          [nodeId]: { loading: true, error: null },
        }));
        try {
          const samples = collectAiScriptSamples(
            nodeId,
            runtimeRef.current[nodeId],
            edgesRef.current,
          );
          const result = await generateScript({
            workspace,
            nodeId,
            stdinSample: samples.stdinSample,
            argvSamples: samples.argvSamples,
          });
          setNodes((current) => {
            const next = current.map((flowNode) =>
              flowNode.id === nodeId
                ? {
                    ...flowNode,
                    data: {
                      ...flowNode.data,
                      model: {
                        ...flowNode.data.model,
                        script: result.script,
                      },
                    },
                  }
                : flowNode,
            );
            persistSoon(next, edgesRef.current);
            return next;
          });
          setGeneration((current) => ({
            ...current,
            [nodeId]: { loading: false, error: null },
          }));
        } catch (error) {
          setGeneration((current) => ({
            ...current,
            [nodeId]: { loading: false, error: String(error) },
          }));
        }
      },
    }),
    [getActionReason, persistLayoutSoon, persistSoon, sendRunRequest, setNodes],
  );

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    setNodes((current) =>
      syncNodeData(current, runtime, generationRef.current, handlers, edgesRef.current, workspaceMetaRef.current?.ui.previewControlsLocation ?? "node"),
    );
  }, [edges, generation, handlers, runtime, setNodes]);

  useEffect(() => {
    const connection = connectKernel(
      (event) => {
        if (event.type === "exec_started") {
          setActiveExecutions((current) =>
            current.some((entry) => entry.execId === event.exec_id)
              ? current
              : [...current, { execId: event.exec_id, nodeId: event.node_id }],
          );
        } else if (
          event.type === "exec_finished" ||
          event.type === "execution_stopped"
        ) {
          setActiveExecutions((current) =>
            current.filter((entry) => entry.execId !== event.exec_id),
          );
        }

        setRuntime((current) => {
          switch (event.type) {
            case "exec_started": {
              clearRunningTimer(event.node_id);
              runningStartedAtRef.current[event.node_id] = Date.now();
              const node = nodesRef.current.find((item) => item.id === event.node_id)?.data.model;
              // Keep the last committed materialized outputs intact until this execution finishes successfully.
              const previousLive = current[event.node_id]?.livePreviews ?? {};
              const nextLive = { ...previousLive };
              if (node) {
                for (const port of previewOutputPortsForKind(node.kind)) {
                  nextLive[port] = { bytes: new Uint8Array(), completed: false };
                }
              }
              return {
                ...current,
                [event.node_id]: {
                  ...(current[event.node_id] ?? {
                    running: false,
                    portActivity: {},
                  }),
                  running: true,
                  lastExecId: event.exec_id,
                  livePreviews: nextLive,
                },
              };
            }
            case "exec_finished": {
              const node = nodesRef.current.find((item) => item.id === event.node_id)?.data.model;
              const previous = current[event.node_id] ?? {
                running: false,
                portActivity: {},
              };
              const committed = { ...(previous.previews ?? {}) };
              const live = { ...(previous.livePreviews ?? {}) };
              if (node) {
                for (const port of previewOutputPortsForKind(node.kind)) {
                  const candidate = live[port];
                  if (event.exit_code === 0 && candidate) {
                    committed[port] = { ...candidate, completed: true };
                  }
                  delete live[port];
                }
              }
              const keepRunning = scheduleRunningClear(event.node_id, event.exec_id);
              return {
                ...current,
                [event.node_id]: {
                  ...previous,
                  running: keepRunning ? true : false,
                  previews: committed,
                  livePreviews: Object.keys(live).length > 0 ? live : undefined,
                },
              };
            }
            case "port_activity":
              return {
                ...current,
                [event.node_id]: {
                  ...(current[event.node_id] ?? {
                    running: false,
                    portActivity: {},
                  }),
                  portActivity: {
                    ...(current[event.node_id]?.portActivity ?? {}),
                    [event.port]: event.timestamp,
                  },
                },
              };
            case "node_output": {
              return {
                ...current,
                [event.node_id]: {
                  ...(current[event.node_id] ?? {
                    running: false,
                    portActivity: {},
                  }),
                  livePreviews: applyNodeOutputEvent(current[event.node_id]?.livePreviews, event),
                },
              };
            }
            case "stream_chunk": {
              const targetExists = nodesRef.current.some((node) => node.id === event.to_node_id);
              if (!targetExists) {
                return current;
              }
              const nextBytes = fromBase64(event.data_base64);
              const targetHandle = edgesRef.current.find((edge) => edge.id === event.edge_id)
                ?.targetHandle as string | null | undefined;
              const parsed = parseHandleId(targetHandle);
              const previewKey = parsed.port === "argv" ? `argv-${parsed.slot ?? 1}` : "stdin";
              const previousState = current[event.to_node_id] ?? {
                running: false,
                portActivity: {},
              };
              const previousLive = event.reset
                ? new Uint8Array()
                : previousState.livePreviews?.[previewKey]?.bytes ?? new Uint8Array();
              const livePreviews = {
                ...(previousState.livePreviews ?? {}),
                [previewKey]: {
                  bytes: concatBytes(previousLive, nextBytes),
                  completed: Boolean(event.completed),
                },
              };
              const committed = { ...(previousState.previews ?? {}) };
              // Input streams commit into materialized state only when the edge closes successfully.
              if (event.completed) {
                if (event.success !== false) {
                  committed[previewKey] = { ...livePreviews[previewKey], completed: true };
                }
                delete livePreviews[previewKey];
              }
              return {
                ...current,
                [event.to_node_id]: {
                  ...previousState,
                  previews: committed,
                  livePreviews: Object.keys(livePreviews).length > 0 ? livePreviews : undefined,
                },
              };
            }

            case "display_update":
              return current;
            case "execution_stopped": {
              const nextState = { ...current };
              for (const [nodeId, state] of Object.entries(current)) {
                if (state.lastExecId === event.exec_id) {
                  const keepRunning = scheduleRunningClear(nodeId, event.exec_id);
                  nextState[nodeId] = {
                    ...state,
                    running: keepRunning ? true : false,
                    livePreviews: undefined,
                  };
                }
              }
              return nextState;
            }
            case "error":
              setToast(event.message);
              return current;
            default:
              return current;
          }
        });
        if (event.type !== "error") {
          persistRuntimeSoon();
        }
      },
      () => setKernelConnected(false),
    );
    socketRef.current = connection;
    connection.onOpen(() => setKernelConnected(true));
    return () => connection.close();
  }, []);

  useEffect(() => {
    const desired = new Map(
      nodes
        .map((node) => [node.id, node.data.model.autoRun] as const)
        .filter((entry): entry is [string, AutoRunConfig] =>
          Boolean(entry[1]?.enabled),
        ),
    );
    const active = autorunRef.current;

    for (const [nodeId, handle] of active.entries()) {
      if (!desired.has(nodeId)) {
        window.clearInterval(handle.timerId);
        active.delete(nodeId);
      }
    }

    for (const [nodeId, config] of desired.entries()) {
      const signature = `${config.mode}:${config.intervalMs}`;
      const existing = active.get(nodeId);
      if (existing?.signature === signature) {
        continue;
      }
      if (existing) {
        window.clearInterval(existing.timerId);
      }
      const timerId = window.setInterval(
        () => {
          sendRunRequest(nodeId, config.mode, true);
        },
        Math.max(config.intervalMs, 100),
      );
      active.set(nodeId, { signature, timerId });
    }
  }, [nodes, sendRunRequest]);

  useEffect(() => {
    return () => {
      for (const handle of autorunRef.current.values()) {
        window.clearInterval(handle.timerId);
      }
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
      autorunRef.current.clear();
      for (const timerId of runningClearTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      runningClearTimersRef.current.clear();
    };
  }, []);


  useEffect(() => {
    if (!toast) {
      return;
    }
    const handle = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(handle);
  }, [toast]);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes((current) => {
        const next = applyNodeChanges(changes, current);
        const shouldPersistImmediately = changes.some((change) => {
          if (change.type === "position") {
            return !change.dragging;
          }
          return change.type !== "select" && change.type !== "dimensions";
        });
        const shouldPersistLayout = changes.some(
          (change) => change.type === "dimensions" && !change.resizing,
        );
        if (shouldPersistImmediately) {
          persistSoon(next, edgesRef.current);
        }
        if (shouldPersistLayout) {
          persistLayoutSoon(next, edgesRef.current);
        }
        return next;
      });
    },
    [persistLayoutSoon, persistSoon, setNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      setEdges((current) => {
        const next = applyEdgeChanges(changes, current);
        setNodes((nodesCurrent) =>
          syncNodeData(nodesCurrent, runtime, generationRef.current, handlers, next, workspaceMetaRef.current?.ui.previewControlsLocation ?? "node"),
        );
        const shouldPersist = changes.some(
          (change) => change.type !== "select",
        );
        if (shouldPersist) {
          persistSoon(nodesRef.current, next);
        }
        return next;
      });
    },
    [handlers, persistSoon, setEdges, setNodes],
  );

  const deleteEdge = useCallback(
    (edgeId: string) => {
      setEdges((current) => {
        const next = current.filter((edge) => edge.id !== edgeId);
        setNodes((nodesCurrent) =>
          syncNodeData(nodesCurrent, runtime, generationRef.current, handlers, next, workspaceMetaRef.current?.ui.previewControlsLocation ?? "node"),
        );
        persistSoon(nodesRef.current, next);
        return next;
      });
    },
    [handlers, persistSoon, setEdges, setNodes],
  );

  const cycleEdgeBuffering = useCallback(
    (edgeId: string) => {
      const nextMode: Record<BufferingMode, BufferingMode> = {
        unbuffered: "line_or_1024",
        line_or_1024: "on_complete",
        on_complete: "unbuffered",
      };
      setEdges((current) => {
        const next = current.map((edge) => {
          if (edge.id !== edgeId) {
            return edge;
          }
          const buffering =
            nextMode[
              (edge.data?.buffering as BufferingMode | undefined) ??
                "unbuffered"
            ];
          return {
            ...edge,
            data: {
              buffering,
              onDelete: deleteEdge,
              onCycle: cycleEdgeBuffering,
            },
            animated: buffering === "unbuffered",
            label: buffering.replaceAll("_", " "),
          };
        });
        setNodes((nodesCurrent) =>
          syncNodeData(nodesCurrent, runtime, generationRef.current, handlers, next, workspaceMetaRef.current?.ui.previewControlsLocation ?? "node"),
        );
        persistSoon(nodesRef.current, next);
        return next;
      });
    },
    [handlers, persistSoon, setEdges, setNodes],
  );

  const cancelPendingWorkspaceSaves = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (layoutPersistTimerRef.current !== null) {
      window.clearTimeout(layoutPersistTimerRef.current);
      layoutPersistTimerRef.current = null;
    }
  }, []);

  // Workspace switches must flush any debounced saves first so delayed timers do not
  // persist the old canvas into the newly selected workspace id.
  const flushPendingWorkspaceSave = useCallback(async () => {
    cancelPendingWorkspaceSaves();
    const nextWorkspace = buildWorkspace();
    if (nextWorkspace) {
      await saveWorkspace(nextWorkspace);
    }
  }, [buildWorkspace, cancelPendingWorkspaceSaves]);

  const applyLoadedWorkspace = useCallback((loaded: Workspace) => {
    const workspaceUi =
      loaded.ui.viewportX === 0 &&
      loaded.ui.viewportY === 0 &&
      loaded.ui.zoom === 1
        ? { ...loaded.ui, zoom: 0.5 }
        : loaded.ui;
    // Sidebar chrome is global UI state, so workspace loads keep the current
    // shared sidebar settings instead of reviving per-workspace sidebar state.
    const ui = { ...workspaceUi, sidebars: sidebarUiRef.current };
    const nextMeta = {
      id: loaded.id,
      name: loaded.name,
      createdAt: loaded.createdAt,
      sortOrder: loaded.sortOrder,
      cwd: loaded.cwd,
      openaiApiKey: loaded.openaiApiKey,
      ui,
    };
    const loadedRuntime = Object.fromEntries(
      loaded.nodes.map((node) => [
        node.id,
        {
          running: false,
          portActivity: {},
          previews: runtimePreviewsFromNode(node),
        },
      ]),
    );
    const loadedEdges = loaded.edges.map((edge) =>
      toFlowEdge(edge, deleteEdge, cycleEdgeBuffering),
    );
    const loadedNodes = loaded.nodes.map((node) =>
      toFlowNode(node, loadedRuntime, {}, handlers, loadedEdges, loaded.ui.previewControlsLocation),
    );

    for (const handle of autorunRef.current.values()) {
      window.clearInterval(handle.timerId);
    }
    autorunRef.current.clear();
    for (const timerId of runningClearTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    runningClearTimersRef.current.clear();
    runningStartedAtRef.current = {};

    workspaceMetaRef.current = nextMeta;
    nodesRef.current = loadedNodes;
    edgesRef.current = loadedEdges;
    runtimeRef.current = loadedRuntime;

    setWorkspaceSummaries((current) =>
      upsertWorkspaceSummary(current, { id: loaded.id, name: loaded.name, createdAt: loaded.createdAt, sortOrder: loaded.sortOrder }),
    );
    setWorkspaceMeta(nextMeta);
    setGeneration({});
    setRuntime(loadedRuntime);
    setActiveExecutions([]);
    setWorkspaceDeleteConfirmingId(null);
    setWorkspaceRenamingId(null);
    setWorkspaceRenameDraft("");
    setTuckspaceQuery("");
    setNodes(loadedNodes);
    setEdges(loadedEdges);

    // React Flow only applies `defaultViewport` on first mount, so switching
    // workspaces has to push the saved viewport back in imperatively.
    window.requestAnimationFrame(() => {
      void flow.setViewport({ x: ui.viewportX, y: ui.viewportY, zoom: ui.zoom }, { duration: 0 });
    });
  }, [cycleEdgeBuffering, deleteEdge, flow, handlers, setEdges, setNodes]);

  const loadWorkspaceIntoCanvas = useCallback(async (workspaceId: string) => {
    if (workspaceMetaRef.current?.id === workspaceId) {
      return;
    }
    if (activeExecutions.length > 0) {
      setToast("stop active executions before switching workspaces");
      return;
    }
    setWorkspaceSwitching(true);
    try {
      await flushPendingWorkspaceSave();
      applyLoadedWorkspace(sanitizeWorkspace(await getWorkspace(workspaceId)));
    } catch (error) {
      setToast(String(error));
    } finally {
      setWorkspaceSwitching(false);
    }
  }, [activeExecutions.length, applyLoadedWorkspace, flushPendingWorkspaceSave]);

  const createAndLoadWorkspace = useCallback(async () => {
    if (activeExecutions.length > 0) {
      setToast("stop active executions before creating a workspace");
      return;
    }
    setWorkspaceSwitching(true);
    try {
      await flushPendingWorkspaceSave();
      const created = sanitizeWorkspace(await createWorkspace());
      applyLoadedWorkspace(created);
    } catch (error) {
      setToast(String(error));
    } finally {
      setWorkspaceSwitching(false);
    }
  }, [activeExecutions.length, applyLoadedWorkspace, flushPendingWorkspaceSave]);


  const confirmDeleteWorkspace = useCallback(async (workspaceId: string) => {
    if (activeExecutions.length > 0) {
      setToast("stop active executions before deleting a workspace");
      return;
    }
    setWorkspaceSwitching(true);
    setWorkspaceDeleteConfirmingId(null);
    setWorkspaceRenamingId(null);
    setWorkspaceRenameDraft("");
    try {
      const deletingActive = workspaceMetaRef.current?.id === workspaceId;
      if (deletingActive) {
        cancelPendingWorkspaceSaves();
      }
      const remainingSummaries = workspaceSummaries.filter((workspace) => workspace.id !== workspaceId);
      await deleteWorkspace(workspaceId);
      if (!deletingActive) {
        setWorkspaceSummaries(remainingSummaries);
        return;
      }
      if (remainingSummaries.length === 0) {
        const created = sanitizeWorkspace(await createWorkspace());
        applyLoadedWorkspace(created);
        return;
      }
      setWorkspaceSummaries(remainingSummaries);
      applyLoadedWorkspace(sanitizeWorkspace(await getWorkspace(remainingSummaries[0].id)));
    } catch (error) {
      setToast(String(error));
    } finally {
      setWorkspaceSwitching(false);
    }
  }, [activeExecutions.length, applyLoadedWorkspace, cancelPendingWorkspaceSaves, workspaceSummaries]);

  const beginWorkspaceRename = useCallback((workspaceId: string, currentName: string) => {
    setWorkspaceDeleteConfirmingId(null);
    setWorkspaceRenamingId(workspaceId);
    setWorkspaceRenameDraft(currentName);
  }, []);

  const requestWorkspaceDelete = useCallback((workspaceId: string) => {
    setWorkspaceRenamingId(null);
    setWorkspaceRenameDraft("");
    setWorkspaceDeleteConfirmingId((current) => (current === workspaceId ? null : workspaceId));
  }, []);

  const toggleSidebar = useCallback((id: SidebarId) => {
    updateSidebarUi((sidebars) => ({
      ...sidebars,
      [id]: {
        ...sidebars[id],
        collapsed: !sidebars[id].collapsed,
      },
    }));
  }, [updateSidebarUi]);

  const persistSidebarWidth = useCallback((id: SidebarId, width: number) => {
    updateSidebarUi((sidebars) => ({
      ...sidebars,
      [id]: {
        ...sidebars[id],
        width,
      },
    }));
  }, [updateSidebarUi]);

  const startSidebarResize = useCallback((id: SidebarId, side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startClientX = event.clientX;
    const startWidth = sidebarUiRef.current[id].width;

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startClientX;
      const width = Math.max(
        SIDEBAR_MIN_WIDTH[id],
        Math.round(startWidth + (side === "left" ? delta : -delta)),
      );
      updateSidebarUi((sidebars) => ({
        ...sidebars,
        [id]: {
          ...sidebars[id],
          width,
        },
      }), false);
    };

    const finish = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      persistSidebarWidth(id, sidebarUiRef.current[id].width);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [persistSidebarWidth, updateSidebarUi]);

  useEffect(() => {
    let disposed = false;

    const loadInitialWorkspace = async () => {
      setWorkspaceSwitching(true);
      try {
        const summaries = sortWorkspaceSummaries(await listWorkspaces());
        if (disposed) {
          return;
        }
        setWorkspaceDeleteConfirmingId(null);
        setWorkspaceSummaries(summaries);
        const initialWorkspaceId = chooseInitialWorkspaceId(
          summaries,
          readWorkspaceIdFromUrl(),
          loadGlobalActiveWorkspaceId(),
        );
        const [sharedTuckspace, loadedWorkspace] = await Promise.all([
          getTuckspace(),
          initialWorkspaceId ? getWorkspace(initialWorkspaceId) : createWorkspace(),
        ]);
        const loaded = sanitizeWorkspace(loadedWorkspace);
        if (disposed) {
          return;
        }
        setTuckspace(sharedTuckspace);
        tuckspaceRef.current = sharedTuckspace;
        applyLoadedWorkspace(loaded);
      } catch (error) {
        if (!disposed) {
          setToast(String(error));
        }
      } finally {
        if (!disposed) {
          setWorkspaceSwitching(false);
        }
      }
    };

    void loadInitialWorkspace();

    return () => {
      disposed = true;
    };
  }, [applyLoadedWorkspace]);

  const onConnect = useCallback(
    (connection: Connection) => {
      const targetNode = nodesRef.current.find(
        (node) => node.id === connection.target,
      );
      const sourceNode = nodesRef.current.find(
        (node) => node.id === connection.source,
      );
      const targetHandle = parseHandleId(connection.targetHandle);
      const targetPort = targetHandle.port;
      const hasExistingPortWire = edgesRef.current.some((edge) => {
        if (edge.target !== connection.target) {
          return false;
        }
        const edgeTarget = parseHandleId(
          edge.targetHandle as string | null | undefined,
        );
        return edgeTarget.port === targetPort;
      });
      const hasExistingTargetHandle = edgesRef.current.some(
        (edge) =>
          edge.target === connection.target &&
          edge.targetHandle === connection.targetHandle,
      );
      if (targetNode && targetPort === "argv" && !nodeHasArgvPort(targetNode.data.model.kind)) {
        setToast("this node does not accept argv input");
        return;
      }
      if (targetPort === "argv" && hasExistingTargetHandle) {
        setToast("argv ports allow one wire each; use the next free port");
        return;
      }
      if (
        targetNode &&
        targetPort === "stdin" &&
        hasExistingPortWire
      ) {
        setToast("non-merge nodes only accept one stdin wire");
        return;
      }
      if (
        targetNode &&
        targetPort !== "stdin" &&
        targetPort !== "argv" &&
        hasExistingPortWire
      ) {
        setToast(`nodes only accept one ${targetPort} wire`);
        return;
      }
      setEdges((current) => {
        const next = addEdge(
          {
            id: encodeId("edge"),
            ...connection,
            type: "workspace",
            data: {
              buffering: "unbuffered",
              onDelete: deleteEdge,
              onCycle: cycleEdgeBuffering,
            },
            label: "unbuffered",
          },
          current,
        ) as FlowEdge[];
        setNodes((nodesCurrent) =>
          syncNodeData(nodesCurrent, runtime, generationRef.current, handlers, next, workspaceMetaRef.current?.ui.previewControlsLocation ?? "node"),
        );
        persistSoon(nodesRef.current, next);
        return next;
      });
    },
    [handlers, persistSoon, setEdges, setNodes],
  );

  const addNode = useCallback(
    (kind: NodeKind) => {
      const canvasBounds = canvasRef.current?.getBoundingClientRect();
      const centeredPosition = canvasBounds
        ? flow.screenToFlowPosition({
            x: canvasBounds.left + canvasBounds.width / 2,
            y: canvasBounds.top + canvasBounds.height / 2,
          })
        : null;
      setNodes((current) => {
        const nextNodeModel = makeNode(kind, current.length + 1);
        const desiredPosition = centeredPosition ?? nextNodeModel.position;
        nextNodeModel.position = chooseNodePosition(
          desiredPosition,
          nextNodeModel.size,
          current.map((node) => ({
            position: node.position,
            size: {
              width: node.width ?? node.data.model.size.width,
              height: node.measured?.height ?? node.height ?? node.data.model.size.height,
            },
          })),
        );
        const nextNode = toFlowNode(
          nextNodeModel,
          runtime,
          generationRef.current,
          handlers,
          edgesRef.current,
          workspaceMetaRef.current?.ui.previewControlsLocation ?? "node",
        );
        const next = [...current, nextNode];
        persistSoon(next, edgesRef.current);
        return next;
      });
    },
    [flow, handlers, persistSoon, runtime, setNodes],
  );

  const renameTuckedSubgraph = useCallback((tuckId: string, name: string) => {
    const nextTuckspace = tuckspaceRef.current.map((item) => (item.id === tuckId ? { ...item, name, userNamed: true } : item));
    setTuckspace(nextTuckspace);
    persistWorkspaceSnapshot(nodesRef.current, edgesRef.current, nextTuckspace);
  }, [persistWorkspaceSnapshot]);

  const moveSelectionToTuckspace = useCallback((targetShellId?: string) => {
    const selectedIds = new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id));
    if (!isClosedSelection(selectedIds, edgesRef.current)) {
      return;
    }
    const tuckedNodes = nodesRef.current
      .filter((node) => selectedIds.has(node.id))
      .map((node) => flowNodeToPersistedWorkspaceNode(node, runtimeRef.current));
    const tuckedEdges = edgesRef.current
      .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
      .map(flowEdgeToWorkspaceEdge);
    const nextTuckspace = storeTuckedSubgraph(tuckspaceRef.current, tuckedNodes, tuckedEdges, targetShellId);
    const nextNodes = nodesRef.current.filter((node) => !selectedIds.has(node.id));
    const nextEdges = edgesRef.current.filter(
      (edge) => !selectedIds.has(edge.source) && !selectedIds.has(edge.target),
    );
    const nextRuntime = Object.fromEntries(
      Object.entries(runtimeRef.current).filter(([nodeId]) => !selectedIds.has(nodeId)),
    );
    for (const nodeId of selectedIds) {
      clearRunningTimer(nodeId);
    }
    setGeneration((current) => Object.fromEntries(
      Object.entries(current).filter(([nodeId]) => !selectedIds.has(nodeId)),
    ));
    setActiveExecutions((current) => current.filter((entry) => !selectedIds.has(entry.nodeId)));
    setTuckspace(nextTuckspace);
    setRuntime(nextRuntime);
    setEdges(nextEdges);
    setNodes(nextNodes);
    persistWorkspaceSnapshot(nextNodes, nextEdges, nextTuckspace, nextRuntime);
  }, [clearRunningTimer, persistWorkspaceSnapshot, setEdges, setNodes]);

  const untuckSubgraph = useCallback((tuckId: string) => {
    const item = tuckspaceRef.current.find((entry) => entry.id === tuckId);
    if (!item) {
      return;
    }
    const existingNodeIds = new Set(nodesRef.current.map((node) => node.id));
    const existingEdgeIds = new Set(edgesRef.current.map((edge) => edge.id));
    if (item.nodes.some((node) => existingNodeIds.has(node.id)) || item.edges.some((edge) => existingEdgeIds.has(edge.id))) {
      setToast('cannot restore subgraph: ids already exist in this workspace');
      return;
    }
    const canvasBounds = canvasRef.current?.getBoundingClientRect();
    const viewportCenter = canvasBounds
      ? flow.screenToFlowPosition({
          x: canvasBounds.left + canvasBounds.width / 2,
          y: canvasBounds.top + canvasBounds.height / 2,
        })
      : null;
    // Restored subgraphs should appear where the user is currently looking, not at their old absolute coordinates.
    const restoredModels = viewportCenter ? recenterTuckedNodes(item.nodes, viewportCenter) : item.nodes;
    const nextTuckspace = shouldKeepShellOnRestore(item)
      ? tuckspaceRef.current.map((entry) => (entry.id === tuckId ? emptyTuckedSubgraph(entry) : entry))
      : tuckspaceRef.current.filter((entry) => entry.id !== tuckId);
    const restoredRuntime = Object.fromEntries(
      restoredModels.map((node) => [
        node.id,
        {
          running: false,
          portActivity: {},
          previews: runtimePreviewsFromNode(node),
        },
      ]),
    );
    const nextRuntime = {
      ...runtimeRef.current,
      ...restoredRuntime,
    };
    const restoredEdges = item.edges.map((edge) => toFlowEdge(edge, deleteEdge, cycleEdgeBuffering));
    const nextEdges = [...edgesRef.current, ...restoredEdges];
    const preservedNodes = nodesRef.current.map((node) => ({ ...node, selected: false }));
    const restoredNodes = restoredModels.map((node) => ({
      ...toFlowNode(node, nextRuntime, generationRef.current, handlers, nextEdges, workspaceMetaRef.current?.ui.previewControlsLocation ?? "node"),
      selected: true,
    }));
    const nextNodes = [...preservedNodes, ...restoredNodes];
    setTuckspace(nextTuckspace);
    setRuntime(nextRuntime);
    setEdges(nextEdges);
    setNodes(nextNodes);
    persistWorkspaceSnapshot(nextNodes, nextEdges, nextTuckspace, nextRuntime);
  }, [cycleEdgeBuffering, deleteEdge, flow, handlers, persistWorkspaceSnapshot, setEdges, setNodes]);

  const reorderTuckedSubgraphs = useCallback((draggedId: string, targetId: string, position: "before" | "after") => {
    const nextTuckspace = reorderTuckspaceWithPlacement(tuckspaceRef.current, draggedId, targetId, position);
    if (nextTuckspace.every((item, index) => item.id === tuckspaceRef.current[index]?.id)) {
      return;
    }
    setTuckspace(nextTuckspace);
    persistWorkspaceSnapshot(nodesRef.current, edgesRef.current, nextTuckspace);
  }, [persistWorkspaceSnapshot]);

  const reorderWorkspaceList = useCallback((draggedId: string, targetId: string, position: "before" | "after") => {
    const nextSummaries = reorderItemsWithPlacement(workspaceSummaries, draggedId, targetId, position).map((workspace, index) => ({
      ...workspace,
      sortOrder: index,
    }));
    if (nextSummaries.every((item, index) => item.id === workspaceSummaries[index]?.id)) {
      return;
    }
    setWorkspaceSummaries(nextSummaries);
    setWorkspaceMeta((current) =>
      current
        ? {
            ...current,
            sortOrder: nextSummaries.find((workspace) => workspace.id === current.id)?.sortOrder ?? current.sortOrder,
          }
        : current,
    );
    if (workspaceMetaRef.current) {
      workspaceMetaRef.current = {
        ...workspaceMetaRef.current,
        sortOrder: nextSummaries.find((workspace) => workspace.id === workspaceMetaRef.current?.id)?.sortOrder ?? workspaceMetaRef.current.sortOrder,
      };
    }
    reorderWorkspaces(nextSummaries.map((workspace) => workspace.id)).catch(async (error) => {
      setToast(String(error));
      try {
        setWorkspaceSummaries(sortWorkspaceSummaries(await listWorkspaces()));
      } catch (refreshError) {
        setToast(String(refreshError));
      }
    });
  }, [workspaceSummaries]);

  const selectedNodes = useMemo(
    () => nodes.filter((node) => node.selected),
    [nodes],
  );
  const selectedEdges = useMemo(
    () => edges.filter((edge) => edge.selected),
    [edges],
  );
  const selectedNodeIds = useMemo(
    () => new Set(selectedNodes.map((node) => node.id)),
    [selectedNodes],
  );
  const selectedEdgeIds = useMemo(
    () => new Set(selectedEdges.map((edge) => edge.id)),
    [selectedEdges],
  );
  const canTuckSelection = useMemo(
    () => isClosedSelection(selectedNodeIds, edges),
    [edges, selectedNodeIds],
  );
  const tuckDisabledReason = selectedNodeIds.size === 0
    ? 'select a subgraph first'
    : canTuckSelection
      ? null
      : 'selection must be closed before tucking';

  const tuckspaceShells = useMemo(
    () => tuckspace.filter((item) => isTuckspaceShell(item) && item.userNamed),
    [tuckspace],
  );


  const selectionActionsStyle = useMemo(() => {
    if (selectedNodes.length === 0 && selectedEdges.length === 0) {
      return null;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return { top: 16, right: 16 } as const;
    }
    const [viewportX, viewportY, zoom] = viewportTransform;
    const minY = Math.min(...selectedNodes.map((node) => node.position.y));
    const maxX = Math.max(...selectedNodes.map((node) => node.position.x + (node.measured?.width ?? node.width ?? node.data.model.size.width)));
    const screenTop = minY * zoom + viewportY;
    const screenRight = maxX * zoom + viewportX;
    const anchorLeft = screenRight + 12;
    const stickyTop = screenTop < 16;
    const stickyRight = anchorLeft > canvas.clientWidth - 180;

    return {
      top: stickyTop ? 16 : Math.max(16, screenTop),
      ...(stickyRight ? { right: 16 } : { left: anchorLeft }),
    } as const;
  }, [selectedEdges.length, selectedNodes, viewportTransform]);

  const deleteTuckShell = useCallback((tuckId: string) => {
    const nextTuckspace = tuckspaceRef.current.filter((item) => item.id !== tuckId);
    setTuckspace(nextTuckspace);
    persistWorkspaceSnapshot(nodesRef.current, edgesRef.current, nextTuckspace);
  }, [persistWorkspaceSnapshot]);

  const visibleTuckspace = useMemo(() => {
    const query = tuckspaceQuery.trim().toLowerCase();
    if (!query) {
      return tuckspace;
    }
    return tuckspace.filter((item) => item.name.toLowerCase().includes(query));
  }, [tuckspace, tuckspaceQuery]);

  const workspaceReorder = useVerticalReorderDrag({
    itemIds: workspaceSummaries.map((workspace) => workspace.id),
    itemRefs: workspaceItemRefs,
    onReorder: reorderWorkspaceList,
  });

  const tuckReorder = useVerticalReorderDrag({
    itemIds: visibleTuckspace.map((item) => item.id),
    itemRefs: tuckItemRefs,
    onReorder: reorderTuckedSubgraphs,
    bodyClassName: "is-tuck-dragging",
  });

  const startDragWorkspace = useCallback((workspaceId: string, event: React.PointerEvent<HTMLElement>) => {
    workspaceReorder.startDrag(
      workspaceId,
      event,
      event.currentTarget.closest(".workspace-list-item") as HTMLElement | null,
    );
  }, [workspaceReorder]);

  const maybeUntuckSubgraph = useCallback((tuckId: string) => {
    if (tuckReorder.shouldSuppressClick(tuckId)) {
      return;
    }
    untuckSubgraph(tuckId);
  }, [tuckReorder, untuckSubgraph]);

  const clearSelectedMaterialized = useCallback(() => {
    const selectedNodeIds = nodesRef.current
      .filter((node) => node.selected)
      .map((node) => node.id);
    if (selectedNodeIds.length === 0) {
      return;
    }
    setRuntime((current) => {
      const next = { ...current };
      for (const nodeId of selectedNodeIds) {
        next[nodeId] = {
          ...(next[nodeId] ?? { running: false, portActivity: {} }),
          previews: {},
          livePreviews: undefined,
        };
      }
      return next;
    });
    persistRuntimeSoon();
  }, [persistRuntimeSoon]);

  const duplicateSelected = useCallback(() => {
    const selectedNodes = nodesRef.current.filter((node) => node.selected);
    if (selectedNodes.length === 0) {
      return;
    }
    const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
    const duplicatedModels = selectedNodes.map((node) => {
      const model = flowNodeToPersistedWorkspaceNode(node, runtimeRef.current);
      return {
        ...model,
        id: encodeId(`node-${model.kind.replaceAll("_", "-")}`),
        position: {
          x: model.position.x + 48,
          y: model.position.y + 48,
        },
      };
    });
    const nodeIdMap = new Map(selectedNodes.map((node, index) => [node.id, duplicatedModels[index]!.id]));
    const duplicatedEdges = edgesRef.current
      .filter((edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target))
      .map((edge) => ({
        ...flowEdgeToWorkspaceEdge(edge),
        id: encodeId('edge'),
        from: {
          ...flowEdgeToWorkspaceEdge(edge).from,
          nodeId: nodeIdMap.get(edge.source) ?? flowEdgeToWorkspaceEdge(edge).from.nodeId,
        },
        to: {
          ...flowEdgeToWorkspaceEdge(edge).to,
          nodeId: nodeIdMap.get(edge.target) ?? flowEdgeToWorkspaceEdge(edge).to.nodeId,
        },
      }));
    const duplicatedRuntime = Object.fromEntries(
      duplicatedModels.map((node) => [
        node.id,
        {
          running: false,
          portActivity: {},
          previews: runtimePreviewsFromNode(node),
        },
      ]),
    );
    const nextRuntime = {
      ...runtimeRef.current,
      ...duplicatedRuntime,
    };
    const nextEdges = [
      ...edgesRef.current.map((edge) => ({ ...edge, selected: false })),
      ...duplicatedEdges.map((edge) => ({
        ...toFlowEdge(edge, deleteEdge, cycleEdgeBuffering),
        selected: true,
      })),
    ];
    const nextNodes = [
      ...nodesRef.current.map((node) => ({ ...node, selected: false })),
      ...duplicatedModels.map((node) => ({
        ...toFlowNode(node, nextRuntime, generationRef.current, handlers, nextEdges, workspaceMetaRef.current?.ui.previewControlsLocation ?? "node"),
        selected: true,
      })),
    ];
    setRuntime(nextRuntime);
    setEdges(nextEdges);
    setNodes(nextNodes);
    persistWorkspaceSnapshot(nextNodes, nextEdges, tuckspaceRef.current, nextRuntime);
  }, [cycleEdgeBuffering, deleteEdge, handlers, persistWorkspaceSnapshot, setEdges, setNodes]);

  const setSelectedEdgeBuffering = useCallback((buffering: BufferingMode) => {
    const selectedEdgeIds = new Set(
      edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id),
    );
    if (selectedEdgeIds.size === 0) {
      return;
    }
    setEdges((current) => {
      const next = current.map((edge) => {
        if (!selectedEdgeIds.has(edge.id)) {
          return edge;
        }
        return {
          ...edge,
          data: {
            buffering,
            onDelete: deleteEdge,
            onCycle: cycleEdgeBuffering,
          },
          animated: buffering === "unbuffered",
          label: buffering.replaceAll("_", " "),
        };
      });
      setNodes((nodesCurrent) =>
        syncNodeData(nodesCurrent, runtime, generationRef.current, handlers, next, workspaceMetaRef.current?.ui.previewControlsLocation ?? "node"),
      );
      persistSoon(nodesRef.current, next);
      return next;
    });
  }, [cycleEdgeBuffering, deleteEdge, handlers, persistSoon, runtime, setEdges, setNodes]);

  const deleteSelected = useCallback(() => {
    const selectedNodeIds = new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id));
    const selectedEdgeIds = new Set(edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id));
    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) {
      return;
    }
    const nextEdges = edgesRef.current.filter(
      (edge) => !selectedEdgeIds.has(edge.id) && !selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target),
    );
    const nextNodes = nodesRef.current.filter((node) => !selectedNodeIds.has(node.id));
    setEdges(nextEdges);
    setNodes(nextNodes);
    persistWorkspaceSnapshot(nextNodes, nextEdges, tuckspaceRef.current);
  }, [persistWorkspaceSnapshot, setEdges, setNodes]);

  const runLayout = useCallback(() => {
    const selectedNodeIds = nodesRef.current
      .filter((node) => node.selected)
      .map((node) => node.id);
    const positions = layoutSelectedNodes(
      selectedNodeIds,
      nodesRef.current.map(flowNodeToWorkspaceNode),
      edgesRef.current.map(flowEdgeToWorkspaceEdge),
    );
    setNodes((current) => {
      const next = current.map((node) =>
        positions.has(node.id)
          ? {
              ...node,
              position: positions.get(node.id)!,
            }
          : node,
      );
      persistSoon(next, edgesRef.current);
      return next;
    });
  }, [persistSoon, setNodes]);

  if (!workspaceMeta) {
    return <div className="app-loading">loading workspace...</div>;
  }

  const sidebarActionsDisabled = workspaceSwitching || activeExecutions.length > 0;
  const sidebarWidths = {
    workspaces: sidebarUi.workspaces.collapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarUi.workspaces.width,
    nodes: sidebarUi.nodes.collapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarUi.nodes.width,
    tuckspace: sidebarUi.tuckspace.collapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarUi.tuckspace.width,
  };

  return (
    <div
      className="app-shell"
      style={{
        ["--sidebar-workspaces-width" as string]: `${sidebarWidths.workspaces}px`,
        ["--sidebar-nodes-width" as string]: `${sidebarWidths.nodes}px`,
        ["--sidebar-tuckspace-width" as string]: `${sidebarWidths.tuckspace}px`,
      }}
    >
      <SidebarPanel
        id="workspaces"
        label="kernel, workspaces, settings"
        collapsed={sidebarUi.workspaces.collapsed}
        side="left"
        onToggle={() => toggleSidebar("workspaces")}
        onResizeStart={(event) => startSidebarResize("workspaces", "left", event)}
      >
        <div className="sidebar-controls-group">
          <section className="sidebar-section">
            <div className="sidebar-section-title">kernel</div>
            <span className={`kernel-pill ${kernelConnected ? "online" : "offline"}`}>
              {kernelConnected ? "kernel online" : "kernel offline"}
            </span>
            {activeExecutions.length > 0 && (
              <section className="execution-panel">
                <div className="node-palette-label">running</div>
                <div className="execution-list">
                  {activeExecutions.map((execution) => {
                    const node = nodes.find((item) => item.id === execution.nodeId);
                    const label = node?.data.model.comment.trim() || node?.data.model.kind || execution.nodeId;
                    return (
                      <div key={execution.execId} className="execution-item">
                        <div className="execution-text">
                          <div className="execution-label">{label}</div>
                          <div className="execution-id">{execution.execId.slice(0, 8)}</div>
                        </div>
                        <button type="button" onClick={() => stopExecution(execution.execId)}>
                          stop
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </section>

          <div className="sidebar-divider" />

          <section className="sidebar-section">
            <div className="sidebar-section-title">workspaces</div>
            <div className="workspace-list">
              {workspaceSummaries.map((workspace) => {
                const renaming = workspaceRenamingId === workspace.id;
                const confirmingDelete = workspaceDeleteConfirmingId === workspace.id;
                return (
                  <div
                    key={workspace.id}
                    ref={(element) => {
                      if (element) {
                        workspaceItemRefs.current.set(workspace.id, element);
                      } else {
                        workspaceItemRefs.current.delete(workspace.id);
                      }
                    }}
                    className={`workspace-list-item${workspace.id === workspaceMeta.id ? " is-active" : ""}${workspaceReorder.draggedId === workspace.id ? " is-drag-placeholder" : ""}${workspaceReorder.dropMarker?.targetId === workspace.id ? ` is-drop-${workspaceReorder.dropMarker.position}` : ""}`}
                  >
                    <div
                      className="workspace-list-main"
                      onPointerDown={renaming ? undefined : (event) => startDragWorkspace(workspace.id, event)}
                    >
                      {renaming ? (
                        <input
                          className="sidebar-input workspace-list-name-input"
                          value={workspaceRenameDraft}
                          autoFocus
                          onChange={(event) => setWorkspaceRenameDraft(event.target.value)}
                          onBlur={() => void renameWorkspace(workspace.id, workspaceRenameDraft)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void renameWorkspace(workspace.id, workspaceRenameDraft);
                            } else if (event.key === "Escape") {
                              setWorkspaceRenamingId(null);
                              setWorkspaceRenameDraft("");
                            }
                          }}
                          title="workspace name"
                        />
                      ) : (
                        <button
                          type="button"
                          className="workspace-list-select"
                          onClick={() => {
                            if (workspaceReorder.shouldSuppressClick(workspace.id)) {
                              return;
                            }
                            void loadWorkspaceIntoCanvas(workspace.id);
                          }}
                          disabled={sidebarActionsDisabled || workspace.id === workspaceMeta.id}
                          title={workspace.name}
                        >
                          {workspace.name}
                        </button>
                      )}
                    </div>
                    <div className="workspace-list-actions">
                      <button
                        type="button"
                        className="workspace-list-action"
                        onClick={() => beginWorkspaceRename(workspace.id, workspace.name)}
                        disabled={workspaceSwitching}
                        title="rename workspace"
                        aria-label="rename workspace"
                      >
                        <PencilIcon />
                      </button>
                      {confirmingDelete ? (
                        <>
                          <button
                            type="button"
                            className="workspace-list-confirm workspace-list-delete is-confirming"
                            onClick={() => void confirmDeleteWorkspace(workspace.id)}
                            disabled={workspaceSwitching || activeExecutions.length > 0}
                            title="confirm delete workspace"
                            aria-label="confirm delete workspace"
                          >
                            confirm delete
                          </button>
                          <button
                            type="button"
                            className="workspace-list-confirm-cancel"
                            onClick={() => setWorkspaceDeleteConfirmingId(null)}
                            disabled={workspaceSwitching}
                            title="cancel workspace deletion"
                            aria-label="cancel workspace deletion"
                          >
                            cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="workspace-list-action workspace-list-delete"
                          onClick={() => requestWorkspaceDelete(workspace.id)}
                          disabled={workspaceSwitching || activeExecutions.length > 0}
                          title="delete workspace"
                          aria-label="delete workspace"
                        >
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="workspace-picker-row workspace-picker-row-single">
              <button
                type="button"
                className="workspace-picker-create"
                onClick={() => void createAndLoadWorkspace()}
                disabled={sidebarActionsDisabled}
                title="create a new workspace"
              >
                new
              </button>
            </div>
            {workspaceSwitching ? (
              <span className="workspace-picker-status">switching…</span>
            ) : activeExecutions.length > 0 ? (
              <span className="workspace-picker-status">stop runs to switch or delete</span>
            ) : null}
          </section>

          <div className="sidebar-divider" />

          <section className="sidebar-section">
            <div className="sidebar-section-title">settings</div>
            <label className="sidebar-field">
              <span className="sidebar-label">pwd</span>
              <input
                className="sidebar-input"
                value={workspaceMeta.cwd}
                onChange={(event) => updateWorkspaceCwd(event.target.value)}
                placeholder="/home/user"
                title="working directory for kernel execution"
                disabled={workspaceSwitching}
              />
            </label>
            <label className="sidebar-field">
              <span className="sidebar-label">openai api key</span>
              <div className="sidebar-input-shell">
                <input
                  className="sidebar-input"
                  type={showOpenaiApiKey ? "text" : "password"}
                  autoComplete="off"
                  value={workspaceMeta.openaiApiKey}
                  onChange={(event) => updateWorkspaceApiKey(event.target.value)}
                  placeholder="sk-..."
                  title="workspace-level OpenAI API key for AI SCRIPT generation"
                  disabled={workspaceSwitching}
                />
                <button
                  type="button"
                  className="sidebar-input-toggle"
                  onClick={() => setShowOpenaiApiKey((current) => !current)}
                  title={showOpenaiApiKey ? "hide openai api key" : "show openai api key"}
                  aria-label={showOpenaiApiKey ? "hide openai api key" : "show openai api key"}
                  disabled={workspaceSwitching}
                >
                  <EyeIcon />
                </button>
              </div>
            </label>
          </section>
        </div>
      </SidebarPanel>

      <SidebarPanel
        id="nodes"
        label="nodes"
        collapsed={sidebarUi.nodes.collapsed}
        side="left"
        onToggle={() => toggleSidebar("nodes")}
        onResizeStart={(event) => startSidebarResize("nodes", "left", event)}
      >
        <div className="node-palette-groups">
          {paletteGroups().map((group) => (
            <section key={group.label} className="node-palette-group">
              <div className="node-palette-label">{group.label}</div>
              <div className="node-palette">
                {group.items.map((choice) => (
                  <button
                    key={choice.kind}
                    type="button"
                    title={choice.help}
                    aria-label={`${choice.label}: ${choice.help}`}
                    onClick={() => addNode(choice.kind)}
                  >
                    <span className={`node-palette-icon node-palette-icon-${choice.kind}`} aria-hidden="true">{choice.icon}</span>
                    <span className="node-palette-text">{choice.label}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </SidebarPanel>

      <main
        ref={canvasRef}
        className="canvas-shell"
        onContextMenu={(event) => {
          if (selectedNodes.length > 0) {
            event.preventDefault();
          }
        }}
      >
        <ReactFlow<FlowNode, FlowEdge>
          defaultViewport={{
            x: workspaceMeta.ui.viewportX,
            y: workspaceMeta.ui.viewportY,
            zoom: workspaceMeta.ui.zoom,
          }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          zoomOnScroll
          panOnScroll={false}
          panOnDrag={[1, 2]}
          minZoom={0.01}
          maxZoom={64}
          colorMode="dark"
          connectionLineType={ConnectionLineType.SmoothStep}
          onMoveEnd={(_, viewport) =>
            updateWorkspaceUi(
              (ui) => ({
                ...ui,
                viewportX: viewport.x,
                viewportY: viewport.y,
                zoom: viewport.zoom,
              }),
              true,
            )
          }
        >
          <MiniMap pannable zoomable className="minimap" />
          <Controls position="bottom-left">
            <ControlButton onClick={() => void flow.zoomTo(1)} title="reset zoom">
              <span className="zoom-control-reset" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <circle cx="10" cy="10" r="5.5" />
                  <path d="M14.5 14.5 20 20" />
                  <path d="M7 10h6" />
                </svg>
              </span>
            </ControlButton>
          </Controls>
          <Panel position="bottom-left" className="zoom-controls-note">
            <div className="zoom-wheel-note">scroll wheel: zoom</div>
          </Panel>
          <Background gap={28} size={1} color="rgba(250, 244, 233, 0.08)" />
        </ReactFlow>
        {selectionActionsStyle && (
          <div className="selection-actions" style={selectionActionsStyle}>
            <button type="button" onClick={duplicateSelected} disabled={selectedNodes.length === 0}>
              <span className="selection-actions-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" focusable="false">
                  <rect x="5" y="5" width="8" height="8" rx="1.2" />
                  <path d="M11 5V3.7A1.2 1.2 0 0 0 9.8 2.5H3.7A1.2 1.2 0 0 0 2.5 3.7v6.1A1.2 1.2 0 0 0 3.7 11H5" />
                </svg>
              </span>
              <span>duplicate</span>
            </button>
            <button type="button" onClick={clearSelectedMaterialized} disabled={selectedNodes.length === 0}>
              <span className="selection-actions-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" focusable="false">
                  <path d="M4 4l8 8" />
                  <path d="M12 4 4 12" />
                </svg>
              </span>
              <span>reset materialized</span>
            </button>
            <button type="button" onClick={deleteSelected}>
              <span className="selection-actions-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" focusable="false">
                  <path d="M3.5 4.5h9" />
                  <path d="M6 4.5V3.2h4V4.5" />
                  <path d="M5.2 4.5v7.3" />
                  <path d="M8 4.5v7.3" />
                  <path d="M10.8 4.5v7.3" />
                  <path d="M4.2 4.5l.5 8.3h6.6l.5-8.3" />
                </svg>
              </span>
              <span>delete</span>
            </button>
            <button type="button" onClick={runLayout}>
              <span className="selection-actions-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" focusable="false">
                  <path d="M2.5 4.5h11" />
                  <path d="M2.5 8h8" />
                  <path d="M2.5 11.5h5" />
                  <path d="M11 7l2.5-2.5" />
                  <path d="M11 9l2.5 2.5" />
                </svg>
              </span>
              <span>organize</span>
            </button>
            <div className="selection-actions-item selection-actions-item-has-submenu">
              <button type="button" disabled={selectedEdges.length === 0} title={selectedEdges.length === 0 ? "select wires first" : "set wire buffer mode"}>
                <span className="selection-actions-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" focusable="false">
                    <path d="M2.5 8h3" />
                    <path d="M7 8h2" />
                    <path d="M11 8h2.5" />
                    <circle cx="5" cy="8" r="0.8" fill="currentColor" stroke="none" />
                    <circle cx="10" cy="8" r="0.8" fill="currentColor" stroke="none" />
                  </svg>
                </span>
                <span>wire buffering</span>
              </button>
              {selectedEdges.length > 0 && (
                <div className="selection-actions-submenu">
                  <button type="button" onClick={() => setSelectedEdgeBuffering("unbuffered")}>unbuffered</button>
                  <button type="button" onClick={() => setSelectedEdgeBuffering("line_or_1024")}>line or 1024</button>
                  <button type="button" onClick={() => setSelectedEdgeBuffering("on_complete")}>on complete</button>
                </div>
              )}
            </div>
            <div className="selection-actions-item selection-actions-item-has-submenu">
              <button
                type="button"
                onClick={() => moveSelectionToTuckspace()}
                disabled={!canTuckSelection}
                title={canTuckSelection ? "Move subgraph into tuckspace" : "Only closed subgraphs can be moved into tuckspace"}
              >
                <span className="selection-actions-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" focusable="false">
                    <path d="M2.5 5.5h11" />
                    <path d="M3.5 5.5v6h9v-6" />
                    <path d="M6 5.5V4h4v1.5" />
                    <path d="M8 2.5v7" />
                    <path d="M5.5 7 8 9.5 10.5 7" />
                  </svg>
                </span>
                <span>move to tuckspace</span>
              </button>
              {canTuckSelection && tuckspaceShells.length > 0 && (
                <div className="selection-actions-submenu">
                  {tuckspaceShells.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      title={`Move subgraph into ${item.name}`}
                      onClick={() => moveSelectionToTuckspace(item.id)}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {toast && <div className="toast">{toast}</div>}
      </main>

      <SidebarPanel
        id="tuckspace"
        label="tuckspace"
        collapsed={sidebarUi.tuckspace.collapsed}
        side="right"
        onToggle={() => toggleSidebar("tuckspace")}
        onResizeStart={(event) => startSidebarResize("tuckspace", "right", event)}
      >
        <div className="tuckspace-header">
          <input
            className="tuckspace-search"
            value={tuckspaceQuery}
            onChange={(event) => setTuckspaceQuery(event.target.value)}
            placeholder="search"
            aria-label="search tuckspace"
          />
        </div>
        <div className="tuckspace-list">
          {tuckspace.length === 0 ? (
            <div className="tuckspace-empty">Closed subgraphs you tuck away will appear here.</div>
          ) : visibleTuckspace.length === 0 ? (
            <div className="tuckspace-empty">No tucked subgraphs match that search.</div>
          ) : (
            visibleTuckspace.map((item) => {
              const dropPosition = tuckReorder.dropMarker?.targetId === item.id ? tuckReorder.dropMarker.position : null;
              return (
                <article
                  key={item.id}
                  ref={(element) => {
                    if (element) {
                      tuckItemRefs.current.set(item.id, element);
                    } else {
                      tuckItemRefs.current.delete(item.id);
                    }
                  }}
                  className={`tuckspace-item${tuckReorder.draggedId === item.id ? " is-drag-placeholder" : ""}${dropPosition ? ` is-drop-${dropPosition}` : ""}${isTuckspaceShell(item) ? " is-shell" : ""}${tuckReorder.draggedId ? " is-drag-active" : ""}`}
                  title={isTuckspaceShell(item) ? "Empty shell" : "Move to workspace"}
                >
                  <TuckspaceCardBody
                    item={item}
                    canPopulate={canTuckSelection}
                    interactive={tuckReorder.draggedId !== item.id}
                    onRestore={() => maybeUntuckSubgraph(item.id)}
                    onPopulate={() => moveSelectionToTuckspace(item.id)}
                    onDeleteShell={() => deleteTuckShell(item.id)}
                    onRename={(value) => renameTuckedSubgraph(item.id, value)}
                    onStartDrag={(event) => tuckReorder.startDrag(item.id, event, (event.currentTarget.closest(".tuckspace-item") as HTMLElement | null))}
                  />
                </article>
              );
            })
          )}
        </div>
      </SidebarPanel>
      {workspaceReorder.draggedId && workspaceReorder.dragPreview && (() => {
        const draggedWorkspace = workspaceSummaries.find((workspace) => workspace.id === workspaceReorder.draggedId);
        if (!draggedWorkspace) {
          return null;
        }
        return (
          <div
            className="workspace-drag-preview"
            style={{
              left: workspaceReorder.dragPreview.x,
              top: workspaceReorder.dragPreview.y,
              width: workspaceReorder.dragPreview.width,
              height: workspaceReorder.dragPreview.height,
            }}
          >
            <div className="workspace-list-item">
              <div className="workspace-list-main">
                <div className="workspace-list-select">{draggedWorkspace.name}</div>
              </div>
            </div>
          </div>
        );
      })()}
      {tuckReorder.draggedId && tuckReorder.dragPreview && (() => {
        const draggedItem = tuckspace.find((item) => item.id === tuckReorder.draggedId);
        if (!draggedItem) {
          return null;
        }
        return (
          <div
            className="tuckspace-drag-preview"
            style={{
              left: tuckReorder.dragPreview.x,
              top: tuckReorder.dragPreview.y,
              width: tuckReorder.dragPreview.width,
              height: tuckReorder.dragPreview.height,
              transform: "scale(0.5)",
              transformOrigin: "top left",
            }}
          >
            <article className={`tuckspace-item${isTuckspaceShell(draggedItem) ? " is-shell" : ""}`}>
              <TuckspaceCardBody
                item={draggedItem}
                canPopulate={canTuckSelection}
                interactive={false}
              />
            </article>
          </div>
        );
      })()}
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <WorkspaceCanvas />
    </ReactFlowProvider>
  );
}
