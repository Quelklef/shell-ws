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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "@xyflow/react/dist/style.css";

import ShellNode from "./components/ShellNode";
import WorkspaceEdgeView from "./components/WorkspaceEdge";
import {
  createWorkspace,
  generateScript,
  getWorkspace,
  listWorkspaces,
  pickFilePath,
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
} from "./lib/types";
import { connectKernel } from "./lib/ws";
import { sanitizeWorkspace } from "./lib/workspace";
import { missingConnectedInputs, missingOutputs, outputPortsForKind, previewOutputPortsForKind, runtimePreviewsFromNode, materializedValuesFromRuntime } from "./lib/materialized";
import { applyNodeOutputEvent } from "./lib/runtimeEvents";
import { nextPaneSizes } from "./lib/paneLayout";
import { concatBytes, encodeId, fromBase64, toBase64 } from "./lib/utils";

const nodeTypes = {
  shell: ShellNode,
};

const edgeTypes = {
  workspace: WorkspaceEdgeView,
};


function makeNode(kind: NodeKind, count: number): WorkspaceNode {
  const previewOpenByDefault = kind === "formula" ? [] : ["stdout"];
  return {
    id: encodeId(kind),
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
    },
  }));
}

function toFlowNode(
  node: WorkspaceNode,
  runtime: Record<string, NodeRuntimeState>,
  generation: Record<string, AiGenerationState>,
  handlers: Pick<
    ShellNodeActions,
    "onUpdate" | "onRun" | "getActionReason" | "onDelete" | "onPickFile" | "onToggleAutorun" | "onGenerate" | "onClearMaterialized" | "onConvertKind" | "onResizeWidth" | "onResizePaneHeight"
  >,
  edges: FlowEdge[],
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
};

type AutorunHandle = {
  signature: string;
  timerId: number;
};

