import type { Edge, Node } from "@xyflow/react";

export type NodeKind =
  | "process"
  | "display"
  | "text"
  | "merge_concat"
  | "merge_line"
  | "merge_byte"
  | "merge_shell";

export type PortKind = "stdin" | "stdout" | "stderr";
export type BufferingMode = "unbuffered" | "line_or_1024" | "on_complete";
export type ExecutionMode = "push" | "pull";

export interface Workspace {
  id: string;
  name: string;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
  ui: {
    viewportX: number;
    viewportY: number;
    zoom: number;
  };
}

export interface WorkspaceNode {
  id: string;
  kind: NodeKind;
  title: string;
  comment: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  shell?: string | null;
  script?: string | null;
  text?: string | null;
  autoRun?: AutoRunConfig | null;
}

export interface AutoRunConfig {
  enabled: boolean;
  mode: ExecutionMode;
  intervalMs: number;
}

export interface WorkspaceEdge {
  id: string;
  from: { nodeId: string; port: PortKind };
  to: { nodeId: string; port: PortKind };
  buffering: BufferingMode;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
}

export type ClientEvent =
  | {
      type: "run_node";
      workspace: Workspace;
      node_id: string;
      mode: ExecutionMode;
    }
  | {
      type: "stop_execution";
      exec_id?: string;
      node_id?: string;
    };

export type ServerEvent =
  | {
      type: "exec_started";
      exec_id: string;
      node_id: string;
      timestamp: number;
    }
  | {
      type: "exec_finished";
      exec_id: string;
      node_id: string;
      exit_code: number | null;
      timestamp: number;
    }
  | {
      type: "port_activity";
      node_id: string;
      port: PortKind;
      bytes: number;
      timestamp: number;
    }
  | {
      type: "stream_chunk";
      edge_id: string;
      from_node_id: string;
      to_node_id: string;
      port: PortKind;
      data_base64: string;
      timestamp: number;
    }
  | {
      type: "display_update";
      node_id: string;
      data_base64: string;
      timestamp: number;
      completed: boolean;
    }
  | {
      type: "execution_stopped";
      exec_id: string;
      timestamp: number;
    }
  | {
      type: "error";
      message: string;
      timestamp: number;
    };

export interface DisplayState {
  bytes: Uint8Array;
  completed: boolean;
}

export interface NodeRuntimeState {
  running: boolean;
  lastExecId?: string;
  portActivity: Partial<Record<PortKind, number>>;
  display?: DisplayState;
}

export interface ShellNodeData extends Record<string, unknown> {
  model: WorkspaceNode;
  runtime: NodeRuntimeState;
  onUpdate: (nodeId: string, patch: Partial<WorkspaceNode>) => void;
  onRun: (nodeId: string, mode: ExecutionMode) => void;
  onStop: (nodeId: string) => void;
  onToggleAutorun: (nodeId: string, next: AutoRunConfig) => void;
}

export interface FlowEdgeData extends Record<string, unknown> {
  buffering: BufferingMode;
  onDelete?: (edgeId: string) => void;
}

export type FlowNode = Node<ShellNodeData, "shell">;
export type FlowEdge = Edge<FlowEdgeData, "smoothstep">;
