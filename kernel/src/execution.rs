use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_recursion::async_recursion;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use parking_lot::Mutex;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{broadcast, mpsc},
    task::JoinHandle,
    time::sleep,
};
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};
use uuid::Uuid;

use crate::model::{
    default_cwd, BufferingMode, Edge, ExecutionMode, Node, NodeKind, PortKind, ServerEvent,
    Workspace,
};

fn node_label(node: &Node) -> &str {
    if node.title.trim().is_empty() {
        &node.id
    } else {
        &node.title
    }
}

fn node_accepts_argv(kind: &NodeKind) -> bool {
    matches!(kind, NodeKind::Script | NodeKind::AiScript | NodeKind::Exec)
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

    pub fn run(&self, workspace: Workspace, node_id: String, mode: ExecutionMode) -> String {
        let exec_id = Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let manager = self.clone();
        let node_for_handle = node_id.clone();
        let exec_id_for_task = exec_id.clone();
        let exec_id_for_remove = exec_id.clone();
        let cancel_for_task = cancel.clone();
        let task = tokio::spawn(async move {
            let mut context = match ExecutionContext::new(
                exec_id_for_task.clone(),
                workspace,
                mode,
                manager.broadcaster.clone(),
                cancel_for_task.clone(),
            ) {
                Ok(context) => context,
                Err(message) => {
                    let _ = manager.broadcaster.send(ServerEvent::Error {
                        message,
                        timestamp: now_ms(),
                    });
                    return;
                }
            };
            context.allowed_nodes = context.compute_allowed_nodes(&node_id);
            let context = Arc::new(context);

            if let Err(message) = context.run(node_id).await {
                let _ = manager.broadcaster.send(ServerEvent::Error {
                    message,
                    timestamp: now_ms(),
                });
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
    mode: ExecutionMode,
    broadcaster: broadcast::Sender<ServerEvent>,
    cancel: CancellationToken,
    nodes: HashMap<String, Node>,
    outgoing: HashMap<String, Vec<Edge>>,
    incoming: HashMap<String, Vec<Edge>>,
    allowed_nodes: HashSet<String>,
    edge_buffers: Arc<Mutex<HashMap<String, EdgeBufferState>>>,
    node_states: Arc<Mutex<HashMap<String, NodeRuntimeState>>>,
}

impl ExecutionContext {
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

    fn new(
        exec_id: String,
        mut workspace: Workspace,
        mode: ExecutionMode,
        broadcaster: broadcast::Sender<ServerEvent>,
        cancel: CancellationToken,
    ) -> Result<Self, String> {
        workspace
            .edges
            .retain(|edge| !is_legacy_unslotted_argv_edge(edge));

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
            outgoing
                .entry(edge.from.node_id.clone())
                .or_default()
                .push(edge.clone());
            incoming
                .entry(edge.to.node_id.clone())
                .or_default()
                .push(edge.clone());
        }

        for node in workspace.nodes.iter().filter(|node| {
            matches!(
                node.kind,
                NodeKind::Script
                    | NodeKind::AiScript
                    | NodeKind::Exec
                    | NodeKind::Passthru
                    | NodeKind::Html
                    | NodeKind::Text
            )
        }) {
            let edges = incoming.get(&node.id).cloned().unwrap_or_default();
            if node_accepts_argv(&node.kind) {
                let stdin_count = edges
                    .iter()
                    .filter(|edge| edge.to.port == PortKind::Stdin)
                    .count();
                if stdin_count > 1 {
                    return Err(format!(
                        "Node {} accepts at most one stdin wire.",
                        node_label(node),
                    ));
                }
                let mut argv_slots = HashSet::new();
                for edge in edges.iter().filter(|edge| edge.to.port == PortKind::Argv) {
                    let Some(slot) = edge.to.slot else {
                        return Err(format!(
                            "Node {} has an argv wire without a target slot.",
                            node_label(node),
                        ));
                    };
                    if !argv_slots.insert(slot) {
                        return Err(format!(
                            "Node {} has multiple argv wires targeting slot {}.",
                            node_label(node),
                            slot,
                        ));
                    }
                }
                if edges
                    .iter()
                    .any(|edge| edge.to.port != PortKind::Stdin && edge.to.port != PortKind::Argv)
                {
                    return Err(format!(
                        "Node {} has an unsupported input port wiring.",
                        node_label(node),
                    ));
                }
            } else {
                let count = edges.len();
                if count > 1 {
                    return Err(format!(
                        "Node {} has {} input wires. Use a merge node for multiple inputs.",
                        node_label(node),
                        count
                    ));
                }
                if edges.iter().any(|edge| edge.to.port == PortKind::Argv) {
                    return Err(format!(
                        "Node {} does not accept argv input.",
                        node_label(node),
                    ));
                }
            }
        }

        Ok(Self {
            exec_id,
            workspace,
            mode,
            broadcaster,
            cancel,
            nodes,
            outgoing,
            incoming,
            allowed_nodes: HashSet::new(),
            edge_buffers: Arc::new(Mutex::new(HashMap::new())),
            node_states: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    async fn run(self: Arc<Self>, node_id: String) -> Result<(), String> {
        if !self.nodes.contains_key(&node_id) {
            return Err(format!("Node {node_id} does not exist"));
        }

        if self.allowed_nodes.is_empty() {
            return Ok(());
        }

        let allowed_edges = self.allowed_edges();
        {
            let mut buffers = self.edge_buffers.lock();
            for edge in allowed_edges {
                buffers.insert(
                    edge.id.clone(),
                    EdgeBufferState {
                        edge,
                        buffered: Vec::new(),
                    },
                );
            }
        }

        if self.mode == ExecutionMode::Push {
            self.clone().start_node(node_id, Vec::new()).await?;
        } else {
            let roots = self.pull_roots();
            if roots.is_empty() {
                self.clone().start_node(node_id, Vec::new()).await?;
            } else {
                for root in roots {
                    self.clone().start_node(root, Vec::new()).await?;
                }
            }
        }

        loop {
            if self.cancel.is_cancelled() {
                break;
            }

            let active = self
                .node_states
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

    fn compute_allowed_nodes(&self, start_node_id: &str) -> HashSet<String> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::from([start_node_id.to_string()]);
        while let Some(node_id) = queue.pop_front() {
            if !visited.insert(node_id.clone()) {
                continue;
            }
            let edges = if self.mode == ExecutionMode::Push {
                self.outgoing.get(&node_id)
            } else {
                self.incoming.get(&node_id)
            };
            if let Some(edges) = edges {
                for edge in edges {
                    let next = if self.mode == ExecutionMode::Push {
                        edge.to.node_id.clone()
                    } else {
                        edge.from.node_id.clone()
                    };
                    queue.push_back(next);
                }
            }
        }
        visited
    }

    fn allowed_edges(&self) -> Vec<Edge> {
        self.workspace
            .edges
            .iter()
            .filter(|edge| {
                self.allowed_nodes.contains(&edge.from.node_id)
                    && self.allowed_nodes.contains(&edge.to.node_id)
                    && matches!(self.mode, ExecutionMode::Push | ExecutionMode::Pull)
            })
            .cloned()
            .collect()
    }

    fn pull_roots(&self) -> Vec<String> {
        self.allowed_nodes
            .iter()
            .filter(|node_id| {
                self.incoming
                    .get(*node_id)
                    .map(|edges| {
                        !edges
                            .iter()
                            .any(|edge| self.allowed_nodes.contains(&edge.from.node_id))
                    })
                    .unwrap_or(true)
            })
            .cloned()
            .collect()
    }

    fn has_allowed_incoming_port(&self, node_id: &str, port: PortKind) -> bool {
        self.incoming
            .get(node_id)
            .map(|edges| {
                edges.iter().any(|edge| {
                    self.allowed_nodes.contains(&edge.from.node_id) && edge.to.port == port
                })
            })
            .unwrap_or(false)
    }

    fn allowed_argv_edges(&self, node_id: &str) -> Vec<Edge> {
        self.incoming
            .get(node_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|edge| {
                self.allowed_nodes.contains(&edge.from.node_id) && edge.to.port == PortKind::Argv
            })
            .collect()
    }

    fn argv_inputs_ready(&self, node_id: &str) -> bool {
        let expected = self.allowed_argv_edges(node_id);
        if expected.is_empty() {
            return true;
        }
        let states = self.node_states.lock();
        let state = states.get(node_id).cloned().unwrap_or_default();
        expected
            .iter()
            .all(|edge| state.argv_completed.contains(&edge.id))
    }

    fn take_command_inputs(
        &self,
        node_id: &str,
        initial_input: Vec<u8>,
    ) -> (Vec<u8>, bool, Vec<String>) {
        let argv_edges = self.allowed_argv_edges(node_id);
        let mut states = self.node_states.lock();
        let state = states.entry(node_id.to_string()).or_default();
        let mut stdin = std::mem::take(&mut state.buffered_stdin);
        stdin.extend(initial_input);
        let close_after_start = state.buffered_stdin_closed;
        state.buffered_stdin_closed = false;
        let mut argv_edges = argv_edges;
        argv_edges.sort_by_key(|edge| edge.to.slot.unwrap_or(usize::MAX));
        let argv = argv_edges
            .into_iter()
            .map(|edge| {
                parse_argv_value(
                    state
                        .argv_inputs
                        .get(&edge.id)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                )
            })
            .collect();
        state.argv_inputs.clear();
        state.argv_completed.clear();
        state.scheduled = false;
        (stdin, close_after_start, argv)
    }

    #[async_recursion]
    async fn start_node(
        self: Arc<Self>,
        node_id: String,
        initial_input: Vec<u8>,
    ) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            return Ok(());
        }

        let node = self
            .nodes
            .get(&node_id)
            .cloned()
            .ok_or_else(|| format!("Unknown node {node_id}"))?;

        match node.kind {
            NodeKind::Text => {
                self.emit_started(&node.id);
                let data = node.text.unwrap_or_default().into_bytes();
                self.emit_port_activity(&node.id, PortKind::Stdout, data.len());
                self.clone()
                    .forward_output(&node.id, PortKind::Stdout, data)
                    .await?;
                self.emit_finished(&node.id, Some(0));
                self.clone().complete_node(&node.id).await?;
            }
            NodeKind::File => {
                self.clone().run_file_node(node).await?;
            }
            NodeKind::Passthru => {
                self.emit_started(&node.id);
                if !initial_input.is_empty() {
                    self.emit_port_activity(&node.id, PortKind::Stdout, initial_input.len());
                    self.clone()
                        .forward_output(&node.id, PortKind::Stdout, initial_input)
                        .await?;
                }
                self.emit_finished(&node.id, Some(0));
                self.clone().complete_node(&node.id).await?;
            }
            NodeKind::Html => {
                self.emit_started(&node.id);
                self.emit_finished(&node.id, Some(0));
                self.clone().complete_node(&node.id).await?;
            }
            NodeKind::Script | NodeKind::AiScript => {
                if self.has_allowed_incoming_port(&node.id, PortKind::Argv)
                    && !self.argv_inputs_ready(&node.id)
                {
                    if !initial_input.is_empty() {
                        let mut states = self.node_states.lock();
                        let state = states.entry(node.id.clone()).or_default();
                        state.buffered_stdin.extend_from_slice(&initial_input);
                        state.scheduled = true;
                    }
                    return Ok(());
                }
                let (initial_input, close_after_start, argv) =
                    self.take_command_inputs(&node.id, initial_input);
                self.clone()
                    .run_script_node(node, initial_input, close_after_start, argv)
                    .await?;
            }
            NodeKind::Exec => {
                if self.has_allowed_incoming_port(&node.id, PortKind::Argv)
                    && !self.argv_inputs_ready(&node.id)
                {
                    if !initial_input.is_empty() {
                        let mut states = self.node_states.lock();
                        let state = states.entry(node.id.clone()).or_default();
                        state.buffered_stdin.extend_from_slice(&initial_input);
                        state.scheduled = true;
                    }
                    return Ok(());
                }
                let (initial_input, close_after_start, argv) =
                    self.take_command_inputs(&node.id, initial_input);
                self.clone()
                    .run_exec_node(node, initial_input, close_after_start, argv)
                    .await?;
            }
        }
        Ok(())
    }

    async fn run_script_node(
        self: Arc<Self>,
        node: Node,
        initial_input: Vec<u8>,
        close_after_start: bool,
        argv: Vec<String>,
    ) -> Result<(), String> {
        let mut command = Command::new(node.shell_value());
        command
            .arg("-c")
            .arg(node.script.clone().unwrap_or_default())
            .arg("--");
        for arg in argv {
            command.arg(arg);
        }
        self.spawn_command_node(node, initial_input, close_after_start, command)
            .await
    }

    async fn run_exec_node(
        self: Arc<Self>,
        node: Node,
        initial_input: Vec<u8>,
        close_after_start: bool,
        argv: Vec<String>,
    ) -> Result<(), String> {
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
        self.spawn_command_node(node, initial_input, close_after_start, command)
            .await
    }

    async fn run_file_node(self: Arc<Self>, node: Node) -> Result<(), String> {
        self.emit_started(&node.id);
        let path = node
            .path
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{} is missing a file path", node_label(&node)))?;
        let resolved_path = self.resolve_workspace_path(&path);
        match tokio::fs::read(&resolved_path).await {
            Ok(data) => {
                self.emit_port_activity(&node.id, PortKind::Stdout, data.len());
                self.clone()
                    .forward_output(&node.id, PortKind::Stdout, data)
                    .await?;
                self.emit_finished(&node.id, Some(0));
            }
            Err(error) => {
                let message = format!("file {}: {error}\n", path).into_bytes();
                self.emit_port_activity(&node.id, PortKind::Stderr, message.len());
                self.clone()
                    .forward_output(&node.id, PortKind::Stderr, message)
                    .await?;
                self.emit_finished(&node.id, Some(1));
            }
        }
        self.clone().complete_node(&node.id).await?;
        Ok(())
    }

    async fn spawn_command_node(
        self: Arc<Self>,
        node: Node,
        initial_input: Vec<u8>,
        close_after_start: bool,
        mut command: Command,
    ) -> Result<(), String> {
        let mut states = self.node_states.lock();
        let state = states.entry(node.id.clone()).or_default();
        if state.running {
            if let Some(writer) = &state.stdin_writer {
                if !initial_input.is_empty() {
                    let _ = writer.send(StdinMessage::Chunk(initial_input));
                }
            }
            return Ok(());
        }
        state.running = true;
        state.scheduled = false;
        drop(states);

        self.emit_started(&node.id);

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
        self.node_states
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
        if close_after_start || !self.has_allowed_incoming_port(&node.id, PortKind::Stdin) {
            let _ = stdin_tx.send(StdinMessage::Close);
        }

        let stdout_context = self.clone();
        let stdout_node = node.id.clone();
        let stdout_task = tokio::spawn(async move {
            stdout_context
                .read_output(stdout_node, PortKind::Stdout, stdout)
                .await;
        });

        let stderr_context = self.clone();
        let stderr_node = node.id.clone();
        let stderr_task = tokio::spawn(async move {
            stderr_context
                .read_output(stderr_node, PortKind::Stderr, stderr)
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
                            warn!("child wait failed: {error}");
                            None
                        }
                    }
                }
                _ = cancel.cancelled() => {
                    let _ = child.kill().await;
                    None
                }
            };
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            context.emit_finished(&node.id, exit_code);
            context.complete_node(&node.id).await.ok();
        });

        Ok(())
    }

    async fn read_output<R>(self: Arc<Self>, node_id: String, port: PortKind, mut reader: R)
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
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
                    self.emit_port_activity(&node_id, port, chunk.len());
                    if let Err(message) = self.clone().forward_output(&node_id, port, chunk).await {
                        error!("{message}");
                    }
                }
                Err(error) => {
                    error!("Failed to read output for {node_id}: {error}");
                    break;
                }
            }
        }
    }

    async fn forward_output(
        self: Arc<Self>,
        from_node_id: &str,
        port: PortKind,
        chunk: Vec<u8>,
    ) -> Result<(), String> {
        if !chunk.is_empty() {
            self.emit_node_output(from_node_id, port, &chunk);
        }
        let edges = self
            .outgoing
            .get(from_node_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|edge| self.allowed_nodes.contains(&edge.to.node_id) && edge.from.port == port)
            .collect::<Vec<_>>();

        for edge in edges {
            let flushed = {
                let mut buffers = self.edge_buffers.lock();
                let state = buffers
                    .get_mut(&edge.id)
                    .ok_or_else(|| format!("Missing buffer state for edge {}", edge.id))?;
                state.accept(chunk.clone())
            };
            for payload in flushed {
                self.emit_stream_chunk(&edge, port, &payload);
                self.clone()
                    .deliver_to_target(&edge, payload, false)
                    .await?;
            }
        }
        Ok(())
    }

    #[async_recursion]
    async fn deliver_to_target(
        self: Arc<Self>,
        edge: &Edge,
        payload: Vec<u8>,
        completed: bool,
    ) -> Result<(), String> {
        let target = self
            .nodes
            .get(&edge.to.node_id)
            .cloned()
            .ok_or_else(|| format!("Unknown target node {}", edge.to.node_id))?;

        sleep(Duration::from_millis(250)).await;

        if !payload.is_empty() {
            self.emit_port_activity(&target.id, edge.to.port, payload.len());
        }

        match target.kind {
            NodeKind::Passthru => {
                let started = {
                    let mut states = self.node_states.lock();
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
                if !payload.is_empty() {
                    self.emit_port_activity(&target.id, PortKind::Stdout, payload.len());
                    self.clone()
                        .forward_output(&target.id, PortKind::Stdout, payload)
                        .await?;
                }
                if completed {
                    self.emit_finished(&target.id, Some(0));
                    self.clone().complete_node(&target.id).await?;
                }
            }
            NodeKind::Html => {
                let started = {
                    let mut states = self.node_states.lock();
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
                    self.emit_finished(&target.id, Some(0));
                    self.clone().complete_node(&target.id).await?;
                }
            }
            NodeKind::Script | NodeKind::AiScript | NodeKind::Exec => match edge.to.port {
                PortKind::Argv => {
                    {
                        let mut states = self.node_states.lock();
                        let state = states.entry(target.id.clone()).or_default();
                        if !payload.is_empty() {
                            state
                                .argv_inputs
                                .entry(edge.id.clone())
                                .or_default()
                                .extend_from_slice(&payload);
                        }
                        if completed {
                            state.argv_completed.insert(edge.id.clone());
                        }
                    }
                    if completed && self.argv_inputs_ready(&target.id) {
                        self.clone()
                            .start_node(target.id.clone(), Vec::new())
                            .await?;
                    }
                }
                PortKind::Stdin => {
                    let waiting_for_argv = self
                        .has_allowed_incoming_port(&target.id, PortKind::Argv)
                        && !self.argv_inputs_ready(&target.id);
                    if waiting_for_argv {
                        let mut states = self.node_states.lock();
                        let state = states.entry(target.id.clone()).or_default();
                        if !payload.is_empty() {
                            state.buffered_stdin.extend_from_slice(&payload);
                        }
                        if completed {
                            state.buffered_stdin_closed = true;
                        }
                        state.scheduled = true;
                    } else {
                        let existing_writer = self
                            .node_states
                            .lock()
                            .get(&target.id)
                            .and_then(|state| state.stdin_writer.clone());
                        if completed {
                            if let Some(writer) = existing_writer {
                                if !payload.is_empty() {
                                    let _ = writer.send(StdinMessage::Chunk(payload));
                                }
                                let _ = writer.send(StdinMessage::Close);
                            } else {
                                self.clone().start_node(target.id.clone(), payload).await?;
                                let writer = self
                                    .node_states
                                    .lock()
                                    .get(&target.id)
                                    .and_then(|state| state.stdin_writer.clone());
                                if let Some(writer) = writer {
                                    let _ = writer.send(StdinMessage::Close);
                                }
                            }
                        } else {
                            let running = self
                                .node_states
                                .lock()
                                .get(&target.id)
                                .map(|state| state.running)
                                .unwrap_or(false);
                            if running {
                                if let Some(writer) = existing_writer {
                                    let _ = writer.send(StdinMessage::Chunk(payload));
                                }
                            } else {
                                self.clone().start_node(target.id.clone(), payload).await?;
                            }
                        }
                    }
                }
                _ => {}
            },
            NodeKind::Text | NodeKind::File => {}
        }
        Ok(())
    }

    async fn complete_node(self: Arc<Self>, node_id: &str) -> Result<(), String> {
        {
            let mut states = self.node_states.lock();
            let state = states.entry(node_id.to_string()).or_default();
            state.running = false;
            state.stdin_writer = None;
        }

        let edges = self
            .outgoing
            .get(node_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|edge| self.allowed_nodes.contains(&edge.to.node_id))
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
            for payload in flushed {
                self.emit_stream_chunk(&edge, edge.from.port, &payload);
                self.clone().deliver_to_target(&edge, payload, true).await?;
            }
            if !delivered_payload {
                self.clone()
                    .deliver_to_target(&edge, Vec::new(), true)
                    .await?;
            }
        }
        Ok(())
    }

    fn emit_node_output(&self, node_id: &str, port: PortKind, payload: &[u8]) {
        let _ = self.broadcaster.send(ServerEvent::NodeOutput {
            node_id: node_id.to_string(),
            port,
            data_base64: BASE64.encode(payload),
            timestamp: now_ms(),
        });
    }

    fn emit_stream_chunk(&self, edge: &Edge, port: PortKind, payload: &[u8]) {
        let _ = self.broadcaster.send(ServerEvent::StreamChunk {
            edge_id: edge.id.clone(),
            from_node_id: edge.from.node_id.clone(),
            to_node_id: edge.to.node_id.clone(),
            port,
            data_base64: BASE64.encode(payload),
            timestamp: now_ms(),
        });
    }

    fn emit_port_activity(&self, node_id: &str, port: PortKind, bytes: usize) {
        let _ = self.broadcaster.send(ServerEvent::PortActivity {
            node_id: node_id.to_string(),
            port,
            bytes,
            timestamp: now_ms(),
        });
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
}