function WorkspaceCanvas() {
  const [workspaceMeta, setWorkspaceMeta] = useState<Pick<
    Workspace,
    "id" | "name" | "cwd" | "openaiApiKey" | "ui"
  > | null>(null);
  const [kernelConnected, setKernelConnected] = useState(false);
  const [generation, setGeneration] = useState<Record<string, AiGenerationState>>({});
  const [runtime, setRuntime] = useState<Record<string, NodeRuntimeState>>({});
  const [activeExecutions, setActiveExecutions] = useState<
    { execId: string; nodeId: string }[]
  >([]);
  const [toast, setToast] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const socketRef = useRef<ReturnType<typeof connectKernel> | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const rightDragRef = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    moved: boolean;
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const workspaceMetaRef = useRef<Pick<Workspace, "id" | "name" | "cwd" | "openaiApiKey" | "ui"> | null>(
    null,
  );
  const nodesRef = useRef<FlowNode[]>([]);
  const edgesRef = useRef<FlowEdge[]>([]);
  const autorunRef = useRef<Map<string, AutorunHandle>>(new Map());
  const runtimeRef = useRef<Record<string, NodeRuntimeState>>({});
  const persistTimerRef = useRef<number | null>(null);
  const layoutPersistTimerRef = useRef<number | null>(null);
  const generationRef = useRef<Record<string, AiGenerationState>>({});
  const runningStartedAtRef = useRef<Record<string, number>>({});
  const runningClearTimersRef = useRef<Map<string, number>>(new Map());

  const flow = useReactFlow<FlowNode, FlowEdge>();
  const userSelectionState = useStore((store) => ({
    rect: store.userSelectionRect,
    active: store.userSelectionActive,
    transform: store.transform,
  }));

  const [nodes, setNodes] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useEdgesState<FlowEdge>([]);

  useEffect(() => {
    workspaceMetaRef.current = workspaceMeta;
  }, [workspaceMeta]);

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
    const previewIds = userSelectionState.active && userSelectionState.rect
      ? new Set(
          flow
            .getIntersectingNodes(
              selectionRectToFlowRect(userSelectionState.rect, userSelectionState.transform),
              true,
              nodesRef.current,
            )
            .map((node) => node.id),
        )
      : new Set<string>();
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const selectionPreview = previewIds.has(node.id);
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
  }, [flow, setNodes, userSelectionState]);

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
        "id" | "name" | "cwd" | "openaiApiKey" | "ui"
      > | null = workspaceMetaRef.current,
      runtimeArg: Record<string, NodeRuntimeState> = runtimeRef.current,
    ): Workspace | null => {
      if (!metaArg) {
        return null;
      }
      return {
        id: metaArg.id,
        name: metaArg.name,
        ui: metaArg.ui,
        cwd: metaArg.cwd,
        openaiApiKey: metaArg.openaiApiKey,
        nodes: nodesArg.map((node) => {
          const model = flowNodeToWorkspaceNode(node);
          const runtimeState = runtimeArg[node.id];
          const materializedValues = materializedValuesFromRuntime(runtimeState?.previews);
          return {
            ...model,
            materializedValues: runtimeState?.previews ? materializedValues : model.materializedValues,
          };
        }),
        edges: edgesArg.map(flowEdgeToWorkspaceEdge),
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
                      uiState: nextPaneSizes(node.data.model.uiState, paneId, height),
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
    let disposed = false;
    listWorkspaces()
      .then(async (summaries) => {
        const loaded = sanitizeWorkspace(
          summaries.length > 0
            ? await getWorkspace(summaries[0].id)
            : await createWorkspace(),
        );
        if (disposed) {
          return;
        }
        const ui =
          loaded.ui.viewportX === 0 &&
          loaded.ui.viewportY === 0 &&
          loaded.ui.zoom === 1
            ? { ...loaded.ui, zoom: 0.5 }
            : loaded.ui;
        setWorkspaceMeta({ id: loaded.id, name: loaded.name, cwd: loaded.cwd, openaiApiKey: loaded.openaiApiKey, ui });
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
        setRuntime(loadedRuntime);
        setNodes(
          loaded.nodes.map((node) =>
            toFlowNode(node, loadedRuntime, {}, handlers, loadedEdges),
          ),
        );
        setEdges(loadedEdges);
      })
      .catch((error) => setToast(String(error)));

    return () => {
      disposed = true;
    };
  }, [handlers, setEdges, setNodes]);

  useEffect(() => {
    setNodes((current) =>
      syncNodeData(current, runtime, generationRef.current, handlers, edgesRef.current),
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
    if (!contextMenu) {
      return;
    }

    const closeOnPointer = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest(".context-menu")) {
        return;
      }
      setContextMenu(null);
    };

    const closeMenu = () => setContextMenu(null);

    window.addEventListener("pointerdown", closeOnPointer, true);
    window.addEventListener("wheel", closeMenu, { passive: true });
    window.addEventListener("keydown", closeMenu);

    return () => {
      window.removeEventListener("pointerdown", closeOnPointer, true);
      window.removeEventListener("wheel", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [contextMenu]);

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
          syncNodeData(nodesCurrent, runtime, generationRef.current, handlers, next),
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
          syncNodeData(nodesCurrent, runtime, generationRef.current, handlers, next),
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
          syncNodeData(nodesCurrent, runtime, generationRef.current, handlers, next),
        );
        persistSoon(nodesRef.current, next);
        return next;
      });
    },
    [handlers, persistSoon, setEdges, setNodes],
  );

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
          syncNodeData(nodesCurrent, runtime, generationRef.current, handlers, next),
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
        );
        const next = [...current, nextNode];
        persistSoon(next, edgesRef.current);
        return next;
      });
    },
    [flow, handlers, persistSoon, runtime, setNodes],
  );

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
    setContextMenu(null);
  }, [persistSoon, setNodes]);

  if (!workspaceMeta) {
    return <div className="app-loading">loading workspace...</div>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-controls-group">
          <span
            className={`kernel-pill ${kernelConnected ? "online" : "offline"}`}
          >
            {kernelConnected ? "kernel online" : "kernel offline"}
          </span>
          <label className="sidebar-field">
            <span className="sidebar-label">pwd</span>
            <input
              className="sidebar-input"
              value={workspaceMeta.cwd}
              onChange={(event) => updateWorkspaceCwd(event.target.value)}
              placeholder="/home/user"
              title="working directory for kernel execution"
            />
          </label>
          <label className="sidebar-field">
            <span className="sidebar-label">openai api key</span>
            <input
              className="sidebar-input"
              type="password"
              autoComplete="off"
              value={workspaceMeta.openaiApiKey}
              onChange={(event) => updateWorkspaceApiKey(event.target.value)}
              placeholder="sk-..."
              title="workspace-level OpenAI API key for AI SCRIPT generation"
            />
          </label>
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
        </div>
        <div className="sidebar-divider" />
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
      </aside>

      <main
        ref={canvasRef}
        className="canvas-shell"
        onPointerDown={(event) => {
          if (event.button === 2) {
            rightDragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              moved: false,
            };
          }
        }}
        onPointerMove={(event) => {
          const state = rightDragRef.current;
          if (
            state.pointerId !== null &&
            state.pointerId === event.pointerId &&
            (event.buttons & 2) === 2
          ) {
            const distance = Math.hypot(
              event.clientX - state.startX,
              event.clientY - state.startY,
            );
            if (distance > 6) {
              state.moved = true;
            }
          }
        }}
        onPointerUp={() => {
          window.setTimeout(() => {
            rightDragRef.current = {
              pointerId: null,
              startX: 0,
              startY: 0,
              moved: false,
            };
          }, 0);
        }}
        onContextMenu={(event) => {
          if (rightDragRef.current.moved) {
            event.preventDefault();
            rightDragRef.current = {
              pointerId: null,
              startX: 0,
              startY: 0,
              moved: false,
            };
            return;
          }
          const selectedCount = nodes.filter((node) => node.selected).length;
          if (selectedCount > 0) {
            event.preventDefault();
            setContextMenu({ x: event.clientX, y: event.clientY });
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
            setWorkspaceMeta((current) => {
              if (!current) {
                return current;
              }
              const next = {
                ...current,
                ui: {
                  viewportX: viewport.x,
                  viewportY: viewport.y,
                  zoom: viewport.zoom,
                },
              };
              const nextWorkspace = buildWorkspace(nodesRef.current, edgesRef.current, next);
              if (nextWorkspace) {
                saveWorkspace(nextWorkspace).catch((error) => setToast(String(error)));
              }
              return next;
            })
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
        {contextMenu && (
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseLeave={() => setContextMenu(null)}
          >
            <button type="button" onClick={runLayout}>
              layout selected
            </button>
          </div>
        )}
        {toast && <div className="toast">{toast}</div>}
      </main>
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
