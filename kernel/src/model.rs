use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(default)]
    pub openai_api_key: Option<String>,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub ui: WorkspaceUi,
}

impl Workspace {
    pub fn example() -> Self {
        Self {
            id: "default".to_string(),
            name: "Shell WS".to_string(),
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes: vec![
                Node {
                    id: "text-1".to_string(),
                    kind: NodeKind::Text,
                    title: "".to_string(),
                    comment: "".to_string(),
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
                    text: Some("".to_string()),
                    auto_run: None,
                    ui_state: NodeUiState::default(),
                },
                Node {
                    id: "passthru-1".to_string(),
                    kind: NodeKind::Passthru,
                    title: "".to_string(),
                    comment: "".to_string(),
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
                buffering: BufferingMode::LineOr1024,
            }],
            ui: WorkspaceUi::default(),
        }
    }
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
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub text: Option<String>,
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
    #[serde(alias = "display")]
    Passthru,
    Html,
    Text,
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
        Self::LineOr1024
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Push,
    Pull,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRunConfig {
    pub enabled: bool,
    pub mode: ExecutionMode,
    pub interval_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDisplayState {
    pub data_base64: String,
    pub completed: bool,
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
    pub editor_heights: std::collections::HashMap<String, f64>,
    #[serde(default)]
    pub previews: std::collections::HashMap<String, PersistedDisplayState>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUi {
    #[serde(default)]
    pub viewport_x: f64,
    #[serde(default)]
    pub viewport_y: f64,
    #[serde(default = "default_zoom")]
    pub zoom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientEvent {
    RunNode {
        workspace: Workspace,
        node_id: String,
        mode: ExecutionMode,
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
        timestamp: u64,
    },
    StreamChunk {
        edge_id: String,
        from_node_id: String,
        to_node_id: String,
        port: PortKind,
        data_base64: String,
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
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
}

pub fn sanitize_workspace_json_value(value: &mut serde_json::Value) {
    const REMOVED: &[&str] = &[
        "tee",
        "merge_concat",
        "merge_line",
        "merge_byte",
        "merge_shell",
    ];
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let mut removed_ids = std::collections::HashSet::new();
    if let Some(nodes) = obj
        .get_mut("nodes")
        .and_then(serde_json::Value::as_array_mut)
    {
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
    if let Some(edges) = obj
        .get_mut("edges")
        .and_then(serde_json::Value::as_array_mut)
    {
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
            match (from, to) {
                (Some(from), Some(to)) => !removed_ids.contains(from) && !removed_ids.contains(to),
                _ => true,
            }
        });
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

#[cfg(test)]
mod tests {
    use super::{default_cwd, ClientEvent, Workspace};

    #[test]
    fn buffering_mode_serializes_with_expected_underscore() {
        let value =
            serde_json::to_string(&super::BufferingMode::LineOr1024).expect("serialize mode");
        assert_eq!(value, "\"line_or_1024\"");

        let parsed: super::BufferingMode =
            serde_json::from_str("\"line_or1024\"").expect("deserialize legacy mode");
        assert_eq!(parsed, super::BufferingMode::LineOr1024);
    }

    #[test]
    fn legacy_process_kind_deserializes_as_script() {
        let kind: super::NodeKind =
            serde_json::from_str("\"process\"").expect("deserialize legacy process kind");
        assert_eq!(kind, super::NodeKind::Script);
    }

    #[test]
    fn legacy_cat_kind_deserializes_as_file() {
        let kind: super::NodeKind =
            serde_json::from_str("\"cat\"").expect("deserialize legacy cat kind");
        assert_eq!(kind, super::NodeKind::File);
    }

    #[test]
    fn legacy_display_kind_deserializes_as_passthru() {
        let kind: super::NodeKind =
            serde_json::from_str("\"display\"").expect("deserialize legacy display kind");
        assert_eq!(kind, super::NodeKind::Passthru);
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
        let workspace: Workspace =
            serde_json::from_value(value).expect("deserialize sanitized workspace");
        assert_eq!(workspace.nodes.len(), 1);
        assert_eq!(workspace.nodes[0].id, "text-1");
        assert!(workspace.edges.is_empty());
    }

    #[test]
    fn run_node_accepts_embedded_workspace_snapshot() {
        let workspace = Workspace::example();
        let payload = serde_json::json!({
            "type": "run_node",
            "workspace": workspace,
            "node_id": "text-1",
            "mode": "push"
        });

        let event: ClientEvent = serde_json::from_value(payload).expect("deserialize run event");
        match event {
            ClientEvent::RunNode {
                workspace, node_id, ..
            } => {
                assert_eq!(workspace.id, "default");
                assert_eq!(node_id, "text-1");
            }
            _ => panic!("expected run_node event"),
        }
    }
}