#[derive(Default, Clone)]
struct NodeRuntimeState {
    running: bool,
    scheduled: bool,
    stdin_writer: Option<mpsc::UnboundedSender<StdinMessage>>,
    buffered_stdin: Vec<u8>,
    buffered_stdin_closed: bool,
    argv_inputs: HashMap<String, Vec<u8>>,
    argv_completed: HashSet<String>,
}

struct EdgeBufferState {
    edge: Edge,
    buffered: Vec<u8>,
}

impl EdgeBufferState {
    fn accept(&mut self, chunk: Vec<u8>) -> Vec<Vec<u8>> {
        match self.edge.buffering {
            BufferingMode::Unbuffered => vec![chunk],
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
                    flushed.push(self.buffered.drain(..end).collect());
                }
                flushed
            }
        }
    }

    fn finish(&mut self) -> Vec<Vec<u8>> {
        if self.buffered.is_empty() {
            return Vec::new();
        }
        vec![std::mem::take(&mut self.buffered)]
    }
}

#[derive(Clone)]
enum StdinMessage {
    Chunk(Vec<u8>),
    Close,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::{sync::broadcast, time::timeout};
    use tokio_util::sync::CancellationToken;

    use super::{EdgeBufferState, ExecutionContext, ExecutionManager};
    use crate::model::{
        default_cwd, BufferingMode, Edge, ExecutionMode, Node, NodeKind, PortKind, PortRef,
        Position, ServerEvent, Size, Workspace, WorkspaceUi,
    };

