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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import "@xyflow/react/dist/style.css";

import ShellNode from "./components/ShellNode";
import WorkspaceEdgeView from "./components/WorkspaceEdge";
import {
  createWorkspace,
  deleteWorkspace,
  reorderWorkspaces,
  generateScript,
  getMaterializedOutputs,
  getTuckspace,
  getWorkspace,
  listWorkspaces,
  pickFilePath,
  saveMaterializedOutputs,
  saveTuckspace,
  saveWorkspace,
} from "./lib/api";
import { collectAiScriptSamples } from "./lib/aiScript";
import { compileExecutionRequest } from "./lib/compileExecutionRequest";
import {
  buildExecutionRequestFromPlan,
  emptyExecutionPlan,
  executionPlanForSelection,
  executionPlanFromRequest,
  executionPlanMatvalsForNode,
  executionPlanPortKeysForNode,
  mergeExecutionPlans,
  participatingNodeIdsForPlan,
  trimExecutionPlan,
} from "./lib/executionPlan";
import { layoutSelectedNodes } from "./lib/layout";
import { chooseNodePosition } from "./lib/nodePlacement";
import { selectionRectToFlowRect } from "./lib/selectionRect";
import { nodeArgvSlots, nodeHasArgvPort, nodeHasInputPort, nodePreviewTabs, nodePreviewTabsForNode } from "./lib/nodePorts";
import type {
  AiGenerationState,
  AutoRunConfig,
  BufferingMode,
  ClientEvent,
  ExecutionAction,
  ExecutionRequest,
  ExecutionPlanState,
  FlowEdge,
  FlowNode,
  MaterializedOutputStore,
  NodeKind,
  NodeMaterialized,
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
import { missingConnectedInputs, missingOutputs, runtimePreviewsFromNode } from "./lib/materialized";
import { outputPortsForKind, previewOutputPortsForKind } from "./lib/portSchema";
import { applyNodeOutputEvent } from "./lib/runtimeEvents";
import { selectionSupportsPreviewCategory, togglePreviewCategoryForSelection, type PreviewToggleCategory } from "./lib/selectionPreviewTabs";
import { nextPaneSizes } from "./lib/paneLayout";
import { emptyTuckedSubgraph, isClosedSelection, isTuckspaceShell, recenterTuckedNodes, reorderTuckspaceWithPlacement, shouldKeepShellOnRestore, storeTuckedSubgraph } from "./lib/tuckspace";
import { concatBytes, encodeId, fromBase64, toBase64 } from "./lib/utils";
import { clearNodeMaterialized, duplicateNodeMaterialized } from "./lib/materializedOutputs";

const nodeTypes = {
  shell: ShellNode,
};

const edgeTypes = {
  workspace: WorkspaceEdgeView,
};

const PAN_ON_DRAG_BUTTONS = [1, 2] as const;
const SELECTION_DRAG_BUTTON = 0;

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
    materialized: { inputs: {}, outputs: {}, lastExitCode: null },
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

type IncomingEdgeSummary = {
  stdinCount: number;
  argvSlotCounts: Map<number, number>;
};

type NodeEdgeDerivedData = {
  argvSlots?: number[];
  previewTabs: string[];
};

function createIncomingEdgeSummary(): IncomingEdgeSummary {
  return {
    stdinCount: 0,
    argvSlotCounts: new Map(),
  };
}

function getOrCreateIncomingEdgeSummary(
  summaries: Map<string, IncomingEdgeSummary>,
  nodeId: string,
) {
  const existing = summaries.get(nodeId);
  if (existing) {
    return existing;
  }
  const created = createIncomingEdgeSummary();
  summaries.set(nodeId, created);
  return created;
}

function summarizeIncomingEdge(
  summaries: Map<string, IncomingEdgeSummary>,
  edge: Pick<FlowEdge, "target" | "targetHandle">,
  delta: 1 | -1,
) {
  const handle = parseHandleId(edge.targetHandle as string | null | undefined);
  if (handle.port !== "stdin" && handle.port !== "argv") {
    return;
  }
  const summary = getOrCreateIncomingEdgeSummary(summaries, edge.target);
  if (handle.port === "stdin") {
    summary.stdinCount = Math.max(0, summary.stdinCount + delta);
  } else {
    const slot = handle.slot ?? 1;
    const nextCount = Math.max(0, (summary.argvSlotCounts.get(slot) ?? 0) + delta);
    if (nextCount === 0) {
      summary.argvSlotCounts.delete(slot);
    } else {
      summary.argvSlotCounts.set(slot, nextCount);
    }
  }
  if (summary.stdinCount === 0 && summary.argvSlotCounts.size === 0) {
    summaries.delete(edge.target);
  }
}

function buildIncomingEdgeSummaries(edges: FlowEdge[]) {
  const summaries = new Map<string, IncomingEdgeSummary>();
  for (const edge of edges) {
    summarizeIncomingEdge(summaries, edge, 1);
  }
  return summaries;
}

function deriveNodeEdgeData(
  kind: NodeKind,
  summary: IncomingEdgeSummary | undefined,
): NodeEdgeDerivedData {
  const previewTabs: string[] = [];
  if (nodeHasInputPort(kind) && (summary?.stdinCount ?? 0) > 0) {
    previewTabs.push("stdin");
  }
  let argvSlots: number[] | undefined;
  if (nodeHasArgvPort(kind)) {
    const connectedArgvSlots = Array.from(summary?.argvSlotCounts.keys() ?? []).sort((a, b) => a - b);
    previewTabs.push(...connectedArgvSlots.map((slot) => `argv-${slot}`));
    if (connectedArgvSlots.length === 0) {
      argvSlots = [1];
    } else {
      const maxSlot = connectedArgvSlots[connectedArgvSlots.length - 1] ?? 1;
      argvSlots = Array.from({ length: maxSlot + 1 }, (_, index) => index + 1);
    }
  }
  previewTabs.push(...previewOutputPortsForKind(kind));
  return { argvSlots, previewTabs };
}

function reconcileIncomingEdgeSummaryForEdgeChange(
  summaries: Map<string, IncomingEdgeSummary>,
  previousEdge: FlowEdge | undefined,
  nextEdge: FlowEdge | undefined,
) {
  const affectedTargetNodeIds = new Set<string>();
  if (previousEdge) {
    summarizeIncomingEdge(summaries, previousEdge, -1);
    affectedTargetNodeIds.add(previousEdge.target);
  }
  if (nextEdge) {
    summarizeIncomingEdge(summaries, nextEdge, 1);
    affectedTargetNodeIds.add(nextEdge.target);
  }
  return affectedTargetNodeIds;
}

function sameArray<T>(left: T[] | undefined, right: T[] | undefined) {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function sameExecutionPlan(left: ExecutionPlanState, right: ExecutionPlanState) {
  return (
    sameArray(left.executableNodeIds, right.executableNodeIds)
    && sameArray(left.edgeIds, right.edgeIds)
    && sameArray(left.providedMatoutIds, right.providedMatoutIds)
  );
}

const PORT_STACK_TOP = 48;
const PORT_SPACING = 30;
const HANDLE_SIZE = 13;

function portTopForEdgeHandle(node: FlowNode, handle: { port: PortKind; slot?: number }, edges: FlowEdge[]) {
  if (handle.port === "stdin" || handle.port === "argv") {
    let index = 0;
    if (nodeHasInputPort(node.data.model.kind)) {
      if (handle.port === "stdin") {
        return PORT_STACK_TOP + index * PORT_SPACING;
      }
      index += 1;
    }
    const argvSlots = computeArgvSlots(node.id, node.data.model.kind, edges) ?? [1];
    const slotIndex = argvSlots.findIndex((slot) => slot === (handle.slot ?? 1));
    return PORT_STACK_TOP + (index + Math.max(slotIndex, 0)) * PORT_SPACING;
  }
  const outputIndex = outputPortsForKind(node.data.model.kind).findIndex((port) => port === handle.port);
  return PORT_STACK_TOP + Math.max(outputIndex, 0) * PORT_SPACING;
}

function rectsIntersect(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function SelectionActionsAnchor({
  canvasRef,
  nodes,
  edges,
  selectedNodes,
  selectedEdges,
  children,
}: {
  canvasRef: React.RefObject<HTMLElement | null>;
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedNodes: FlowNode[];
  selectedEdges: FlowEdge[];
  children: ReactNode;
}) {
  const viewportTransform = useStore((store) => store.transform);
  const selectionActionsRef = useRef<HTMLDivElement | null>(null);
  const [selectionActionsSize, setSelectionActionsSize] = useState({ width: 180, height: 240 });
  const nodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  const selectedEdgeBounds = useMemo(() => {
    if (selectedEdges.length === 0) {
      return null;
    }
    const [viewportX, viewportY, zoom] = viewportTransform;
    const anchors = selectedEdges.flatMap((edge) => {
      const sourceNode = nodeById.get(edge.source);
      const targetNode = nodeById.get(edge.target);
      if (!sourceNode || !targetNode) {
        return [];
      }
      const sourceHandle = parseHandleId(edge.sourceHandle as string | null | undefined);
      const targetHandle = parseHandleId(edge.targetHandle as string | null | undefined);
      const sourceWidth = sourceNode.measured?.width ?? sourceNode.width ?? sourceNode.data.model.size.width;
      return [
        {
          top: (sourceNode.position.y + portTopForEdgeHandle(sourceNode, sourceHandle, edges) - HANDLE_SIZE / 2) * zoom + viewportY,
          right: (sourceNode.position.x + sourceWidth) * zoom + viewportX,
        },
        {
          top: (targetNode.position.y + portTopForEdgeHandle(targetNode, targetHandle, edges) - HANDLE_SIZE / 2) * zoom + viewportY,
          right: targetNode.position.x * zoom + viewportX,
        },
      ];
    });
    if (anchors.length === 0) {
      return null;
    }
    const rightmost = anchors.reduce((best, anchor) =>
      anchor.right > best.right || (anchor.right === best.right && anchor.top < best.top) ? anchor : best,
    );
    return {
      top: rightmost.top,
      right: rightmost.right,
    };
  }, [edges, nodeById, selectedEdges, viewportTransform]);

  useLayoutEffect(() => {
    const element = selectionActionsRef.current;
    if (!element) {
      return;
    }
    const updateSize = () => {
      const next = { width: element.offsetWidth, height: element.offsetHeight };
      setSelectionActionsSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selectedNodes.length, selectedEdges.length]);

  const selectionActionsStyle = useMemo(() => {
    if (selectedNodes.length === 0 && selectedEdges.length === 0) {
      return null;
    }
    const canvas = canvasRef.current;
    const margin = 16;
    if (!canvas) {
      return { top: margin, right: margin } as const;
    }
    let anchorLeft = margin;
    let anchorTop = margin;
    if (selectedNodes.length > 0) {
      const [viewportX, viewportY, zoom] = viewportTransform;
      const minY = Math.min(...selectedNodes.map((node) => node.position.y));
      const maxX = Math.max(...selectedNodes.map((node) => node.position.x + (node.measured?.width ?? node.width ?? node.data.model.size.width)));
      anchorLeft = maxX * zoom + viewportX + 12;
      anchorTop = minY * zoom + viewportY;
    } else if (selectedEdgeBounds) {
      anchorLeft = selectedEdgeBounds.right + 12;
      anchorTop = selectedEdgeBounds.top;
    }
    const maxLeft = Math.max(margin, canvas.clientWidth - selectionActionsSize.width - margin);
    const maxTop = Math.max(margin, canvas.clientHeight - selectionActionsSize.height - margin);
    return {
      left: Math.min(Math.max(margin, anchorLeft), maxLeft),
      top: Math.min(Math.max(margin, anchorTop), maxTop),
    } as const;
  }, [canvasRef, selectedEdgeBounds, selectedEdges.length, selectedNodes, selectionActionsSize.height, selectionActionsSize.width, viewportTransform]);

  if (!selectionActionsStyle) {
    return null;
  }

  return (
    <div ref={selectionActionsRef} className="selection-actions" style={selectionActionsStyle}>
      {children}
    </div>
  );
}

function SelectionGestureHint({
  rect,
  altActive,
  shiftActive,
}: {
  rect: { x: number; y: number; width: number; height: number };
  altActive: boolean;
  shiftActive: boolean;
}) {
  const top = Math.max(12, rect.y - (altActive ? 58 : 30));
  const left = Math.max(12, rect.x + 6);
  return (
    <div className="selection-gesture-hint" style={{ left, top }}>
      <div className={`selection-gesture-hint-box ${altActive ? "is-active" : ""}`}>
        ALT: select nodes for exec
      </div>
      {altActive && (
        <div className={`selection-gesture-hint-box selection-gesture-hint-box-exec ${shiftActive ? "is-active" : ""}`}>
          SHIFT: add/remove nodes from exec
        </div>
      )}
    </div>
  );
}

function selectionPreviewNodeClassName(selectionPreview: boolean) {
  return selectionPreview ? "is-selection-preview" : undefined;
}

function toFlowNode(
  node: WorkspaceNode,
  runtime: Record<string, NodeRuntimeState>,
  generation: Record<string, AiGenerationState>,
  handlers: Pick<
    ShellNodeActions,
    "onUpdate" | "onRun" | "onSelectExecutionTarget" | "getActionReason" | "onToggleExecutionPlanMatout" | "onDelete" | "onPickFile" | "onToggleAutorun" | "onGenerate" | "onClearMaterialized" | "onConvertKind" | "onResizeWidth" | "onResizePaneHeight" | "onResizePaneWidth"
  >,
  edgeDerived: NodeEdgeDerivedData,
  previewControlsLocation: Workspace["ui"]["previewControlsLocation"],
  executionPlan: ExecutionPlanState,
  participatingNodeIds: Set<string>,
): FlowNode {
  return {
    id: node.id,
    type: "shell",
    position: node.position,
    data: {
      model: node,
      runtime: runtime[node.id] ?? { running: false, portActivity: {} },
      generation: generation[node.id],
      executionPlan: {
        isExecutable: executionPlan.executableNodeIds.includes(node.id),
        isParticipating: participatingNodeIds.has(node.id),
        portKeys: executionPlanPortKeysForNode(node, edgeDerived.argvSlots, executionPlan, []),
        matvals: executionPlanMatvalsForNode(node, executionPlan),
      },
      argvSlots: edgeDerived.argvSlots,
      previewTabs: edgeDerived.previewTabs,
      previewControlsLocation,
      onUpdate: handlers.onUpdate,
      onRun: handlers.onRun,
      onSelectExecutionTarget: handlers.onSelectExecutionTarget,
      getActionReason: handlers.getActionReason,
      onToggleExecutionPlanMatout: handlers.onToggleExecutionPlanMatout,
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
    className: selectionPreviewNodeClassName(false),
    style: {
      width: node.size.width,
    },
  };
}

function toFlowEdge(
  edge: WorkspaceEdge,
  onDelete?: (edgeId: string) => void,
  onCycle?: (edgeId: string) => void,
  executionPlan: ExecutionPlanState = emptyExecutionPlan(),
  execSelectionGestureActive = false,
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
    data: {
      buffering: edge.buffering,
      executionPlan: executionPlan.edgeIds.includes(edge.id),
      execSelectionGestureActive,
      selectionPreview: false,
      onDelete,
      onCycle,
    },
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
  _runtime: Record<string, NodeRuntimeState>,
): WorkspaceNode {
  const model = flowNodeToWorkspaceNode(node);
  return {
    ...model,
    materialized: model.materialized
      ? {
          ...model.materialized,
        }
      : model.materialized,
  };
}


type ShellNodeActions = {
  onUpdate: (nodeId: string, patch: Partial<WorkspaceNode>) => void;
  onRun: (nodeId: string, action: ExecutionAction) => void;
  onSelectExecutionTarget: (nodeId: string, action: ExecutionAction, additive: boolean) => void;
  getActionReason: (nodeId: string, action: ExecutionAction) => string | null;
  onToggleExecutionPlanMatout: (nodeId: string, id: string) => void;
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
  const [materializedOutputStore, setMaterializedOutputStore] = useState<MaterializedOutputStore>({});
  const [executionPlan, setExecutionPlan] = useState<ExecutionPlanState>(() => emptyExecutionPlan());
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
    onSelectExecutionTarget: () => undefined,
    getActionReason: () => null,
    onToggleExecutionPlanMatout: () => undefined,
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
  const workspaceEdgesRef = useRef<WorkspaceEdge[]>([]);
  const autorunRef = useRef<Map<string, AutorunHandle>>(new Map());
  const runtimeRef = useRef<Record<string, NodeRuntimeState>>({});
  const materializedOutputStoreRef = useRef<MaterializedOutputStore>({});
  const executionPlanRef = useRef<ExecutionPlanState>(executionPlan);
  const displayedExecutionPlanRef = useRef<ExecutionPlanState>(executionPlan);
  const persistTimerRef = useRef<number | null>(null);
  const layoutPersistTimerRef = useRef<number | null>(null);
  const generationRef = useRef<Record<string, AiGenerationState>>({});
  const incomingEdgeSummaryRef = useRef<Map<string, IncomingEdgeSummary>>(new Map());
  const tuckspaceRef = useRef<TuckedSubgraph[]>([]);
  const workspaceItemRefs = useRef(new Map<string, HTMLElement>());
  const tuckItemRefs = useRef(new Map<string, HTMLElement>());
  const runningStartedAtRef = useRef<Record<string, number>>({});
  const runningClearTimersRef = useRef<Map<string, number>>(new Map());
  const selectionGestureActiveRef = useRef(false);
  const selectionGestureClearTimerRef = useRef<number | null>(null);
  const selectionExecModifierRef = useRef({ alt: false, shift: false });
  const userSelectionActiveRef = useRef(false);
  const gesturePreviewNodeIdsRef = useRef<string[]>([]);
  const gesturePreviewEdgeIdsRef = useRef<string[]>([]);
  const selectionPreviewNodeIdsRef = useRef<Set<string>>(new Set());
  const selectionPreviewEdgeIdsRef = useRef<Set<string>>(new Set());

  const flow = useReactFlow<FlowNode, FlowEdge>();
  const userSelectionRect = useStore((store) => store.userSelectionRect);
  const userSelectionActive = useStore((store) => store.userSelectionActive);
  const zoom = useStore((store) => store.transform[2]);

  const [nodes, setNodes] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useEdgesState<FlowEdge>([]);
  const [selectionExecModifier, setSelectionExecModifier] = useState({ alt: false, shift: false });
  // Selection churn is a hot path. Effects that only care about node-model slices
  // should key off a reduced signature instead of the whole node array.
  const autorunConfigSignature = useMemo(
    () =>
      nodes.map((node) => {
        const config = node.data.model.autoRun;
        return config?.enabled
          ? `${node.id}:${config.mode}:${config.intervalMs}`
          : `${node.id}:off`;
      }).join("|"),
    [nodes],
  );

  const stableNodeActions = useMemo<ShellNodeActions>(() => ({
    onUpdate: (...args) => (handlersRef.current ?? handlersFallback).onUpdate(...args),
    onRun: (...args) => (handlersRef.current ?? handlersFallback).onRun(...args),
    onSelectExecutionTarget: (...args) => (handlersRef.current ?? handlersFallback).onSelectExecutionTarget(...args),
    getActionReason: (...args) => (handlersRef.current ?? handlersFallback).getActionReason(...args),
    onToggleExecutionPlanMatout: (...args) => (handlersRef.current ?? handlersFallback).onToggleExecutionPlanMatout(...args),
    onDelete: (...args) => (handlersRef.current ?? handlersFallback).onDelete(...args),
    onPickFile: (...args) => (handlersRef.current ?? handlersFallback).onPickFile(...args),
    onToggleAutorun: (...args) => (handlersRef.current ?? handlersFallback).onToggleAutorun(...args),
    onGenerate: (...args) => (handlersRef.current ?? handlersFallback).onGenerate(...args),
    onClearMaterialized: (...args) => (handlersRef.current ?? handlersFallback).onClearMaterialized(...args),
    onConvertKind: (...args) => (handlersRef.current ?? handlersFallback).onConvertKind(...args),
    onResizeWidth: (...args) => (handlersRef.current ?? handlersFallback).onResizeWidth(...args),
    onResizePaneHeight: (...args) => (handlersRef.current ?? handlersFallback).onResizePaneHeight(...args),
    onResizePaneWidth: (...args) => (handlersRef.current ?? handlersFallback).onResizePaneWidth(...args),
  }), [handlersFallback]);

  const patchNodesById = useCallback((nodeIds: Iterable<string>, updater: (node: FlowNode) => FlowNode) => {
    const ids = new Set(nodeIds);
    if (ids.size === 0) {
      return;
    }
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        if (!ids.has(node.id)) {
          return node;
        }
        const updated = updater(node);
        if (updated !== node) {
          changed = true;
        }
        return updated;
      });
      return changed ? next : current;
    });
  }, [setNodes]);

  const updateNodePreviewControlsLocation = useCallback((nextLocation: Workspace["ui"]["previewControlsLocation"]) => {
    patchNodesById(nodesRef.current.map((node) => node.id), (node) =>
      node.data.previewControlsLocation === nextLocation
        ? node
        : {
            ...node,
            data: {
              ...node.data,
              previewControlsLocation: nextLocation,
            },
          });
  }, [patchNodesById]);

  const updateNodeGenerationData = useCallback((nodeId: string, nextGeneration: AiGenerationState | undefined) => {
    patchNodesById([nodeId], (node) =>
      node.data.generation === nextGeneration
        ? node
        : {
            ...node,
            data: {
              ...node.data,
              generation: nextGeneration,
            },
          });
  }, [patchNodesById]);

  const participatingNodeIdsForCurrentPlan = useCallback((plan: ExecutionPlanState) => {
    const ids = new Set(plan.executableNodeIds);
    if (plan.edgeIds.length === 0) {
      return ids;
    }
    const edgeById = new Map(edgesRef.current.map((edge) => [edge.id, edge]));
    for (const edgeId of plan.edgeIds) {
      const edge = edgeById.get(edgeId);
      if (!edge) {
        continue;
      }
      ids.add(edge.source);
      ids.add(edge.target);
    }
    return ids;
  }, []);

  const updateNodeMaterializedData = useCallback((nodeId: string, nextMaterialized: NodeMaterialized | undefined) => {
    const participatingNodeIds = participatingNodeIdsForCurrentPlan(displayedExecutionPlanRef.current);
    const workspaceEdges = workspaceEdgesRef.current;
    patchNodesById([nodeId], (node) =>
      {
        if (node.data.model.materialized === nextMaterialized) {
          return node;
        }
        const nextModel = {
          ...node.data.model,
          materialized: nextMaterialized,
        };
        const matvals = executionPlanMatvalsForNode(
          nextModel,
          displayedExecutionPlanRef.current,
        );
        return {
            ...node,
            data: {
              ...node.data,
              model: nextModel,
              executionPlan: {
                isExecutable: displayedExecutionPlanRef.current.executableNodeIds.includes(node.id),
                isParticipating: participatingNodeIds.has(node.id),
                portKeys: executionPlanPortKeysForNode(
                  nextModel,
                  node.data.argvSlots,
                  displayedExecutionPlanRef.current,
                  workspaceEdges,
                  matvals,
                ),
                matvals,
              },
            },
          };
      });
  }, [participatingNodeIdsForCurrentPlan, patchNodesById]);

  const updateNodeRuntimeData = useCallback((nodeId: string, nextRuntime: NodeRuntimeState | undefined) => {
    patchNodesById([nodeId], (node) => {
      const runtimeData = nextRuntime ?? { running: false, portActivity: {} };
      return node.data.runtime === runtimeData
        ? node
        : {
            ...node,
            data: {
              ...node.data,
              runtime: runtimeData,
            },
          };
    });
  }, [patchNodesById]);

  const updateNodeExecutionPlanData = useCallback((previousPlan: ExecutionPlanState, nextPlan: ExecutionPlanState) => {
    const previousParticipatingNodeIds = participatingNodeIdsForCurrentPlan(previousPlan);
    const participatingNodeIds = participatingNodeIdsForCurrentPlan(nextPlan);
    const workspaceEdges = workspaceEdgesRef.current;
    const sameProvidedMatouts = sameArray(previousPlan.providedMatoutIds, nextPlan.providedMatoutIds);
    const changedMatoutIds = new Set<string>();
    if (!sameProvidedMatouts) {
      const previousMatoutIds = new Set(previousPlan.providedMatoutIds);
      const nextMatoutIds = new Set(nextPlan.providedMatoutIds);
      for (const id of previousPlan.providedMatoutIds) {
        if (!nextMatoutIds.has(id)) {
          changedMatoutIds.add(id);
        }
      }
      for (const id of nextPlan.providedMatoutIds) {
        if (!previousMatoutIds.has(id)) {
          changedMatoutIds.add(id);
        }
      }
    }
    const affectedNodeIds = new Set<string>([
      ...previousPlan.executableNodeIds,
      ...nextPlan.executableNodeIds,
      ...previousParticipatingNodeIds,
      ...participatingNodeIds,
    ]);
    if (changedMatoutIds.size > 0) {
      for (const node of nodesRef.current) {
        const inputIds = Object.values(node.data.model.materialized?.inputs ?? {});
        const outputIds = Object.values(node.data.model.materialized?.outputs ?? {});
        if ([...inputIds, ...outputIds].some((id) => id && changedMatoutIds.has(id))) {
          affectedNodeIds.add(node.id);
        }
      }
    }
    patchNodesById(affectedNodeIds, (node) => {
      const currentNodeExecutionPlan = node.data.executionPlan;
      const nextMatvals = sameProvidedMatouts && currentNodeExecutionPlan
        ? currentNodeExecutionPlan.matvals
        : executionPlanMatvalsForNode(node.data.model, nextPlan);
      const nextNodeExecutionPlan = {
        isExecutable: nextPlan.executableNodeIds.includes(node.id),
        isParticipating: participatingNodeIds.has(node.id),
        portKeys: executionPlanPortKeysForNode(node.data.model, node.data.argvSlots, nextPlan, workspaceEdges, nextMatvals),
        matvals: nextMatvals,
      };
      const samePortKeys = currentNodeExecutionPlan?.portKeys.length === nextNodeExecutionPlan.portKeys.length
        && currentNodeExecutionPlan.portKeys.every((entry, index) => entry === nextNodeExecutionPlan.portKeys[index]);
      const sameMatvals = currentNodeExecutionPlan?.matvals.length === nextNodeExecutionPlan.matvals.length
        && currentNodeExecutionPlan.matvals.every((entry, index) => {
          const nextEntry = nextNodeExecutionPlan.matvals[index];
          return nextEntry
            && entry.id === nextEntry.id
            && entry.key === nextEntry.key
            && entry.source === nextEntry.source
            && entry.included === nextEntry.included;
        });
      if (
        currentNodeExecutionPlan?.isExecutable === nextNodeExecutionPlan.isExecutable
        && currentNodeExecutionPlan?.isParticipating === nextNodeExecutionPlan.isParticipating
        && samePortKeys
        && sameMatvals
      ) {
        return node;
      }
      return {
        ...node,
        data: {
          ...node.data,
          executionPlan: nextNodeExecutionPlan,
        },
      };
    });
  }, [participatingNodeIdsForCurrentPlan, patchNodesById]);

  const updateNodesRuntimeData = useCallback((nodeIds: Iterable<string>, runtimeMap: Record<string, NodeRuntimeState>) => {
    patchNodesById(nodeIds, (node) => {
      const runtimeData = runtimeMap[node.id] ?? { running: false, portActivity: {} };
      return node.data.runtime === runtimeData
        ? node
        : {
            ...node,
            data: {
              ...node.data,
              runtime: runtimeData,
            },
          };
    });
  }, [patchNodesById]);

  const updateNodeEdgeDerivedData = useCallback((nodeIds: Iterable<string>) => {
    const workspaceEdges = workspaceEdgesRef.current;
    patchNodesById(nodeIds, (node) => {
      const derived = deriveNodeEdgeData(
        node.data.model.kind,
        incomingEdgeSummaryRef.current.get(node.id),
      );
      const nextPortKeys = executionPlanPortKeysForNode(
        node.data.model,
        derived.argvSlots,
        displayedExecutionPlanRef.current,
        workspaceEdges,
      );
      return sameArray(node.data.argvSlots, derived.argvSlots)
        && sameArray(node.data.previewTabs, derived.previewTabs)
        && sameArray(node.data.executionPlan?.portKeys, nextPortKeys)
        ? node
        : {
            ...node,
            data: {
              ...node.data,
              argvSlots: derived.argvSlots,
              previewTabs: derived.previewTabs,
              executionPlan: node.data.executionPlan
                ? {
                    ...node.data.executionPlan,
                    portKeys: nextPortKeys,
                  }
                : node.data.executionPlan,
            },
          };
    });
  }, [patchNodesById]);

  const updateEdgeExecutionPlanData = useCallback((previousPlan: ExecutionPlanState, nextPlan: ExecutionPlanState) => {
    const edgeIds = new Set(nextPlan.edgeIds);
    const execSelectionGestureActive = selectionExecModifierRef.current.alt && userSelectionActive;
    const affectedEdgeIds = new Set<string>([...previousPlan.edgeIds, ...nextPlan.edgeIds]);
    if (affectedEdgeIds.size === 0) {
      return;
    }
    setEdges((current) => {
      let changed = false;
      const next = current.map((edge) => {
        if (!affectedEdgeIds.has(edge.id)) {
          return edge;
        }
        const executionPlan = edgeIds.has(edge.id);
        if (
          edge.data?.executionPlan === executionPlan
          && edge.data?.execSelectionGestureActive === execSelectionGestureActive
        ) {
          return edge;
        }
        changed = true;
        return {
          ...edge,
          data: {
            buffering: edge.data?.buffering ?? "unbuffered",
            executionPlan,
            execSelectionGestureActive,
            selectionPreview: edge.data?.selectionPreview ?? false,
            onDelete: edge.data?.onDelete,
            onCycle: edge.data?.onCycle,
          },
        };
      });
      return changed ? next : current;
    });
  }, [setEdges, userSelectionActive]);

  const buildDisplayedExecutionPlan = useCallback((modifier = selectionExecModifierRef.current) => {
    if (!userSelectionActiveRef.current || !modifier.alt) {
      return executionPlanRef.current;
    }
    const gesturePlan = executionPlanForSelection(
      gesturePreviewNodeIdsRef.current,
      gesturePreviewEdgeIdsRef.current,
    );
    return modifier.shift
      ? mergeExecutionPlans(executionPlanRef.current, gesturePlan, true)
      : gesturePlan;
  }, []);

  const syncDisplayedExecutionPlan = useCallback((nextPlan: ExecutionPlanState) => {
    const previousPlan = displayedExecutionPlanRef.current;
    if (sameExecutionPlan(previousPlan, nextPlan)) {
      return;
    }
    // Exec-selection drags are hot enough that mirroring preview ids through React state
    // causes too much whole-canvas rerender churn. Diff and patch the displayed plan directly.
    updateNodeExecutionPlanData(previousPlan, nextPlan);
    updateEdgeExecutionPlanData(previousPlan, nextPlan);
    displayedExecutionPlanRef.current = nextPlan;
  }, [updateEdgeExecutionPlanData, updateNodeExecutionPlanData]);

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
    workspaceEdgesRef.current = edges.map(flowEdgeToWorkspaceEdge);
  }, [edges]);

  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  useEffect(() => {
    materializedOutputStoreRef.current = materializedOutputStore;
  }, [materializedOutputStore]);

  useEffect(() => {
    executionPlanRef.current = executionPlan;
  }, [executionPlan]);

  useEffect(() => {
    userSelectionActiveRef.current = userSelectionActive;
    syncDisplayedExecutionPlan(buildDisplayedExecutionPlan());
  }, [buildDisplayedExecutionPlan, syncDisplayedExecutionPlan, userSelectionActive]);

  useEffect(() => {
    const updateModifierState = (event: KeyboardEvent) => {
      if (event.key === "Alt") {
        event.preventDefault();
      }
      const next = { alt: event.altKey, shift: event.shiftKey };
      selectionExecModifierRef.current = next;
      syncDisplayedExecutionPlan(buildDisplayedExecutionPlan(next));
      setSelectionExecModifier((current) =>
        current.alt === next.alt && current.shift === next.shift ? current : next,
      );
    };
    const clearModifierState = () => {
      selectionExecModifierRef.current = { alt: false, shift: false };
      syncDisplayedExecutionPlan(executionPlanRef.current);
      setSelectionExecModifier((current) =>
        current.alt || current.shift ? { alt: false, shift: false } : current,
      );
    };
    window.addEventListener("keydown", updateModifierState);
    window.addEventListener("keyup", updateModifierState);
    window.addEventListener("blur", clearModifierState);
    return () => {
      window.removeEventListener("keydown", updateModifierState);
      window.removeEventListener("keyup", updateModifierState);
      window.removeEventListener("blur", clearModifierState);
    };
  }, [buildDisplayedExecutionPlan, syncDisplayedExecutionPlan]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const forwardPanMouseDown = (event: MouseEvent) => {
      const selectionRect = (event.target as HTMLElement | null)?.closest(".react-flow__nodesselection-rect") as HTMLElement | null;
      if (!selectionRect) {
        return;
      }
      if (event.button === SELECTION_DRAG_BUTTON || !PAN_ON_DRAG_BUTTONS.includes(event.button as 1 | 2)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      selectionRect.style.pointerEvents = "none";
      const underlying = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      selectionRect.style.pointerEvents = "";
      if (!underlying) {
        return;
      }

      underlying.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
        }),
      );
    };

    canvas.addEventListener("mousedown", forwardPanMouseDown, true);
    return () => {
      canvas.removeEventListener("mousedown", forwardPanMouseDown, true);
    };
  }, []);

  useEffect(() => {
    tuckspaceRef.current = tuckspace;
  }, [tuckspace]);

  useEffect(() => {
    const viewport = flow.getViewport();
    const nextPreviewIds = userSelectionActive && userSelectionRect
      ? new Set(
          flow
            .getIntersectingNodes(
              selectionRectToFlowRect(userSelectionRect, [viewport.x, viewport.y, viewport.zoom]),
              true,
              nodesRef.current,
            )
            .map((node) => node.id),
        )
      : new Set<string>();
    const previousPreviewIds = selectionPreviewNodeIdsRef.current;
    const changedIds = new Set<string>();
    for (const id of previousPreviewIds) {
      if (!nextPreviewIds.has(id)) {
        changedIds.add(id);
      }
    }
    for (const id of nextPreviewIds) {
      if (!previousPreviewIds.has(id)) {
        changedIds.add(id);
      }
    }
    // During drag selection we only want to touch nodes whose preview bit flipped.
    selectionPreviewNodeIdsRef.current = nextPreviewIds;
    patchNodesById(changedIds, (node) => {
      const selectionPreview = nextPreviewIds.has(node.id);
      const className = selectionPreviewNodeClassName(selectionPreview);
      if (node.className === className) {
        return node;
      }
      return {
        ...node,
        className,
      };
    });
    const previewNodeIds = Array.from(nextPreviewIds).sort();
    gesturePreviewNodeIdsRef.current = previewNodeIds;
    if (selectionExecModifierRef.current.alt && userSelectionActive) {
      syncDisplayedExecutionPlan(buildDisplayedExecutionPlan());
    }
  }, [buildDisplayedExecutionPlan, flow, patchNodesById, syncDisplayedExecutionPlan, userSelectionActive, userSelectionRect]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !userSelectionActive || !userSelectionRect) {
      const previousSelectedIds = selectionPreviewEdgeIdsRef.current;
      if (previousSelectedIds.size > 0) {
        setEdges((current) => {
          let changed = false;
          const next = current.map((edge) => {
            if (!previousSelectedIds.has(edge.id) || !edge.data?.selectionPreview) {
              return edge;
            }
            changed = true;
            return {
              ...edge,
              data: {
                ...edge.data,
                selectionPreview: false,
              },
            };
          });
          return changed ? next : current;
        });
      }
      selectionPreviewEdgeIdsRef.current = new Set();
      gesturePreviewEdgeIdsRef.current = [];
      return;
    }
    const canvasBounds = canvas.getBoundingClientRect();
    const selectionBounds = {
      left: userSelectionRect.x,
      top: userSelectionRect.y,
      right: userSelectionRect.x + userSelectionRect.width,
      bottom: userSelectionRect.y + userSelectionRect.height,
    };
    const selectedEdgeIds = new Set<string>();
    for (const edgeElement of canvas.querySelectorAll<SVGGElement>('.react-flow__edge[data-id]')) {
      const edgeId = edgeElement.dataset.id;
      if (!edgeId) {
        continue;
      }
      const bounds = edgeElement.getBoundingClientRect();
      const edgeBounds = {
        left: bounds.left - canvasBounds.left,
        top: bounds.top - canvasBounds.top,
        right: bounds.right - canvasBounds.left,
        bottom: bounds.bottom - canvasBounds.top,
      };
      if (rectsIntersect(selectionBounds, edgeBounds)) {
        selectedEdgeIds.add(edgeId);
      }
    }
    const sortedEdgeIds = Array.from(selectedEdgeIds).sort();
    gesturePreviewEdgeIdsRef.current = sortedEdgeIds;
    if (selectionExecModifierRef.current.alt) {
      syncDisplayedExecutionPlan(buildDisplayedExecutionPlan());
      const previousSelectedIds = selectionPreviewEdgeIdsRef.current;
      if (previousSelectedIds.size > 0) {
        setEdges((current) => {
          let changed = false;
          const next = current.map((edge) => {
            if (!previousSelectedIds.has(edge.id) || !edge.data?.selectionPreview) {
              return edge;
            }
            changed = true;
            return {
              ...edge,
              data: {
                ...edge.data,
                selectionPreview: false,
              },
            };
          });
          return changed ? next : current;
        });
        selectionPreviewEdgeIdsRef.current = new Set();
      }
      return;
    }
    const previousSelectedIds = selectionPreviewEdgeIdsRef.current;
    const changedIds = new Set<string>();
    for (const id of previousSelectedIds) {
      if (!selectedEdgeIds.has(id)) {
        changedIds.add(id);
      }
    }
    for (const id of selectedEdgeIds) {
      if (!previousSelectedIds.has(id)) {
        changedIds.add(id);
      }
    }
    selectionPreviewEdgeIdsRef.current = selectedEdgeIds;
    setEdges((current) => {
      let changed = false;
      const next = current.map((edge) => {
        if (!changedIds.has(edge.id)) {
          return edge;
        }
        const selectionPreview = selectedEdgeIds.has(edge.id);
        if ((edge.data?.selectionPreview ?? false) === selectionPreview) {
          return edge;
        }
        changed = true;
        return {
          ...edge,
          data: edge.data
            ? {
                ...edge.data,
                selectionPreview,
              }
            : edge.data,
        };
      });
      return changed ? next : current;
    });
  }, [buildDisplayedExecutionPlan, setEdges, syncDisplayedExecutionPlan, userSelectionActive, userSelectionRect]);

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
    if (selectionGestureClearTimerRef.current !== null) {
      window.clearTimeout(selectionGestureClearTimerRef.current);
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

  useEffect(() => {
    const workspace = buildWorkspace();
    if (!workspace) {
      return;
    }
    const trimmed = trimExecutionPlan(
      executionPlanRef.current,
      workspace,
      Object.keys(materializedOutputStoreRef.current),
    );
    if (
      sameArray(trimmed.executableNodeIds, executionPlanRef.current.executableNodeIds)
      && sameArray(trimmed.edgeIds, executionPlanRef.current.edgeIds)
      && sameArray(trimmed.providedMatoutIds, executionPlanRef.current.providedMatoutIds)
    ) {
      return;
    }
    setExecutionPlan(trimmed);
  }, [buildWorkspace, materializedOutputStore, nodes]);

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
      saveMaterializedOutputs(materializedOutputStoreRef.current).catch((error) => setToast(String(error)));
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
        if (next.ui.previewControlsLocation !== current.ui.previewControlsLocation) {
          updateNodePreviewControlsLocation(next.ui.previewControlsLocation);
        }
        if (persist) {
          const nextWorkspace = buildWorkspace(nodesRef.current, edgesRef.current, next);
          if (nextWorkspace) {
            saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
          }
        }
        return next;
      });
    },
    [buildWorkspace, updateNodePreviewControlsLocation],
  );

  const persistMaterializedOutputStore = useCallback((nextStore: MaterializedOutputStore) => {
    materializedOutputStoreRef.current = nextStore;
    saveMaterializedOutputs(nextStore).catch((error) => setToast(String(error)));
  }, []);

  const persistWorkspaceSnapshot = useCallback((
    nextNodes: FlowNode[],
    nextEdges: FlowEdge[],
    nextTuckspace: TuckedSubgraph[],
    nextRuntime: Record<string, NodeRuntimeState> = runtimeRef.current,
    nextStore: MaterializedOutputStore = materializedOutputStoreRef.current,
  ) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    tuckspaceRef.current = nextTuckspace;
    runtimeRef.current = nextRuntime;
    materializedOutputStoreRef.current = nextStore;
    const nextWorkspace = buildWorkspace(nextNodes, nextEdges, workspaceMetaRef.current, nextRuntime);
    if (nextWorkspace) {
      saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
    }
    saveTuckspace(nextTuckspace).catch((error) => setToast(String(error)));
    saveMaterializedOutputs(nextStore).catch((error) => setToast(String(error)));
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

  const beginSelectionGesture = useCallback(() => {
    if (selectionGestureClearTimerRef.current !== null) {
      window.clearTimeout(selectionGestureClearTimerRef.current);
      selectionGestureClearTimerRef.current = null;
    }
    selectionGestureActiveRef.current = true;
  }, []);

  const endSelectionGesture = useCallback(() => {
    if (selectionGestureClearTimerRef.current !== null) {
      window.clearTimeout(selectionGestureClearTimerRef.current);
    }
    const execSelectionActive = selectionExecModifierRef.current.alt;
    const execSelectionShift = selectionExecModifierRef.current.shift;
    const finalPreviewNodeIds = new Set(selectionPreviewNodeIdsRef.current);
    const finalPreviewEdgeIds = new Set(selectionPreviewEdgeIdsRef.current);
    const finalGestureNodeIds = [...gesturePreviewNodeIdsRef.current];
    const finalGestureEdgeIds = [...gesturePreviewEdgeIdsRef.current];
    // React Flow can deliver the final select changes just after selection-end fires.
    selectionGestureClearTimerRef.current = window.setTimeout(() => {
      if (execSelectionActive) {
        const computedPlan = executionPlanForSelection(
          finalGestureNodeIds,
          finalGestureEdgeIds,
        );
        setExecutionPlan((current) => mergeExecutionPlans(current, computedPlan, execSelectionShift));
        gesturePreviewNodeIdsRef.current = [];
        gesturePreviewEdgeIdsRef.current = [];
        setNodes((current) => {
          let changed = false;
          const next = current.map((node) => {
            if (!node.selected) {
              return node;
            }
            changed = true;
            return { ...node, selected: false };
          });
          return changed ? next : current;
        });
        setEdges((current) => {
          let changed = false;
          const next = current.map((edge) => {
            const selectionPreview = edge.data?.selectionPreview ?? false;
            if (!edge.selected && !selectionPreview) {
              return edge;
            }
            changed = true;
            return {
              ...edge,
              selected: false,
              data: edge.data
                ? {
                    ...edge.data,
                    selectionPreview: false,
                  }
                : edge.data,
            };
          });
          return changed ? next : current;
        });
      } else {
        const selectedNodeIds = finalPreviewNodeIds;
        setNodes((current) => {
          let changed = false;
          const next = current.map((node) => {
            const selected = selectedNodeIds.has(node.id);
            if (node.selected === selected) {
              return node;
            }
            changed = true;
            return { ...node, selected };
          });
          return changed ? next : current;
        });
        const selectedEdgeIds = finalPreviewEdgeIds;
        setEdges((current) => {
          let changed = false;
          const next = current.map((edge) => {
            const selected = selectedEdgeIds.has(edge.id);
            const selectionPreview = edge.data?.selectionPreview ?? false;
            if (edge.selected === selected && !selectionPreview) {
              return edge;
            }
            changed = true;
            return {
              ...edge,
              selected,
              data: edge.data
                ? {
                    ...edge.data,
                    selectionPreview: false,
                  }
                : edge.data,
            };
          });
          return changed ? next : current;
        });
        selectionPreviewNodeIdsRef.current = new Set();
        selectionPreviewEdgeIdsRef.current = new Set();
      }
      selectionGestureActiveRef.current = false;
      selectionGestureClearTimerRef.current = null;
    }, 0);
  }, [setEdges, setNodes]);

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
        const next = {
          ...current,
          [nodeId]: {
            ...state,
            running: false,
          },
        };
        updateNodeRuntimeData(nodeId, next[nodeId]);
        return next;
      });
      runningClearTimersRef.current.delete(nodeId);
    }, remaining);
    runningClearTimersRef.current.set(nodeId, timerId);
    return true;
  }, [clearRunningTimer, updateNodeRuntimeData]);

  const sendRunRequest = useCallback(
    (nodeId: string, action: ExecutionAction, silenceIfDisconnected = false) => {
      const workspace = buildWorkspace();
      if (!workspace) {
        return;
      }
      let request;
      try {
        request = compileExecutionRequest(workspace, nodeId, action);
      } catch (error) {
        setToast(String(error));
        return;
      }
      const event: ClientEvent = {
        type: "run_node",
        request,
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

  const sendExecutionRequest = useCallback((
    request: ExecutionRequest,
    silenceIfDisconnected = false,
  ) => {
    const event: ClientEvent = {
      type: "run_node",
      request,
    };
    if (!socketRef.current?.ready) {
      if (!silenceIfDisconnected) {
        setToast("kernel websocket is not connected yet");
      }
      return false;
    }
    socketRef.current.send(event);
    return true;
  }, []);

  const runCurrentExecutionPlan = useCallback(() => {
    const workspace = buildWorkspace();
    if (!workspace) {
      return;
    }
    const request = buildExecutionRequestFromPlan(workspace, executionPlanRef.current);
    if (request.graph.nodes.length === 0) {
      setToast("execution plan is empty");
      return;
    }
    sendExecutionRequest(request);
  }, [buildWorkspace, sendExecutionRequest]);

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
      onSelectExecutionTarget: (nodeId, action, additive) => {
        const workspace = buildWorkspace();
        if (!workspace) {
          return;
        }
        try {
          const computedPlan = executionPlanFromRequest(
            compileExecutionRequest(workspace, nodeId, action),
          );
          setExecutionPlan((current) => mergeExecutionPlans(current, computedPlan, additive));
        } catch (error) {
          setToast(String(error));
        }
      },
      getActionReason,
      onToggleExecutionPlanMatout: (_nodeId, id) => {
        setExecutionPlan((current) => ({
          ...current,
          providedMatoutIds: current.providedMatoutIds.includes(id)
            ? current.providedMatoutIds.filter((candidate) => candidate !== id)
            : [...current.providedMatoutIds, id].sort(),
        }));
      },
      onDelete: (nodeId) => {
        setNodes((current) => {
          const nextEdges = edgesRef.current.filter(
            (edge) => edge.source !== nodeId && edge.target !== nodeId,
          );
          const nextIncomingSummaries = buildIncomingEdgeSummaries(nextEdges);
          const affectedTargetIds = new Set(
            edgesRef.current
              .filter((edge) => edge.source === nodeId && edge.target !== nodeId)
              .map((edge) => edge.target),
          );
          incomingEdgeSummaryRef.current = nextIncomingSummaries;
          const next = current
            .filter((node) => node.id !== nodeId)
            .map((node) => {
              if (!affectedTargetIds.has(node.id)) {
                return node;
              }
              const derived = deriveNodeEdgeData(
                node.data.model.kind,
                nextIncomingSummaries.get(node.id),
              );
              return sameArray(node.data.argvSlots, derived.argvSlots) && sameArray(node.data.previewTabs, derived.previewTabs)
                ? node
                : {
                    ...node,
                    data: {
                      ...node.data,
                      argvSlots: derived.argvSlots,
                      previewTabs: derived.previewTabs,
                    },
                  };
            });
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
        const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
        if (!node) {
          return;
        }
        const cleared = clearNodeMaterialized(
          flowNodeToPersistedWorkspaceNode(node, runtimeRef.current),
          materializedOutputStoreRef.current,
        );
        const nextRuntime = {
          ...runtimeRef.current,
          [nodeId]: {
            ...(runtimeRef.current[nodeId] ?? { running: false, portActivity: {} }),
            previews: runtimePreviewsFromNode(cleared.node, cleared.store),
            livePreviews: undefined,
          },
        };
        const participatingNodeIds = participatingNodeIdsForCurrentPlan(executionPlanRef.current);
        const nextNodes = nodesRef.current.map((candidate) =>
          candidate.id === nodeId
            ? {
                ...toFlowNode(
                  cleared.node,
                  nextRuntime,
                  generationRef.current,
                  stableNodeActions,
                  deriveNodeEdgeData(cleared.node.kind, incomingEdgeSummaryRef.current.get(cleared.node.id)),
                  workspaceMetaRef.current?.ui.previewControlsLocation ?? "node",
                  executionPlanRef.current,
                  participatingNodeIds,
                ),
                selected: candidate.selected,
              }
            : candidate,
        );
        setMaterializedOutputStore(cleared.store);
        setRuntime(nextRuntime);
        setNodes(nextNodes);
        persistWorkspaceSnapshot(nextNodes, edgesRef.current, tuckspaceRef.current, nextRuntime, cleared.store);
      },
      onConvertKind: (nodeId, kind) => {
        setNodes((current) => {
          let nextEdges = edgesRef.current;
          let nextIncomingSummaries = incomingEdgeSummaryRef.current;
          const affectedTargetIds = new Set<string>();
          if (kind === "display") {
            nextEdges = edgesRef.current.filter((edge) => edge.source !== nodeId);
            for (const edge of edgesRef.current) {
              if (edge.source === nodeId && edge.target !== nodeId) {
                affectedTargetIds.add(edge.target);
              }
            }
            nextIncomingSummaries = buildIncomingEdgeSummaries(nextEdges);
            incomingEdgeSummaryRef.current = nextIncomingSummaries;
            setEdges(nextEdges);
          }
          const next = current.map((node) =>
            node.id === nodeId || affectedTargetIds.has(node.id)
              ? (() => {
                  const nextModel = node.id === nodeId
                    ? {
                        ...node.data.model,
                        kind,
                      }
                    : node.data.model;
                  const derived = deriveNodeEdgeData(
                    nextModel.kind,
                    nextIncomingSummaries.get(node.id),
                  );
                  return {
                    ...node,
                    data: {
                      ...node.data,
                      model: nextModel,
                      argvSlots: derived.argvSlots,
                      previewTabs: derived.previewTabs,
                    },
                  };
                })()
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
        const loadingGeneration = { loading: true, error: null };
        setGeneration((current) => ({
          ...current,
          [nodeId]: loadingGeneration,
        }));
        updateNodeGenerationData(nodeId, loadingGeneration);
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
          const completeGeneration = { loading: false, error: null };
          setGeneration((current) => ({
            ...current,
            [nodeId]: completeGeneration,
          }));
          updateNodeGenerationData(nodeId, completeGeneration);
        } catch (error) {
          const failedGeneration = { loading: false, error: String(error) };
          setGeneration((current) => ({
            ...current,
            [nodeId]: failedGeneration,
          }));
          updateNodeGenerationData(nodeId, failedGeneration);
        }
      },
    }),
    [
      buildWorkspace,
      getActionReason,
      persistLayoutSoon,
      persistSoon,
      sendRunRequest,
      setNodes,
      stableNodeActions,
      updateNodeGenerationData,
    ],
  );

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

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
              const next = {
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
              updateNodeRuntimeData(event.node_id, next[event.node_id]);
              return next;
            }
            case "materialized_state": {
              const nextStore = { ...materializedOutputStoreRef.current, ...event.upserted_entries };
              for (const id of event.deleted_ids) {
                delete nextStore[id];
              }
              materializedOutputStoreRef.current = nextStore;
              setMaterializedOutputStore(nextStore);
              const nextMaterialized = { ...event.materialized };
              updateNodeMaterializedData(event.node_id, nextMaterialized);
              const node = nodesRef.current.find((item) => item.id === event.node_id)?.data.model;
              const previous = current[event.node_id] ?? {
                running: false,
                portActivity: {},
              };
              const next = {
                ...current,
                [event.node_id]: {
                  ...previous,
                  previews: node
                    ? runtimePreviewsFromNode(
                        {
                          ...node,
                          materialized: nextMaterialized,
                        },
                        nextStore,
                      )
                    : previous.previews,
                },
              };
              updateNodeRuntimeData(event.node_id, next[event.node_id]);
              return next;
            }
            case "exec_finished": {
              const node = nodesRef.current.find((item) => item.id === event.node_id)?.data.model;
              if (node) {
                updateNodeMaterializedData(event.node_id, {
                  ...(node.materialized ?? { inputs: {}, outputs: {} }),
                  lastExitCode: event.materialized
                    ? event.exit_code
                    : node.materialized?.lastExitCode ?? null,
                });
              }
              const previous = current[event.node_id] ?? {
                running: false,
                portActivity: {},
              };
              const committed = { ...(previous.previews ?? {}) };
              const live = { ...(previous.livePreviews ?? {}) };
              if (node) {
                for (const port of previewOutputPortsForKind(node.kind)) {
                  const candidate = live[port];
                  if (event.materialized && candidate) {
                    committed[port] = { ...candidate, completed: true };
                  }
                  delete live[port];
                }
              }
              const keepRunning = scheduleRunningClear(event.node_id, event.exec_id);
              const next = {
                ...current,
                [event.node_id]: {
                  ...previous,
                  running: keepRunning ? true : false,
                  previews: committed,
                  livePreviews: Object.keys(live).length > 0 ? live : undefined,
                },
              };
              updateNodeRuntimeData(event.node_id, next[event.node_id]);
              return next;
            }
            case "port_activity": {
              const next = {
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
              updateNodeRuntimeData(event.node_id, next[event.node_id]);
              return next;
            }
            case "node_output": {
              const next = {
                ...current,
                [event.node_id]: {
                  ...(current[event.node_id] ?? {
                    running: false,
                    portActivity: {},
                  }),
                  livePreviews: applyNodeOutputEvent(current[event.node_id]?.livePreviews, event),
                },
              };
              updateNodeRuntimeData(event.node_id, next[event.node_id]);
              return next;
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
              const next = {
                ...current,
                [event.to_node_id]: {
                  ...previousState,
                  previews: committed,
                  livePreviews: Object.keys(livePreviews).length > 0 ? livePreviews : undefined,
                },
              };
              updateNodeRuntimeData(event.to_node_id, next[event.to_node_id]);
              return next;
            }

            case "display_update":
              return current;
            case "execution_stopped": {
              const nextState = { ...current };
              const updatedNodeIds: string[] = [];
              for (const [nodeId, state] of Object.entries(current)) {
                if (state.lastExecId === event.exec_id) {
                  const keepRunning = scheduleRunningClear(nodeId, event.exec_id);
                  nextState[nodeId] = {
                    ...state,
                    running: keepRunning ? true : false,
                    livePreviews: undefined,
                  };
                  updatedNodeIds.push(nodeId);
                }
              }
              updateNodesRuntimeData(updatedNodeIds, nextState);
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
  }, [clearRunningTimer, scheduleRunningClear, updateNodeMaterializedData, updateNodeRuntimeData, updateNodesRuntimeData]);

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
  // Selection churn is a hot path. Keep autorun bookkeeping keyed to the node model
  // auto-run slice rather than the whole node object so selection changes do not
  // tear down and rebuild interval state.
  }, [autorunConfigSignature, sendRunRequest]);

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
      const filteredChanges = changes.filter((change) => change.type !== "select");
      if (filteredChanges.length === 0) {
        return;
      }
      setNodes((current) => {
        const next = applyNodeChanges(filteredChanges, current);
        const shouldPersistImmediately = filteredChanges.some((change) => {
          if (change.type === "position") {
            return !change.dragging;
          }
          return change.type !== "dimensions";
        });
        const shouldPersistLayout = filteredChanges.some(
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
      const filteredChanges = changes.filter((change) => change.type !== "select");
      if (filteredChanges.length === 0) {
        return;
      }
      setEdges((current) => {
        const next = applyEdgeChanges(filteredChanges, current);
        const currentById = new Map(current.map((edge) => [edge.id, edge]));
        const nextById = new Map(next.map((edge) => [edge.id, edge]));
        const affectedTargetNodeIds = new Set<string>();
        for (const change of filteredChanges) {
          if (!("id" in change)) {
            continue;
          }
          for (const nodeId of reconcileIncomingEdgeSummaryForEdgeChange(
            incomingEdgeSummaryRef.current,
            currentById.get(change.id),
            nextById.get(change.id),
          )) {
            affectedTargetNodeIds.add(nodeId);
          }
        }
        updateNodeEdgeDerivedData(affectedTargetNodeIds);
        const shouldPersist = filteredChanges.length > 0;
        if (shouldPersist) {
          persistSoon(nodesRef.current, next);
        }
        return next;
      });
    },
    [persistSoon, setEdges, updateNodeEdgeDerivedData],
  );

  const deleteEdge = useCallback(
    (edgeId: string) => {
      setEdges((current) => {
        const deletedEdge = current.find((edge) => edge.id === edgeId);
        const next = current.filter((edge) => edge.id !== edgeId);
        if (deletedEdge) {
          summarizeIncomingEdge(incomingEdgeSummaryRef.current, deletedEdge, -1);
          updateNodeEdgeDerivedData([deletedEdge.target]);
        }
        persistSoon(nodesRef.current, next);
        return next;
      });
    },
    [persistSoon, setEdges, updateNodeEdgeDerivedData],
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
              ...edge.data,
              buffering,
              onDelete: deleteEdge,
              onCycle: cycleEdgeBuffering,
            },
            animated: buffering === "unbuffered",
            label: buffering.replaceAll("_", " "),
          };
        });
        persistSoon(nodesRef.current, next);
        return next;
      });
    },
    [persistSoon, setEdges],
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
      await Promise.all([
        saveWorkspace(nextWorkspace),
        saveMaterializedOutputs(materializedOutputStoreRef.current),
      ]);
      return;
    }
    await saveMaterializedOutputs(materializedOutputStoreRef.current);
  }, [buildWorkspace, cancelPendingWorkspaceSaves]);

  const applyLoadedWorkspace = useCallback((loaded: Workspace, store: MaterializedOutputStore = materializedOutputStoreRef.current) => {
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
          previews: runtimePreviewsFromNode(node, store),
        },
      ]),
    );
    const loadedEdges = loaded.edges.map((edge) =>
      toFlowEdge(edge, deleteEdge, cycleEdgeBuffering, emptyExecutionPlan(), false),
    );
    const incomingSummaries = buildIncomingEdgeSummaries(loadedEdges);
    const participatingNodeIds = new Set<string>();
    const loadedNodes = loaded.nodes.map((node) =>
      toFlowNode(
        node,
        loadedRuntime,
        {},
        stableNodeActions,
        deriveNodeEdgeData(node.kind, incomingSummaries.get(node.id)),
        loaded.ui.previewControlsLocation,
        emptyExecutionPlan(),
        participatingNodeIds,
      ),
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
    incomingEdgeSummaryRef.current = incomingSummaries;
    executionPlanRef.current = emptyExecutionPlan();

    setWorkspaceSummaries((current) =>
      upsertWorkspaceSummary(current, { id: loaded.id, name: loaded.name, createdAt: loaded.createdAt, sortOrder: loaded.sortOrder }),
    );
    setWorkspaceMeta(nextMeta);
    setGeneration({});
    setRuntime(loadedRuntime);
    setExecutionPlan(emptyExecutionPlan());
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
  }, [cycleEdgeBuffering, deleteEdge, flow, setEdges, setNodes, stableNodeActions]);

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
      const workspace = sanitizeWorkspace(await getWorkspace(workspaceId));
      applyLoadedWorkspace(workspace, materializedOutputStoreRef.current);
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
      applyLoadedWorkspace(created, materializedOutputStoreRef.current);
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
      let nextStore = materializedOutputStoreRef.current;
      const materializedNodes = deletingActive
        ? nodesRef.current.map((node) => flowNodeToPersistedWorkspaceNode(node, runtimeRef.current))
        : sanitizeWorkspace(await getWorkspace(workspaceId)).nodes;
      for (const node of materializedNodes) {
        const cleared = clearNodeMaterialized(node, nextStore);
        nextStore = cleared.store;
      }
      setMaterializedOutputStore(nextStore);
      persistMaterializedOutputStore(nextStore);
      const remainingSummaries = workspaceSummaries.filter((workspace) => workspace.id !== workspaceId);
      await deleteWorkspace(workspaceId);
      if (!deletingActive) {
        setWorkspaceSummaries(remainingSummaries);
        return;
      }
      if (remainingSummaries.length === 0) {
        const created = sanitizeWorkspace(await createWorkspace());
        applyLoadedWorkspace(created, materializedOutputStoreRef.current);
        return;
      }
      setWorkspaceSummaries(remainingSummaries);
      applyLoadedWorkspace(sanitizeWorkspace(await getWorkspace(remainingSummaries[0].id)), materializedOutputStoreRef.current);
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
        const [sharedTuckspace, sharedMaterializedOutputs, loadedWorkspace] = await Promise.all([
          getTuckspace(),
          getMaterializedOutputs(),
          initialWorkspaceId ? getWorkspace(initialWorkspaceId) : createWorkspace(),
        ]);
        const workspace = sanitizeWorkspace(loadedWorkspace);
        if (disposed) {
          return;
        }
        setTuckspace(sharedTuckspace);
        tuckspaceRef.current = sharedTuckspace;
        setMaterializedOutputStore(sharedMaterializedOutputs);
        materializedOutputStoreRef.current = sharedMaterializedOutputs;
        applyLoadedWorkspace(workspace, sharedMaterializedOutputs);
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
              executionPlan: false,
              onDelete: deleteEdge,
              onCycle: cycleEdgeBuffering,
            },
            label: "unbuffered",
          },
          current,
        ) as FlowEdge[];
        const nextEdge = next[next.length - 1];
        if (nextEdge) {
          summarizeIncomingEdge(incomingEdgeSummaryRef.current, nextEdge, 1);
          updateNodeEdgeDerivedData([nextEdge.target]);
        }
        persistSoon(nodesRef.current, next);
        return next;
      });
    },
    [persistSoon, setEdges, updateNodeEdgeDerivedData],
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
          stableNodeActions,
          deriveNodeEdgeData(nextNodeModel.kind, incomingEdgeSummaryRef.current.get(nextNodeModel.id)),
          workspaceMetaRef.current?.ui.previewControlsLocation ?? "node",
          executionPlanRef.current,
          participatingNodeIdsForCurrentPlan(executionPlanRef.current),
        );
        const next = [...current, nextNode];
        persistSoon(next, edgesRef.current);
        return next;
      });
    },
    [flow, persistSoon, runtime, setNodes, stableNodeActions],
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
    const nextIncomingSummaries = buildIncomingEdgeSummaries(nextEdges);
    for (const nodeId of selectedIds) {
      clearRunningTimer(nodeId);
    }
    setGeneration((current) => Object.fromEntries(
      Object.entries(current).filter(([nodeId]) => !selectedIds.has(nodeId)),
    ));
    setActiveExecutions((current) => current.filter((entry) => !selectedIds.has(entry.nodeId)));
    incomingEdgeSummaryRef.current = nextIncomingSummaries;
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
          previews: runtimePreviewsFromNode(node, materializedOutputStoreRef.current),
        },
      ]),
    );
    const nextRuntime = {
      ...runtimeRef.current,
      ...restoredRuntime,
    };
    const restoredEdges = item.edges.map((edge) => toFlowEdge(edge, deleteEdge, cycleEdgeBuffering, executionPlanRef.current, selectionExecModifierRef.current.alt && userSelectionActive));
    const nextEdges = [...edgesRef.current, ...restoredEdges];
    const nextIncomingSummaries = buildIncomingEdgeSummaries(nextEdges);
    const nextExecutionPlanEdges = nextEdges.map(flowEdgeToWorkspaceEdge);
    const participatingNodeIds = new Set(participatingNodeIdsForPlan(executionPlanRef.current, nextExecutionPlanEdges));
    const preservedNodes = nodesRef.current.map((node) => ({ ...node, selected: false }));
    const restoredNodes = restoredModels.map((node) => ({
      ...toFlowNode(
        node,
        nextRuntime,
        generationRef.current,
        stableNodeActions,
        deriveNodeEdgeData(node.kind, nextIncomingSummaries.get(node.id)),
        workspaceMetaRef.current?.ui.previewControlsLocation ?? "node",
        executionPlanRef.current,
        participatingNodeIds,
      ),
      selected: true,
    }));
    const nextNodes = [...preservedNodes, ...restoredNodes];
    incomingEdgeSummaryRef.current = nextIncomingSummaries;
    setTuckspace(nextTuckspace);
    setRuntime(nextRuntime);
    setEdges(nextEdges);
    setNodes(nextNodes);
    persistWorkspaceSnapshot(nextNodes, nextEdges, nextTuckspace, nextRuntime);
  }, [cycleEdgeBuffering, deleteEdge, flow, persistWorkspaceSnapshot, setEdges, setNodes, stableNodeActions]);

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
    () => userSelectionActive ? [] : nodes.filter((node) => node.selected),
    [nodes, userSelectionActive],
  );
  const selectedEdges = useMemo(
    () => userSelectionActive ? [] : edges.filter((edge) => edge.selected),
    [edges, userSelectionActive],
  );
  const selectedNodeIds = useMemo(
    () => new Set(selectedNodes.map((node) => node.id)),
    [selectedNodes],
  );
  const selectedEdgeIds = useMemo(
    () => new Set(selectedEdges.map((edge) => edge.id)),
    [selectedEdges],
  );
  const selectedPreviewNodes = useMemo(
    () => userSelectionActive
      ? []
      : selectedNodes.map((node) => ({
          id: node.id,
          previewTabs: node.data.previewTabs ?? nodePreviewTabs(node.data.model.kind),
          openPreviewTabs: node.data.model.uiState?.openPreviewTabs ?? [],
        })),
    [selectedNodes, userSelectionActive],
  );
  const executionPlanHasTargets =
    executionPlan.executableNodeIds.length > 0 || executionPlan.edgeIds.length > 0;
  const executionPlanParticipatingNodeIds = useMemo(
    () => participatingNodeIdsForPlan(executionPlan, edges.map(flowEdgeToWorkspaceEdge)),
    [edges, executionPlan],
  );
  const executionPlanSummary = useMemo(
    () => ({
      nodeCount: executionPlanParticipatingNodeIds.length,
      edgeCount: executionPlan.edgeIds.length,
      matoutCount: executionPlan.providedMatoutIds.length,
    }),
    [executionPlan, executionPlanParticipatingNodeIds.length],
  );

  useEffect(() => {
    syncDisplayedExecutionPlan(buildDisplayedExecutionPlan());
  }, [buildDisplayedExecutionPlan, executionPlan, syncDisplayedExecutionPlan]);

  const canTuckSelection = useMemo(
    () => userSelectionActive ? false : isClosedSelection(selectedNodeIds, edges),
    [edges, selectedNodeIds, userSelectionActive],
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

  const canToggleSelectedPreviewTabs = useMemo(
    () => userSelectionActive
      ? { all: false, stdin: false, stdout: false, stderr: false, argv: false }
      : {
          all: selectionSupportsPreviewCategory(selectedPreviewNodes, "all"),
          stdin: selectionSupportsPreviewCategory(selectedPreviewNodes, "stdin"),
          stdout: selectionSupportsPreviewCategory(selectedPreviewNodes, "stdout"),
          stderr: selectionSupportsPreviewCategory(selectedPreviewNodes, "stderr"),
          argv: selectionSupportsPreviewCategory(selectedPreviewNodes, "argv"),
        },
    [selectedPreviewNodes, userSelectionActive],
  );

  const deleteTuckShell = useCallback((tuckId: string) => {
    const nextTuckspace = tuckspaceRef.current.filter((item) => item.id !== tuckId);
    setTuckspace(nextTuckspace);
    persistWorkspaceSnapshot(nodesRef.current, edgesRef.current, nextTuckspace);
  }, [persistWorkspaceSnapshot]);

  const clearSelection = useCallback(() => {
    setNodes((current) => {
      const next = current.map((node) => (node.selected ? { ...node, selected: false } : node));
      return next;
    });
    setEdges((current) => {
      const next = current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge));
      return next;
    });
  }, [setEdges, setNodes]);

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
    const selectedNodeIds = new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id));
    if (selectedNodeIds.size === 0) {
      return;
    }
    let nextStore = materializedOutputStoreRef.current;
    const updatedModels = new Map<string, WorkspaceNode>();
    for (const node of nodesRef.current) {
      if (!selectedNodeIds.has(node.id)) {
        continue;
      }
      const persisted = flowNodeToPersistedWorkspaceNode(node, runtimeRef.current);
      const cleared = clearNodeMaterialized(persisted, nextStore);
      nextStore = cleared.store;
      updatedModels.set(node.id, cleared.node);
    }
    const nextRuntime = { ...runtimeRef.current };
    for (const [nodeId, model] of updatedModels) {
      nextRuntime[nodeId] = {
        ...(nextRuntime[nodeId] ?? { running: false, portActivity: {} }),
        previews: runtimePreviewsFromNode(model, nextStore),
        livePreviews: undefined,
      };
    }
    const nextNodes = nodesRef.current.map((node) => {
      const updated = updatedModels.get(node.id);
      return updated
        ? {
            ...toFlowNode(
              updated,
              nextRuntime,
              generationRef.current,
              stableNodeActions,
              deriveNodeEdgeData(updated.kind, incomingEdgeSummaryRef.current.get(updated.id)),
              workspaceMetaRef.current?.ui.previewControlsLocation ?? "node",
              executionPlanRef.current,
              participatingNodeIdsForCurrentPlan(executionPlanRef.current),
            ),
            selected: node.selected,
          }
        : node;
    });
    setMaterializedOutputStore(nextStore);
    setRuntime(nextRuntime);
    setNodes(nextNodes);
    persistWorkspaceSnapshot(nextNodes, edgesRef.current, tuckspaceRef.current, nextRuntime, nextStore);
  }, [persistWorkspaceSnapshot, setNodes, stableNodeActions]);

  const duplicateSelected = useCallback(() => {
    const selectedNodes = nodesRef.current.filter((node) => node.selected);
    if (selectedNodes.length === 0) {
      return;
    }
    const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
    let nextStore = materializedOutputStoreRef.current;
    const duplicatedModels = selectedNodes.map((node) => {
      const model = flowNodeToPersistedWorkspaceNode(node, runtimeRef.current);
      const duplicated = {
        ...model,
        materialized: { inputs: {}, outputs: {}, lastExitCode: model.materialized?.lastExitCode ?? null },
        id: encodeId(`node-${model.kind.replaceAll("_", "-")}`),
        position: {
          x: model.position.x + 48,
          y: model.position.y + 48,
        },
      };
      const result = duplicateNodeMaterialized(model, duplicated, nextStore);
      nextStore = result.store;
      return result.node;
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
          previews: runtimePreviewsFromNode(node, nextStore),
        },
      ]),
    );
    const nextRuntime = {
      ...runtimeRef.current,
      ...duplicatedRuntime,
    };
    const nextIncomingSummaries = buildIncomingEdgeSummaries([
      ...edgesRef.current,
      ...duplicatedEdges.map((edge) => toFlowEdge(edge, deleteEdge, cycleEdgeBuffering, executionPlanRef.current, selectionExecModifierRef.current.alt && userSelectionActive)),
    ]);
    const nextEdges = [
      ...edgesRef.current.map((edge) => ({ ...edge, selected: false })),
      ...duplicatedEdges.map((edge) => ({
        ...toFlowEdge(edge, deleteEdge, cycleEdgeBuffering, executionPlanRef.current, selectionExecModifierRef.current.alt && userSelectionActive),
        selected: true,
      })),
    ];
    const nextExecutionPlanEdges = nextEdges.map(flowEdgeToWorkspaceEdge);
    const participatingNodeIds = new Set(participatingNodeIdsForPlan(executionPlanRef.current, nextExecutionPlanEdges));
    const nextNodes = [
      ...nodesRef.current.map((node) => ({ ...node, selected: false })),
      ...duplicatedModels.map((node) => ({
        ...toFlowNode(
          node,
          nextRuntime,
          generationRef.current,
          stableNodeActions,
          deriveNodeEdgeData(node.kind, nextIncomingSummaries.get(node.id)),
          workspaceMetaRef.current?.ui.previewControlsLocation ?? "node",
          executionPlanRef.current,
          participatingNodeIds,
        ),
        selected: true,
      })),
    ];
    incomingEdgeSummaryRef.current = nextIncomingSummaries;
    setMaterializedOutputStore(nextStore);
    setRuntime(nextRuntime);
    setEdges(nextEdges);
    setNodes(nextNodes);
    persistWorkspaceSnapshot(nextNodes, nextEdges, tuckspaceRef.current, nextRuntime, nextStore);
  }, [cycleEdgeBuffering, deleteEdge, persistWorkspaceSnapshot, setEdges, setNodes, stableNodeActions]);

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
            ...edge.data,
            buffering,
            onDelete: deleteEdge,
            onCycle: cycleEdgeBuffering,
          },
          animated: buffering === "unbuffered",
          label: buffering.replaceAll("_", " "),
        };
      });
      persistSoon(nodesRef.current, next);
      return next;
    });
  }, [cycleEdgeBuffering, deleteEdge, persistSoon, setEdges]);

  const toggleSelectedPreviewTabs = useCallback((category: PreviewToggleCategory) => {
    const nextTabsByNodeId = togglePreviewCategoryForSelection(selectedPreviewNodes, category);
    if (nextTabsByNodeId.size === 0) {
      return;
    }
    setNodes((current) => {
      const next = current.map((node) => {
        const nextTabs = nextTabsByNodeId.get(node.id);
        if (!nextTabs) {
          return node;
        }
        return {
          ...node,
          data: {
            ...node.data,
            model: {
              ...node.data.model,
              uiState: {
                ...(node.data.model.uiState ?? {}),
                openPreviewTabs: nextTabs,
              },
            },
          },
        };
      });
      persistSoon(next, edgesRef.current);
      return next;
    });
  }, [persistSoon, selectedPreviewNodes, setNodes]);

  const deleteSelected = useCallback(() => {
    const selectedNodeIds = new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id));
    const selectedEdgeIds = new Set(edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id));
    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) {
      return;
    }
    let nextStore = materializedOutputStoreRef.current;
    for (const node of nodesRef.current) {
      if (!selectedNodeIds.has(node.id)) {
        continue;
      }
      const persisted = flowNodeToPersistedWorkspaceNode(node, runtimeRef.current);
      const cleared = clearNodeMaterialized(persisted, nextStore);
      nextStore = cleared.store;
    }
    const nextEdges = edgesRef.current.filter(
      (edge) => !selectedEdgeIds.has(edge.id) && !selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target),
    );
    const nextIncomingSummaries = buildIncomingEdgeSummaries(nextEdges);
    const affectedTargetIds = new Set(
      edgesRef.current
        .filter((edge) =>
          selectedEdgeIds.has(edge.id)
          || (selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target)),
        )
        .map((edge) => edge.target),
    );
    const nextNodes = nodesRef.current
      .filter((node) => !selectedNodeIds.has(node.id))
      .map((node) => {
        if (!affectedTargetIds.has(node.id)) {
          return node;
        }
        const derived = deriveNodeEdgeData(
          node.data.model.kind,
          nextIncomingSummaries.get(node.id),
        );
        return sameArray(node.data.argvSlots, derived.argvSlots) && sameArray(node.data.previewTabs, derived.previewTabs)
          ? node
          : {
              ...node,
              data: {
                ...node.data,
                argvSlots: derived.argvSlots,
                previewTabs: derived.previewTabs,
              },
            };
      });
    const nextRuntime = Object.fromEntries(Object.entries(runtimeRef.current).filter(([nodeId]) => !selectedNodeIds.has(nodeId)));
    incomingEdgeSummaryRef.current = nextIncomingSummaries;
    setMaterializedOutputStore(nextStore);
    setRuntime(nextRuntime);
    setEdges(nextEdges);
    setNodes(nextNodes);
    persistWorkspaceSnapshot(nextNodes, nextEdges, tuckspaceRef.current, nextRuntime, nextStore);
  }, [persistWorkspaceSnapshot, setEdges, setNodes]);

  const runLayout = useCallback(() => {
    const selectedNodeIds = nodesRef.current
      .filter((node) => node.selected)
      .map((node) => node.id);
    const positions = layoutSelectedNodes(
      selectedNodeIds,
      nodesRef.current.map(flowNodeToWorkspaceNode),
      workspaceEdgesRef.current,
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
        className={`canvas-shell ${selectionExecModifier.alt ? "is-exec-plan-modifier-active" : ""} ${selectionExecModifier.alt && userSelectionActive ? "is-exec-selection-active" : ""}`}
        onContextMenu={(event) => {
          if (selectedNodes.length > 0) {
            event.preventDefault();
          }
        }}
      >
        <ReactFlow<FlowNode, FlowEdge>
          style={{
            ["--canvas-zoom" as string]: `${zoom}`,
            ["--selection-gesture-color" as string]: userSelectionActive && selectionExecModifier.alt
              ? "var(--exec-plan-color)"
              : "var(--selection)",
          }}
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
          deleteKeyCode={null}
          zoomOnScroll
          panOnScroll={false}
          panOnDrag={PAN_ON_DRAG_BUTTONS as unknown as number[]}
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
          onPaneClick={clearSelection}
          onSelectionStart={beginSelectionGesture}
          onSelectionEnd={endSelectionGesture}
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
          {executionPlanHasTargets && (
            <Panel position="top-right" className="exec-plan-panel">
              <div className="exec-plan-panel-summary">
                plan · {executionPlanSummary.nodeCount} nodes · {executionPlanSummary.edgeCount} wires · {executionPlanSummary.matoutCount} matvals
              </div>
              <div className="exec-plan-panel-buttons">
                <button type="button" onClick={runCurrentExecutionPlan}>
                  play
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => setExecutionPlan(emptyExecutionPlan())}
                >
                  reset
                </button>
              </div>
            </Panel>
          )}
          <Panel position="bottom-left" className="zoom-controls-note">
            <div className="zoom-wheel-note">scroll wheel: zoom</div>
          </Panel>
          <Background gap={28} size={1} color="rgba(250, 244, 233, 0.08)" />
        </ReactFlow>
        {!userSelectionActive && (
          <SelectionActionsAnchor
            canvasRef={canvasRef}
            nodes={nodes}
            edges={edges}
            selectedNodes={selectedNodes}
            selectedEdges={selectedEdges}
          >
            <button type="button" onClick={duplicateSelected} disabled={selectedNodes.length === 0}>
              <span className="selection-actions-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" focusable="false">
                  <rect x="5" y="5" width="8" height="8" rx="1.2" />
                  <path d="M11 5V3.7A1.2 1.2 0 0 0 9.8 2.5H3.7A1.2 1.2 0 0 0 2.5 3.7v6.1A1.2 1.2 0 0 0 3.7 11H5" />
                </svg>
              </span>
              <span>duplicate</span>
            </button>
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
            <button type="button" onClick={runLayout} disabled={selectedNodes.length < 2} title={selectedNodes.length < 2 ? "select at least two nodes" : "organize selected nodes"}>
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
              <button type="button" disabled={selectedNodes.length === 0} title={selectedNodes.length === 0 ? "select nodes first" : "toggle preview tabs"}>
                <span className="selection-actions-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" focusable="false">
                    <path d="M2.5 4.5h11" />
                    <path d="M2.5 8h11" />
                    <path d="M2.5 11.5h11" />
                  </svg>
                </span>
                <span>toggle tabs</span>
              </button>
              {selectedNodes.length > 0 && (
                <div className="selection-actions-submenu">
                  <button type="button" disabled={!canToggleSelectedPreviewTabs.all} onClick={() => toggleSelectedPreviewTabs("all")}>all</button>
                  <button type="button" disabled={!canToggleSelectedPreviewTabs.stdin} onClick={() => toggleSelectedPreviewTabs("stdin")}>stdin</button>
                  <button type="button" disabled={!canToggleSelectedPreviewTabs.stdout} onClick={() => toggleSelectedPreviewTabs("stdout")}>stdout</button>
                  <button type="button" disabled={!canToggleSelectedPreviewTabs.stderr} onClick={() => toggleSelectedPreviewTabs("stderr")}>stderr</button>
                  <button type="button" disabled={!canToggleSelectedPreviewTabs.argv} onClick={() => toggleSelectedPreviewTabs("argv")}>argv</button>
                </div>
              )}
            </div>
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
          </SelectionActionsAnchor>
        )}
        {userSelectionActive && userSelectionRect && (
          <SelectionGestureHint
            rect={userSelectionRect}
            altActive={selectionExecModifier.alt}
            shiftActive={selectionExecModifier.shift}
          />
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
