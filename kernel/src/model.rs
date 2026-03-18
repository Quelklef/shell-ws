use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
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
            nodes: vec![
                Node {
                    id: "text-1".to_string(),
                    kind: NodeKind::Text,
                    title: "Seed".to_string(),
                    comment: "".to_string(),
                    position: Position { x: 80.0, y: 120.0 },
                    size: Size {
                        width: 320.0,
                        height: 220.0,
                    },
                    shell: Some("bash".to_string()),
                    script: None,
                    text: Some("hello from shell-ws\n".to_string()),
                    auto_run: None,
                },
                Node {
                    id: "display-1".to_string(),
                    kind: NodeKind::Display,
                    title: "Display".to_string(),
                    comment: "".to_string(),
                    position: Position { x: 520.0, y: 120.0 },
                    size: Size {
                        width: 360.0,
                        height: 260.0,
                    },
                    shell: Some("bash".to_string()),
                    script: None,
                    text: None,
                    auto_run: None,
                },
            ],
            edges: vec![Edge {
                id: "edge-1".to_string(),
                from: PortRef {
                    node_id: "text-1".to_string(),
                    port: PortKind::Stdout,
                },
                to: PortRef {
                    node_id: "display-1".to_string(),
                    port: PortKind::Stdin,
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
    pub text: Option<String>,
    #[serde(default, alias = "auto_run")]
    pub auto_run: Option<AutoRunConfig>,
}

impl Node {
    pub fn shell_value(&self) -> String {
        self.shell.clone().unwrap_or_else(default_shell)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Process,
    Display,
    Text,
    MergeConcat,
    MergeLine,
    MergeByte,
    MergeShell,
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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PortKind {
    Stdin,
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BufferingMode {
    Unbuffered,
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

pub fn default_shell() -> String {
    "bash".to_string()
}

fn default_shell_option() -> Option<String> {
    Some(default_shell())
}

fn default_zoom() -> f64 {
    0.5
}

#[cfg(test)]
mod tests {
    use super::{ClientEvent, Workspace};

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