    fn edge(mode: BufferingMode) -> Edge {
        Edge {
            id: "edge".to_string(),
            from: PortRef {
                node_id: "a".to_string(),
                port: PortKind::Stdout,
                slot: None,
            },
            to: PortRef {
                node_id: "b".to_string(),
                port: PortKind::Stdin,
                slot: None,
            },
            buffering: mode,
        }
    }

    #[test]
    fn legacy_unslotted_argv_edges_are_ignored() {
        let workspace = Workspace {
            id: "test".to_string(),
            name: "test".to_string(),
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes: vec![
                Node {
                    id: "text-1".to_string(),
                    kind: NodeKind::Text,
                    title: "".to_string(),
                    comment: "".to_string(),
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
                    text: Some(
                        "hello
"
                        .to_string(),
                    ),
                    auto_run: None,
                    ui_state: Default::default(),
                },
                Node {
                    id: "script-1".to_string(),
                    kind: NodeKind::Script,
                    title: "".to_string(),
                    comment: "".to_string(),
                    position: Position { x: 240.0, y: 0.0 },
                    size: Size {
                        width: 200.0,
                        height: 120.0,
                    },
                    shell: Some("bash".to_string()),
                    script: Some("true".to_string()),
                    description: None,
                    include_sample_inputs: None,
                    path: None,
                    args: None,
                    text: None,
                    auto_run: None,
                    ui_state: Default::default(),
                },
            ],
            edges: vec![Edge {
                id: "legacy-argv".to_string(),
                from: PortRef {
                    node_id: "text-1".to_string(),
                    port: PortKind::Stdout,
                    slot: None,
                },
                to: PortRef {
                    node_id: "script-1".to_string(),
                    port: PortKind::Argv,
                    slot: None,
                },
                buffering: BufferingMode::LineOr1024,
            }],
            ui: WorkspaceUi::default(),
        };

        let (tx, _) = broadcast::channel(16);
        let context = ExecutionContext::new(
            "exec".to_string(),
            workspace,
            ExecutionMode::Push,
            tx,
            CancellationToken::new(),
        )
        .expect("execution context should ignore legacy argv edges");

        assert!(context.workspace.edges.is_empty());
        assert!(context.incoming.get("script-1").is_none());
    }

