import {
  Background,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "@xyflow/react/dist/style.css";

import ShellNode from "./components/ShellNode";
import WorkspaceEdgeView from "./components/WorkspaceEdge";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  saveWorkspace,
} from "./lib/api";
import { layoutSelectedNodes } from "./lib/layout";
import type {
  AutoRunConfig,
  BufferingMode,
  ClientEvent,
  ExecutionMode,
  FlowEdge,
  FlowNode,
  NodeKind,
  NodeRuntimeState,
  PortKind,
  Workspace,
  WorkspaceEdge,
  WorkspaceNode,
} from "./lib/types";
import { connectKernel } from "./lib/ws";
import { concatBytes, encodeId, fromBase64 } from "./lib/utils";

const nodeTypes = {
  shell: ShellNode,
};

const edgeTypes = {
  workspace: WorkspaceEdgeView,
};

function makeNode(kind: NodeKind, count: number): WorkspaceNode {
  return {
    id: encodeId(kind),
    kind,
    title: `${kind.replaceAll("_", " ")} ${count}`,
    comment: "",
    position: { x: 140 + count * 30, y: 140 + count * 24 },
    size: { width: 320, height: kind === "display" ? 300 : 230 },
    shell: "bash",
    script:
      kind === "process" || kind === "merge_shell" ? "printf 'hello\\n'" : null,
    text: kind === "text" ? "shell-ws\n" : null,
    autoRun: null,
  };
}

function paletteGroups(): {
  label: string;
  items: { kind: NodeKind; label: string }[];
}[] {
  return [
    {
      label: "sources",
      items: [{ kind: "text", label: "text" }],
    },
    {
      label: "process",
      items: [{ kind: "process", label: "process" }],
    },
    {
      label: "merge",
      items: [
        { kind: "merge_concat", label: "concat" },
        { kind: "merge_line", label: "line" },
        { kind: "merge_byte", label: "byte" },
        { kind: "merge_shell", label: "shell" },
      ],
    },
    {
      label: "sinks",
      items: [{ kind: "display", label: "display" }],
    },
  ];
}

function toFlowNode(
  node: WorkspaceNode,
  runtime: Record<string, NodeRuntimeState>,
  handlers: Pick<
    ShellNodeActions,
    "onUpdate" | "onRun" | "onStop" | "onDelete" | "onToggleAutorun"
  >,
): FlowNode {
  return {
    id: node.id,
    type: "shell",
    position: node.position,
    data: {
      model: node,
      runtime: runtime[node.id] ?? { running: false, portActivity: {} },
      onUpdate: handlers.onUpdate,
      onRun: handlers.onRun,
      onStop: handlers.onStop,
      onDelete: handlers.onDelete,
      onToggleAutorun: handlers.onToggleAutorun,
    },
    width: node.size.width,
    height: node.size.height,
    initialWidth: node.size.width,
    initialHeight: node.size.height,
    draggable: true,
    selectable: true,
    style: {
      width: node.size.width,
      height: node.size.height,
    },
  };
}

function toFlowEdge(
  edge: WorkspaceEdge,
  onDelete?: (edgeId: string) => void,
): FlowEdge {
  return {
    id: edge.id,
    source: edge.from.nodeId,
    sourceHandle: edge.from.port,
    target: edge.to.nodeId,
    targetHandle: edge.to.port,
    type: "workspace",
    animated: edge.buffering === "unbuffered",
    data: { buffering: edge.buffering, onDelete },
    label: edge.buffering.replaceAll("_", " "),
  };
}

function flowNodeToWorkspaceNode(node: FlowNode): WorkspaceNode {
  const model = node.data.model;
  return {
    ...model,
    position: node.position,
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
      port: (edge.sourceHandle as PortKind | null) ?? "stdout",
    },
    to: {
      nodeId: edge.target,
      port: (edge.targetHandle as PortKind | null) ?? "stdin",
    },
    buffering:
      (edge.data?.buffering as BufferingMode | undefined) ?? "line_or_1024",
  };
}

type ShellNodeActions = {
  onUpdate: (nodeId: string, patch: Partial<WorkspaceNode>) => void;
  onRun: (nodeId: string, mode: ExecutionMode) => void;
  onStop: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onToggleAutorun: (nodeId: string, next: AutoRunConfig) => void;
};

type AutorunHandle = {
  signature: string;
  timerId: number;
};

