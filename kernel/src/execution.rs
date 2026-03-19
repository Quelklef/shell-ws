use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use async_recursion::async_recursion;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use parking_lot::Mutex;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{broadcast, mpsc},
    task::JoinHandle,
    time::{sleep, Duration},
};
use tokio_util::sync::CancellationToken;
use tracing::error;
use uuid::Uuid;

use crate::model::{
    default_cwd, BufferingMode, Edge, ExecutionAction, LegacyPersistedDisplayState, MaterializedValue,
    Node, NodeKind, PortKind, ServerEvent, Workspace,
};

fn node_label(node: &Node) -> &str {
    if node.title.trim().is_empty() {
        &node.id
    } else {
        &node.title
    }
}

fn output_ports(kind: &NodeKind) -> &'static [PortKind] {
    match kind {
        NodeKind::Script | NodeKind::AiScript | NodeKind::Exec | NodeKind::File => {
            &[PortKind::Stdout, PortKind::Stderr]
        }
        NodeKind::Text | NodeKind::Passthru => &[PortKind::Stdout],
        NodeKind::Html => &[],
    }
}

fn node_accepts_argv(kind: &NodeKind) -> bool {
    matches!(kind, NodeKind::Script | NodeKind::AiScript | NodeKind::Exec)
}

fn output_key(port: PortKind) -> &'static str {
    match port {
        PortKind::Stdout => "stdout",
        PortKind::Stderr => "stderr",
        PortKind::Stdin | PortKind::Argv => unreachable!("output ports only"),
    }
}

fn input_key(port: PortKind, slot: Option<usize>) -> String {
    match port {
        PortKind::Stdin => "stdin".to_string(),
        PortKind::Argv => format!("argv-{}", slot.unwrap_or(1)),
        PortKind::Stdout | PortKind::Stderr => unreachable!("input ports only"),
    }
}

fn decode_materialized_value(value: &MaterializedValue) -> Vec<u8> {
    BASE64.decode(&value.data_base64).unwrap_or_default()
}

fn decode_legacy_preview(value: &LegacyPersistedDisplayState) -> Vec<u8> {
    BASE64.decode(&value.data_base64).unwrap_or_default()
}

fn encode_bytes(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

fn is_legacy_unslotted_argv_edge(edge: &Edge) -> bool {
    edge.to.port == PortKind::Argv && edge.to.slot.is_none()
}

fn parse_argv_value(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches(['\n', '\r'])
        .to_string()
}

#[derive(Clone)]
pub struct ExecutionManager {
    active: Arc<Mutex<HashMap<String, ExecutionHandle>>>,
    broadcaster: broadcast::Sender<ServerEvent>,
}

impl ExecutionManager {
    pub fn new(broadcaster: broadcast::Sender<ServerEvent>) -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
            broadcaster,
        }
    }

    pub fn run(&self, workspace: Workspace, node_id: String, action: ExecutionAction) -> String {
        let exec_id = Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let manager = self.clone();
        let node_for_handle = node_id.clone();
        let exec_id_for_task = exec_id.clone();
        let exec_id_for_remove = exec_id.clone();
        let cancel_for_task = cancel.clone();
        let task = tokio::spawn(async move {
            let context = match ExecutionContext::new(
                exec_id_for_task.clone(),
                workspace,
                action,
                manager.broadcaster.clone(),
                cancel_for_task.clone(),
            ) {
                Ok(context) => Arc::new(context),
                Err(message) => {
                    let _ = manager.broadcaster.send(ServerEvent::Error {
                        message,
                        timestamp: now_ms(),
                    });
                    return;
                }
            };

            if let Err(message) = context.clone().run(node_id).await {
                if !context.cancel.is_cancelled() {
                    let _ = manager.broadcaster.send(ServerEvent::Error {
                        message,
                        timestamp: now_ms(),
                    });
                }
            }

            manager.active.lock().remove(&exec_id_for_remove);
        });

        self.active.lock().insert(
            exec_id.clone(),
            ExecutionHandle {
                node_id: node_for_handle,
                cancel,
                _task: task,
            },
        );
        exec_id
    }

    pub fn stop_by_id(&self, exec_id: &str) {
        if let Some(handle) = self.active.lock().remove(exec_id) {
            handle.cancel.cancel();
            let _ = self.broadcaster.send(ServerEvent::ExecutionStopped {
                exec_id: exec_id.to_string(),
                timestamp: now_ms(),
            });
        }
    }

    pub fn stop_by_node(&self, node_id: &str) {
        let exec_ids: Vec<String> = self
            .active
            .lock()
            .iter()
            .filter_map(|(exec_id, handle)| (handle.node_id == node_id).then_some(exec_id.clone()))
            .collect();
        for exec_id in exec_ids {
            self.stop_by_id(&exec_id);
        }
    }
}

struct ExecutionHandle {
    node_id: String,
    cancel: CancellationToken,
    _task: JoinHandle<()>,
}

struct ExecutionContext {
    exec_id: String,
    workspace: Workspace,
    action: ExecutionAction,
    broadcaster: broadcast::Sender<ServerEvent>,
    cancel: CancellationToken,
    nodes: HashMap<String, Node>,
    outgoing: HashMap<String, Vec<Edge>>,
    incoming: HashMap<String, Vec<Edge>>,
    materialized_inputs: Arc<Mutex<HashMap<String, HashMap<String, Vec<u8>>>>>,
    materialized_outputs: Arc<Mutex<HashMap<String, HashMap<String, Vec<u8>>>>>,
    push_reachable: Arc<Mutex<HashSet<String>>>,
    edge_buffers: Arc<Mutex<HashMap<String, EdgeBufferState>>>,
    stream_states: Arc<Mutex<HashMap<String, StreamingNodeState>>>,
    live_inputs: Arc<Mutex<HashMap<String, HashMap<String, Vec<u8>>>>>,
    live_outputs: Arc<Mutex<HashMap<String, HashMap<String, Vec<u8>>>>>,
}

