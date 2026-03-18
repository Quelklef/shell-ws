use std::{
    collections::{HashMap, HashSet, VecDeque},
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
    BufferingMode, Edge, ExecutionMode, Node, NodeKind, PortKind, ServerEvent, Workspace,
};

fn node_label(node: &Node) -> &str {
    if node.title.trim().is_empty() {
        &node.id
    } else {
        &node.title
    }
}

fn node_accepts_argv(kind: &NodeKind) -> bool {
    matches!(kind, NodeKind::Script | NodeKind::Exec)
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
    fn new(
        exec_id: String,
        workspace: Workspace,
        mode: ExecutionMode,
        broadcaster: broadcast::Sender<ServerEvent>,
        cancel: CancellationToken,
    ) -> Result<Self, String> {
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
                    | NodeKind::Exec
                    | NodeKind::Display
                    | NodeKind::Text
                    | NodeKind::Tee
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
                if edges.iter().any(|edge| {
                    edge.to.port != PortKind::Stdin && edge.to.port != PortKind::Argv
                }) {
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
            .map(|edge| parse_argv_value(state.argv_inputs.get(&edge.id).map(Vec::as_slice).unwrap_or(&[])))
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
            NodeKind::Cat => {
                self.clone().run_cat_node(node).await?;
            }
            NodeKind::Display => {
                self.emit_started(&node.id);
                if !initial_input.is_empty() {
                    self.update_display(&node.id, initial_input.clone(), false);
                    self.emit_port_activity(&node.id, PortKind::Stdout, initial_input.len());
                    self.clone()
                        .forward_output(&node.id, PortKind::Stdout, initial_input)
                        .await?;
                }
                self.update_display(&node.id, Vec::new(), true);
                self.emit_finished(&node.id, Some(0));
                self.clone().complete_node(&node.id).await?;
            }
            NodeKind::Tee => {
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
            NodeKind::MergeConcat
            | NodeKind::MergeLine
            | NodeKind::MergeByte
            | NodeKind::MergeShell => {
                self.clone().run_merge_node(node, initial_input).await?;
            }
            NodeKind::Script => {
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

    async fn run_cat_node(self: Arc<Self>, node: Node) -> Result<(), String> {
        self.emit_started(&node.id);
        let path = node
            .path
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{} is missing a file path", node_label(&node)))?;
        match tokio::fs::read(&path).await {
            Ok(data) => {
                self.emit_port_activity(&node.id, PortKind::Stdout, data.len());
                self.clone()
                    .forward_output(&node.id, PortKind::Stdout, data)
                    .await?;
                self.emit_finished(&node.id, Some(0));
            }
            Err(error) => {
                let message = format!(
                    "cat {}: {error}
",
                    path
                )
                .into_bytes();
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

    async fn run_merge_node(
        self: Arc<Self>,
        node: Node,
        _initial_input: Vec<u8>,
    ) -> Result<(), String> {
        let incoming = self
            .incoming
            .get(&node.id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|edge| self.allowed_nodes.contains(&edge.from.node_id))
            .collect::<Vec<_>>();

        if incoming.is_empty() {
            self.emit_started(&node.id);
            self.emit_finished(&node.id, Some(0));
            self.clone().complete_node(&node.id).await?;
            return Ok(());
        }

        let maybe_inputs = {
            let states = self.node_states.lock();
            let state = states.get(&node.id).cloned().unwrap_or_default();
            incoming
                .iter()
                .map(|edge| state.merge_inputs.get(&edge.id).cloned())
                .collect::<Option<Vec<_>>>()
        };

        let Some(inputs) = maybe_inputs else {
            return Ok(());
        };

        self.emit_started(&node.id);
        let output = match node.kind {
            NodeKind::MergeConcat => inputs.concat(),
            NodeKind::MergeLine => interleave_lines(&inputs),
            NodeKind::MergeByte => interleave_bytes(&inputs),
            NodeKind::MergeShell => self.run_shell_merge(&node, inputs).await?,
            _ => Vec::new(),
        };
        self.emit_port_activity(&node.id, PortKind::Stdout, output.len());
        self.clone()
            .forward_output(&node.id, PortKind::Stdout, output)
            .await?;
        self.emit_finished(&node.id, Some(0));
        self.clone().complete_node(&node.id).await?;
        self.node_states
            .lock()
            .entry(node.id)
            .or_default()
            .merge_inputs
            .clear();
        Ok(())
    }

    async fn run_shell_merge(&self, node: &Node, inputs: Vec<Vec<u8>>) -> Result<Vec<u8>, String> {
        let temp_dir = std::env::temp_dir().join(format!("shell-ws-merge-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir)
            .await
            .map_err(|error| format!("Failed to create temp dir: {error}"))?;

        let mut args = Vec::new();
        for (index, input) in inputs.iter().enumerate() {
            let path = temp_dir.join(format!("input-{index}.txt"));
            tokio::fs::write(&path, input)
                .await
                .map_err(|error| format!("Failed to write merge input: {error}"))?;
            args.push(path);
        }

        let mut command = Command::new(node.shell_value());
        let mut script = node.script.clone().unwrap_or_default();
        if !args.is_empty() {
            script.push(' ');
            script.push_str(
                &args
                    .iter()
                    .map(|path| path.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
        command.arg("-c").arg(script);
        let output = command
            .output()
            .await
            .map_err(|error| format!("Failed to run shell merge {}: {error}", node_label(node)))?;

        let _ = tokio::fs::remove_dir_all(temp_dir).await;
        Ok(output.stdout)
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
            NodeKind::Display => {
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
                    self.update_display(&target.id, payload.clone(), false);
                    self.emit_port_activity(&target.id, PortKind::Stdout, payload.len());
                    self.clone()
                        .forward_output(&target.id, PortKind::Stdout, payload)
                        .await?;
                }
                if completed {
                    self.update_display(&target.id, Vec::new(), true);
                    self.emit_finished(&target.id, Some(0));
                    self.clone().complete_node(&target.id).await?;
                }
            }
            NodeKind::Script | NodeKind::Exec => {
                match edge.to.port {
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
                            self.clone().start_node(target.id.clone(), Vec::new()).await?;
                        }
                    }
                    PortKind::Stdin => {
                        let waiting_for_argv = self.has_allowed_incoming_port(&target.id, PortKind::Argv)
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
                }
            }
            NodeKind::MergeConcat
            | NodeKind::MergeLine
            | NodeKind::MergeByte
            | NodeKind::MergeShell => {
                {
                    let mut states = self.node_states.lock();
                    let state = states.entry(target.id.clone()).or_default();
                    let entry = state.merge_inputs.entry(edge.id.clone()).or_default();
                    entry.extend_from_slice(&payload);
                }
                if completed {
                    sleep(Duration::from_millis(250)).await;
                    self.clone().run_merge_node(target, Vec::new()).await?;
                }
            }
            NodeKind::Tee => {
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
            NodeKind::Text | NodeKind::Cat => {}
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

    fn update_display(&self, node_id: &str, payload: Vec<u8>, completed: bool) {
        let _ = self.broadcaster.send(ServerEvent::DisplayUpdate {
            node_id: node_id.to_string(),
            data_base64: BASE64.encode(payload),
            timestamp: now_ms(),
            completed,
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
    merge_inputs: HashMap<String, Vec<u8>>,
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

fn interleave_lines(inputs: &[Vec<u8>]) -> Vec<u8> {
    let mut lines = inputs
        .iter()
        .map(|input| {
            String::from_utf8_lossy(input)
                .lines()
                .map(|line| format!("{line}\n").into_bytes())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    let mut output = Vec::new();
    loop {
        let mut changed = false;
        for source in &mut lines {
            if !source.is_empty() {
                output.extend(source.remove(0));
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    output
}

fn interleave_bytes(inputs: &[Vec<u8>]) -> Vec<u8> {
    let max_len = inputs.iter().map(Vec::len).max().unwrap_or(0);
    let mut output = Vec::with_capacity(inputs.iter().map(Vec::len).sum());
    for index in 0..max_len {
        for input in inputs {
            if let Some(byte) = input.get(index) {
                output.push(*byte);
            }
        }
    }
    output
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

    use super::{interleave_bytes, interleave_lines, EdgeBufferState, ExecutionManager};
    use crate::model::{
        BufferingMode, Edge, ExecutionMode, Node, NodeKind, PortKind, PortRef, Position,
        ServerEvent, Size, Workspace, WorkspaceUi,
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
                    path: None,
                    args: None,
                    text: Some("hello
".to_string()),
                    auto_run: None,
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
                    path: None,
                    args: None,
                    text: Some("world
".to_string()),
                    auto_run: None,
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
                    path: None,
                    args: None,
                    text: None,
                    auto_run: None,
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

        assert_eq!(exit_code, Some(0), "script did not receive slotted argv input");
    }

    #[tokio::test]
    async fn display_nodes_forward_input_to_stdout() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let workspace = Workspace {
            id: "test".to_string(),
            name: "test".to_string(),
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
                    path: None,
                    args: None,
                    text: Some("hello
".to_string()),
                    auto_run: None,
                },
                Node {
                    id: "display-1".to_string(),
                    kind: NodeKind::Display,
                    title: "".to_string(),
                    comment: "".to_string(),
                    position: Position { x: 240.0, y: 0.0 },
                    size: Size {
                        width: 200.0,
                        height: 120.0,
                    },
                    shell: Some("bash".to_string()),
                    script: None,
                    path: None,
                    args: None,
                    text: None,
                    auto_run: None,
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
                    path: None,
                    args: None,
                    text: None,
                    auto_run: None,
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
                        node_id: "display-1".to_string(),
                        port: PortKind::Stdin,
                        slot: None,
                    },
                    buffering: BufferingMode::LineOr1024,
                },
                Edge {
                    id: "edge-2".to_string(),
                    from: PortRef {
                        node_id: "display-1".to_string(),
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

        assert!(finished.is_ok(), "display node did not forward downstream");
    }

    #[tokio::test]
    async fn fully_flushed_edges_still_close_downstream_stdin() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let workspace = Workspace {
            id: "test".to_string(),
            name: "test".to_string(),
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
                    path: None,
                    args: None,
                    text: Some("hello
".to_string()),
                    auto_run: None,
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
                    path: None,
                    args: None,
                    text: None,
                    auto_run: None,
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

    #[test]
    fn byte_interleave_works() {
        let output = interleave_bytes(&[b"abc".to_vec(), b"12".to_vec()]);
        assert_eq!(output, b"a1b2c".to_vec());
    }

    #[test]
    fn line_interleave_works() {
        let output = interleave_lines(&[b"a\nb\n".to_vec(), b"1\n2\n".to_vec()]);
        assert_eq!(String::from_utf8_lossy(&output), "a\n1\nb\n2\n");
    }
}
