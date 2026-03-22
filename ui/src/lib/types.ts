import type { WorkspaceSidebars } from "./workspaceUi";
import type { Edge, Node } from "@xyflow/react";

export type NodeKind =
  | "script"
  | "ai_script"
  | "exec"
  | "file"
  | "passthru"
  | "display"
  | "html"
  | "text"
  | "formula";

export type PortKind = "stdin" | "argv" | "stdout" | "stderr";
export type BufferingMode = "unbuffered" | "line_or_1024" | "on_complete";
export type ExecutionAction =
  | "pull_inputs"
  | "pull_run"
  | "rerun"
  | "rerun_push"
  | "repush";

export type MaterializedOutputPort = "stdout" | "stderr";
export type MatOutId = string;

export interface MaterializedReferrer {
  nodeId: string;
  key: string;
}

export interface ProducedBy {
  execId: string;
  nodeId: string;
  port: MaterializedOutputPort;
}

export interface MatOutEntry {
  dataBase64: string;
  producedBy: ProducedBy;
  referrers: MaterializedReferrer[];
}

export type MaterializedOutputStore = Record<MatOutId, MatOutEntry>;

export interface NodeMaterialized {
  inputs?: Record<string, MatOutId> | null;
  outputs?: Partial<Record<MaterializedOutputPort, MatOutId>> | null;
  lastExitCode?: number | null;
}

export type ExecArg =
  | { source: "literal"; value: string }
  | { source: "argv"; slot: number };

export interface PaneSizeState {
  width?: number;
  height?: number;
}

export interface NodeUiState {
  openPreviewTabs?: string[];
  showAutoControls?: boolean;
  paneSizes?: Record<string, PaneSizeState>;
}

export interface TopologyPreviewNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
}

export interface TopologyPreviewEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface TuckedSubgraph {
  id: string;
  name: string;
  userNamed?: boolean;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
  topologyPreview: {
    nodes: TopologyPreviewNode[];
    edges: TopologyPreviewEdge[];
  };
}

export type PreviewControlsLocation = "node" | "floating";

export interface Workspace {
  id: string;
  name: string;
  createdAt?: number;
  sortOrder?: number;
  cwd: string;
  openaiApiKey: string;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
  tuckspace: TuckedSubgraph[];
  ui: {
    viewportX: number;
    viewportY: number;
    zoom: number;
    sidebars: WorkspaceSidebars;
    previewControlsLocation: PreviewControlsLocation;
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
  description?: string | null;
  includeSampleInputs?: boolean | null;
  path?: string | null;
  args?: ExecArg[] | null;
  text?: string | null;
  formula?: string | null;
  materialized?: NodeMaterialized | null;
  autoRun?: AutoRunConfig | null;
  uiState?: NodeUiState | null;
}

export interface AutoRunConfig {
  enabled: boolean;
  mode: ExecutionAction;
  intervalMs: number;
}

export interface WorkspaceEdge {
  id: string;
  from: { nodeId: string; port: PortKind; slot?: number | null };
  to: { nodeId: string; port: PortKind; slot?: number | null };
  buffering: BufferingMode;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt?: number;
  sortOrder?: number;
}

export type ClientEvent =
  | {
      type: "run_node";
      workspace: Workspace;
      materialized_output_store: MaterializedOutputStore;
      node_id: string;
      action: ExecutionAction;
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
      type: "materialized_state";
      node_id: string;
      materialized: NodeMaterialized;
      upserted_entries: MaterializedOutputStore;
      deleted_ids: string[];
      timestamp: number;
    }
  | {
      type: "exec_finished";
      exec_id: string;
      node_id: string;
      exit_code: number | null;
      materialized: boolean;
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
      type: "node_output";
      node_id: string;
      port: PortKind;
      data_base64: string;
      reset?: boolean;
      timestamp: number;
    }
  | {
      type: "stream_chunk";
      edge_id: string;
      from_node_id: string;
      to_node_id: string;
      port: PortKind;
      data_base64: string;
      reset?: boolean;
      completed?: boolean;
      success?: boolean;
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
  previews?: Record<string, DisplayState>;
  livePreviews?: Record<string, DisplayState>;
}

export interface AiGenerationState {
  loading: boolean;
  error?: string | null;
}

export interface GenerateScriptRequest {
  workspace: Workspace;
  nodeId: string;
  stdinSample?: string;
  argvSamples: { slot: number; value: string }[];
}

export interface GenerateScriptResponse {
  script: string;
}

export interface ShellNodeData extends Record<string, unknown> {
  model: WorkspaceNode;
  runtime: NodeRuntimeState;
  argvSlots?: number[];
  previewTabs?: string[];
  previewControlsLocation?: PreviewControlsLocation;
  generation?: AiGenerationState;
  selectionPreview?: boolean;
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
}

export interface FlowEdgeData extends Record<string, unknown> {
  buffering: BufferingMode;
  onDelete?: (edgeId: string) => void;
  onCycle?: (edgeId: string) => void;
}

export type FlowNode = Node<ShellNodeData, "shell">;
export type FlowEdge = Edge<FlowEdgeData, string>;