impl ExecutionContext {
    fn new(
        exec_id: String,
        mut workspace: Workspace,
        action: ExecutionAction,
        broadcaster: broadcast::Sender<ServerEvent>,
        cancel: CancellationToken,
    ) -> Result<Self, String> {
        workspace.edges.retain(|edge| !is_legacy_unslotted_argv_edge(edge));

        let nodes: HashMap<String, Node> = workspace
            .nodes
            .iter()
            .cloned()
            .map(|node| (node.id.clone(), node))
            .collect();
        let mut outgoing: HashMap<String, Vec<Edge>> = HashMap::new();
        let mut incoming: HashMap<String, Vec<Edge>> = HashMap::new();

        for edge in &workspace.edges {
            if !nodes.contains_key(&edge.from.node_id) || !nodes.contains_key(&edge.to.node_id) {
                return Err(format!("Edge {} references a missing node", edge.id));
            }
            outgoing.entry(edge.from.node_id.clone()).or_default().push(edge.clone());
            incoming.entry(edge.to.node_id.clone()).or_default().push(edge.clone());
        }

        for node in workspace.nodes.iter() {
            let edges = incoming.get(&node.id).cloned().unwrap_or_default();
            if node_accepts_argv(&node.kind) {
                let stdin_count = edges.iter().filter(|edge| edge.to.port == PortKind::Stdin).count();
                if stdin_count > 1 {
                    return Err(format!("Node {} accepts at most one stdin wire.", node_label(node)));
                }
                let mut argv_slots = HashSet::new();
                for edge in edges.iter().filter(|edge| edge.to.port == PortKind::Argv) {
                    let Some(slot) = edge.to.slot else {
                        return Err(format!("Node {} has an argv wire without a target slot.", node_label(node)));
                    };
                    if !argv_slots.insert(slot) {
                        return Err(format!(
                            "Node {} has multiple argv wires targeting slot {}.",
                            node_label(node),
                            slot,
                        ));
                    }
                }
            } else if edges.len() > 1 {
                return Err(format!(
                    "Node {} has {} input wires. This node accepts only one input.",
                    node_label(node),
                    edges.len()
                ));
            }
        }

        let materialized_inputs = workspace
            .nodes
            .iter()
            .map(|node| (node.id.clone(), materialized_input_map(node)))
            .collect();
        let materialized_outputs = workspace
            .nodes
            .iter()
            .map(|node| (node.id.clone(), materialized_output_map(node)))
            .collect();

        Ok(Self {
            exec_id,
            workspace,
            action,
            broadcaster,
            cancel,
            nodes,
            outgoing,
            incoming,
            materialized_inputs: Arc::new(Mutex::new(materialized_inputs)),
            materialized_outputs: Arc::new(Mutex::new(materialized_outputs)),
            push_reachable: Arc::new(Mutex::new(HashSet::new())),
            edge_buffers: Arc::new(Mutex::new(HashMap::new())),
            stream_states: Arc::new(Mutex::new(HashMap::new())),
            live_inputs: Arc::new(Mutex::new(HashMap::new())),
            live_outputs: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    async fn run(self: Arc<Self>, node_id: String) -> Result<(), String> {
        if !self.nodes.contains_key(&node_id) {
            return Err(format!("Node {node_id} does not exist"));
        }
        match self.action {
            ExecutionAction::PullInputs => self.pull_inputs(node_id, Vec::new()).await,
            ExecutionAction::PullRun => {
                self.clone().pull_inputs(node_id.clone(), Vec::new()).await?;
                self.clone().run_materialized_node(node_id).await.map(|_| ())
            }
            ExecutionAction::Rerun => {
                self.ensure_rerunnable(&node_id)?;
                self.run_materialized_node(node_id).await.map(|_| ())
            }
            ExecutionAction::RerunPush => {
                self.ensure_rerunnable(&node_id)?;
                self.clone().run_streaming_push(node_id).await
            }
            ExecutionAction::Repush => {
                self.ensure_repushable(&node_id)?;
                let mut visited = HashSet::new();
                self.propagate_repush(node_id, &mut visited).await
            }
        }
    }

    fn workspace_cwd(&self) -> PathBuf {
        let cwd = self.workspace.cwd.trim();
        if cwd.is_empty() {
            PathBuf::from(default_cwd())
        } else {
            PathBuf::from(cwd)
        }
    }

    fn resolve_workspace_path(&self, value: &str) -> PathBuf {
        let path = Path::new(value);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.workspace_cwd().join(path)
        }
    }

    fn connected_input_edges(&self, node_id: &str) -> Vec<Edge> {
        self.incoming.get(node_id).cloned().unwrap_or_default()
    }

    fn outgoing_edges_for(&self, node_id: &str, port: PortKind) -> Vec<Edge> {
        self.outgoing
            .get(node_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|edge| edge.from.port == port)
            .collect()
    }

    fn required_input_keys(&self, node_id: &str) -> Vec<String> {
        let mut keys = HashSet::new();
        for edge in self.connected_input_edges(node_id) {
            keys.insert(input_key(edge.to.port, edge.to.slot));
        }
        let mut keys: Vec<String> = keys.into_iter().collect();
        keys.sort();
        keys
    }

    fn node_materialized_inputs(&self, node_id: &str) -> HashMap<String, Vec<u8>> {
        self.materialized_inputs
            .lock()
            .get(node_id)
            .cloned()
            .unwrap_or_default()
    }

    fn node_materialized_outputs(&self, node_id: &str) -> HashMap<String, Vec<u8>> {
        self.materialized_outputs
            .lock()
            .get(node_id)
            .cloned()
            .unwrap_or_default()
    }

    fn ensure_rerunnable(&self, node_id: &str) -> Result<(), String> {
        let available = self.node_materialized_inputs(node_id);
        let missing: Vec<String> = self
            .required_input_keys(node_id)
            .into_iter()
            .filter(|key| !available.contains_key(key))
            .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "{} is missing materialized {}.",
                node_label(self.nodes.get(node_id).expect("node")),
                missing.join(", "),
            ))
        }
    }

    fn ensure_repushable(&self, node_id: &str) -> Result<(), String> {
        let node = self.nodes.get(node_id).expect("node");
        let required = output_ports(&node.kind);
        if required.is_empty() {
            return Err(format!("{} has no outputs to push.", node_label(node)));
        }
        let available = self.node_materialized_outputs(node_id);
        let missing: Vec<String> = required
            .iter()
            .map(|port| output_key(*port).to_string())
            .filter(|key| !available.contains_key(key))
            .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "{} is missing materialized {}.",
                node_label(node),
                missing.join(", "),
            ))
        }
    }


    async fn run_streaming_push(self: Arc<Self>, node_id: String) -> Result<(), String> {
        self.init_streaming_push(&node_id);
        self.clone().start_streaming_root(node_id).await?;

        loop {
            if self.cancel.is_cancelled() {
                break;
            }
            let active = self
                .stream_states
                .lock()
                .values()
                .any(|state| state.running || state.scheduled);
            if !active {
                break;
            }
            sleep(Duration::from_millis(40)).await;
        }

        Ok(())
    }

    fn init_streaming_push(&self, start_node_id: &str) {
        let reachable = self.compute_push_reachable(start_node_id);
        *self.push_reachable.lock() = reachable.clone();
        self.edge_buffers.lock().clear();
        self.stream_states.lock().clear();
        self.live_inputs.lock().clear();
        self.live_outputs.lock().clear();

        let mut buffers = self.edge_buffers.lock();
        for edge in self.workspace.edges.iter().filter(|edge| {
            reachable.contains(&edge.from.node_id) && reachable.contains(&edge.to.node_id)
        }) {
            buffers.insert(
                edge.id.clone(),
                EdgeBufferState {
                    edge: edge.clone(),
                    buffered: Vec::new(),
                    sent_any: false,
                },
            );
        }
    }

    fn compute_push_reachable(&self, start_node_id: &str) -> HashSet<String> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::from([start_node_id.to_string()]);
        while let Some(node_id) = queue.pop_front() {
            if !visited.insert(node_id.clone()) {
                continue;
            }
            if let Some(edges) = self.outgoing.get(&node_id) {
                for edge in edges {
                    queue.push_back(edge.to.node_id.clone());
                }
            }
        }
        visited
    }

    fn streaming_reachable_contains(&self, node_id: &str) -> bool {
        self.push_reachable.lock().contains(node_id)
    }

    fn has_fresh_stdin_edge(&self, node_id: &str) -> bool {
        self.connected_input_edges(node_id).into_iter().any(|edge| {
            edge.to.port == PortKind::Stdin && self.streaming_reachable_contains(&edge.from.node_id)
        })
    }

    fn streaming_command_ready(&self, node_id: &str) -> bool {
        let inputs = self.node_materialized_inputs(node_id);
        let states = self.stream_states.lock();
        let state = states.get(node_id).cloned().unwrap_or_default();

        if self.has_fresh_stdin_edge(node_id) {
            if !state.stdin_seen && !state.buffered_stdin_closed {
                return false;
            }
        } else if self.has_connected_stdin(node_id) && !inputs.contains_key("stdin") {
            return false;
        }

        for edge in self.connected_input_edges(node_id)
            .into_iter()
            .filter(|edge| edge.to.port == PortKind::Argv)
        {
            if self.streaming_reachable_contains(&edge.from.node_id) {
                if !state.argv_completed.contains(&edge.id) {
                    return false;
                }
            } else if !inputs.contains_key(&input_key(PortKind::Argv, edge.to.slot)) {
                return false;
            }
        }

        true
    }

    fn take_streaming_command_inputs(&self, node_id: &str) -> (Vec<u8>, bool, Vec<String>) {
        let committed = self.node_materialized_inputs(node_id);
        let mut argv_edges = self
            .connected_input_edges(node_id)
            .into_iter()
            .filter(|edge| edge.to.port == PortKind::Argv)
            .collect::<Vec<_>>();
        argv_edges.sort_by_key(|edge| edge.to.slot.unwrap_or(usize::MAX));

        let mut states = self.stream_states.lock();
        let state = states.entry(node_id.to_string()).or_default();

        let use_fresh_stdin = self.has_fresh_stdin_edge(node_id);
        let stdin = if self.has_connected_stdin(node_id) {
            if use_fresh_stdin {
                std::mem::take(&mut state.buffered_stdin)
            } else {
                committed.get("stdin").cloned().unwrap_or_default()
            }
        } else {
            Vec::new()
        };
        let close_after_start = if self.has_connected_stdin(node_id) {
            if use_fresh_stdin {
                state.buffered_stdin_closed
            } else {
                true
            }
        } else {
            true
        };
        state.buffered_stdin_closed = false;
        state.stdin_seen = false;

        let argv = argv_edges
            .into_iter()
            .map(|edge| {
                let key = input_key(PortKind::Argv, edge.to.slot);
                if self.streaming_reachable_contains(&edge.from.node_id) {
                    parse_argv_value(
                        state
                            .argv_inputs
                            .remove(&edge.id)
                            .unwrap_or_default()
                            .as_slice(),
                    )
                } else {
                    parse_argv_value(committed.get(&key).map(Vec::as_slice).unwrap_or(&[]))
                }
            })
            .collect();

        state.argv_completed.clear();
        state.scheduled = false;
        state.tainted = false;
        state.output_resets.clear();
        (stdin, close_after_start, argv)
    }

    async fn start_streaming_root(self: Arc<Self>, node_id: String) -> Result<(), String> {
        let node = self
            .nodes
            .get(&node_id)
            .cloned()
            .ok_or_else(|| format!("Unknown node {node_id}"))?;
        match node.kind {
            NodeKind::Text => self.run_streaming_text_node(node).await,
            NodeKind::File => self.run_streaming_file_node(node).await,
            NodeKind::Passthru => self.run_streaming_passthru_root(node).await,
            NodeKind::Html => self.run_streaming_html_root(node).await,
            NodeKind::Script | NodeKind::AiScript => {
                let (stdin, close_after_start, argv) = self.take_streaming_command_inputs(&node.id);
                self.spawn_streaming_command_node(node, stdin, close_after_start, argv, true)
                    .await
            }
            NodeKind::Exec => {
                let (stdin, close_after_start, argv) = self.take_streaming_command_inputs(&node.id);
                self.spawn_streaming_command_node(node, stdin, close_after_start, argv, false)
                    .await
            }
        }
    }

    async fn run_streaming_text_node(self: Arc<Self>, node: Node) -> Result<(), String> {
        self.begin_streaming_node(&node.id);
        let stdout = node.text.clone().unwrap_or_default().into_bytes();
        self.clone()
            .forward_output_streaming(&node.id, PortKind::Stdout, stdout)
            .await?;
        self.finish_streaming_node(&node.id, Some(0)).await
    }

    async fn run_streaming_passthru_root(self: Arc<Self>, node: Node) -> Result<(), String> {
        self.begin_streaming_node(&node.id);
        let stdin = if self.has_connected_stdin(&node.id) {
            self.node_materialized_inputs(&node.id)
                .remove("stdin")
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        self.clone()
            .forward_output_streaming(&node.id, PortKind::Stdout, stdin)
            .await?;
        self.finish_streaming_node(&node.id, Some(0)).await
    }

    async fn run_streaming_html_root(self: Arc<Self>, node: Node) -> Result<(), String> {
        self.begin_streaming_node(&node.id);
        self.finish_streaming_node(&node.id, Some(0)).await
    }

    async fn run_streaming_file_node(self: Arc<Self>, node: Node) -> Result<(), String> {
        self.begin_streaming_node(&node.id);
        let path = node
            .path
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{} is missing a file path", node_label(&node)))?;
        let resolved_path = self.resolve_workspace_path(&path);
        let exit_code = match tokio::fs::read(&resolved_path).await {
            Ok(data) => {
                self.clone()
                    .forward_output_streaming(&node.id, PortKind::Stdout, data)
                    .await?;
                Some(0)
            }
            Err(error) => {
                let message = format!("file {}: {error}
", path).into_bytes();
                self.clone()
                    .forward_output_streaming(&node.id, PortKind::Stderr, message)
                    .await?;
                Some(1)
            }
        };
        self.finish_streaming_node(&node.id, exit_code).await
    }

    fn begin_streaming_node(&self, node_id: &str) {
        let mut states = self.stream_states.lock();
        let state = states.entry(node_id.to_string()).or_default();
        state.running = true;
        state.scheduled = false;
        state.tainted = false;
        state.output_resets.clear();
        self.live_outputs.lock().remove(node_id);
        self.emit_started(node_id);
    }

    async fn spawn_streaming_command_node(
        self: Arc<Self>,
        node: Node,
        initial_input: Vec<u8>,
        close_after_start: bool,
        argv: Vec<String>,
        shell_script: bool,
    ) -> Result<(), String> {
        {
            let mut states = self.stream_states.lock();
            let state = states.entry(node.id.clone()).or_default();
            if state.running {
                if let Some(writer) = &state.stdin_writer {
                    if !initial_input.is_empty() {
                        let _ = writer.send(StdinMessage::Chunk(initial_input));
                    }
                    if close_after_start {
                        let _ = writer.send(StdinMessage::Close);
                    }
                }
                return Ok(());
            }
            state.running = true;
            state.scheduled = false;
            state.output_resets.clear();
            state.tainted = false;
        }
        self.live_outputs.lock().remove(&node.id);
        self.emit_started(&node.id);

        let mut command = if shell_script {
            let mut command = Command::new(node.shell_value());
            command.arg("-c").arg(node.script.clone().unwrap_or_default()).arg("--");
            for arg in argv {
                command.arg(arg);
            }
            command
        } else {
            let path = node
                .path
                .clone()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{} is missing a binary path", node_label(&node)))?;
            let mut command = Command::new(path);
            for arg in node.args.clone().unwrap_or_default() {
                command.arg(arg);
            }
            for arg in argv {
                command.arg(arg);
            }
            command
        };

        command.current_dir(self.workspace_cwd());
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to spawn {}: {error}", node_label(&node)))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("Failed to open stdin for {}", node_label(&node)))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("Failed to open stdout for {}", node_label(&node)))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("Failed to open stderr for {}", node_label(&node)))?;

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<StdinMessage>();
        self.stream_states
            .lock()
            .entry(node.id.clone())
            .or_default()
            .stdin_writer = Some(stdin_tx.clone());

        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(message) = stdin_rx.recv().await {
                match message {
                    StdinMessage::Chunk(data) => {
                        if stdin.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    StdinMessage::Close => {
                        let _ = stdin.shutdown().await;
                        break;
                    }
                }
            }
        });

        if !initial_input.is_empty() {
            let _ = stdin_tx.send(StdinMessage::Chunk(initial_input));
        }
        if close_after_start || !self.has_fresh_stdin_edge(&node.id) {
            let _ = stdin_tx.send(StdinMessage::Close);
        }

        let stdout_context = self.clone();
        let stdout_node = node.id.clone();
        let stdout_task = tokio::spawn(async move {
            stdout_context
                .read_streaming_output(stdout_node, PortKind::Stdout, stdout)
                .await;
        });

        let stderr_context = self.clone();
        let stderr_node = node.id.clone();
        let stderr_task = tokio::spawn(async move {
            stderr_context
                .read_streaming_output(stderr_node, PortKind::Stderr, stderr)
                .await;
        });

        let cancel = self.cancel.clone();
        let context = self.clone();
        tokio::spawn(async move {
            let exit_code = tokio::select! {
                result = child.wait() => {
                    match result {
                        Ok(status) => status.code(),
                        Err(error) => {
                            error!("child wait failed for {}: {}", node.id, error);
                            None
                        }
                    }
                }
                _ = cancel.cancelled() => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    None
                }
            };
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            if let Err(message) = context.finish_streaming_node(&node.id, exit_code).await {
                error!("{message}");
            }
        });

        Ok(())
    }

    async fn read_streaming_output<R>(self: Arc<Self>, node_id: String, port: PortKind, mut reader: R)
    where
        R: AsyncRead + Unpin + Send + 'static,
    {
        let mut buffer = [0_u8; 1024];
        loop {
            if self.cancel.is_cancelled() {
                break;
            }
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    let chunk = buffer[..read].to_vec();
                    if let Err(message) = self.clone().forward_output_streaming(&node_id, port, chunk).await {
                        error!("{message}");
                        break;
                    }
                }
                Err(error) => {
                    error!("Failed to read output for {}: {}", node_id, error);
                    break;
                }
            }
        }
    }

    #[async_recursion]
    async fn forward_output_streaming(
        self: Arc<Self>,
        from_node_id: &str,
        port: PortKind,
        chunk: Vec<u8>,
    ) -> Result<(), String> {
        if !chunk.is_empty() {
            self.emit_port_activity(from_node_id, port, chunk.len());
            self.append_live_output(from_node_id, port, &chunk);
            self.emit_node_output_chunk(from_node_id, port, &chunk);
        }

        let edges = self
            .outgoing
            .get(from_node_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|edge| self.streaming_reachable_contains(&edge.to.node_id) && edge.from.port == port)
            .collect::<Vec<_>>();

        for edge in edges {
            let flushed = {
                let mut buffers = self.edge_buffers.lock();
                let state = buffers
                    .get_mut(&edge.id)
                    .ok_or_else(|| format!("Missing buffer state for edge {}", edge.id))?;
                state.accept(chunk.clone())
            };
            for (reset, payload) in flushed {
                self.emit_stream_chunk(&edge, port, &payload, reset, false, true);
                self.clone().deliver_to_target_streaming(&edge, payload, false, true).await?;
            }
        }
        Ok(())
    }

    async fn finish_streaming_node(self: Arc<Self>, node_id: &str, exit_code: Option<i32>) -> Result<(), String> {
        // A node that saw a failed upstream stream should not replace committed notebook state
        // with outputs derived from partial live input, even if its own process exits 0.
        let commit_success = exit_code == Some(0) && !self.stream_states.lock().get(node_id).map(|state| state.tainted).unwrap_or(false);

        {
            let mut states = self.stream_states.lock();
            let state = states.entry(node_id.to_string()).or_default();
            state.running = false;
            state.scheduled = false;
            state.stdin_writer = None;
        }

        if commit_success {
            self.commit_live_outputs(node_id);
        } else {
            self.live_outputs.lock().remove(node_id);
        }

        self.emit_finished(node_id, exit_code);

        let edges = self
            .outgoing
            .get(node_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|edge| self.streaming_reachable_contains(&edge.to.node_id))
            .collect::<Vec<_>>();

        for edge in edges {
            let flushed = {
                let mut buffers = self.edge_buffers.lock();
                let Some(state) = buffers.get_mut(&edge.id) else {
                    continue;
                };
                state.finish()
            };
            let delivered_payload = !flushed.is_empty();
            for (reset, payload) in flushed {
                self.emit_stream_chunk(&edge, edge.from.port, &payload, reset, true, commit_success);
                self.clone()
                    .deliver_to_target_streaming(&edge, payload, true, commit_success)
                    .await?;
            }
            if !delivered_payload {
                let reset = {
                    let buffers = self.edge_buffers.lock();
                    let state = buffers.get(&edge.id).expect("edge buffer");
                    !state.sent_any
                };
                self.emit_stream_chunk(&edge, edge.from.port, &[], reset, true, commit_success);
                self.clone()
                    .deliver_to_target_streaming(&edge, Vec::new(), true, commit_success)
                    .await?;
            }
        }
        Ok(())
    }

    #[async_recursion]
    async fn deliver_to_target_streaming(
        self: Arc<Self>,
        edge: &Edge,
        payload: Vec<u8>,
        completed: bool,
        success: bool,
    ) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            return Ok(());
        }

        let target = self
            .nodes
            .get(&edge.to.node_id)
            .cloned()
            .ok_or_else(|| format!("Unknown target node {}", edge.to.node_id))?;
        let key = input_key(edge.to.port, edge.to.slot);

        sleep(Duration::from_millis(250)).await;

        if !payload.is_empty() {
            self.emit_port_activity(&target.id, edge.to.port, payload.len());
            self.append_live_input(&target.id, &key, &payload);
        } else if completed {
            self.live_inputs
                .lock()
                .entry(target.id.clone())
                .or_default()
                .entry(key.clone())
                .or_insert_with(Vec::new);
        }

        if completed {
            if success {
                self.commit_live_input(&target.id, &key);
            } else {
                self.discard_live_input(&target.id, &key);
                self.stream_states
                    .lock()
                    .entry(target.id.clone())
                    .or_default()
                    .tainted = true;
            }
        }

        match target.kind {
            NodeKind::Passthru => {
                let started = {
                    let mut states = self.stream_states.lock();
                    let state = states.entry(target.id.clone()).or_default();
                    if state.running {
                        false
                    } else {
                        state.running = true;
                        state.output_resets.clear();
                        true
                    }
                };
                if started {
                    self.live_outputs.lock().remove(&target.id);
                    self.emit_started(&target.id);
                }
                if !payload.is_empty() {
                    self.clone()
                        .forward_output_streaming(&target.id, PortKind::Stdout, payload)
                        .await?;
                }
                if completed {
                    self.clone().finish_streaming_node(&target.id, Some(0)).await?;
                }
            }
            NodeKind::Html => {
                let started = {
                    let mut states = self.stream_states.lock();
                    let state = states.entry(target.id.clone()).or_default();
                    if state.running {
                        false
                    } else {
                        state.running = true;
                        true
                    }
                };
                if started {
                    self.emit_started(&target.id);
                }
                if completed {
                    self.clone().finish_streaming_node(&target.id, Some(0)).await?;
                }
            }
            NodeKind::Script | NodeKind::AiScript | NodeKind::Exec => match edge.to.port {
                PortKind::Argv => {
                    {
                        let mut states = self.stream_states.lock();
                        let state = states.entry(target.id.clone()).or_default();
                        state.argv_inputs.entry(edge.id.clone()).or_default().extend_from_slice(&payload);
                        if completed {
                            state.argv_completed.insert(edge.id.clone());
                        }
                        if !success {
                            state.tainted = true;
                        }
                    }
                    if completed && self.streaming_command_ready(&target.id) {
                        self.clone().start_ready_streaming_command(target.id.clone()).await?;
                    }
                }
                PortKind::Stdin => {
                    let existing_writer = {
                        let mut states = self.stream_states.lock();
                        let state = states.entry(target.id.clone()).or_default();
                        if !payload.is_empty() {
                            state.buffered_stdin.extend_from_slice(&payload);
                            state.stdin_seen = true;
                        }
                        if completed {
                            state.buffered_stdin_closed = true;
                        }
                        if !success {
                            state.tainted = true;
                        }
                        state.stdin_writer.clone()
                    };
                    if let Some(writer) = existing_writer {
                        if !payload.is_empty() {
                            let _ = writer.send(StdinMessage::Chunk(payload));
                        }
                        if completed {
                            let _ = writer.send(StdinMessage::Close);
                        }
                    } else if self.streaming_command_ready(&target.id) {
                        self.clone().start_ready_streaming_command(target.id.clone()).await?;
                    }
                }
                _ => {}
            },
            NodeKind::Text | NodeKind::File => {}
        }

        Ok(())
    }

    async fn start_ready_streaming_command(self: Arc<Self>, node_id: String) -> Result<(), String> {
        let node = self
            .nodes
            .get(&node_id)
            .cloned()
            .ok_or_else(|| format!("Unknown node {node_id}"))?;
        if !self.streaming_command_ready(&node.id) {
            let mut states = self.stream_states.lock();
            states.entry(node.id.clone()).or_default().scheduled = true;
            return Ok(());
        }
        let (stdin, close_after_start, argv) = self.take_streaming_command_inputs(&node.id);
        match node.kind {
            NodeKind::Script | NodeKind::AiScript => {
                self.spawn_streaming_command_node(node, stdin, close_after_start, argv, true)
                    .await
            }
            NodeKind::Exec => {
                self.spawn_streaming_command_node(node, stdin, close_after_start, argv, false)
                    .await
            }
            _ => Ok(()),
        }
    }

    fn append_live_input(&self, node_id: &str, key: &str, payload: &[u8]) {
        self.live_inputs
            .lock()
            .entry(node_id.to_string())
            .or_default()
            .entry(key.to_string())
            .or_default()
            .extend_from_slice(payload);
    }

    fn append_live_output(&self, node_id: &str, port: PortKind, payload: &[u8]) {
        self.live_outputs
            .lock()
            .entry(node_id.to_string())
            .or_default()
            .entry(output_key(port).to_string())
            .or_default()
            .extend_from_slice(payload);
    }

    fn commit_live_input(&self, node_id: &str, key: &str) {
        let bytes = self
            .live_inputs
            .lock()
            .get(node_id)
            .and_then(|inputs| inputs.get(key).cloned())
            .unwrap_or_default();
        self.set_materialized_input(node_id, key, bytes);
    }

    fn discard_live_input(&self, node_id: &str, key: &str) {
        if let Some(inputs) = self.live_inputs.lock().get_mut(node_id) {
            inputs.remove(key);
        }
    }

    fn commit_live_outputs(&self, node_id: &str) {
        let outputs = self.live_outputs.lock().remove(node_id).unwrap_or_default();
        let node = self.nodes.get(node_id).expect("node");
        let mut next = HashMap::new();
        for port in output_ports(&node.kind) {
            let key = output_key(*port).to_string();
            next.insert(key.clone(), outputs.get(&key).cloned().unwrap_or_default());
        }
        self.materialized_outputs.lock().insert(node_id.to_string(), next);
    }

    fn emit_node_output_chunk(&self, node_id: &str, port: PortKind, payload: &[u8]) {
        let reset = {
            let mut states = self.stream_states.lock();
            let state = states.entry(node_id.to_string()).or_default();
            state.output_resets.insert(port)
        };
        let _ = self.broadcaster.send(ServerEvent::NodeOutput {
            node_id: node_id.to_string(),
            port,
            data_base64: encode_bytes(payload),
            reset: !reset,
            timestamp: now_ms(),
        });
    }

    fn emit_stream_chunk(
        &self,
        edge: &Edge,
        port: PortKind,
        payload: &[u8],
        reset: bool,
        completed: bool,
        success: bool,
    ) {
        let _ = self.broadcaster.send(ServerEvent::StreamChunk {
            edge_id: edge.id.clone(),
            from_node_id: edge.from.node_id.clone(),
            to_node_id: edge.to.node_id.clone(),
            port,
            data_base64: encode_bytes(payload),
            reset,
            completed,
            success,
            timestamp: now_ms(),
        });
    }

    #[async_recursion]
    async fn pull_inputs(self: Arc<Self>, node_id: String, path: Vec<String>) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            return Ok(());
        }
        let incoming = self.connected_input_edges(&node_id);
        let mut next_path = path;
        next_path.push(node_id.clone());
        for edge in incoming {
            self.clone().pull_run_node(edge.from.node_id.clone(), next_path.clone()).await?;
            self.clone().deliver_cached_output_to_input(&edge).await?;
        }
        Ok(())
    }

    #[async_recursion]
    async fn pull_run_node(self: Arc<Self>, node_id: String, path: Vec<String>) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            return Ok(());
        }
        if path.contains(&node_id) {
            return Err(format!("pull cycle detected at {node_id}"));
        }
        let mut next_path = path;
        next_path.push(node_id.clone());
        self.clone().pull_inputs(node_id.clone(), next_path).await?;
        self.run_materialized_node(node_id).await?;
        Ok(())
    }

    async fn run_materialized_node(self: Arc<Self>, node_id: String) -> Result<Option<i32>, String> {
        if self.cancel.is_cancelled() {
            return Ok(None);
        }
        let node = self.nodes.get(&node_id).cloned().ok_or_else(|| format!("Unknown node {node_id}"))?;
        self.emit_started(&node.id);
        let result = match node.kind {
            NodeKind::Text => self.run_text_node(&node).await,
            NodeKind::File => self.run_file_node(&node).await,
            NodeKind::Passthru => self.run_passthru_node(&node).await,
            NodeKind::Html => self.run_html_node(&node).await,
            NodeKind::Script | NodeKind::AiScript => self.run_script_like_node(&node, true).await,
            NodeKind::Exec => self.run_script_like_node(&node, false).await,
        }?;
        self.emit_finished(&node.id, result);
        Ok(result)
    }

    async fn run_text_node(&self, node: &Node) -> Result<Option<i32>, String> {
        let stdout = node.text.clone().unwrap_or_default().into_bytes();
        self.replace_materialized_outputs(&node.id, vec![(PortKind::Stdout, stdout.clone())]);
        self.emit_output_chunks(&node.id, PortKind::Stdout, &stdout);
        Ok(Some(0))
    }

    async fn run_passthru_node(&self, node: &Node) -> Result<Option<i32>, String> {
        let stdin = self.node_materialized_inputs(&node.id).remove("stdin").unwrap_or_default();
        self.replace_materialized_outputs(&node.id, vec![(PortKind::Stdout, stdin.clone())]);
        self.emit_output_chunks(&node.id, PortKind::Stdout, &stdin);
        Ok(Some(0))
    }

    async fn run_html_node(&self, node: &Node) -> Result<Option<i32>, String> {
        self.replace_materialized_outputs(&node.id, Vec::new());
        Ok(Some(0))
    }

    async fn run_file_node(&self, node: &Node) -> Result<Option<i32>, String> {
        let path = node
            .path
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{} is missing a file path", node_label(node)))?;
        let resolved_path = self.resolve_workspace_path(&path);
        match tokio::fs::read(&resolved_path).await {
            Ok(stdout) => {
                let stderr = Vec::new();
                self.replace_materialized_outputs(
                    &node.id,
                    vec![
                        (PortKind::Stdout, stdout.clone()),
                        (PortKind::Stderr, stderr.clone()),
                    ],
                );
                self.emit_output_chunks(&node.id, PortKind::Stdout, &stdout);
                Ok(Some(0))
            }
            Err(error) => {
                let stdout = Vec::new();
                let stderr = format!("file {}: {error}\n", path).into_bytes();
                self.replace_materialized_outputs(
                    &node.id,
                    vec![
                        (PortKind::Stdout, stdout.clone()),
                        (PortKind::Stderr, stderr.clone()),
                    ],
                );
                self.emit_output_chunks(&node.id, PortKind::Stderr, &stderr);
                Ok(Some(1))
            }
        }
    }

    async fn run_script_like_node(&self, node: &Node, shell_script: bool) -> Result<Option<i32>, String> {
        let inputs = self.node_materialized_inputs(&node.id);
        let stdin = if self.has_connected_stdin(&node.id) {
            inputs.get("stdin").cloned().unwrap_or_default()
        } else {
            Vec::new()
        };

        let mut argv = Vec::new();
        for edge in self.connected_input_edges(&node.id)
            .into_iter()
            .filter(|edge| edge.to.port == PortKind::Argv)
        {
            let key = input_key(PortKind::Argv, edge.to.slot);
            let value = inputs.get(&key).cloned().unwrap_or_default();
            argv.push((edge.to.slot.unwrap_or(1), parse_argv_value(&value)));
        }
        argv.sort_by_key(|(slot, _)| *slot);

        let mut command = if shell_script {
            let mut command = Command::new(node.shell_value());
            command.arg("-c").arg(node.script.clone().unwrap_or_default()).arg("--");
            for (_, arg) in argv {
                command.arg(arg);
            }
            command
        } else {
            let path = node
                .path
                .clone()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{} is missing a binary path", node_label(node)))?;
            let mut command = Command::new(path);
            for arg in node.args.clone().unwrap_or_default() {
                command.arg(arg);
            }
            for (_, arg) in argv {
                command.arg(arg);
            }
            command
        };

        command.current_dir(self.workspace_cwd());
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| format!("Failed to spawn {}: {error}", node_label(node)))?;

        if let Some(mut child_stdin) = child.stdin.take() {
            let stdin_data = stdin.clone();
            tokio::spawn(async move {
                let _ = child_stdin.write_all(&stdin_data).await;
                let _ = child_stdin.shutdown().await;
            });
        }

        let stdout_reader = child.stdout.take().ok_or_else(|| format!("Failed to read stdout for {}", node_label(node)))?;
        let stderr_reader = child.stderr.take().ok_or_else(|| format!("Failed to read stderr for {}", node_label(node)))?;

        let stdout_task = tokio::spawn(read_output_stream(
            self.broadcaster.clone(),
            node.id.clone(),
            PortKind::Stdout,
            stdout_reader,
        ));
        let stderr_task = tokio::spawn(read_output_stream(
            self.broadcaster.clone(),
            node.id.clone(),
            PortKind::Stderr,
            stderr_reader,
        ));

        let status = tokio::select! {
            _ = self.cancel.cancelled() => {
                let _ = child.kill().await;
                child.wait().await.ok();
                None
            }
            status = child.wait() => Some(status.map_err(|error| format!("Failed while waiting for {}: {error}", node_label(node)))?),
        };

        let stdout = stdout_task.await.map_err(|error| error.to_string())?;
        let stderr = stderr_task.await.map_err(|error| error.to_string())?;
        self.replace_materialized_outputs(
            &node.id,
            vec![
                (PortKind::Stdout, stdout.clone()),
                (PortKind::Stderr, stderr.clone()),
            ],
        );
        Ok(status.map(|value| value.code().unwrap_or_default()))
    }

    #[async_recursion]
    async fn propagate_repush(
        self: Arc<Self>,
        node_id: String,
        visited: &mut HashSet<String>,
    ) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            return Ok(());
        }
        if !visited.insert(node_id.clone()) {
            return Ok(());
        }
        self.emit_started(&node_id);
        let outputs = self.node_materialized_outputs(&node_id);
        let node = self.nodes.get(&node_id).expect("node");
        for port in output_ports(&node.kind) {
            let bytes = outputs.get(output_key(*port)).cloned().unwrap_or_default();
            self.emit_output_chunks(&node_id, *port, &bytes);
        }
        self.emit_finished(&node_id, Some(0));
        let affected = self.clone().deliver_outputs_for_node(&node_id).await?;
        for target_id in affected {
            if self.can_repush_from_materialized(&target_id) {
                self.clone().propagate_repush(target_id, visited).await?;
            }
        }
        Ok(())
    }

    async fn deliver_outputs_for_node(self: Arc<Self>, node_id: &str) -> Result<HashSet<String>, String> {
        let outputs = self.node_materialized_outputs(node_id);
        let mut affected = HashSet::new();
        for port in output_ports(&self.nodes.get(node_id).expect("node").kind) {
            let bytes = outputs.get(output_key(*port)).cloned().unwrap_or_default();
            for edge in self.outgoing_edges_for(node_id, *port) {
                self.clone().deliver_bytes_over_edge(&edge, *port, bytes.clone()).await?;
                affected.insert(edge.to.node_id.clone());
            }
        }
        Ok(affected)
    }

    async fn deliver_cached_output_to_input(self: Arc<Self>, edge: &Edge) -> Result<(), String> {
        let bytes = self
            .node_materialized_outputs(&edge.from.node_id)
            .get(output_key(edge.from.port))
            .cloned()
            .unwrap_or_default();
        self.deliver_bytes_over_edge(edge, edge.from.port, bytes).await
    }

    async fn deliver_bytes_over_edge(
        self: Arc<Self>,
        edge: &Edge,
        from_port: PortKind,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            return Ok(());
        }
        let chunks = chunk_for_edge(edge.buffering, &bytes);
        for (index, chunk) in chunks.iter().enumerate() {
            let _ = self.broadcaster.send(ServerEvent::StreamChunk {
                edge_id: edge.id.clone(),
                from_node_id: edge.from.node_id.clone(),
                to_node_id: edge.to.node_id.clone(),
                port: from_port,
                data_base64: encode_bytes(chunk),
                reset: index == 0,
                completed: true,
                success: true,
                timestamp: now_ms(),
            });
            if !chunk.is_empty() {
                self.emit_port_activity(&edge.to.node_id, edge.to.port, chunk.len());
            }
        }
        self.set_materialized_input(&edge.to.node_id, &input_key(edge.to.port, edge.to.slot), bytes);
        Ok(())
    }

    fn has_connected_stdin(&self, node_id: &str) -> bool {
        self.connected_input_edges(node_id)
            .iter()
            .any(|edge| edge.to.port == PortKind::Stdin)
    }

    fn can_repush_from_materialized(&self, node_id: &str) -> bool {
        let node = match self.nodes.get(node_id) {
            Some(node) => node,
            None => return false,
        };
        let required = output_ports(&node.kind);
        if required.is_empty() {
            return false;
        }
        let outputs = self.node_materialized_outputs(node_id);
        required
            .iter()
            .all(|port| outputs.contains_key(output_key(*port)))
    }

    fn set_materialized_input(&self, node_id: &str, key: &str, bytes: Vec<u8>) {
        self.materialized_inputs
            .lock()
            .entry(node_id.to_string())
            .or_default()
            .insert(key.to_string(), bytes);
    }

    fn replace_materialized_outputs(&self, node_id: &str, outputs: Vec<(PortKind, Vec<u8>)>) {
        let mut next = HashMap::new();
        for (port, bytes) in outputs {
            next.insert(output_key(port).to_string(), bytes);
        }
        self.materialized_outputs
            .lock()
            .insert(node_id.to_string(), next);
    }

    fn emit_started(&self, node_id: &str) {
        let _ = self.broadcaster.send(ServerEvent::ExecStarted {
            exec_id: self.exec_id.clone(),
            node_id: node_id.to_string(),
            timestamp: now_ms(),
        });
    }

    fn emit_finished(&self, node_id: &str, exit_code: Option<i32>) {
        let _ = self.broadcaster.send(ServerEvent::ExecFinished {
            exec_id: self.exec_id.clone(),
            node_id: node_id.to_string(),
            exit_code,
            timestamp: now_ms(),
        });
    }

    fn emit_port_activity(&self, node_id: &str, port: PortKind, bytes: usize) {
        if bytes == 0 {
            return;
        }
        let _ = self.broadcaster.send(ServerEvent::PortActivity {
            node_id: node_id.to_string(),
            port,
            bytes,
            timestamp: now_ms(),
        });
    }

    fn emit_output_chunks(&self, node_id: &str, port: PortKind, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.emit_port_activity(node_id, port, bytes.len());
        let _ = self.broadcaster.send(ServerEvent::NodeOutput {
            node_id: node_id.to_string(),
            port,
            data_base64: encode_bytes(bytes),
            reset: false,
            timestamp: now_ms(),
        });
    }
}


