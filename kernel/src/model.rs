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
        Self {
            id: "default".to_string(),
            name: "Shell WS".to_string(),
            created_at: 0,
            sort_order: 0,
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes: vec![
                Node {
                    id: "text-1".to_string(),
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
                    materialized_values: HashMap::new(),
                    auto_run: None,
                    ui_state: NodeUiState::default(),
                },
                Node {
                    id: "passthru-1".to_string(),
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
                    materialized_values: HashMap::new(),
                    auto_run: None,
                    ui_state: NodeUiState::default(),
                },
            ],
            edges: vec![Edge {
                id: "edge-1".to_string(),
                from: PortRef {
                    node_id: "text-1".to_string(),
                    port: PortKind::Stdout,
                    slot: None,
                },
                to: PortRef {
                    node_id: "passthru-1".to_string(),
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
    pub materialized_values: HashMap<String, MaterializedValue>,
    #[serde(default, alias = "auto_run")]
    pub auto_run: Option<AutoRunConfig>,
    #[serde(default)]
    pub ui_state: NodeUiState,
}

impl Node {
    pub fn shell_value(&self) -> String {
        self.shell.clone().unwrap_or_else(default_shell)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    #[serde(alias = "process")]
    Script,
    AiScript,
    Exec,
    #[serde(alias = "cat")]
    File,
    Display,
    Passthru,
    Html,
    Text,
    Formula,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ExecArg {
    LegacyLiteral(String),
    Configured(ExecArgConfig),
}

impl ExecArg {
    pub fn resolve(&self, argv: &[String]) -> Result<String, String> {
        match self {
            Self::LegacyLiteral(value) => Ok(value.clone()),
            Self::Configured(ExecArgConfig::Literal { value }) => Ok(value.clone()),
            Self::Configured(ExecArgConfig::Argv { slot }) => argv
                .get(slot.saturating_sub(1))
                .cloned()
                .ok_or_else(|| format!("missing argv-{slot} for exec argument")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum ExecArgConfig {
    Literal { value: String },
    Argv { slot: usize },
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
    #[serde(rename = "line_or_1024", alias = "line_or1024")]
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
    #[serde(alias = "pull")]
    PullRun,
    Rerun,
    #[serde(alias = "push")]
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
pub struct MaterializedValue {
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeUiState {
    #[serde(default)]
    pub active_preview_tab: Option<String>,
    #[serde(default)]
    pub open_preview_tabs: Vec<String>,
    #[serde(default)]
    pub show_auto_controls: bool,
    #[serde(default)]
    pub editor_heights: HashMap<String, f64>,
    #[serde(default)]
    pub previews: HashMap<String, LegacyPersistedDisplayState>,
    #[serde(default)]
    pub pane_sizes: HashMap<String, PaneSizeState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PaneSizeState {
    pub height: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPersistedDisplayState {
    pub data_base64: String,
    #[serde(default)]
    pub completed: bool,
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
}

impl Default for WorkspaceUi {
    fn default() -> Self {
        Self {
            viewport_x: 0.0,
            viewport_y: 0.0,
            zoom: default_zoom(),
            sidebars: WorkspaceSidebars::default(),
        }
    }
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
        workspace: Workspace,
        node_id: String,
        action: ExecutionAction,
    },
    StopExecution {
        exec_id: Option<String>,
        node_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    ExecStarted {
        exec_id: String,
        node_id: String,
        timestamp: u64,
    },
    ExecFinished {
        exec_id: String,
        node_id: String,
        exit_code: Option<i32>,
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
        timestamp: u64,
    },
    Error {
        message: String,
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

pub fn sanitize_workspace_json_value(value: &mut serde_json::Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    sanitize_graph_container(obj);
    if let Some(tuckspace) = obj.get_mut("tuckspace") {
        sanitize_tuckspace_json_value(tuckspace);
    }
}

pub fn sanitize_tuckspace_json_value(value: &mut serde_json::Value) {
    if let Some(tuckspace) = value.as_array_mut() {
        for item in tuckspace.iter_mut() {
            if let Some(item_obj) = item.as_object_mut() {
                sanitize_graph_container(item_obj);
            }
        }
    }
}

fn sanitize_graph_container(obj: &mut serde_json::Map<String, serde_json::Value>) {
    const REMOVED: &[&str] = &["tee", "merge_concat", "merge_line", "merge_byte", "merge_shell"];
    let mut removed_ids = std::collections::HashSet::new();
    if let Some(nodes) = obj.get_mut("nodes").and_then(serde_json::Value::as_array_mut) {
        for node in nodes.iter_mut() {
            if let Some(node_obj) = node.as_object_mut() {
                merge_legacy_materialized_values(node_obj);
            }
        }
        nodes.retain(|node| {
            let Some(kind) = node.get("kind").and_then(serde_json::Value::as_str) else {
                return true;
            };
            if REMOVED.contains(&kind) {
                if let Some(id) = node.get("id").and_then(serde_json::Value::as_str) {
                    removed_ids.insert(id.to_string());
                }
                return false;
            }
            true
        });
    }
    if let Some(edges) = obj.get_mut("edges").and_then(serde_json::Value::as_array_mut) {
        edges.retain(|edge| {
            let from = edge
                .get("from")
                .and_then(serde_json::Value::as_object)
                .and_then(|port| port.get("nodeId").or_else(|| port.get("node_id")))
                .and_then(serde_json::Value::as_str);
            let to = edge
                .get("to")
                .and_then(serde_json::Value::as_object)
                .and_then(|port| port.get("nodeId").or_else(|| port.get("node_id")))
                .and_then(serde_json::Value::as_str);
            let is_legacy_unslotted_argv = edge
                .get("to")
                .and_then(serde_json::Value::as_object)
                .map(|port| {
                    port.get("port").and_then(serde_json::Value::as_str) == Some("argv")
                        && !port.contains_key("slot")
                })
                .unwrap_or(false);
            match (from, to) {
                (Some(from), Some(to)) => {
                    !is_legacy_unslotted_argv
                        && !removed_ids.contains(from)
                        && !removed_ids.contains(to)
                }
                _ => true,
            }
        });
    }
}

fn merge_legacy_materialized_values(node: &mut serde_json::Map<String, serde_json::Value>) {
    let mut merged = node
        .remove("materializedValues")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    for legacy_key in ["materializedInputs", "materialized_inputs"] {
        if let Some(values) = node.remove(legacy_key).and_then(|value| value.as_object().cloned()) {
            merged.extend(values);
        }
    }
    for legacy_key in ["materializedOutputs", "materialized_outputs"] {
        if let Some(values) = node.remove(legacy_key).and_then(|value| value.as_object().cloned()) {
            merged.extend(values);
        }
    }

    if !merged.is_empty() {
        node.insert("materializedValues".to_string(), serde_json::Value::Object(merged));
    }
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
    use super::{default_cwd, ClientEvent, ExecutionAction, Workspace};

    #[test]
    fn buffering_mode_serializes_with_expected_underscore() {
        let value = serde_json::to_string(&super::BufferingMode::LineOr1024).expect("serialize mode");
        assert_eq!(value, "\"line_or_1024\"");

        let parsed: super::BufferingMode =
            serde_json::from_str("\"line_or1024\"").expect("deserialize legacy mode");
        assert_eq!(parsed, super::BufferingMode::LineOr1024);
    }

    #[test]
    fn legacy_process_kind_deserializes_as_script() {
        let kind: super::NodeKind = serde_json::from_str("\"process\"").expect("deserialize legacy process kind");
        assert_eq!(kind, super::NodeKind::Script);
    }

    #[test]
    fn legacy_cat_kind_deserializes_as_file() {
        let kind: super::NodeKind = serde_json::from_str("\"cat\"").expect("deserialize legacy cat kind");
        assert_eq!(kind, super::NodeKind::File);
    }

    #[test]
    fn display_kind_deserializes_as_display() {
        let kind: super::NodeKind = serde_json::from_str("\"display\"").expect("deserialize display kind");
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
    fn sanitize_workspace_json_merges_legacy_materialized_maps() {
        let mut value = serde_json::json!({
            "id": "w",
            "name": "w",
            "cwd": "/tmp",
            "nodes": [
                {
                    "id": "script-1",
                    "kind": "script",
                    "title": "",
                    "comment": "",
                    "position": {"x": 0, "y": 0},
                    "size": {"width": 1, "height": 1},
                    "materializedInputs": {"stdin": {"dataBase64": "aGVsbG8="}},
                    "materialized_outputs": {"stdout": {"dataBase64": "d29ybGQ="}}
                }
            ],
            "edges": [],
            "ui": {}
        });
        super::sanitize_workspace_json_value(&mut value);
        let workspace: Workspace = serde_json::from_value(value).expect("deserialize sanitized workspace");
        assert_eq!(
            workspace.nodes[0].materialized_values.get("stdin").map(|value| value.data_base64.as_str()),
            Some("aGVsbG8=")
        );
        assert_eq!(
            workspace.nodes[0].materialized_values.get("stdout").map(|value| value.data_base64.as_str()),
            Some("d29ybGQ=")
        );
    }

    #[test]
    fn sanitize_workspace_json_drops_removed_node_kinds() {
        let mut value = serde_json::json!({
            "id": "w",
            "name": "w",
            "cwd": "/tmp",
            "nodes": [
                { "id": "tee-1", "kind": "tee", "title": "", "comment": "", "position": {"x":0,"y":0}, "size": {"width":1,"height":1} },
                { "id": "text-1", "kind": "text", "title": "", "comment": "", "position": {"x":0,"y":0}, "size": {"width":1,"height":1}, "text": "" }
            ],
            "edges": [
                { "id": "e1", "from": {"nodeId": "text-1", "port": "stdout"}, "to": {"nodeId": "tee-1", "port": "stdin"}, "buffering": "line_or_1024" }
            ],
            "ui": {}
        });
        super::sanitize_workspace_json_value(&mut value);
        let workspace: Workspace = serde_json::from_value(value).expect("deserialize sanitized workspace");
        assert_eq!(workspace.nodes.len(), 1);
        assert_eq!(workspace.nodes[0].id, "text-1");
        assert!(workspace.edges.is_empty());
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

        let serialized = serde_json::to_value(&workspace).expect("serialize workspace with pane sizes");
        assert_eq!(
            serialized["nodes"][0]["uiState"]["paneSizes"]["text"]["height"],
            serde_json::json!(381.0)
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
        let serialized = serde_json::to_value(&workspace).expect("serialize workspace with tuckspace");
        assert_eq!(serialized["tuckspace"][0]["name"], serde_json::json!("Saved"));
    }

    #[test]
    fn sanitize_tuckspace_json_sanitizes_tucked_graphs() {
        let mut value = serde_json::json!([
            {
                "id": "saved-1",
                "name": "Saved",
                "nodes": [
                    {
                        "id": "cat-1",
                        "kind": "cat",
                        "title": "",
                        "comment": "",
                        "position": { "x": 0.0, "y": 0.0 },
                        "size": { "width": 100.0, "height": 100.0 }
                    },
                    {
                        "id": "tee-1",
                        "kind": "tee",
                        "title": "",
                        "comment": "",
                        "position": { "x": 0.0, "y": 0.0 },
                        "size": { "width": 100.0, "height": 100.0 }
                    }
                ],
                "edges": [
                    {
                        "id": "edge-1",
                        "from": { "nodeId": "cat-1", "port": "stdout" },
                        "to": { "nodeId": "tee-1", "port": "stdin" }
                    }
                ]
            }
        ]);

        super::sanitize_tuckspace_json_value(&mut value);
        let tuckspace: Vec<super::TuckedSubgraph> =
            serde_json::from_value(value).expect("deserialize sanitized tuckspace");
        assert_eq!(tuckspace[0].nodes.len(), 1);
        assert_eq!(tuckspace[0].nodes[0].kind, super::NodeKind::File);
        assert!(tuckspace[0].edges.is_empty());
    }

    #[test]
    fn sanitize_workspace_json_sanitizes_tuckspace_graphs() {
        let mut value = serde_json::json!({
            "id": "w",
            "name": "w",
            "cwd": "/tmp",
            "nodes": [],
            "edges": [],
            "tuckspace": [
                {
                    "id": "t1",
                    "name": "Saved",
                    "nodes": [
                        { "id": "tee-1", "kind": "tee", "title": "", "comment": "", "position": {"x":0,"y":0}, "size": {"width":1,"height":1} },
                        { "id": "cat-1", "kind": "cat", "title": "", "comment": "", "position": {"x":0,"y":0}, "size": {"width":1,"height":1}, "text": "" }
                    ],
                    "edges": [
                        { "id": "e1", "from": {"nodeId": "cat-1", "port": "stdout"}, "to": {"nodeId": "tee-1", "port": "stdin"}, "buffering": "line_or_1024" }
                    ],
                    "topologyPreview": {"nodes": [], "edges": []}
                }
            ],
            "ui": {}
        });
        super::sanitize_workspace_json_value(&mut value);
        let workspace: Workspace = serde_json::from_value(value).expect("deserialize sanitized tuckspace workspace");
        assert_eq!(workspace.tuckspace[0].nodes.len(), 1);
        assert_eq!(workspace.tuckspace[0].nodes[0].kind, super::NodeKind::File);
        assert!(workspace.tuckspace[0].edges.is_empty());
    }

    #[test]
    fn run_node_accepts_embedded_workspace_snapshot() {
        let workspace = Workspace::example();
        let payload = serde_json::json!({
            "type": "run_node",
            "workspace": workspace,
            "node_id": "text-1",
            "action": "rerun_push"
        });

        let event: ClientEvent = serde_json::from_value(payload).expect("deserialize run event");
        match event {
            ClientEvent::RunNode { workspace, node_id, action } => {
                assert_eq!(workspace.id, "default");
                assert_eq!(node_id, "text-1");
                assert_eq!(action, ExecutionAction::RerunPush);
            }
            _ => panic!("expected run_node event"),
        }
    }
}
