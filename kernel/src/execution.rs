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

#[derive(Clone, Copy)]
enum StreamingSeedMode {
    Execute,
    MaterializedOutputs,
}

#[derive(Clone)]
struct StreamingSeed {
    node_id: String,
    seed: StreamingSeedMode,
}

struct StreamingExecutionPlan {
    scope: HashSet<String>,
    seeds: Vec<StreamingSeed>,
    blocked_nodes: HashSet<String>,
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
    materialized_values: Arc<Mutex<HashMap<String, HashMap<String, Vec<u8>>>>>,
    execution_scope: Arc<Mutex<HashSet<String>>>,
    blocked_nodes: Arc<Mutex<HashSet<String>>>,
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

        let materialized_values = workspace
            .nodes
            .iter()
            .map(|node| (node.id.clone(), materialized_value_map(node)))
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
            materialized_values: Arc::new(Mutex::new(materialized_values)),
            execution_scope: Arc::new(Mutex::new(HashSet::new())),
            blocked_nodes: Arc::new(Mutex::new(HashSet::new())),
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
        let plan = match self.action {
            ExecutionAction::PullInputs => self.compute_streaming_pull_plan(&node_id, false)?,
            ExecutionAction::PullRun => self.compute_streaming_pull_plan(&node_id, true)?,
            ExecutionAction::Rerun => {
                self.ensure_rerunnable(&node_id)?;
                self.compute_streaming_rerun_plan(&node_id)
            }
            ExecutionAction::RerunPush => {
                self.ensure_rerunnable(&node_id)?;
                self.compute_streaming_push_plan(&node_id)
            }
            ExecutionAction::Repush => {
                self.ensure_repushable(&node_id)?;
                self.compute_streaming_repush_plan(&node_id)
            }
        };
        self.clone().execute_streaming_plan(plan).await
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

    fn required_input_keys(&self, node_id: &str) -> Vec<String> {
        let mut keys = HashSet::new();
        for edge in self.connected_input_edges(node_id) {
            keys.insert(input_key(edge.to.port, edge.to.slot));
        }
        let mut keys: Vec<String> = keys.into_iter().collect();
        keys.sort();
        keys
    }

    fn node_materialized_values(&self, node_id: &str) -> HashMap<String, Vec<u8>> {
        self.materialized_values
            .lock()
            .get(node_id)
            .cloned()
            .unwrap_or_default()
    }

    fn node_materialized_inputs(&self, node_id: &str) -> HashMap<String, Vec<u8>> {
        self.node_materialized_values(node_id)
            .into_iter()
            .filter(|(key, _)| key == "stdin" || key.starts_with("argv-"))
            .collect()
    }