#[derive(Default, Clone)]
struct StreamingNodeState {
    running: bool,
    scheduled: bool,
    tainted: bool,
    stdin_writer: Option<mpsc::UnboundedSender<StdinMessage>>,
    buffered_stdin: Vec<u8>,
    buffered_stdin_closed: bool,
    stdin_seen: bool,
    argv_inputs: HashMap<String, Vec<u8>>,
    argv_completed: HashSet<String>,
    output_resets: HashSet<PortKind>,
}

struct EdgeBufferState {
    edge: Edge,
    buffered: Vec<u8>,
    sent_any: bool,
}

impl EdgeBufferState {
    fn accept(&mut self, chunk: Vec<u8>) -> Vec<(bool, Vec<u8>)> {
        match self.edge.buffering {
            BufferingMode::Unbuffered => {
                let reset = !self.sent_any;
                self.sent_any = true;
                vec![(reset, chunk)]
            }
            BufferingMode::OnComplete => {
                self.buffered.extend_from_slice(&chunk);
                Vec::new()
            }
            BufferingMode::LineOr1024 => {
                self.buffered.extend_from_slice(&chunk);
                let mut flushed = Vec::new();
                while let Some(position) = self
                    .buffered
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .or_else(|| (self.buffered.len() >= 1024).then_some(1023))
                {
                    let end = position + 1;
                    let reset = !self.sent_any;
                    self.sent_any = true;
                    flushed.push((reset, self.buffered.drain(..end).collect()));
                }
                flushed
            }
        }
    }

