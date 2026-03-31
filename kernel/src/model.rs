use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub sort_order: u64,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(default)]
    pub openai_api_key: Option<String>,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub tuckspace: Vec<TuckedSubgraph>,
    #[serde(default)]
    pub ui: WorkspaceUi,
}

impl Workspace {
    pub fn empty() -> Self {
        Self {
            id: "default".to_string(),
            name: "Workspace".to_string(),
            created_at: 0,
            sort_order: 0,
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes: Vec::new(),
            edges: Vec::new(),
            tuckspace: Vec::new(),
            ui: WorkspaceUi::default(),
        }
    }

    pub fn example() -> Self {
        let workspace_id = crate::id::encode_workspace_id();
        let text_id = crate::id::encode_node_id(&NodeKind::Text);
        let passthru_id = crate::id::encode_node_id(&NodeKind::Passthru);
        let edge_id = crate::id::encode_edge_id();
        Self {
            id: workspace_id,
            name: "Shell WS".to_string(),
            created_at: 0,
            sort_order: 0,
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes: vec![
                Node {
                    id: text_id.clone(),
                    kind: NodeKind::Text,
                    title: String::new(),
                    comment: String::new(),
                    position: Position { x: 80.0, y: 120.0 },
                    size: Size {
                        width: 320.0,
                        height: 220.0,
                    },
                    shell: Some("bash".to_string()),
                    script: None,
                    description: None,
                    include_sample_inputs: None,
                    path: None,
                    args: None,
                    text: Some(String::new()),
                    formula: None,
                    materialized: NodeMaterialized::default(),
                    auto_run: None,
                    ui_state: NodeUiState::default(),
                },
                Node {
                    id: passthru_id.clone(),
                    kind: NodeKind::Passthru,
                    title: String::new(),
                    comment: String::new(),
                    position: Position { x: 520.0, y: 120.0 },
                    size: Size {
                        width: 360.0,
                        height: 260.0,
                    },
                    shell: Some("bash".to_string()),
                    script: None,
                    description: None,
                    include_sample_inputs: None,
                    path: None,
                    args: None,
                    text: None,
                    formula: None,
                    materialized: NodeMaterialized::default(),
                    auto_run: None,
                    ui_state: NodeUiState::default(),
                },
            ],
            edges: vec![Edge {
                id: edge_id,
                from: PortRef {
                    node_id: text_id,
                    port: PortKind::Stdout,
                    slot: None,
                },
                to: PortRef {
                    node_id: passthru_id,
                    port: PortKind::Stdin,
                    slot: None,
                },
                buffering: BufferingMode::Unbuffered,
            }],
            tuckspace: Vec::new(),
            ui: WorkspaceUi::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TuckedSubgraph {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub user_named: bool,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub topology_preview: TopologyPreview,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TopologyPreview {
    #[serde(default)]
    pub nodes: Vec<TopologyPreviewNode>,
    #[serde(default)]
    pub edges: Vec<TopologyPreviewEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyPreviewNode {
    pub id: String,
    pub kind: NodeKind,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyPreviewEdge {
    pub id: String,
    pub from_node_id: String,
    pub to_node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub kind: NodeKind,
    pub title: String,
    #[serde(default)]
    pub comment: String,
    pub position: Position,
    pub size: Size,
    #[serde(default = "default_shell_option")]
    pub shell: Option<String>,
    #[serde(default)]
    pub script: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub include_sample_inputs: Option<bool>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<ExecArg>>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub formula: Option<String>,
    #[serde(default)]
    pub materialized: NodeMaterialized,
    #[serde(default)]
    pub auto_run: Option<AutoRunConfig>,
    #[serde(default)]
    pub ui_state: NodeUiState,
}

impl Node {
    pub fn shell_value(&self) -> String {
        self.shell.clone().unwrap_or_else(default_shell)
    }
}

pub type MaterializedOutputStore = HashMap<String, MatOutEntry>;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedReferrer {
    pub node_id: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProducedBy {
    pub exec_id: String,
    pub node_id: String,
    pub port: PortKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatOutEntry {
    pub data_base64: String,
    pub produced_by: ProducedBy,
    // Replayed outputs can originate from any active materialized binding, even when no
    // node execution happens in this request, so the materialized value itself must carry
    // the exit status needed for downstream semantics.
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub referrers: Vec<MaterializedReferrer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeMaterialized {
    #[serde(default)]
    pub inputs: HashMap<String, String>,
    #[serde(default)]
    pub outputs: HashMap<String, String>,
    #[serde(default)]
    pub last_exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Script,
    AiScript,
    Exec,
    File,
    Display,
    Passthru,
    Html,
    Text,
    Formula,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum ExecArg {
    Literal { value: String },
    Argv { slot: usize },
}

impl ExecArg {
    pub fn resolve(&self, argv: &[String]) -> Result<String, String> {
        match self {
            Self::Literal { value } => Ok(value.clone()),
            Self::Argv { slot } => argv
                .get(slot.saturating_sub(1))
                .cloned()
                .ok_or_else(|| format!("missing argv-{slot} for exec argument")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    pub from: PortRef,
    pub to: PortRef,
    #[serde(default)]
    pub buffering: BufferingMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct PortRef {
    #[serde(alias = "node_id")]
    pub node_id: String,
    pub port: PortKind,
    #[serde(default)]
    pub slot: Option<usize>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PortKind {
    Stdin,
    Argv,
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BufferingMode {
    Unbuffered,
    #[serde(rename = "line_or_1024")]
    LineOr1024,
    OnComplete,
}

impl Default for BufferingMode {
    fn default() -> Self {
        Self::Unbuffered
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionAction {
    PullInputs,
    PullRun,
    Rerun,
    RerunPush,
    Repush,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRunConfig {
    pub enabled: bool,
    pub mode: ExecutionAction,
    pub interval_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeUiState {
    #[serde(default)]
    pub open_preview_tabs: Vec<String>,
    #[serde(default)]
    pub show_auto_controls: bool,
    #[serde(default)]
    pub editor_heights: HashMap<String, f64>,
    #[serde(default)]
    pub pane_sizes: HashMap<String, PaneSizeState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PaneSizeState {
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUi {
    #[serde(default)]
    pub viewport_x: f64,
    #[serde(default)]
    pub viewport_y: f64,
    #[serde(default = "default_zoom")]
    pub zoom: f64,
    #[serde(default)]
    pub sidebars: WorkspaceSidebars,
    #[serde(default)]
    pub preview_controls_location: PreviewControlsLocation,
}

impl Default for WorkspaceUi {
    fn default() -> Self {
        Self {
            viewport_x: 0.0,
            viewport_y: 0.0,
            zoom: default_zoom(),
            sidebars: WorkspaceSidebars::default(),
            preview_controls_location: PreviewControlsLocation::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PreviewControlsLocation {
    Node,
    #[default]
    Floating,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSidebars {
    #[serde(default = "default_workspaces_sidebar")]
    pub workspaces: WorkspaceSidebarState,
    #[serde(default = "default_settings_sidebar")]
    pub settings: WorkspaceSidebarState,
    #[serde(default = "default_nodes_sidebar")]
    pub nodes: WorkspaceSidebarState,
    #[serde(default = "default_tuckspace_sidebar")]
    pub tuckspace: WorkspaceSidebarState,
}

impl Default for WorkspaceSidebars {
    fn default() -> Self {
        Self {
            workspaces: default_workspaces_sidebar(),
            settings: default_settings_sidebar(),
            nodes: default_nodes_sidebar(),
            tuckspace: default_tuckspace_sidebar(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSidebarState {
    pub width: f64,
    #[serde(default)]
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientEvent {
    RunNode {
        request: ExecutionRequest,
    },
    StopExecution {
        exec_id: Option<String>,
        node_id: Option<String>,
    },
}

// Execution requests operate on a scoped execution graph, not a persisted workspace.
// Included wires imply endpoint participation even when one endpoint node is omitted
// from `graph.nodes`.
pub type ExecutionGraph = Workspace;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRequest {
    pub graph: ExecutionGraph,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub matouts: HashMap<String, String>,
    #[serde(default)]
    pub active_matouts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionOutcome {
    Completed,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    ExecStarted {
        exec_id: String,
        #[serde(default)]
        client_request_id: Option<String>,
        node_id: String,
        timestamp: u64,
    },
    MaterializedState {
        node_id: String,
        materialized: NodeMaterialized,
        upserted_entries: MaterializedOutputStore,
        deleted_ids: Vec<String>,
        timestamp: u64,
    },
    ExecFinished {
        exec_id: String,
        node_id: String,
        exit_code: Option<i32>,
        materialized: bool,
        materialized_state: NodeMaterialized,
        upserted_entries: MaterializedOutputStore,
        deleted_ids: Vec<String>,
        timestamp: u64,
    },
    PortActivity {
        node_id: String,
        port: PortKind,
        bytes: usize,
        timestamp: u64,
    },
    NodeOutput {
        node_id: String,
        port: PortKind,
        data_base64: String,
        #[serde(default)]
        reset: bool,
        timestamp: u64,
    },
    StreamChunk {
        edge_id: String,
        from_node_id: String,
        to_node_id: String,
        port: PortKind,
        data_base64: String,
        #[serde(default)]
        reset: bool,
        #[serde(default)]
        completed: bool,
        #[serde(default = "default_true")]
        success: bool,
        timestamp: u64,
    },
    DisplayUpdate {
        node_id: String,
        data_base64: String,
        timestamp: u64,
        completed: bool,
    },
    ExecutionStopped {
        exec_id: String,
        outcome: ExecutionOutcome,
        timestamp: u64,
    },
    Error {
        message: String,
        #[serde(default)]
        client_request_id: Option<String>,
        timestamp: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub sort_order: u64,
}

pub fn default_shell() -> String {
    "bash".to_string()
}

pub fn default_cwd() -> String {
    std::env::var("HOME").unwrap_or_else(|_| ".".to_string())
}

fn default_shell_option() -> Option<String> {
    Some(default_shell())
}

fn default_zoom() -> f64 {
    0.5
}

fn default_true() -> bool {
    true
}

fn default_workspaces_sidebar() -> WorkspaceSidebarState {
    WorkspaceSidebarState {
        width: 220.0,
        collapsed: false,
    }
}

fn default_settings_sidebar() -> WorkspaceSidebarState {
    WorkspaceSidebarState {
        width: 220.0,
        collapsed: false,
    }
}

fn default_nodes_sidebar() -> WorkspaceSidebarState {
    WorkspaceSidebarState {
        width: 190.0,
        collapsed: false,
    }
}

fn default_tuckspace_sidebar() -> WorkspaceSidebarState {
    WorkspaceSidebarState {
        width: 280.0,
        collapsed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::{default_cwd, ClientEvent, Workspace};

    #[test]
    fn buffering_mode_serializes_with_expected_underscore() {
        let value =
            serde_json::to_string(&super::BufferingMode::LineOr1024).expect("serialize mode");
        assert_eq!(value, "\"line_or_1024\"");

        let parsed: super::BufferingMode =
            serde_json::from_str("\"line_or_1024\"").expect("deserialize mode");
        assert_eq!(parsed, super::BufferingMode::LineOr1024);
    }

    #[test]
    fn display_kind_deserializes_as_display() {
        let kind: super::NodeKind =
            serde_json::from_str("\"display\"").expect("deserialize display kind");
        assert_eq!(kind, super::NodeKind::Display);
    }

    #[test]
    fn workspace_ui_defaults_sidebars() {
        let workspace: Workspace = serde_json::from_value(serde_json::json!({
            "id": "w",
            "name": "Workspace",
            "ui": { "viewportX": 0.0, "viewportY": 0.0, "zoom": 1.0 },
            "nodes": [],
            "edges": []
        }))
        .expect("deserialize workspace ui defaults");

        assert_eq!(workspace.ui.sidebars.workspaces.width, 220.0);
        assert!(!workspace.ui.sidebars.tuckspace.collapsed);
        assert_eq!(
            workspace.ui.preview_controls_location,
            super::PreviewControlsLocation::Floating
        );
    }

    #[test]
    fn workspace_defaults_cwd_to_home() {
        let workspace: Workspace = serde_json::from_value(serde_json::json!({
            "id": "default",
            "name": "Shell WS",
            "nodes": [],
            "edges": [],
            "ui": {},
        }))
        .expect("deserialize workspace with default cwd");

        assert_eq!(workspace.cwd, default_cwd());
        assert_eq!(workspace.openai_api_key.unwrap_or_default(), "");
    }

    #[test]
    fn node_ui_state_preserves_pane_sizes() {
        let workspace: Workspace = serde_json::from_value(serde_json::json!({
            "id": "w",
            "name": "w",
            "cwd": "/tmp",
            "nodes": [
                {
                    "id": "text-1",
                    "kind": "text",
                    "title": "",
                    "comment": "",
                    "position": {"x": 0, "y": 0},
                    "size": {"width": 1, "height": 1},
                    "text": "",
                    "uiState": {
                        "paneSizes": {
                            "text": {"height": 381.0}
                        }
                    }
                }
            ],
            "edges": [],
            "ui": {}
        }))
        .expect("deserialize workspace with pane sizes");

        assert_eq!(
            workspace.nodes[0]
                .ui_state
                .pane_sizes
                .get("text")
                .and_then(|value| value.height),
            Some(381.0)
        );
    }

    #[test]
    fn workspace_preserves_tuckspace_roundtrip() {
        let workspace: Workspace = serde_json::from_value(serde_json::json!({
            "id": "w",
            "name": "w",
            "cwd": "/tmp",
            "nodes": [],
            "edges": [],
            "tuckspace": [
                {
                    "id": "t1",
                    "name": "Saved",
                    "userNamed": true,
                    "nodes": [
                        {
                            "id": "text-1",
                            "kind": "text",
                            "title": "",
                            "comment": "",
                            "position": {"x": 0, "y": 0},
                            "size": {"width": 1, "height": 1},
                            "text": ""
                        }
                    ],
                    "edges": [],
                    "topologyPreview": {
                        "nodes": [{"id": "text-1", "kind": "text", "x": 10.0, "y": 10.0}],
                        "edges": []
                    }
                }
            ],
            "ui": {}
        }))
        .expect("deserialize workspace with tuckspace");

        assert_eq!(workspace.tuckspace.len(), 1);
        assert_eq!(workspace.tuckspace[0].name, "Saved");
        assert!(workspace.tuckspace[0].user_named);
    }

    #[test]
    fn run_node_accepts_embedded_workspace_snapshot() {
        let workspace = Workspace::example();
        let payload = serde_json::json!({
            "type": "run_node",
            "request": {
                "graph": workspace,
                "matouts": {}
            }
        });

        let event: ClientEvent = serde_json::from_value(payload).expect("deserialize run event");
        match event {
            ClientEvent::RunNode { request } => {
                assert!(request.matouts.is_empty());
                assert!(request.active_matouts.is_empty());
            }
            _ => panic!("unexpected client event"),
        }
    }
}