    fn node_materialized_outputs(&self, node_id: &str) -> HashMap<String, Vec<u8>> {
        self.node_materialized_values(node_id)
            .into_iter()
            .filter(|(key, _)| key == "stdout" || key == "stderr")
            .collect()
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


    fn compute_streaming_push_plan(&self, node_id: &str) -> StreamingExecutionPlan {
        StreamingExecutionPlan {
            scope: self.compute_forward_scope(node_id),
            seeds: vec![StreamingSeed {
                node_id: node_id.to_string(),
                seed: StreamingSeedMode::Execute,
            }],
            blocked_nodes: HashSet::new(),
        }
    }

    fn compute_streaming_rerun_plan(&self, node_id: &str) -> StreamingExecutionPlan {
        StreamingExecutionPlan {
            scope: HashSet::from([node_id.to_string()]),
            seeds: vec![StreamingSeed {
                node_id: node_id.to_string(),
                seed: StreamingSeedMode::Execute,
            }],
            blocked_nodes: HashSet::new(),
        }
    }

    fn compute_streaming_repush_plan(&self, node_id: &str) -> StreamingExecutionPlan {
        StreamingExecutionPlan {
            scope: self.compute_forward_scope(node_id),
            seeds: vec![StreamingSeed {
                node_id: node_id.to_string(),
                seed: StreamingSeedMode::MaterializedOutputs,
            }],
            blocked_nodes: HashSet::new(),
        }
    }

    fn compute_streaming_pull_plan(
        &self,
        target_node_id: &str,
        run_target: bool,
    ) -> Result<StreamingExecutionPlan, String> {
        // Pull still runs through the forward executor; the only difference is that planning
        // walks backward first to find the dependency closure and the seed nodes that should start it.
        let scope = self.compute_backward_scope(target_node_id);
        let root_ids = self.roots_in_scope(&scope);
        let mut seeds = root_ids
            .iter()
            .filter(|node_id| run_target || node_id.as_str() != target_node_id)
            .cloned()
            .map(|node_id| StreamingSeed {
                node_id,
                seed: StreamingSeedMode::Execute,
            })
            .collect::<Vec<_>>();
        let blocked_nodes = if run_target {
            HashSet::new()
        } else {
            HashSet::from([target_node_id.to_string()])
        };

        if seeds.is_empty() {
            if run_target && scope.contains(target_node_id) && root_ids.contains(&target_node_id.to_string()) {
                seeds.push(StreamingSeed {
                    node_id: target_node_id.to_string(),
                    seed: StreamingSeedMode::Execute,
                });
            } else if scope.len() > 1 {
                return Err(format!("pull cycle detected at {target_node_id}"));
            }
        }

        Ok(StreamingExecutionPlan {
            scope,
            seeds,
            blocked_nodes,
        })
    }

    // Keep planning separate from execution so every action can share one forward engine.
    // That makes scope/seed derivation explicit and avoids action-specific control flow drift.
    async fn execute_streaming_plan(self: Arc<Self>, plan: StreamingExecutionPlan) -> Result<(), String> {
        self.init_streaming_plan(&plan);
        for seed in plan.seeds {
            match seed.seed {
                StreamingSeedMode::Execute => self.clone().start_streaming_root(seed.node_id).await?,
                StreamingSeedMode::MaterializedOutputs => {
                    self.clone().start_streaming_materialized_root(seed.node_id).await?
                }
            }
        }
        self.wait_for_streaming_completion().await
    }

    async fn wait_for_streaming_completion(&self) -> Result<(), String> {
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

    fn init_streaming_plan(&self, plan: &StreamingExecutionPlan) {
        *self.execution_scope.lock() = plan.scope.clone();
        *self.blocked_nodes.lock() = plan.blocked_nodes.clone();
        let reachable = &plan.scope;
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

    fn compute_forward_scope(&self, start_node_id: &str) -> HashSet<String> {
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


    fn compute_backward_scope(&self, start_node_id: &str) -> HashSet<String> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::from([start_node_id.to_string()]);
        while let Some(node_id) = queue.pop_front() {
            if !visited.insert(node_id.clone()) {
                continue;
            }
            if let Some(edges) = self.incoming.get(&node_id) {
                for edge in edges {
                    queue.push_back(edge.from.node_id.clone());
                }
            }
        }
        visited
    }

    fn roots_in_scope(&self, scope: &HashSet<String>) -> Vec<String> {
        let mut roots = scope
            .iter()
            .filter(|node_id| {
                self.incoming
                    .get(node_id.as_str())
                    .map(|edges| !edges.iter().any(|edge| scope.contains(&edge.from.node_id)))
                    .unwrap_or(true)
            })
            .cloned()
            .collect::<Vec<_>>();
        roots.sort();
        roots
    }

    fn streaming_reachable_contains(&self, node_id: &str) -> bool {
        self.execution_scope.lock().contains(node_id)
    }


    fn should_execute_node_in_scope(&self, node_id: &str) -> bool {
        !self.blocked_nodes.lock().contains(node_id)
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


    async fn start_streaming_materialized_root(self: Arc<Self>, node_id: String) -> Result<(), String> {
        let node = self
            .nodes
            .get(&node_id)
            .cloned()
            .ok_or_else(|| format!("Unknown node {node_id}"))?;
        self.begin_streaming_node(&node.id);
        let outputs = self.node_materialized_outputs(&node.id);
        for port in output_ports(&node.kind) {
            let bytes = outputs.get(output_key(*port)).cloned().unwrap_or_default();
            self.clone()
                .forward_output_streaming(&node.id, *port, bytes)
                .await?;
        }
        self.finish_streaming_node(&node.id, Some(0)).await
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
            state.scheduled = false;
            state.stdin_writer = None;
        }

        if commit_success {
            self.commit_live_outputs(node_id);
        } else {
            self.live_outputs.lock().remove(node_id);
        }

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

        // Keep the node marked running until downstream completion delivery finishes.
        // Otherwise the run can appear idle before blocked targets have committed pulled inputs.
        {
            let mut states = self.stream_states.lock();
            let state = states.entry(node_id.to_string()).or_default();
            state.running = false;
        }
        self.emit_finished(node_id, exit_code);
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

        if !self.should_execute_node_in_scope(&target.id) {
            return Ok(());
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
        self.replace_materialized_outputs(node_id, next);
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

    fn has_connected_stdin(&self, node_id: &str) -> bool {
        self.connected_input_edges(node_id)
            .iter()
            .any(|edge| edge.to.port == PortKind::Stdin)
    }

    fn set_materialized_input(&self, node_id: &str, key: &str, bytes: Vec<u8>) {
        self.set_materialized_value(node_id, key, bytes);
    }

    fn set_materialized_value(&self, node_id: &str, key: &str, bytes: Vec<u8>) {
        self.materialized_values
            .lock()
            .entry(node_id.to_string())
            .or_default()
            .insert(key.to_string(), bytes);
    }

    fn replace_materialized_outputs(&self, node_id: &str, outputs: HashMap<String, Vec<u8>>) {
        let mut materialized = self.materialized_values.lock();
        let values = materialized.entry(node_id.to_string()).or_default();
        values.retain(|key, _| key != "stdout" && key != "stderr");
        values.extend(outputs);
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

fn materialized_value_map(node: &Node) -> HashMap<String, Vec<u8>> {
    let mut values: HashMap<String, Vec<u8>> = node
        .materialized_values
        .iter()
        .map(|(key, value)| (key.clone(), decode_materialized_value(value)))
        .collect();
    if values.is_empty() {
        for (key, value) in &node.ui_state.previews {
            values.insert(key.clone(), decode_legacy_preview(value));
        }
    }
    values
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
            materialized_values: HashMap::new(),
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


    mod smoke {
        use super::*;
        use std::collections::{BTreeMap, BTreeSet};
        use tempfile::tempdir;

        type Snapshot = BTreeMap<String, BTreeMap<String, String>>;

        fn smoke_script(id: &str, script: &str) -> Node {
            let mut node = node(NodeKind::Script, id);
            node.script = Some(script.to_string());
            node
        }

        fn smoke_edge(id: &str, from: &str, to: &str) -> Edge {
            let mut edge = edge(id, from, PortKind::Stdout, to, PortKind::Stdin, None);
            edge.buffering = BufferingMode::Unbuffered;
            edge
        }

        fn seed(node: &mut Node, key: &str, value: &str) {
            node.materialized_values.insert(
                key.to_string(),
                MaterializedValue {
                    data_base64: encode_bytes(value.as_bytes()),
                },
            );
        }

        fn seeded_snapshot() -> Snapshot {
            BTreeMap::from([
                (
                    "a".to_string(),
                    BTreeMap::from([
                        ("stdout".to_string(), "old-a".to_string()),
                        ("stderr".to_string(), "old-a-err".to_string()),
                    ]),
                ),
                (
                    "b".to_string(),
                    BTreeMap::from([
                        ("stdin".to_string(), "old-b-in".to_string()),
                        ("stdout".to_string(), "old-b-out".to_string()),
                        ("stderr".to_string(), "old-b-err".to_string()),
                    ]),
                ),
                (
                    "c".to_string(),
                    BTreeMap::from([
                        ("stdin".to_string(), "old-c-in".to_string()),
                        ("stdout".to_string(), "old-c-out".to_string()),
                        ("stderr".to_string(), "old-c-err".to_string()),
                    ]),
                ),
            ])
        }

        fn build_smoke_context(action: ExecutionAction) -> (Arc<ExecutionContext>, tempfile::TempDir, Snapshot) {
            let tempdir = tempdir().expect("tempdir");
            let mut a = smoke_script("a", "printf 'A' >> trace.log; printf 'a'");
            let mut b = smoke_script(
                "b",
                r#"printf 'B' >> trace.log; input=$(cat); printf '%s b' "$input""#,
            );
            let mut c = smoke_script(
                "c",
                r#"printf 'C' >> trace.log; input=$(cat); printf '%s c' "$input""#,
            );

            seed(&mut a, "stdout", "old-a");
            seed(&mut a, "stderr", "old-a-err");
            seed(&mut b, "stdin", "old-b-in");
            seed(&mut b, "stdout", "old-b-out");
            seed(&mut b, "stderr", "old-b-err");
            seed(&mut c, "stdin", "old-c-in");
            seed(&mut c, "stdout", "old-c-out");
            seed(&mut c, "stderr", "old-c-err");

            let mut ws = workspace(
                vec![a, b, c],
                vec![smoke_edge("edge-ab", "a", "b"), smoke_edge("edge-bc", "b", "c")],
            );
            ws.cwd = tempdir.path().to_string_lossy().into_owned();
            let context = Arc::new(
                ExecutionContext::new(
                    "smoke-exec".to_string(),
                    ws,
                    action,
                    broadcast::channel(64).0,
                    CancellationToken::new(),
                )
                .expect("context"),
            );
            (context, tempdir, seeded_snapshot())
        }

        fn trace_recomputed_nodes(tempdir: &tempfile::TempDir) -> BTreeSet<String> {
            let trace = std::fs::read_to_string(tempdir.path().join("trace.log")).unwrap_or_default();
            trace.chars()
                .filter_map(|marker| match marker {
                    'A' => Some("a".to_string()),
                    'B' => Some("b".to_string()),
                    'C' => Some("c".to_string()),
                    _ => None,
                })
                .collect()
        }

        fn final_snapshot(context: &ExecutionContext) -> Snapshot {
            let materialized = context.materialized_values.lock();
            let mut snapshot = BTreeMap::new();
            for (node_id, ports) in [
                ("a", ["stdout", "stderr"].as_slice()),
                ("b", ["stdin", "stdout", "stderr"].as_slice()),
                ("c", ["stdin", "stdout", "stderr"].as_slice()),
            ] {
                let values = ports
                    .iter()
                    .map(|port| {
                        let bytes = materialized
                            .get(node_id)
                            .and_then(|node_ports| node_ports.get(*port))
                            .cloned()
                            .unwrap_or_default();
                        (
                            (*port).to_string(),
                            String::from_utf8(bytes).expect("materialized utf8"),
                        )
                    })
                    .collect();
                snapshot.insert(node_id.to_string(), values);
            }
            snapshot
        }

        fn rematerialized_ports(before: &Snapshot, after: &Snapshot) -> BTreeSet<String> {
            let mut changed = BTreeSet::new();
            for (node_id, ports) in after {
                for (port, value) in ports {
                    let old = before.get(node_id).and_then(|node| node.get(port));
                    if old != Some(value) {
                        changed.insert(format!("{node_id}.{port}"));
                    }
                }
            }
            changed
        }

        async fn assert_smoke_case(
            action: ExecutionAction,
            expected_recomputed: &[&str],
            expected_rematerialized: &[&str],
            expected_snapshot: Snapshot,
        ) {
            let (context, tempdir, seeded) = build_smoke_context(action);
            context.clone().run("b".to_string()).await.expect("run");

            let recomputed = trace_recomputed_nodes(&tempdir);
            let final_values = final_snapshot(&context);
            let rematerialized = rematerialized_ports(&seeded, &final_values);

            assert_eq!(
                recomputed,
                expected_recomputed.iter().map(|node| (*node).to_string()).collect(),
                "unexpected recomputed nodes for {:?}",
                action
            );
            assert_eq!(
                rematerialized,
                expected_rematerialized.iter().map(|port| (*port).to_string()).collect(),
                "unexpected rematerialized ports for {:?}",
                action
            );
            assert_eq!(final_values, expected_snapshot, "unexpected final snapshot for {:?}", action);
        }

        #[tokio::test]
        async fn smoke_test_pull_inputs() {
            assert_smoke_case(
                ExecutionAction::PullInputs,
                &["a"],
                &["a.stdout", "a.stderr", "b.stdin"],
                BTreeMap::from([
                    (
                        "a".to_string(),
                        BTreeMap::from([
                            ("stdout".to_string(), "a".to_string()),
                            ("stderr".to_string(), "".to_string()),
                        ]),
                    ),
                    (
                        "b".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "a".to_string()),
                            ("stdout".to_string(), "old-b-out".to_string()),
                            ("stderr".to_string(), "old-b-err".to_string()),
                        ]),
                    ),
                    (
                        "c".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "old-c-in".to_string()),
                            ("stdout".to_string(), "old-c-out".to_string()),
                            ("stderr".to_string(), "old-c-err".to_string()),
                        ]),
                    ),
                ]),
            )
            .await;
        }

        #[tokio::test]
        async fn smoke_test_pull_run() {
            assert_smoke_case(
                ExecutionAction::PullRun,
                &["a", "b"],
                &["a.stdout", "a.stderr", "b.stdin", "b.stdout", "b.stderr"],
                BTreeMap::from([
                    (
                        "a".to_string(),
                        BTreeMap::from([
                            ("stdout".to_string(), "a".to_string()),
                            ("stderr".to_string(), "".to_string()),
                        ]),
                    ),
                    (
                        "b".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "a".to_string()),
                            ("stdout".to_string(), "a b".to_string()),
                            ("stderr".to_string(), "".to_string()),
                        ]),
                    ),
                    (
                        "c".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "old-c-in".to_string()),
                            ("stdout".to_string(), "old-c-out".to_string()),
                            ("stderr".to_string(), "old-c-err".to_string()),
                        ]),
                    ),
                ]),
            )
            .await;
        }

        #[tokio::test]
        async fn smoke_test_rerun() {
            assert_smoke_case(
                ExecutionAction::Rerun,
                &["b"],
                &["b.stdout", "b.stderr"],
                BTreeMap::from([
                    (
                        "a".to_string(),
                        BTreeMap::from([
                            ("stdout".to_string(), "old-a".to_string()),
                            ("stderr".to_string(), "old-a-err".to_string()),
                        ]),
                    ),
                    (
                        "b".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "old-b-in".to_string()),
                            ("stdout".to_string(), "old-b-in b".to_string()),
                            ("stderr".to_string(), "".to_string()),
                        ]),
                    ),
                    (
                        "c".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "old-c-in".to_string()),
                            ("stdout".to_string(), "old-c-out".to_string()),
                            ("stderr".to_string(), "old-c-err".to_string()),
                        ]),
                    ),
                ]),
            )
            .await;
        }

        #[tokio::test]
        async fn smoke_test_rerun_push() {
            assert_smoke_case(
                ExecutionAction::RerunPush,
                &["b", "c"],
                &["b.stdout", "b.stderr", "c.stdin", "c.stdout", "c.stderr"],
                BTreeMap::from([
                    (
                        "a".to_string(),
                        BTreeMap::from([
                            ("stdout".to_string(), "old-a".to_string()),
                            ("stderr".to_string(), "old-a-err".to_string()),
                        ]),
                    ),
                    (
                        "b".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "old-b-in".to_string()),
                            ("stdout".to_string(), "old-b-in b".to_string()),
                            ("stderr".to_string(), "".to_string()),
                        ]),
                    ),
                    (
                        "c".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "old-b-in b".to_string()),
                            ("stdout".to_string(), "old-b-in b c".to_string()),
                            ("stderr".to_string(), "".to_string()),
                        ]),
                    ),
                ]),
            )
            .await;
        }

        #[tokio::test]
        async fn smoke_test_repush() {
            assert_smoke_case(
                ExecutionAction::Repush,
                &["c"],
                &["c.stdin", "c.stdout", "c.stderr"],
                BTreeMap::from([
                    (
                        "a".to_string(),
                        BTreeMap::from([
                            ("stdout".to_string(), "old-a".to_string()),
                            ("stderr".to_string(), "old-a-err".to_string()),
                        ]),
                    ),
                    (
                        "b".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "old-b-in".to_string()),
                            ("stdout".to_string(), "old-b-out".to_string()),
                            ("stderr".to_string(), "old-b-err".to_string()),
                        ]),
                    ),
                    (
                        "c".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "old-b-out".to_string()),
                            ("stdout".to_string(), "old-b-out c".to_string()),
                            ("stderr".to_string(), "".to_string()),
                        ]),
                    ),
                ]),
            )
            .await;
        }
    }


    #[tokio::test]
    async fn pull_inputs_runs_shared_dependencies_once() {
        let (tx, _) = broadcast::channel(256);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut source = node(NodeKind::Script, "source");
        source.script = Some("printf 'hello\n'".to_string());
        let passthru_a = node(NodeKind::Passthru, "pass-a");
        let passthru_b = node(NodeKind::Passthru, "pass-b");
        let mut target = node(NodeKind::Script, "target");
        target.script = Some("cat >/dev/null".to_string());
        let workspace = workspace(
            vec![source, passthru_a, passthru_b, target],
            vec![
                edge("edge-source-a", "source", PortKind::Stdout, "pass-a", PortKind::Stdin, None),
                edge("edge-source-b", "source", PortKind::Stdout, "pass-b", PortKind::Stdin, None),
                edge("edge-a-target", "pass-a", PortKind::Stdout, "target", PortKind::Stdin, None),
                edge("edge-b-target", "pass-b", PortKind::Stdout, "target", PortKind::Argv, Some(1)),
            ],
        );

        let exec_id = manager.run(workspace, "target".to_string(), ExecutionAction::PullInputs);
        let mut source_starts = 0;
        timeout(Duration::from_secs(3), async {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecStarted { exec_id: seen, node_id, .. }) if seen == exec_id && node_id == "source" => {
                        source_starts += 1;
                    }
                    Ok(ServerEvent::ExecFinished { exec_id: seen, node_id, .. }) if seen == exec_id && node_id == "pass-b" => break,
                    Ok(ServerEvent::Error { message, .. }) => panic!("unexpected execution error: {message}"),
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await
        .expect("pull_inputs execution did not finish");

        assert_eq!(source_starts, 1, "shared dependency should execute once per pull_inputs run");
    }

    #[tokio::test]
    async fn pull_run_runs_shared_dependencies_once() {
        let (tx, _) = broadcast::channel(256);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut source = node(NodeKind::Script, "source");
        source.script = Some("printf 'hello\n'".to_string());
        let passthru_a = node(NodeKind::Passthru, "pass-a");
        let passthru_b = node(NodeKind::Passthru, "pass-b");
        let mut target = node(NodeKind::Script, "target");
        target.script = Some("printf '%s %s\n' \"$1\" \"$(cat)\"".to_string());
        let workspace = workspace(
            vec![source, passthru_a, passthru_b, target],
            vec![
                edge("edge-source-a", "source", PortKind::Stdout, "pass-a", PortKind::Stdin, None),
                edge("edge-source-b", "source", PortKind::Stdout, "pass-b", PortKind::Stdin, None),
                edge("edge-a-target", "pass-a", PortKind::Stdout, "target", PortKind::Stdin, None),
                edge("edge-b-target", "pass-b", PortKind::Stdout, "target", PortKind::Argv, Some(1)),
            ],
        );

        let exec_id = manager.run(workspace, "target".to_string(), ExecutionAction::PullRun);
        let mut source_starts = 0;
        timeout(Duration::from_secs(3), async {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecStarted { exec_id: seen, node_id, .. }) if seen == exec_id && node_id == "source" => {
                        source_starts += 1;
                    }
                    Ok(ServerEvent::ExecFinished { exec_id: seen, node_id, .. }) if seen == exec_id && node_id == "target" => break,
                    Ok(ServerEvent::Error { message, .. }) => panic!("unexpected execution error: {message}"),
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await
        .expect("pull_run execution did not finish");

        assert_eq!(source_starts, 1, "shared dependency should execute once per pull_run");
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
        script.materialized_values.insert(
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
                        source.materialized_values.insert(
                            "stdout".to_string(),
                            MaterializedValue {
                                data_base64: encode_bytes(b"old-output\n"),
                            },
                        );
                        let mut sink = node(NodeKind::Script, "script-2");
                        sink.script = Some("cat >/dev/null".to_string());
                        sink.materialized_values.insert(
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
                .materialized_values
                .lock()
                .get("script-1")
                .and_then(|ports| ports.get("stdout"))
                .cloned(),
            Some(b"old-output\n".to_vec())
        );
        assert_eq!(
            context
                .materialized_values
                .lock()
                .get("script-2")
                .and_then(|ports| ports.get("stdin"))
                .cloned(),
            Some(b"old-input\n".to_vec())
        );
    }




    #[tokio::test]
    async fn materialized_empty_outputs_still_allow_repush() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut file = node(NodeKind::File, "file-1");
        file.materialized_values.insert(
            "stdout".to_string(),
            MaterializedValue {
                data_base64: encode_bytes(b""),
            },
        );
        file.materialized_values.insert(
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