function WorkspaceCanvas() {
  const [workspaceMeta, setWorkspaceMeta] = useState<Pick<
    Workspace,
    "id" | "name" | "ui"
  > | null>(null);
  const [kernelConnected, setKernelConnected] = useState(false);
  const [runtime, setRuntime] = useState<Record<string, NodeRuntimeState>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const socketRef = useRef<ReturnType<typeof connectKernel> | null>(null);
  const workspaceMetaRef = useRef<Pick<Workspace, "id" | "name" | "ui"> | null>(
    null,
  );
  const nodesRef = useRef<FlowNode[]>([]);
  const edgesRef = useRef<FlowEdge[]>([]);
  const autorunRef = useRef<Map<string, AutorunHandle>>(new Map());

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

  const buildWorkspace = useCallback(
    (
      nodesArg: FlowNode[] = nodesRef.current,
      edgesArg: FlowEdge[] = edgesRef.current,
      metaArg: Pick<
        Workspace,
        "id" | "name" | "ui"
      > | null = workspaceMetaRef.current,
    ): Workspace | null => {
      if (!metaArg) {
        return null;
      }
      return {
        id: metaArg.id,
        name: metaArg.name,
        ui: metaArg.ui,
        nodes: nodesArg.map(flowNodeToWorkspaceNode),
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

  const sendRunRequest = useCallback(
    (nodeId: string, mode: ExecutionMode, silenceIfDisconnected = false) => {
      const workspace = buildWorkspace();
      if (!workspace) {
        return;
      }
      const event: ClientEvent = {
        type: "run_node",
        workspace,
        node_id: nodeId,
        mode,
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
                  height: patch.size?.height ?? node.height,
                  style: {
                    ...node.style,
                    width: patch.size?.width ?? node.data.model.size.width,
                    height: patch.size?.height ?? node.data.model.size.height,
                  },
                }
              : node,
          );
          persistSoon(next, edgesRef.current);
          return next;
        });
      },
      onRun: (nodeId, mode) => {
        sendRunRequest(nodeId, mode);
      },
      onStop: (nodeId) => {
        if (!socketRef.current?.ready) {
          setToast("kernel websocket is not connected yet");
          return;
        }
        socketRef.current.send({
          type: "stop_execution",
          node_id: nodeId,
        });
      },
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
    }),
    [persistSoon, sendRunRequest, setNodes],
  );

  useEffect(() => {
    let disposed = false;
    listWorkspaces()
      .then(async (summaries) => {
        const loaded =
          summaries.length > 0
            ? await getWorkspace(summaries[0].id)
            : await createWorkspace();
        if (disposed) {
          return;
        }
        const ui =
          loaded.ui.viewportX === 0 &&
          loaded.ui.viewportY === 0 &&
          loaded.ui.zoom === 1
            ? { ...loaded.ui, zoom: 0.5 }
            : loaded.ui;
        setWorkspaceMeta({ id: loaded.id, name: loaded.name, ui });
        setRuntime(
          Object.fromEntries(
            loaded.nodes.map((node) => [
              node.id,
              { running: false, portActivity: {}, display: undefined },
            ]),
          ),
        );
        setNodes(loaded.nodes.map((node) => toFlowNode(node, {}, handlers)));
        setEdges(loaded.edges.map((edge) => toFlowEdge(edge, deleteEdge)));
      })
      .catch((error) => setToast(String(error)));

    return () => {
      disposed = true;
    };
  }, [handlers, setEdges, setNodes]);

  useEffect(() => {
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        data: {
          ...node.data,
          runtime: runtime[node.id] ?? { running: false, portActivity: {} },
          onUpdate: handlers.onUpdate,
          onRun: handlers.onRun,
          onStop: handlers.onStop,
          onDelete: handlers.onDelete,
          onToggleAutorun: handlers.onToggleAutorun,
        },
      })),
    );
  }, [handlers, runtime, setNodes]);

  useEffect(() => {
    const connection = connectKernel(
      (event) => {
        setRuntime((current) => {
          switch (event.type) {
            case "exec_started": {
              const isDisplay = nodesRef.current.some(
                (node) =>
                  node.id === event.node_id &&
                  node.data.model.kind === "display",
              );
              return {
                ...current,
                [event.node_id]: {
                  ...(current[event.node_id] ?? {
                    running: false,
                    portActivity: {},
                  }),
                  running: true,
                  lastExecId: event.exec_id,
                  display: isDisplay
                    ? { bytes: new Uint8Array(), completed: false }
                    : current[event.node_id]?.display,
                },
              };
            }
            case "exec_finished":
              return {
                ...current,
                [event.node_id]: {
                  ...(current[event.node_id] ?? {
                    running: false,
                    portActivity: {},
                  }),
                  running: false,
                },
              };
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
            case "display_update": {
              const nextBytes = fromBase64(event.data_base64);
              const previous =
                current[event.node_id]?.display?.bytes ?? new Uint8Array();
              return {
                ...current,
                [event.node_id]: {
                  ...(current[event.node_id] ?? {
                    running: false,
                    portActivity: {},
                  }),
                  display: {
                    bytes: event.completed
                      ? previous
                      : concatBytes(previous, nextBytes),
                    completed: event.completed,
                  },
                },
              };
            }
            case "error":
              setToast(event.message);
              return current;
            default:
              return current;
          }
        });
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
      autorunRef.current.clear();
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
        const shouldPersist = changes.some((change) => {
          if (change.type === "position") {
            return !change.dragging;
          }
          if (change.type === "dimensions") {
            return !change.resizing;
          }
          return change.type !== "select";
        });
        if (shouldPersist) {
          persistSoon(next, edgesRef.current);
        }
        return next;
      });
    },
    [persistSoon, setNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      setEdges((current) => {
        const next = applyEdgeChanges(changes, current);
        const shouldPersist = changes.some(
          (change) => change.type !== "select",
        );
        if (shouldPersist) {
          persistSoon(nodesRef.current, next);
        }
        return next;
      });
    },
    [persistSoon, setEdges],
  );

  const deleteEdge = useCallback(
    (edgeId: string) => {
      setEdges((current) => {
        const next = current.filter((edge) => edge.id !== edgeId);
        persistSoon(nodesRef.current, next);
        return next;
      });
    },
    [persistSoon, setEdges],
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
                "line_or_1024"
            ];
          return {
            ...edge,
            data: { buffering, onDelete: deleteEdge },
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

  const onConnect = useCallback(
    (connection: Connection) => {
      const targetNode = nodesRef.current.find(
        (node) => node.id === connection.target,
      );
      const hasExistingInput = edgesRef.current.some(
        (edge) => edge.target === connection.target,
      );
      if (
        targetNode &&
        !targetNode.data.model.kind.startsWith("merge_") &&
        hasExistingInput
      ) {
        setToast("non-merge nodes only accept one stdin wire");
        return;
      }
      setEdges((current) => {
        const next = addEdge(
          {
            id: encodeId("edge"),
            ...connection,
            type: "workspace",
            data: { buffering: "line_or_1024", onDelete: deleteEdge },
            label: "line or 1024",
          },
          current,
        ) as FlowEdge[];
        persistSoon(nodesRef.current, next);
        return next;
      });
    },
    [persistSoon, setEdges],
  );

  const addNode = useCallback(
    (kind: NodeKind) => {
      setNodes((current) => {
        const nextNode = toFlowNode(
          makeNode(kind, current.length + 1),
          runtime,
          handlers,
        );
        const next = [...current, nextNode];
        persistSoon(next, edgesRef.current);
        return next;
      });
    },
    [handlers, persistSoon, runtime, setNodes],
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
        <span
          className={`kernel-pill ${kernelConnected ? "online" : "offline"}`}
        >
          {kernelConnected ? "kernel online" : "kernel offline"}
        </span>
        <div className="node-palette-groups">
          {paletteGroups().map((group) => (
            <section key={group.label} className="node-palette-group">
              <div className="node-palette-label">{group.label}</div>
              <div className="node-palette">
                {group.items.map((choice) => (
                  <button
                    key={choice.kind}
                    type="button"
                    onClick={() => addNode(choice.kind)}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </aside>

      <main
        className="canvas-shell"
        onContextMenu={(event) => {
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
          onEdgeClick={(_, edge) => cycleEdgeBuffering(edge.id)}
          onConnect={onConnect}
          selectionOnDrag
          panOnScroll
          panOnDrag={[1, 2]}
          colorMode="dark"
          connectionLineType={ConnectionLineType.SmoothStep}
          onMoveEnd={(_, viewport) =>
            setWorkspaceMeta((current) =>
              current
                ? {
                    ...current,
                    ui: {
                      viewportX: viewport.x,
                      viewportY: viewport.y,
                      zoom: viewport.zoom,
                    },
                  }
                : current,
            )
          }
        >
          <MiniMap pannable zoomable className="minimap" />
          <Controls />
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