    fn finish(&mut self) -> Vec<(bool, Vec<u8>)> {
        if self.buffered.is_empty() {
            return Vec::new();
        }
        let reset = !self.sent_any;
        self.sent_any = true;
        vec![(reset, std::mem::take(&mut self.buffered))]
    }
}

#[derive(Clone)]
enum StdinMessage {
    Chunk(Vec<u8>),
    Close,
}

async fn read_output_stream<R>(
    broadcaster: broadcast::Sender<ServerEvent>,
    node_id: String,
    port: PortKind,
    mut reader: R,
) -> Vec<u8>
where
    R: AsyncRead + Unpin,
{
    let mut collected = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                let chunk = &buffer[..read];
                collected.extend_from_slice(chunk);
                let _ = broadcaster.send(ServerEvent::PortActivity {
                    node_id: node_id.clone(),
                    port,
                    bytes: read,
                    timestamp: now_ms(),
                });
                let _ = broadcaster.send(ServerEvent::NodeOutput {
                    node_id: node_id.clone(),
                    port,
                    data_base64: encode_bytes(chunk),
                    reset: false,
                    timestamp: now_ms(),
                });
            }
            Err(error) => {
                error!("failed to read {:?} for {}: {}", port, node_id, error);
                break;
            }
        }
    }
    collected
}