    #[test]
    fn line_or_1024_flushes_on_newline() {
        let mut state = EdgeBufferState {
            edge: edge(BufferingMode::LineOr1024),
            buffered: Vec::new(),
        };
        let flushed = state.accept(b"hello\nworld".to_vec());
        assert_eq!(flushed, vec![b"hello\n".to_vec()]);
        assert_eq!(state.finish(), vec![b"world".to_vec()]);
    }

    #[tokio::test]
    async fn argv_edges_feed_script_positional_args() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let workspace = Workspace {
            id: "test".to_string(),
            name: "test".to_string(),
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes: vec![
                Node {
                    id: "text-1".to_string(),
                    kind: NodeKind::Text,
                    title: "".to_string(),
                    comment: "".to_string(),
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
                    text: Some(
                        "hello
"
                        .to_string(),
                    ),
                    auto_run: None,
                    ui_state: Default::default(),
                },
                Node {
                    id: "text-2".to_string(),
                    kind: NodeKind::Text,
                    title: "".to_string(),
                    comment: "".to_string(),
                    position: Position { x: 0.0, y: 140.0 },
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
                    text: Some(
                        "world
"
                        .to_string(),
                    ),
                    auto_run: None,
                    ui_state: Default::default(),
                },
                Node {
                    id: "script-1".to_string(),
                    kind: NodeKind::Script,
                    title: "".to_string(),
                    comment: "".to_string(),
                    position: Position { x: 240.0, y: 0.0 },
                    size: Size {
                        width: 200.0,
                        height: 120.0,
                    },
                    shell: Some("bash".to_string()),
                    script: Some(r#"test "$1" = hello && test "$2" = world"#.to_string()),
                    description: None,
                    include_sample_inputs: None,
                    path: None,
                    args: None,
                    text: None,
                    auto_run: None,
                    ui_state: Default::default(),
                },
            ],
            edges: vec![
                Edge {
                    id: "edge-1".to_string(),
                    from: PortRef {
                        node_id: "text-1".to_string(),
                        port: PortKind::Stdout,
                        slot: None,
                    },
                    to: PortRef {
                        node_id: "script-1".to_string(),
                        port: PortKind::Argv,
                        slot: Some(1),
                    },
                    buffering: BufferingMode::LineOr1024,
                },
                Edge {
                    id: "edge-2".to_string(),
                    from: PortRef {
                        node_id: "text-2".to_string(),
                        port: PortKind::Stdout,
                        slot: None,
                    },
                    to: PortRef {
                        node_id: "script-1".to_string(),
                        port: PortKind::Argv,
                        slot: Some(2),
                    },
                    buffering: BufferingMode::LineOr1024,
                },
            ],
            ui: WorkspaceUi::default(),
        };

        let exec_id = manager.run(workspace, "script-1".to_string(), ExecutionMode::Pull);
        let exit_code = timeout(Duration::from_secs(2), async move {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecFinished {
                        exec_id: seen_exec_id,
                        node_id,
                        exit_code,
                        ..
                    }) if seen_exec_id == exec_id && node_id == "script-1" => return exit_code,
                    Ok(ServerEvent::Error { message, .. }) => {
                        panic!("unexpected execution error: {message}");
                    }
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await
        .expect("script node never completed");

        assert_eq!(
            exit_code,
            Some(0),
            "script did not receive slotted argv input"
        );
    }

    #[tokio::test]
        async fn ai_script_nodes_execute_like_script() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let workspace = Workspace {
            id: "test".to_string(),
            name: "test".to_string(),
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes: vec![Node {
                id: "ai-script-1".to_string(),
                kind: NodeKind::AiScript,
                title: "".to_string(),
                comment: "".to_string(),
                position: Position { x: 0.0, y: 0.0 },
                size: Size {
                    width: 200.0,
                    height: 120.0,
                },
                shell: Some("bash".to_string()),
                script: Some("printf 'ok'".to_string()),
                description: Some("print ok".to_string()),
                include_sample_inputs: Some(false),
                path: None,
                args: None,
                text: None,
                auto_run: None,
                ui_state: Default::default(),
            }],
            edges: vec![],
            ui: WorkspaceUi::default(),
        };

        let exec_id = manager.run(workspace, "ai-script-1".to_string(), ExecutionMode::Push);
        let exit_code = tokio::time::timeout(Duration::from_secs(2), async move {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecFinished {
                        exec_id: seen_exec_id,
                        node_id,
                        exit_code,
                        ..
                    }) if seen_exec_id == exec_id && node_id == "ai-script-1" => return exit_code,
                    Ok(_) => continue,
                    Err(error) => panic!("execution event stream closed unexpectedly: {error}"),
                }
            }
        })
        .await
        .expect("ai_script node never completed");

        assert_eq!(exit_code, Some(0));
    }

    #[tokio::test]
    async fn script_nodes_run_in_workspace_cwd() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let cwd = temp_dir.path().to_string_lossy().to_string();
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let workspace = Workspace {
            id: "test".to_string(),
            name: "test".to_string(),
            cwd: cwd.clone(),
            openai_api_key: Some(String::new()),
            nodes: vec![Node {
                id: "script-1".to_string(),
                kind: NodeKind::Script,
                title: "".to_string(),
                comment: "".to_string(),
                position: Position { x: 0.0, y: 0.0 },
                size: Size {
                    width: 200.0,
                    height: 120.0,
                },
                shell: Some("bash".to_string()),
                script: Some(format!(r#"test "$(pwd)" = "{}""#, cwd)),
                description: None,
                include_sample_inputs: None,
                path: None,
                args: None,
                text: None,
                auto_run: None,
                ui_state: Default::default(),
            }],
            edges: vec![],
            ui: WorkspaceUi::default(),
        };

        let exec_id = manager.run(workspace, "script-1".to_string(), ExecutionMode::Push);
        let exit_code = timeout(Duration::from_secs(2), async move {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecFinished {
                        exec_id: seen_exec_id,
                        node_id,
                        exit_code,
                        ..
                    }) if seen_exec_id == exec_id && node_id == "script-1" => return exit_code,
                    Ok(ServerEvent::Error { message, .. }) => {
                        panic!("unexpected execution error: {message}");
                    }
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await
        .expect("script node never completed");

        assert_eq!(exit_code, Some(0), "script did not inherit workspace cwd");
    }

    #[tokio::test]
    async fn passthru_nodes_forward_input_to_stdout() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let workspace = Workspace {
            id: "test".to_string(),
            name: "test".to_string(),
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes: vec![
                Node {
                    id: "text-1".to_string(),
                    kind: NodeKind::Text,
                    title: "".to_string(),
                    comment: "".to_string(),
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
                    text: Some(
                        "hello
"
                        .to_string(),
                    ),
                    auto_run: None,
                    ui_state: Default::default(),
                },
                Node {
                    id: "passthru-1".to_string(),
                    kind: NodeKind::Passthru,
                    title: "".to_string(),
                    comment: "".to_string(),
                    position: Position { x: 240.0, y: 0.0 },
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
                    auto_run: None,
                    ui_state: Default::default(),
                },
                Node {
                    id: "script-1".to_string(),
                    kind: NodeKind::Script,
                    title: "".to_string(),
                    comment: "".to_string(),
                    position: Position { x: 480.0, y: 0.0 },
                    size: Size {
                        width: 200.0,
                        height: 120.0,
                    },
                    shell: Some("bash".to_string()),
                    script: Some("grep h >/dev/null; echo done >&2".to_string()),
                    description: None,
                    include_sample_inputs: None,
                    path: None,
                    args: None,
                    text: None,
                    auto_run: None,
                    ui_state: Default::default(),
                },
            ],
            edges: vec![
                Edge {
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
                },
                Edge {
                    id: "edge-2".to_string(),
                    from: PortRef {
                        node_id: "passthru-1".to_string(),
                        port: PortKind::Stdout,
                        slot: None,
                    },
                    to: PortRef {
                        node_id: "script-1".to_string(),
                        port: PortKind::Stdin,
                        slot: None,
                    },
                    buffering: BufferingMode::LineOr1024,
                },
            ],
            ui: WorkspaceUi::default(),
        };

        let exec_id = manager.run(workspace, "text-1".to_string(), ExecutionMode::Push);
        let finished = timeout(Duration::from_secs(3), async move {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecFinished {
                        exec_id: seen_exec_id,
                        node_id,
                        ..
                    }) if seen_exec_id == exec_id && node_id == "script-1" => return,
                    Ok(ServerEvent::Error { message, .. }) => {
                        panic!("unexpected execution error: {message}");
                    }
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await;

        assert!(finished.is_ok(), "passthru node did not forward downstream");
    }

    #[tokio::test]
    async fn fully_flushed_edges_still_close_downstream_stdin() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let workspace = Workspace {
            id: "test".to_string(),
            name: "test".to_string(),
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes: vec![
                Node {
                    id: "text-1".to_string(),
                    kind: NodeKind::Text,
                    title: "".to_string(),
                    comment: "".to_string(),
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
                    text: Some(
                        "hello
"
                        .to_string(),
                    ),
                    auto_run: None,
                    ui_state: Default::default(),
                },
                Node {
                    id: "script-1".to_string(),
                    kind: NodeKind::Script,
                    title: "".to_string(),
                    comment: "".to_string(),
                    position: Position { x: 240.0, y: 0.0 },
                    size: Size {
                        width: 200.0,
                        height: 120.0,
                    },
                    shell: Some("bash".to_string()),
                    script: Some("grep h >/dev/null; echo done >&2".to_string()),
                    description: None,
                    include_sample_inputs: None,
                    path: None,
                    args: None,
                    text: None,
                    auto_run: None,
                    ui_state: Default::default(),
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
                    node_id: "script-1".to_string(),
                    port: PortKind::Stdin,
                    slot: None,
                },
                buffering: BufferingMode::LineOr1024,
            }],
            ui: WorkspaceUi::default(),
        };

        let exec_id = manager.run(workspace, "text-1".to_string(), ExecutionMode::Push);
        let finished = timeout(Duration::from_secs(2), async move {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecFinished {
                        exec_id: seen_exec_id,
                        node_id,
                        ..
                    }) if seen_exec_id == exec_id && node_id == "script-1" => return,
                    Ok(ServerEvent::Error { message, .. }) => {
                        panic!("unexpected execution error: {message}");
                    }
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await;

        assert!(finished.is_ok(), "downstream script never observed EOF");
    }

    #[tokio::test]
    async fn stdout_previews_emit_without_downstream_edges() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let workspace = Workspace {
            id: "test".to_string(),
            name: "test".to_string(),
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes: vec![Node {
                id: "text-1".to_string(),
                kind: NodeKind::Text,
                title: "".to_string(),
                comment: "".to_string(),
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
                text: Some(
                    "hello
"
                    .to_string(),
                ),
                auto_run: None,
                ui_state: Default::default(),
            }],
            edges: vec![],
            ui: WorkspaceUi::default(),
        };

        let exec_id = manager.run(workspace, "text-1".to_string(), ExecutionMode::Push);
        let saw_output = timeout(Duration::from_secs(2), async move {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::NodeOutput { node_id, port, .. })
                        if node_id == "text-1" && port == PortKind::Stdout =>
                    {
                        return true
                    }
                    Ok(ServerEvent::ExecFinished {
                        exec_id: seen_exec_id,
                        ..
                    }) if seen_exec_id == exec_id => return false,
                    Ok(ServerEvent::Error { message, .. }) => {
                        panic!("unexpected execution error: {message}");
                    }
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await
        .expect("text node never completed");

        assert!(
            saw_output,
            "node output event was not emitted for detached stdout"
        );
    }
}