fn materialized_input_map(node: &Node) -> HashMap<String, Vec<u8>> {
    let mut values: HashMap<String, Vec<u8>> = node
        .materialized_inputs
        .iter()
        .map(|(key, value)| (key.clone(), decode_materialized_value(value)))
        .collect();
    if values.is_empty() {
        for (key, value) in &node.ui_state.previews {
            if key == "stdin" || key.starts_with("argv-") {
                values.insert(key.clone(), decode_legacy_preview(value));
            }
        }
    }
    values
}

fn materialized_output_map(node: &Node) -> HashMap<String, Vec<u8>> {
    let mut values: HashMap<String, Vec<u8>> = node
        .materialized_outputs
        .iter()
        .map(|(key, value)| (key.clone(), decode_materialized_value(value)))
        .collect();
    if values.is_empty() {
        for (key, value) in &node.ui_state.previews {
            if key == "stdout" || key == "stderr" {
                values.insert(key.clone(), decode_legacy_preview(value));
            }
        }
    }
    values
}

fn chunk_for_edge(mode: BufferingMode, bytes: &[u8]) -> Vec<Vec<u8>> {
    if bytes.is_empty() {
        return vec![Vec::new()];
    }
    match mode {
        BufferingMode::OnComplete | BufferingMode::Unbuffered => vec![bytes.to_vec()],
        BufferingMode::LineOr1024 => {
            let mut chunks = Vec::new();
            let mut start = 0;
            let mut index = 0;
            while index < bytes.len() {
                index += 1;
                let boundary = bytes[index - 1] == b'\n' || index - start >= 1024;
                if boundary {
                    chunks.push(bytes[start..index].to_vec());
                    start = index;
                }
            }
            if start < bytes.len() {
                chunks.push(bytes[start..].to_vec());
            }
            chunks
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AutoRunConfig, Position, Size, WorkspaceUi};
    use tokio::time::{timeout, Duration};

    fn node(kind: NodeKind, id: &str) -> Node {
        Node {
            id: id.to_string(),
            kind,
            title: String::new(),
            comment: String::new(),
            position: Position { x: 0.0, y: 0.0 },
            size: Size {
                width: 200.0,
                height: 120.0,
            },
            shell: Some("bash".to_string()),
            script: None,
            description: None,
            include_sample_inputs: None,
            path: None,
            args: None,
            text: None,
            materialized_inputs: HashMap::new(),
            materialized_outputs: HashMap::new(),
            auto_run: Some(AutoRunConfig {
                enabled: false,
                mode: ExecutionAction::RerunPush,
                interval_ms: 1000,
            }),
            ui_state: Default::default(),
        }
    }

    fn edge(id: &str, from: &str, from_port: PortKind, to: &str, to_port: PortKind, slot: Option<usize>) -> Edge {
        Edge {
            id: id.to_string(),
            from: crate::model::PortRef {
                node_id: from.to_string(),
                port: from_port,
                slot: None,
            },
            to: crate::model::PortRef {
                node_id: to.to_string(),
                port: to_port,
                slot,
            },
            buffering: BufferingMode::LineOr1024,
        }
    }

    fn workspace(nodes: Vec<Node>, edges: Vec<Edge>) -> Workspace {
        Workspace {
            id: "test".to_string(),
            name: "test".to_string(),
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes,
            edges,
            ui: WorkspaceUi::default(),
        }
    }

    async fn wait_for_finish(rx: &mut broadcast::Receiver<ServerEvent>, exec_id: &str, node_id: &str) -> Option<i32> {
        timeout(Duration::from_secs(3), async {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecFinished { exec_id: seen, node_id: seen_node, exit_code, .. })
                        if seen == exec_id && seen_node == node_id => return exit_code,
                    Ok(ServerEvent::Error { message, .. }) => panic!("unexpected execution error: {message}"),
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await
        .expect("execution never completed")
    }

    #[test]
    fn chunking_preserves_empty_values() {
        let chunks = chunk_for_edge(BufferingMode::LineOr1024, b"");
        assert_eq!(chunks, vec![Vec::<u8>::new()]);
    }

    #[tokio::test]
    async fn rerun_uses_materialized_inputs() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut script = node(NodeKind::Script, "script-1");
        script.script = Some("grep hello >/dev/null; echo done >&2".to_string());
        script.materialized_inputs.insert(
            "stdin".to_string(),
            MaterializedValue {
                data_base64: encode_bytes(b"hello\n"),
            },
        );
        let workspace = workspace(vec![script], vec![]);

        let exec_id = manager.run(workspace, "script-1".to_string(), ExecutionAction::Rerun);
        assert_eq!(wait_for_finish(&mut rx, &exec_id, "script-1").await, Some(0));
    }

    #[tokio::test]
    async fn pull_inputs_materializes_without_running_target() {
        let (tx, _) = broadcast::channel(128);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut text = node(NodeKind::Text, "text-1");
        text.text = Some("hello\n".to_string());
        let mut script = node(NodeKind::Script, "script-1");
        script.script = Some("cat".to_string());
        let workspace = workspace(
            vec![text, script],
            vec![edge("edge-1", "text-1", PortKind::Stdout, "script-1", PortKind::Stdin, None)],
        );

        let exec_id = manager.run(workspace, "script-1".to_string(), ExecutionAction::PullInputs);
        assert_eq!(wait_for_finish(&mut rx, &exec_id, "text-1").await, Some(0));
        let saw_target_start = timeout(Duration::from_millis(300), async {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecStarted { exec_id: seen, node_id, .. })
                        if seen == exec_id && node_id == "script-1" => return true,
                    Ok(ServerEvent::ExecutionStopped { .. }) => return false,
                    Ok(_) => {}
                    Err(_) => return false,
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(!saw_target_start, "target should not run during pull_inputs");
    }

    #[tokio::test]
    async fn rerun_push_reuses_cached_sibling_inputs() {
        let (tx, _) = broadcast::channel(128);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut text = node(NodeKind::Text, "text-1");
        text.text = Some("hello\n".to_string());
        let mut script = node(NodeKind::Script, "script-1");
        script.script = Some("printf '%s %s\n' \"$1\" \"$(cat)\"".to_string());
        script.materialized_inputs.insert(
            "argv-1".to_string(),
            MaterializedValue {
                data_base64: encode_bytes(b"world\n"),
            },
        );
        let workspace = workspace(
            vec![text, script],
            vec![
                edge("edge-1", "text-1", PortKind::Stdout, "script-1", PortKind::Stdin, None),
                edge("edge-2", "text-1", PortKind::Stdout, "script-1", PortKind::Argv, Some(1)),
            ],
        );

        let exec_id = manager.run(workspace, "text-1".to_string(), ExecutionAction::RerunPush);
        assert_eq!(wait_for_finish(&mut rx, &exec_id, "script-1").await, Some(0));
    }

    #[tokio::test]
    async fn rerun_push_starts_downstream_before_source_finishes() {
        let (tx, _) = broadcast::channel(256);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut source = node(NodeKind::Script, "script-1");
        source.script = Some("printf 'one\n'; sleep 0.2; printf 'two\n'".to_string());
        let mut sink = node(NodeKind::Script, "script-2");
        sink.script = Some("cat >/dev/null".to_string());
        let workspace = workspace(
            vec![source, sink],
            vec![edge("edge-1", "script-1", PortKind::Stdout, "script-2", PortKind::Stdin, None)],
        );

        let exec_id = manager.run(workspace, "script-1".to_string(), ExecutionAction::RerunPush);
        let mut source_finished_at = None;
        let mut sink_started_at = None;
        timeout(Duration::from_secs(3), async {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecStarted { exec_id: seen, node_id, timestamp })
                        if seen == exec_id && node_id == "script-2" => {
                            sink_started_at = Some(timestamp);
                            if source_finished_at.is_some() {
                                break;
                            }
                        }
                    Ok(ServerEvent::ExecFinished { exec_id: seen, node_id, timestamp, .. })
                        if seen == exec_id && node_id == "script-1" => {
                            source_finished_at = Some(timestamp);
                            if sink_started_at.is_some() {
                                break;
                            }
                        }
                    Ok(ServerEvent::Error { message, .. }) => panic!("unexpected execution error: {message}"),
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await
        .expect("streaming rerun_push did not emit the expected events");

        assert!(sink_started_at.is_some(), "downstream node never started");
        assert!(source_finished_at.is_some(), "source node never finished");
        assert!(
            sink_started_at.unwrap() <= source_finished_at.unwrap(),
            "downstream should start before or while the source is still running"
        );
    }

    #[tokio::test]
    async fn failed_rerun_push_keeps_committed_values_unchanged() {
        let (tx, _) = broadcast::channel(256);
        let context = Arc::new(
            ExecutionContext::new(
                "exec-test".to_string(),
                workspace(
                    {
                        let mut source = node(NodeKind::Script, "script-1");
                        source.script = Some("printf 'fresh\n'; exit 1".to_string());
                        source.materialized_outputs.insert(
                            "stdout".to_string(),
                            MaterializedValue {
                                data_base64: encode_bytes(b"old-output\n"),
                            },
                        );
                        let mut sink = node(NodeKind::Script, "script-2");
                        sink.script = Some("cat >/dev/null".to_string());
                        sink.materialized_inputs.insert(
                            "stdin".to_string(),
                            MaterializedValue {
                                data_base64: encode_bytes(b"old-input\n"),
                            },
                        );
                        vec![source, sink]
                    },
                    vec![edge("edge-1", "script-1", PortKind::Stdout, "script-2", PortKind::Stdin, None)],
                ),
                ExecutionAction::RerunPush,
                tx,
                CancellationToken::new(),
            )
            .expect("context"),
        );

        context.clone().run("script-1".to_string()).await.expect("run");

        assert_eq!(
            context
                .materialized_outputs
                .lock()
                .get("script-1")
                .and_then(|ports| ports.get("stdout"))
                .cloned(),
            Some(b"old-output\n".to_vec())
        );
        assert_eq!(
            context
                .materialized_inputs
                .lock()
                .get("script-2")
                .and_then(|ports| ports.get("stdin"))
                .cloned(),
            Some(b"old-input\n".to_vec())
        );
    }

    #[tokio::test]
    async fn repush_uses_materialized_outputs_without_running_node() {
        let (tx, _) = broadcast::channel(128);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut text = node(NodeKind::Text, "text-1");
        text.materialized_outputs.insert(
            "stdout".to_string(),
            MaterializedValue {
                data_base64: encode_bytes(b"cached\n"),
            },
        );
        let workspace = workspace(vec![text], vec![]);

        let exec_id = manager.run(workspace, "text-1".to_string(), ExecutionAction::Repush);
        assert_eq!(wait_for_finish(&mut rx, &exec_id, "text-1").await, Some(0));
    }

    #[tokio::test]
    async fn materialized_empty_outputs_still_allow_repush() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut file = node(NodeKind::File, "file-1");
        file.materialized_outputs.insert(
            "stdout".to_string(),
            MaterializedValue {
                data_base64: encode_bytes(b""),
            },
        );
        file.materialized_outputs.insert(
            "stderr".to_string(),
            MaterializedValue {
                data_base64: encode_bytes(b""),
            },
        );
        let workspace = workspace(vec![file], vec![]);

        let exec_id = manager.run(workspace, "file-1".to_string(), ExecutionAction::Repush);
        assert_eq!(wait_for_finish(&mut rx, &exec_id, "file-1").await, Some(0));
    }
}
