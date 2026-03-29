use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

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

use crate::formula;
use crate::materialized_outputs::{
    create_output_entries, decode_entry_bytes, set_node_input_ref, MaterializedMutation,
};
use crate::model::{
    default_cwd, BufferingMode, Edge, ExecutionRequest, MaterializedOutputStore, Node, NodeKind,
    NodeMaterialized, PortKind, ServerEvent, Workspace,
};
use crate::port_schema::node_port_schema;

fn node_label(node: &Node) -> &str {
    if node.title.trim().is_empty() {
        &node.id
    } else {
        &node.title
    }
}

fn source_output_ports(kind: &NodeKind) -> &'static [PortKind] {
    node_port_schema(kind).source_outputs
}

fn materialized_output_ports(kind: &NodeKind) -> &'static [PortKind] {
    node_port_schema(kind).materialized_outputs
}

fn node_accepts_stdin(kind: &NodeKind) -> bool {
    node_port_schema(kind).stdin
}

fn node_accepts_argv(kind: &NodeKind) -> bool {
    node_port_schema(kind).argv
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

fn encode_bytes(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

const PROCESS_OUTPUT_READ_CHUNK_SIZE: usize = 1024;

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

    pub fn run(
        &self,
        request: ExecutionRequest,
        materialized_output_store: MaterializedOutputStore,
    ) -> String {
        let exec_id = crate::id::encode_exec_id();
        let cancel = CancellationToken::new();
        let manager = self.clone();
        let node_for_handle = request
            .seed_node_ids
            .first()
            .cloned()
            .or_else(|| request.workspace.nodes.first().map(|node| node.id.clone()))
            .unwrap_or_default();
        let exec_id_for_task = exec_id.clone();
        let exec_id_for_remove = exec_id.clone();
        let cancel_for_task = cancel.clone();
        let task = tokio::spawn(async move {
            let context = match ExecutionContext::new(
                exec_id_for_task.clone(),
                request,
                materialized_output_store,
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

            if let Err(message) = context.clone().run().await {
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

struct StreamingExecutionPlan {
    scope: HashSet<String>,
    seeds: Vec<String>,
    blocked_nodes: HashSet<String>,
}

struct ExecutionContext {
    exec_id: String,
    request: ExecutionRequest,
    workspace: Workspace,
    broadcaster: broadcast::Sender<ServerEvent>,
    cancel: CancellationToken,
    nodes: HashMap<String, Node>,
    outgoing: HashMap<String, Vec<Edge>>,
    incoming: HashMap<String, Vec<Edge>>,
    materialized_values: Arc<Mutex<HashMap<String, HashMap<String, Vec<u8>>>>>,
    materialized_nodes: Arc<Mutex<HashMap<String, NodeMaterialized>>>,
    materialized_output_store: Arc<Mutex<MaterializedOutputStore>>,
    available_matout_ids: HashSet<String>,
    last_exit_codes: Arc<Mutex<HashMap<String, Option<i32>>>>,
    execution_scope: Arc<Mutex<HashSet<String>>>,
    blocked_nodes: Arc<Mutex<HashSet<String>>>,
}

impl ExecutionContext {
    fn new(
        exec_id: String,
        request: ExecutionRequest,
        materialized_output_store: MaterializedOutputStore,
        broadcaster: broadcast::Sender<ServerEvent>,
        cancel: CancellationToken,
    ) -> Result<Self, String> {
        let workspace = request.workspace.clone();
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

        for node in workspace.nodes.iter() {
            let edges = incoming.get(&node.id).cloned().unwrap_or_default();
            if node_accepts_argv(&node.kind) {
                let stdin_count = edges
                    .iter()
                    .filter(|edge| edge.to.port == PortKind::Stdin)
                    .count();
                let max_stdin = usize::from(node_accepts_stdin(&node.kind));
                if stdin_count > max_stdin {
                    return Err(format!(
                        "Node {} accepts at most {} stdin wire{}.",
                        node_label(node),
                        max_stdin,
                        if max_stdin == 1 { "" } else { "s" }
                    ));
                }
                let mut argv_slots = HashSet::new();
                for edge in edges.iter().filter(|edge| edge.to.port == PortKind::Argv) {
                    let Some(slot) = edge.to.slot else {
                        return Err(format!(
                            "Node {} has an argv wire without a target slot.",
                            node_label(node)
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
            } else if node_accepts_stdin(&node.kind) {
                if edges.len() > 1 {
                    return Err(format!(
                        "Node {} has {} input wires. This node accepts only one input.",
                        node_label(node),
                        edges.len()
                    ));
                }
            } else if !edges.is_empty() {
                return Err(format!(
                    "Node {} does not accept input wires.",
                    node_label(node)
                ));
            }
        }

        let provided_ids = request
            .provided_matout_ids
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        for id in &provided_ids {
            if !materialized_output_store.contains_key(id) {
                return Err(format!("missing materialized output {id}"));
            }
        }
        let referenced_ids = workspace
            .nodes
            .iter()
            .flat_map(|node| {
                node.materialized
                    .inputs
                    .values()
                    .chain(node.materialized.outputs.values())
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .collect::<HashSet<_>>();
        for id in &provided_ids {
            if !referenced_ids.contains(id) {
                return Err(format!("unused provided materialized output {id}"));
            }
        }

        let materialized_values = workspace
            .nodes
            .iter()
            .map(|node| {
                (
                    node.id.clone(),
                    materialized_value_map(node, &materialized_output_store),
                )
            })
            .collect();
        let materialized_nodes = workspace
            .nodes
            .iter()
            .map(|node| (node.id.clone(), node.materialized.clone()))
            .collect();
        let last_exit_codes = workspace
            .nodes
            .iter()
            .map(|node| (node.id.clone(), node.materialized.last_exit_code))
            .collect();

        Ok(Self {
            exec_id,
            request,
            workspace,
            broadcaster,
            cancel,
            nodes,
            outgoing,
            incoming,
            materialized_values: Arc::new(Mutex::new(materialized_values)),
            materialized_nodes: Arc::new(Mutex::new(materialized_nodes)),
            materialized_output_store: Arc::new(Mutex::new(materialized_output_store)),
            available_matout_ids: provided_ids,
            last_exit_codes: Arc::new(Mutex::new(last_exit_codes)),
            execution_scope: Arc::new(Mutex::new(HashSet::new())),
            blocked_nodes: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    async fn run(self: Arc<Self>) -> Result<(), String> {
        let plan = self.validate_request()?;
        self.clone().execute_streaming_plan(plan).await
    }

    fn validate_request(&self) -> Result<StreamingExecutionPlan, String> {
        if self.request.seed_node_ids.is_empty() {
            return Err("execution request has no seeds".to_string());
        }

        let scope = self
            .workspace
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<HashSet<_>>();
        let seeds = self.request.seed_node_ids.iter().cloned().collect::<HashSet<_>>();
        let blocked_nodes = self
            .request
            .blocked_node_ids
            .iter()
            .cloned()
            .collect::<HashSet<_>>();

        for node_id in seeds.iter().chain(blocked_nodes.iter()) {
            if !scope.contains(node_id) {
                return Err(format!("node {node_id} is not in the execution graph"));
            }
        }

        let roots = self.roots_in_scope(&scope).into_iter().collect::<HashSet<_>>();
        for seed in &seeds {
            if !roots.contains(seed) {
                return Err(format!("seed node {seed} is not a graph-theoretic root"));
            }
        }
        for root in &roots {
            if !seeds.contains(root) {
                return Err(format!("graph root {root} is missing from the seed set"));
            }
        }

        let reachable = self.forward_reachable_from(&seeds);
        for node_id in &scope {
            if !reachable.contains(node_id) {
                return Err(format!("node {node_id} is unreachable from the provided seeds"));
            }
        }

        for node_id in &blocked_nodes {
            let has_downstream = self
                .outgoing
                .get(node_id)
                .map(|edges| edges.iter().any(|edge| scope.contains(&edge.to.node_id)))
                .unwrap_or(false);
            if has_downstream
                && (!seeds.contains(node_id) || !self.node_has_replayable_outputs(node_id))
            {
                return Err(format!(
                    "blocked node {node_id} cannot feed downstream execution without provided outputs"
                ));
            }
        }
        for node_id in seeds.intersection(&blocked_nodes) {
            if !self.node_has_replayable_outputs(node_id) {
                let node = self.nodes.get(node_id).expect("seed node");
                return Err(format!("{} has no outputs to push.", node_label(node)));
            }
        }

        Ok(StreamingExecutionPlan {
            scope,
            seeds: self.request.seed_node_ids.clone(),
            blocked_nodes,
        })
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

    fn node_available_materialized_inputs(&self, node_id: &str) -> HashMap<String, Vec<u8>> {
        let nodes = self.materialized_nodes.lock();
        let Some(materialized) = nodes.get(node_id) else {
            return HashMap::new();
        };
        let store = self.materialized_output_store.lock();
        materialized
            .inputs
            .iter()
            .filter(|(_, id)| self.available_matout_ids.contains(*id))
            .filter_map(|(key, id)| store.get(id).map(|entry| (key.clone(), decode_entry_bytes(entry))))
            .collect()
    }

    fn node_available_materialized_outputs(&self, node_id: &str) -> HashMap<String, Vec<u8>> {
        let nodes = self.materialized_nodes.lock();
        let Some(materialized) = nodes.get(node_id) else {
            return HashMap::new();
        };
        let store = self.materialized_output_store.lock();
        materialized
            .outputs
            .iter()
            .filter(|(_, id)| self.available_matout_ids.contains(*id))
            .filter_map(|(key, id)| store.get(id).map(|entry| (key.clone(), decode_entry_bytes(entry))))
            .collect()
    }

    fn node_last_exit_code(&self, node_id: &str) -> Option<i32> {
        self.last_exit_codes.lock().get(node_id).copied().flatten()
    }

    fn node_has_replayable_outputs(&self, node_id: &str) -> bool {
        !self.node_available_materialized_outputs(node_id).is_empty()
    }

    fn forward_reachable_from(&self, seeds: &HashSet<String>) -> HashSet<String> {
        let mut visited = HashSet::new();
        let mut queue = seeds.iter().cloned().collect::<VecDeque<_>>();
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

    fn should_execute_node_in_scope(&self, node_id: &str) -> bool {
        !self.blocked_nodes.lock().contains(node_id)
    }

    // Keep planning separate from execution so every action can share one forward engine.
    // A central controller owns scheduling, propagation, and completion; worker tasks only emit facts.
    async fn execute_streaming_plan(
        self: Arc<Self>,
        plan: StreamingExecutionPlan,
    ) -> Result<(), String> {
        RunController::new(self, plan).run().await
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

    fn set_materialized_input_bytes(&self, node_id: &str, key: &str, bytes: Vec<u8>) {
        self.materialized_values
            .lock()
            .entry(node_id.to_string())
            .or_default()
            .insert(key.to_string(), bytes);
    }

    fn replace_materialized_output_bytes(&self, node_id: &str, outputs: HashMap<String, Vec<u8>>) {
        let mut materialized = self.materialized_values.lock();
        let values = materialized.entry(node_id.to_string()).or_default();
        values.retain(|key, _| key != "stdout" && key != "stderr");
        values.extend(outputs);
    }

    fn node_output_matout_id(&self, node_id: &str, port: PortKind) -> Option<String> {
        let key = output_key(port);
        self.materialized_nodes
            .lock()
            .get(node_id)
            .and_then(|materialized| materialized.outputs.get(key))
            .cloned()
    }

    fn emit_materialized_state(&self, node_id: &str, mutation: MaterializedMutation) {
        let materialized = self
            .materialized_nodes
            .lock()
            .get(node_id)
            .cloned()
            .unwrap_or_default();
        let _ = self.broadcaster.send(ServerEvent::MaterializedState {
            node_id: node_id.to_string(),
            materialized,
            upserted_entries: mutation.upserted_entries,
            deleted_ids: mutation.deleted_ids,
            timestamp: now_ms(),
        });
    }

    fn set_materialized_input_ref(
        &self,
        node_id: &str,
        key: &str,
        bytes: Vec<u8>,
        matout_id: Option<String>,
    ) {
        self.set_materialized_input_bytes(node_id, key, bytes);
        let mut nodes = self.materialized_nodes.lock();
        let mut store = self.materialized_output_store.lock();
        let Some(node) = self.nodes.get(node_id) else {
            return;
        };
        let state = nodes.entry(node_id.to_string()).or_default();
        let mut shadow = node.clone();
        shadow.materialized = state.clone();
        let mutation = set_node_input_ref(&mut shadow, key, matout_id, &mut store);
        *state = shadow.materialized.clone();
        drop(store);
        drop(nodes);
        self.emit_materialized_state(node_id, mutation);
    }

    fn replace_materialized_outputs(
        &self,
        node_id: &str,
        outputs: HashMap<String, Vec<u8>>,
        exit_code: Option<i32>,
    ) {
        self.replace_materialized_output_bytes(node_id, outputs.clone());
        self.last_exit_codes
            .lock()
            .insert(node_id.to_string(), exit_code);
        let mut nodes = self.materialized_nodes.lock();
        let mut store = self.materialized_output_store.lock();
        let Some(node) = self.nodes.get(node_id) else {
            return;
        };
        let state = nodes.entry(node_id.to_string()).or_default();
        let mut shadow = node.clone();
        shadow.materialized = state.clone();
        shadow.materialized.last_exit_code = exit_code;
        let mutation = create_output_entries(&mut shadow, &self.exec_id, outputs, &mut store);
        *state = shadow.materialized.clone();
        drop(store);
        drop(nodes);
        self.emit_materialized_state(node_id, mutation);
    }

    fn emit_started(&self, node_id: &str) {
        let _ = self.broadcaster.send(ServerEvent::ExecStarted {
            exec_id: self.exec_id.clone(),
            node_id: node_id.to_string(),
            timestamp: now_ms(),
        });
    }

    fn emit_finished(&self, node_id: &str, exit_code: Option<i32>, materialized: bool) {
        let _ = self.broadcaster.send(ServerEvent::ExecFinished {
            exec_id: self.exec_id.clone(),
            node_id: node_id.to_string(),
            exit_code,
            materialized,
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

enum ControllerEvent {
    NodeOutputChunk {
        node_id: String,
        port: PortKind,
        chunk: Vec<u8>,
    },
    NodeExited {
        node_id: String,
        exit_code: Option<i32>,
    },
    DeliveryReady(DelayedDelivery),
}

#[derive(Clone)]
struct DelayedDelivery {
    sequence: u64,
    edge: Edge,
    port: PortKind,
    payload: Vec<u8>,
    reset: bool,
    completed: bool,
    success: bool,
}

struct RunController {
    context: Arc<ExecutionContext>,
    plan: StreamingExecutionPlan,
    events_tx: mpsc::UnboundedSender<ControllerEvent>,
    events_rx: mpsc::UnboundedReceiver<ControllerEvent>,
    stream_states: HashMap<String, StreamingNodeState>,
    edge_buffers: HashMap<String, EdgeBufferState>,
    live_inputs: HashMap<String, HashMap<String, Vec<u8>>>,
    live_outputs: HashMap<String, HashMap<String, Vec<u8>>>,
    pending_finish_events: HashMap<String, (Option<i32>, bool)>,
    pending_delivery_counts: HashMap<String, usize>,
    next_delivery_sequence: HashMap<String, u64>,
    next_delivery_to_process: HashMap<String, u64>,
    ready_deliveries: HashMap<String, BTreeMap<u64, DelayedDelivery>>,
    active_external_tasks: usize,
}

impl RunController {
    fn new(context: Arc<ExecutionContext>, plan: StreamingExecutionPlan) -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        Self {
            context,
            plan,
            events_tx,
            events_rx,
            stream_states: HashMap::new(),
            edge_buffers: HashMap::new(),
            live_inputs: HashMap::new(),
            live_outputs: HashMap::new(),
            pending_finish_events: HashMap::new(),
            pending_delivery_counts: HashMap::new(),
            next_delivery_sequence: HashMap::new(),
            next_delivery_to_process: HashMap::new(),
            ready_deliveries: HashMap::new(),
            active_external_tasks: 0,
        }
    }

    async fn run(mut self) -> Result<(), String> {
        self.init();
        for seed in self.plan.seeds.clone() {
            self.start_seed(seed).await?;
        }

        loop {
            if self.context.cancel.is_cancelled() {
                break;
            }
            if self.active_external_tasks == 0
                && self.events_rx.is_empty()
                && self.ready_deliveries.values().all(BTreeMap::is_empty)
            {
                break;
            }
            let Some(event) = (tokio::select! {
                _ = self.context.cancel.cancelled() => None,
                event = self.events_rx.recv() => event,
            }) else {
                break;
            };
            self.handle_event(event).await?;
        }

        Ok(())
    }

    fn init(&mut self) {
        *self.context.execution_scope.lock() = self.plan.scope.clone();
        *self.context.blocked_nodes.lock() = self.plan.blocked_nodes.clone();
        for edge in self.context.workspace.edges.iter().filter(|edge| {
            self.plan.scope.contains(&edge.from.node_id)
                && self.plan.scope.contains(&edge.to.node_id)
        }) {
            self.edge_buffers.insert(
                edge.id.clone(),
                EdgeBufferState {
                    edge: edge.clone(),
                    buffered: Vec::new(),
                    sent_any: false,
                },
            );
        }
    }

    async fn start_seed(&mut self, node_id: String) -> Result<(), String> {
        if self.context.node_has_replayable_outputs(&node_id) {
            self.start_materialized_seed(node_id).await
        } else if self.context.should_execute_node_in_scope(&node_id) {
            self.start_node_execute(node_id).await
        } else {
            Ok(())
        }
    }

    async fn handle_event(&mut self, event: ControllerEvent) -> Result<(), String> {
        match event {
            ControllerEvent::NodeOutputChunk {
                node_id,
                port,
                chunk,
            } => self.handle_output_chunk(&node_id, port, chunk).await,
            ControllerEvent::NodeExited { node_id, exit_code } => {
                self.active_external_tasks = self.active_external_tasks.saturating_sub(1);
                self.handle_node_exit(&node_id, exit_code).await
            }
            ControllerEvent::DeliveryReady(delivery) => {
                self.active_external_tasks = self.active_external_tasks.saturating_sub(1);
                self.enqueue_ready_delivery(delivery).await
            }
        }
    }

    async fn enqueue_ready_delivery(&mut self, delivery: DelayedDelivery) -> Result<(), String> {
        self.ready_deliveries
            .entry(delivery.edge.id.clone())
            .or_default()
            .insert(delivery.sequence, delivery.clone());
        self.drain_ready_deliveries(&delivery.edge.id).await
    }

    async fn drain_ready_deliveries(&mut self, edge_id: &str) -> Result<(), String> {
        loop {
            let next_sequence = self
                .next_delivery_to_process
                .get(edge_id)
                .copied()
                .unwrap_or(0);
            let Some(delivery) = self
                .ready_deliveries
                .get_mut(edge_id)
                .and_then(|deliveries| deliveries.remove(&next_sequence))
            else {
                break;
            };
            if self
                .ready_deliveries
                .get(edge_id)
                .map(BTreeMap::is_empty)
                .unwrap_or(false)
            {
                self.ready_deliveries.remove(edge_id);
            }
            self.next_delivery_to_process
                .insert(edge_id.to_string(), next_sequence + 1);
            self.process_ready_delivery(delivery).await?;
        }
        Ok(())
    }

    async fn process_ready_delivery(&mut self, delivery: DelayedDelivery) -> Result<(), String> {
        // Per-edge delivery order matters: argv/stdin completion must never overtake earlier bytes.
        self.context.emit_stream_chunk(
            &delivery.edge,
            delivery.port,
            &delivery.payload,
            delivery.reset,
            delivery.completed,
            delivery.success,
        );
        let from_node_id = delivery.edge.from.node_id.clone();
        let result = self
            .handle_delivery(
                delivery.edge,
                delivery.payload,
                delivery.completed,
                delivery.success,
            )
            .await;
        if let Some(count) = self.pending_delivery_counts.get_mut(&from_node_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.pending_delivery_counts.remove(&from_node_id);
            }
        }
        self.finish_node_if_delivery_drained(&from_node_id);
        result
    }

    fn state_mut(&mut self, node_id: &str) -> &mut StreamingNodeState {
        self.stream_states.entry(node_id.to_string()).or_default()
    }

    fn append_live_input(&mut self, node_id: &str, key: &str, payload: &[u8]) {
        self.live_inputs
            .entry(node_id.to_string())
            .or_default()
            .entry(key.to_string())
            .or_default()
            .extend_from_slice(payload);
    }

    fn append_live_output(&mut self, node_id: &str, port: PortKind, payload: &[u8]) {
        self.live_outputs
            .entry(node_id.to_string())
            .or_default()
            .entry(output_key(port).to_string())
            .or_default()
            .extend_from_slice(payload);
    }

    fn commit_live_input(&mut self, edge: &Edge, node_id: &str, key: &str) {
        let bytes = self
            .live_inputs
            .get(node_id)
            .and_then(|inputs| inputs.get(key).cloned())
            .unwrap_or_default();
        let matout_id = self
            .context
            .node_output_matout_id(&edge.from.node_id, edge.from.port);
        self.context
            .set_materialized_input_ref(node_id, key, bytes, matout_id);
    }

    fn discard_live_input(&mut self, node_id: &str, key: &str) {
        if let Some(inputs) = self.live_inputs.get_mut(node_id) {
            inputs.remove(key);
        }
    }

    fn commit_live_outputs(&mut self, node_id: &str, exit_code: Option<i32>) {
        let outputs = self.live_outputs.remove(node_id).unwrap_or_default();
        let node = self.context.nodes.get(node_id).expect("node");
        let mut next = HashMap::new();
        for port in materialized_output_ports(&node.kind) {
            let key = output_key(*port).to_string();
            next.insert(key.clone(), outputs.get(&key).cloned().unwrap_or_default());
        }
        self.context
            .replace_materialized_outputs(node_id, next, exit_code);
    }

    fn has_fresh_stdin_edge(&self, node_id: &str) -> bool {
        self.context
            .connected_input_edges(node_id)
            .into_iter()
            .any(|edge| {
                edge.to.port == PortKind::Stdin && self.plan.scope.contains(&edge.from.node_id)
            })
    }

    fn required_materialized_input_keys(&self, node_id: &str) -> HashSet<String> {
        self.context
            .materialized_nodes
            .lock()
            .get(node_id)
            .map(|materialized| materialized.inputs.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn has_required_stdin(&self, node_id: &str) -> bool {
        self.context
            .connected_input_edges(node_id)
            .iter()
            .any(|edge| edge.to.port == PortKind::Stdin)
            || self.required_materialized_input_keys(node_id).contains("stdin")
    }

    fn required_argv_slots(&self, node_id: &str) -> Vec<usize> {
        let mut slots = self
            .context
            .connected_input_edges(node_id)
            .into_iter()
            .filter(|edge| edge.to.port == PortKind::Argv)
            .filter_map(|edge| edge.to.slot)
            .collect::<HashSet<_>>();
        for key in self.required_materialized_input_keys(node_id) {
            if let Some(slot) = key
                .strip_prefix("argv-")
                .and_then(|raw| raw.parse::<usize>().ok())
            {
                slots.insert(slot);
            }
        }
        let mut ordered = slots.into_iter().collect::<Vec<_>>();
        ordered.sort_unstable();
        ordered
    }

    fn streaming_command_ready(&self, node_id: &str) -> bool {
        let inputs = self.context.node_available_materialized_inputs(node_id);
        let state = self.stream_states.get(node_id).cloned().unwrap_or_default();

        if state.tainted {
            return false;
        }

        for edge in self.context.connected_input_edges(node_id) {
            let key = input_key(edge.to.port, edge.to.slot);
            if self.plan.scope.contains(&edge.from.node_id) {
                match edge.to.port {
                    PortKind::Stdin => {
                        if !state.stdin_seen && !state.buffered_stdin_closed {
                            return false;
                        }
                    }
                    PortKind::Argv => {
                        if !state.argv_completed.contains(&edge.id) {
                            return false;
                        }
                    }
                    _ => {}
                }
            } else if !inputs.contains_key(&key) {
                return false;
            }
        }

        let fresh_keys = self
            .context
            .connected_input_edges(node_id)
            .into_iter()
            .filter(|edge| self.plan.scope.contains(&edge.from.node_id))
            .map(|edge| input_key(edge.to.port, edge.to.slot))
            .collect::<HashSet<_>>();
        for key in self.required_materialized_input_keys(node_id) {
            if !fresh_keys.contains(&key) && !inputs.contains_key(&key) {
                return false;
            }
        }

        true
    }

    fn take_streaming_command_inputs(&mut self, node_id: &str) -> (Vec<u8>, bool, Vec<String>) {
        let committed = self.context.node_available_materialized_inputs(node_id);
        let has_connected_stdin = self.has_required_stdin(node_id);
        let argv_slots = self.required_argv_slots(node_id);
        let fresh_argv_edges = self
            .context
            .connected_input_edges(node_id)
            .into_iter()
            .filter(|edge| edge.to.port == PortKind::Argv)
            .filter_map(|edge| {
                edge.to.slot.map(|slot| {
                    (
                        slot,
                        (
                            self.plan.scope.contains(&edge.from.node_id),
                            edge.id.clone(),
                        ),
                    )
                })
            })
            .collect::<HashMap<_, _>>();

        let use_fresh_stdin = self.has_fresh_stdin_edge(node_id);
        let state = self.state_mut(node_id);

        let stdin = if has_connected_stdin {
            if use_fresh_stdin {
                std::mem::take(&mut state.buffered_stdin)
            } else {
                committed.get("stdin").cloned().unwrap_or_default()
            }
        } else {
            Vec::new()
        };
        let close_after_start = if has_connected_stdin {
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

        let argv = argv_slots
            .into_iter()
            .map(|slot| {
                let key = input_key(PortKind::Argv, Some(slot));
                if let Some((true, edge_id)) = fresh_argv_edges.get(&slot).cloned() {
                    parse_argv_value(
                        state
                            .argv_inputs
                            .remove(&edge_id)
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

    async fn start_node_execute(&mut self, node_id: String) -> Result<(), String> {
        let node = self
            .context
            .nodes
            .get(&node_id)
            .cloned()
            .ok_or_else(|| format!("Unknown node {node_id}"))?;
        match node.kind {
            NodeKind::Text => self.run_text_node(node).await,
            NodeKind::File => self.run_file_node(node).await,
            NodeKind::Display => self.run_display_root(node).await,
            NodeKind::Passthru => self.run_passthru_root(node).await,
            NodeKind::Html => self.run_html_root(node).await,
            NodeKind::Script | NodeKind::AiScript => {
                let (stdin, close_after_start, argv) = self.take_streaming_command_inputs(&node.id);
                self.spawn_command_node(node, stdin, close_after_start, argv, true)
                    .await
            }
            NodeKind::Formula => {
                let (_, _, argv) = self.take_streaming_command_inputs(&node.id);
                self.run_formula_node(node, argv).await
            }
            NodeKind::Exec => {
                let (stdin, close_after_start, argv) = self.take_streaming_command_inputs(&node.id);
                self.spawn_command_node(node, stdin, close_after_start, argv, false)
                    .await
            }
        }
    }

    async fn start_materialized_seed(&mut self, node_id: String) -> Result<(), String> {
        let node = self
            .context
            .nodes
            .get(&node_id)
            .cloned()
            .ok_or_else(|| format!("Unknown node {node_id}"))?;
        self.begin_node(&node.id);
        self.state_mut(&node.id).replaying_materialized = true;
        let outputs = self.context.node_available_materialized_outputs(&node.id);
        for port in source_output_ports(&node.kind) {
            let Some(bytes) = outputs.get(output_key(*port)).cloned() else {
                continue;
            };
            self.handle_output_chunk(&node.id, *port, bytes).await?;
        }
        // Repush replays the materialized result, including its exit status, so downstream
        // propagation follows the same success/failure rules as a fresh execution.
        self.handle_node_exit(&node.id, self.context.node_last_exit_code(&node.id))
            .await
    }

    async fn start_ready_node(&mut self, node_id: String) -> Result<(), String> {
        if self
            .stream_states
            .get(&node_id)
            .map(|state| state.running)
            .unwrap_or(false)
        {
            return Ok(());
        }
        if !self.context.should_execute_node_in_scope(&node_id) {
            return Ok(());
        }
        if self.context.node_has_replayable_outputs(&node_id) {
            self.start_materialized_seed(node_id).await
        } else {
            self.start_node_execute(node_id).await
        }
    }

    fn begin_node(&mut self, node_id: &str) {
        let state = self.state_mut(node_id);
        state.running = true;
        state.scheduled = false;
        state.tainted = false;
        state.output_resets.clear();
        self.live_outputs.remove(node_id);
        self.context.emit_started(node_id);
    }

    async fn run_text_node(&mut self, node: Node) -> Result<(), String> {
        self.begin_node(&node.id);
        self.handle_output_chunk(
            &node.id,
            PortKind::Stdout,
            node.text.clone().unwrap_or_default().into_bytes(),
        )
        .await?;
        self.handle_node_exit(&node.id, Some(0)).await
    }

    async fn run_display_root(&mut self, node: Node) -> Result<(), String> {
        self.begin_node(&node.id);
        let stdin = if self.has_required_stdin(&node.id) {
            self.context
                .node_available_materialized_inputs(&node.id)
                .remove("stdin")
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        self.handle_output_chunk(&node.id, PortKind::Stdout, stdin)
            .await?;
        self.handle_node_exit(&node.id, Some(0)).await
    }

    async fn run_passthru_root(&mut self, node: Node) -> Result<(), String> {
        self.run_display_root(node).await
    }

    async fn run_html_root(&mut self, node: Node) -> Result<(), String> {
        self.begin_node(&node.id);
        self.handle_node_exit(&node.id, Some(0)).await
    }

    async fn run_file_node(&mut self, node: Node) -> Result<(), String> {
        self.begin_node(&node.id);
        let path = node
            .path
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{} is missing a file path", node_label(&node)))?;
        let resolved_path = self.context.resolve_workspace_path(&path);
        let exit_code = match tokio::fs::read(&resolved_path).await {
            Ok(data) => {
                self.handle_output_chunk(&node.id, PortKind::Stdout, data)
                    .await?;
                Some(0)
            }
            Err(error) => {
                self.handle_output_chunk(
                    &node.id,
                    PortKind::Stderr,
                    format!(
                        "file {}: {error}
",
                        path
                    )
                    .into_bytes(),
                )
                .await?;
                Some(1)
            }
        };
        self.handle_node_exit(&node.id, exit_code).await
    }

    async fn run_formula_node(&mut self, node: Node, argv: Vec<String>) -> Result<(), String> {
        self.begin_node(&node.id);
        let source = node
            .formula
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("{} is missing a formula", node_label(&node)))?;
        let exit_code = match formula::evaluate(&source, &argv) {
            Ok(output) => {
                self.handle_output_chunk(&node.id, PortKind::Stdout, output.into_bytes())
                    .await?;
                Some(0)
            }
            Err(error) => {
                self.handle_output_chunk(
                    &node.id,
                    PortKind::Stderr,
                    format!(
                        "{error}
"
                    )
                    .into_bytes(),
                )
                .await?;
                Some(1)
            }
        };
        self.handle_node_exit(&node.id, exit_code).await
    }

    async fn spawn_command_node(
        &mut self,
        node: Node,
        initial_input: Vec<u8>,
        close_after_start: bool,
        argv: Vec<String>,
        shell_script: bool,
    ) -> Result<(), String> {
        if self.state_mut(&node.id).running {
            return Ok(());
        }
        self.begin_node(&node.id);

        let mut command = if shell_script {
            let mut command = Command::new(node.shell_value());
            command
                .arg("-c")
                .arg(node.script.clone().unwrap_or_default())
                .arg("--");
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
            let configured_args = node.args.clone().unwrap_or_default();
            if configured_args.is_empty() {
                for arg in argv {
                    command.arg(arg);
                }
            } else {
                for arg in configured_args {
                    command.arg(arg.resolve(&argv)?);
                }
            }
            command
        };

        command.current_dir(self.context.workspace_cwd());
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
        self.state_mut(&node.id).stdin_writer = Some(stdin_tx.clone());

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

        let events_tx = self.events_tx.clone();
        let stdout_node = node.id.clone();
        let stdout_task = tokio::spawn(async move {
            read_worker_output(events_tx, stdout_node, PortKind::Stdout, stdout).await;
        });

        let events_tx = self.events_tx.clone();
        let stderr_node = node.id.clone();
        let stderr_task = tokio::spawn(async move {
            read_worker_output(events_tx, stderr_node, PortKind::Stderr, stderr).await;
        });

        let cancel = self.context.cancel.clone();
        let events_tx = self.events_tx.clone();
        self.active_external_tasks += 1;
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
            let _ = events_tx.send(ControllerEvent::NodeExited {
                node_id: node.id,
                exit_code,
            });
        });

        Ok(())
    }

    async fn handle_output_chunk(
        &mut self,
        from_node_id: &str,
        port: PortKind,
        chunk: Vec<u8>,
    ) -> Result<(), String> {
        if !chunk.is_empty() {
            self.context
                .emit_port_activity(from_node_id, port, chunk.len());
            self.append_live_output(from_node_id, port, &chunk);
            // The first chunk for a port resets the UI preview; later chunks append onto it.
            let reset = self.state_mut(from_node_id).output_resets.insert(port);
            let _ = self.context.broadcaster.send(ServerEvent::NodeOutput {
                node_id: from_node_id.to_string(),
                port,
                data_base64: encode_bytes(&chunk),
                reset,
                timestamp: now_ms(),
            });
        }

        let edges = self
            .context
            .outgoing
            .get(from_node_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|edge| self.plan.scope.contains(&edge.to.node_id) && edge.from.port == port)
            .collect::<Vec<_>>();

        for edge in edges {
            let flushed = {
                let state = self
                    .edge_buffers
                    .get_mut(&edge.id)
                    .ok_or_else(|| format!("Missing buffer state for edge {}", edge.id))?;
                state.accept(chunk.clone())
            };
            for (reset, payload) in flushed {
                self.schedule_delivery(edge.clone(), port, payload, reset, false, true);
            }
        }
        Ok(())
    }

    async fn handle_node_exit(
        &mut self,
        node_id: &str,
        exit_code: Option<i32>,
    ) -> Result<(), String> {
        let (tainted, replaying_materialized) = self
            .stream_states
            .get(node_id)
            .map(|state| (state.tainted, state.replaying_materialized))
            .unwrap_or((false, false));
        // Only committed exits update materialized state. Tainted or abnormal exits leave the
        // previous committed outputs and exit code intact so downstream reuse stays conservative.
        let materialized = exit_code.is_some() && !tainted && !replaying_materialized;
        // Downstream reuse is stricter: only a clean zero exit may propagate to dependent nodes.
        let propagation_success = exit_code == Some(0) && !tainted;

        if let Some(state) = self.stream_states.get_mut(node_id) {
            state.running = false;
            state.scheduled = false;
            state.stdin_writer = None;
            state.replaying_materialized = false;
        }

        if materialized {
            self.commit_live_outputs(node_id, exit_code);
        } else {
            self.live_outputs.remove(node_id);
        }

        let edges = self
            .context
            .outgoing
            .get(node_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|edge| self.plan.scope.contains(&edge.to.node_id))
            .collect::<Vec<_>>();

        for edge in edges {
            let flushed = {
                let Some(state) = self.edge_buffers.get_mut(&edge.id) else {
                    continue;
                };
                state.finish()
            };
            let delivered_payload = !flushed.is_empty();
            for (reset, payload) in flushed {
                self.schedule_delivery(
                    edge.clone(),
                    edge.from.port,
                    payload,
                    reset,
                    true,
                    propagation_success,
                );
            }
            if !delivered_payload {
                let reset = self
                    .edge_buffers
                    .get(&edge.id)
                    .map(|state| !state.sent_any)
                    .unwrap_or(true);
                self.schedule_delivery(
                    edge.clone(),
                    edge.from.port,
                    Vec::new(),
                    reset,
                    true,
                    propagation_success,
                );
            }
        }

        self.pending_finish_events
            .insert(node_id.to_string(), (exit_code, materialized));
        self.finish_node_if_delivery_drained(node_id);
        Ok(())
    }

    fn finish_node_if_delivery_drained(&mut self, node_id: &str) {
        // A node is not fully finished until every delayed delivery sourced from it has drained.
        // Otherwise pull-style runs can return before a blocked target commits its final input.
        if self
            .pending_delivery_counts
            .get(node_id)
            .copied()
            .unwrap_or(0)
            != 0
        {
            return;
        }
        if let Some((exit_code, materialized)) = self.pending_finish_events.remove(node_id) {
            self.context.emit_finished(node_id, exit_code, materialized);
        }
    }

    fn schedule_delivery(
        &mut self,
        edge: Edge,
        port: PortKind,
        payload: Vec<u8>,
        reset: bool,
        completed: bool,
        success: bool,
    ) {
        let events_tx = self.events_tx.clone();
        let sequence = {
            let next = self
                .next_delivery_sequence
                .entry(edge.id.clone())
                .or_default();
            let sequence = *next;
            *next += 1;
            sequence
        };
        *self
            .pending_delivery_counts
            .entry(edge.from.node_id.clone())
            .or_default() += 1;
        self.active_external_tasks += 1;
        tokio::spawn(async move {
            sleep(Duration::from_millis(250)).await;
            let _ = events_tx.send(ControllerEvent::DeliveryReady(DelayedDelivery {
                sequence,
                edge,
                port,
                payload,
                reset,
                completed,
                success,
            }));
        });
    }

    async fn handle_delivery(
        &mut self,
        edge: Edge,
        payload: Vec<u8>,
        completed: bool,
        success: bool,
    ) -> Result<(), String> {
        if self.context.cancel.is_cancelled() {
            return Ok(());
        }

        let target = self
            .context
            .nodes
            .get(&edge.to.node_id)
            .cloned()
            .ok_or_else(|| format!("Unknown target node {}", edge.to.node_id))?;
        let key = input_key(edge.to.port, edge.to.slot);

        if !payload.is_empty() {
            self.context
                .emit_port_activity(&target.id, edge.to.port, payload.len());
            self.append_live_input(&target.id, &key, &payload);
        } else if completed {
            self.live_inputs
                .entry(target.id.clone())
                .or_default()
                .entry(key.clone())
                .or_insert_with(Vec::new);
        }

        if completed {
            if success {
                self.commit_live_input(&edge, &target.id, &key);
            } else {
                self.discard_live_input(&target.id, &key);
                self.state_mut(&target.id).tainted = true;
            }
        }

        if !self.context.should_execute_node_in_scope(&target.id) {
            return Ok(());
        }

        match target.kind {
            NodeKind::Display | NodeKind::Passthru => {
                let started = if self.state_mut(&target.id).running {
                    false
                } else {
                    self.begin_node(&target.id);
                    true
                };
                if started || !payload.is_empty() {
                    self.handle_output_chunk(&target.id, PortKind::Stdout, payload)
                        .await?;
                }
                if completed {
                    self.handle_node_exit(&target.id, Some(0)).await?;
                }
            }
            NodeKind::Html => {
                let started = if self.state_mut(&target.id).running {
                    false
                } else {
                    self.begin_node(&target.id);
                    true
                };
                if started && completed {
                    self.handle_node_exit(&target.id, Some(0)).await?;
                } else if completed {
                    self.handle_node_exit(&target.id, Some(0)).await?;
                }
            }
            NodeKind::Script | NodeKind::AiScript | NodeKind::Exec | NodeKind::Formula => {
                match edge.to.port {
                    PortKind::Argv => {
                        let state = self.state_mut(&target.id);
                        state
                            .argv_inputs
                            .entry(edge.id.clone())
                            .or_default()
                            .extend_from_slice(&payload);
                        if completed {
                            state.argv_completed.insert(edge.id.clone());
                        }
                        if !success {
                            state.tainted = true;
                        }
                        if completed && self.streaming_command_ready(&target.id) {
                            self.start_ready_node(target.id.clone()).await?;
                        }
                    }
                    PortKind::Stdin => {
                        let existing_writer = {
                            let state = self.state_mut(&target.id);
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
                            self.start_ready_node(target.id.clone()).await?;
                        }
                    }
                    _ => {}
                }
            }
            NodeKind::Text | NodeKind::File => {}
        }

        Ok(())
    }
}

async fn read_worker_output<R>(
    events_tx: mpsc::UnboundedSender<ControllerEvent>,
    node_id: String,
    port: PortKind,
    mut reader: R,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut buffer = [0_u8; PROCESS_OUTPUT_READ_CHUNK_SIZE];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                let _ = events_tx.send(ControllerEvent::NodeOutputChunk {
                    node_id: node_id.clone(),
                    port,
                    chunk: buffer[..read].to_vec(),
                });
            }
            Err(error) => {
                error!("Failed to read output for {}: {}", node_id, error);
                break;
            }
        }
    }
}

#[derive(Default, Clone)]
struct StreamingNodeState {
    running: bool,
    scheduled: bool,
    tainted: bool,
    replaying_materialized: bool,
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

fn materialized_value_map(
    node: &Node,
    store: &MaterializedOutputStore,
) -> HashMap<String, Vec<u8>> {
    let mut values: HashMap<String, Vec<u8>> = HashMap::new();
    for (key, id) in &node.materialized.inputs {
        if let Some(entry) = store.get(id) {
            values.insert(key.clone(), decode_entry_bytes(entry));
        }
    }
    for (key, id) in &node.materialized.outputs {
        if let Some(entry) = store.get(id) {
            values.insert(key.clone(), decode_entry_bytes(entry));
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
    use crate::model::{
        AutoRunConfig, ExecutionAction, ExecutionRequest, MatOutEntry, MaterializedReferrer,
        PortKind as ModelPortKind, Position, ProducedBy, Size, WorkspaceUi,
    };
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
            formula: None,
            materialized: crate::model::NodeMaterialized {
                inputs: HashMap::new(),
                outputs: HashMap::new(),
                last_exit_code: Some(0),
            },
            auto_run: Some(AutoRunConfig {
                enabled: false,
                mode: ExecutionAction::RerunPush,
                interval_ms: 1000,
            }),
            ui_state: Default::default(),
        }
    }

    fn edge(
        id: &str,
        from: &str,
        from_port: PortKind,
        to: &str,
        to_port: PortKind,
        slot: Option<usize>,
    ) -> Edge {
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
            created_at: 0,
            sort_order: 0,
            cwd: default_cwd(),
            openai_api_key: Some(String::new()),
            nodes,
            edges,
            tuckspace: Vec::new(),
            ui: WorkspaceUi::default(),
        }
    }

    fn upstream_closure(workspace: &Workspace, start: &str) -> HashSet<String> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::from([start.to_string()]);
        while let Some(node_id) = queue.pop_front() {
            if !visited.insert(node_id.clone()) {
                continue;
            }
            for edge in workspace.edges.iter().filter(|edge| edge.to.node_id == node_id) {
                queue.push_back(edge.from.node_id.clone());
            }
        }
        visited
    }

    fn downstream_closure(workspace: &Workspace, start: &str) -> HashSet<String> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::from([start.to_string()]);
        while let Some(node_id) = queue.pop_front() {
            if !visited.insert(node_id.clone()) {
                continue;
            }
            for edge in workspace.edges.iter().filter(|edge| edge.from.node_id == node_id) {
                queue.push_back(edge.to.node_id.clone());
            }
        }
        visited
    }

    fn root_ids(workspace: &Workspace, scope: &HashSet<String>) -> Vec<String> {
        let mut roots = scope
            .iter()
            .filter(|node_id| {
                !workspace
                    .edges
                    .iter()
                    .any(|edge| edge.to.node_id == **node_id && scope.contains(&edge.from.node_id))
            })
            .cloned()
            .collect::<Vec<_>>();
        roots.sort();
        roots
    }

    fn connected_input_keys(workspace: &Workspace, node_id: &str) -> HashSet<String> {
        workspace
            .edges
            .iter()
            .filter(|edge| edge.to.node_id == node_id)
            .filter_map(|edge| match edge.to.port {
                PortKind::Stdin => Some("stdin".to_string()),
                PortKind::Argv => Some(format!("argv-{}", edge.to.slot.unwrap_or(1))),
                PortKind::Stdout | PortKind::Stderr => None,
            })
            .collect()
    }

    fn connected_output_ports(
        workspace: &Workspace,
        scope: &HashSet<String>,
        node_id: &str,
    ) -> HashSet<String> {
        let mut ports = workspace
            .edges
            .iter()
            .filter(|edge| {
                edge.from.node_id == node_id
                    && scope.contains(&edge.from.node_id)
                    && scope.contains(&edge.to.node_id)
            })
            .filter_map(|edge| match edge.from.port {
                PortKind::Stdout => Some("stdout".to_string()),
                PortKind::Stderr => Some("stderr".to_string()),
                PortKind::Stdin | PortKind::Argv => None,
            })
            .collect::<HashSet<_>>();
        if ports.is_empty() {
            let node = workspace
                .nodes
                .iter()
                .find(|node| node.id == node_id)
                .expect("target node");
            ports.extend(
                source_output_ports(&node.kind)
                    .iter()
                    .map(|port| output_key(*port).to_string()),
            );
        }
        ports
    }

    fn prepare_workspace_materialized(
        workspace: &Workspace,
        scope: &HashSet<String>,
        target_node_id: &str,
        allowed_input_keys: Option<&HashSet<String>>,
        allowed_output_ports: Option<&HashSet<String>>,
    ) -> Workspace {
        let mut next = workspace.clone();
        next.nodes.retain(|node| scope.contains(&node.id));
        for node in &mut next.nodes {
            if node.id == target_node_id {
                if let Some(keys) = allowed_input_keys {
                    node.materialized.inputs.retain(|key, _| keys.contains(key));
                }
                if let Some(ports) = allowed_output_ports {
                    node.materialized.outputs.retain(|key, _| ports.contains(key));
                }
            }
        }
        next.edges
            .retain(|edge| scope.contains(&edge.from.node_id) && scope.contains(&edge.to.node_id));
        next
    }

    fn request_for_action(
        workspace: &Workspace,
        node_id: &str,
        action: ExecutionAction,
    ) -> ExecutionRequest {
        let target = workspace
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .expect("target node");
        let mut provided_ids = HashSet::new();
        let mut allowed_input_keys = None;
        let mut allowed_output_ports = None;
        let (scope, seeds, blocked_node_ids) = match action {
            ExecutionAction::PullInputs => {
                let scope = upstream_closure(workspace, node_id);
                let seeds = root_ids(workspace, &scope);
                (scope, seeds, vec![node_id.to_string()])
            }
            ExecutionAction::PullRun => {
                let scope = upstream_closure(workspace, node_id);
                let seeds = root_ids(workspace, &scope);
                (scope, seeds, Vec::new())
            }
            ExecutionAction::Rerun => {
                let keys = connected_input_keys(workspace, node_id);
                for key in &keys {
                    if let Some(id) = target.materialized.inputs.get(key) {
                        provided_ids.insert(id.clone());
                    }
                }
                allowed_input_keys = Some(keys);
                (
                    HashSet::from([node_id.to_string()]),
                    vec![node_id.to_string()],
                    Vec::new(),
                )
            }
            ExecutionAction::RerunPush => {
                let keys = connected_input_keys(workspace, node_id);
                for key in &keys {
                    if let Some(id) = target.materialized.inputs.get(key) {
                        provided_ids.insert(id.clone());
                    }
                }
                allowed_input_keys = Some(keys);
                (
                    downstream_closure(workspace, node_id),
                    vec![node_id.to_string()],
                    Vec::new(),
                )
            }
            ExecutionAction::Repush => {
                let scope = downstream_closure(workspace, node_id);
                let ports = connected_output_ports(workspace, &scope, node_id);
                for port in &ports {
                    if let Some(id) = target.materialized.outputs.get(port) {
                        provided_ids.insert(id.clone());
                    }
                }
                allowed_output_ports = Some(ports);
                (
                    scope,
                    vec![node_id.to_string()],
                    vec![node_id.to_string()],
                )
            }
        };
        ExecutionRequest {
            workspace: prepare_workspace_materialized(
                workspace,
                &scope,
                node_id,
                allowed_input_keys.as_ref(),
                allowed_output_ports.as_ref(),
            ),
            seed_node_ids: seeds,
            provided_matout_ids: {
                let mut ids = provided_ids.into_iter().collect::<Vec<_>>();
                ids.sort();
                ids
            },
            blocked_node_ids,
        }
    }

    fn context_for_action(
        exec_id: &str,
        workspace: Workspace,
        store: MaterializedOutputStore,
        node_id: &str,
        action: ExecutionAction,
        broadcaster: broadcast::Sender<ServerEvent>,
    ) -> Arc<ExecutionContext> {
        Arc::new(
            ExecutionContext::new(
                exec_id.to_string(),
                request_for_action(&workspace, node_id, action),
                store,
                broadcaster,
                CancellationToken::new(),
            )
            .expect("context"),
        )
    }

    fn seed_materialized_text(
        node: &mut Node,
        store: &mut MaterializedOutputStore,
        key: &str,
        value: &str,
    ) {
        let port = if key == "stderr" {
            ModelPortKind::Stderr
        } else {
            ModelPortKind::Stdout
        };
        let id = crate::id::encode_matout_id();
        store.insert(
            id.clone(),
            MatOutEntry {
                data_base64: encode_bytes(value.as_bytes()),
                produced_by: ProducedBy {
                    exec_id: "seed".to_string(),
                    node_id: node.id.clone(),
                    port,
                },
                referrers: vec![MaterializedReferrer {
                    node_id: node.id.clone(),
                    key: key.to_string(),
                }],
            },
        );
        if key == "stdout" || key == "stderr" {
            node.materialized.outputs.insert(key.to_string(), id);
        } else {
            node.materialized.inputs.insert(key.to_string(), id);
        }
    }

    fn materialized_text(context: &ExecutionContext, node_id: &str, key: &str) -> String {
        let bytes = context
            .materialized_values
            .lock()
            .get(node_id)
            .and_then(|values| values.get(key))
            .cloned()
            .unwrap_or_default();
        String::from_utf8(bytes).expect("materialized utf8")
    }

    async fn wait_for_finish(
        rx: &mut broadcast::Receiver<ServerEvent>,
        exec_id: &str,
        node_id: &str,
    ) -> Option<i32> {
        timeout(Duration::from_secs(3), async {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecFinished {
                        exec_id: seen,
                        node_id: seen_node,
                        exit_code,
                        ..
                    }) if seen == exec_id && seen_node == node_id => return exit_code,
                    Ok(ServerEvent::Error { message, .. }) => {
                        panic!("unexpected execution error: {message}")
                    }
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await
        .expect("execution never completed")
    }

    mod argv {
        use super::*;

        fn argv_context(action: ExecutionAction) -> Arc<ExecutionContext> {
            let mut source = node(NodeKind::Script, "a");
            source.script = Some("printf 'testing\n'".to_string());
            let mut target = node(NodeKind::Script, "b");
            target.script = Some("printf '%s' \"$1\"".to_string());
            context_for_action(
                "argv-exec",
                workspace(
                    vec![source, target],
                    vec![edge(
                        "edge-ab",
                        "a",
                        PortKind::Stdout,
                        "b",
                        PortKind::Argv,
                        Some(1),
                    )],
                ),
                HashMap::new(),
                if matches!(action, ExecutionAction::PullRun) {
                    "b"
                } else {
                    "a"
                },
                action,
                broadcast::channel(64).0,
            )
        }

        #[tokio::test]
        async fn argv_test_delivery_ordering() {
            let context = argv_context(ExecutionAction::RerunPush);
            let plan = context.validate_request().expect("plan");
            let edge = context.workspace.edges[0].clone();
            let mut controller = RunController::new(context, plan);
            controller.init();

            controller
                .handle_event(ControllerEvent::DeliveryReady(DelayedDelivery {
                    sequence: 1,
                    edge: edge.clone(),
                    port: PortKind::Stdout,
                    payload: Vec::new(),
                    reset: false,
                    completed: true,
                    success: true,
                }))
                .await
                .expect("completion event");
            assert!(
                !controller
                    .stream_states
                    .get("b")
                    .map(|state| state.running)
                    .unwrap_or(false),
                "argv completion must not start the target before earlier argv bytes arrive"
            );

            controller
                .handle_event(ControllerEvent::DeliveryReady(DelayedDelivery {
                    sequence: 0,
                    edge,
                    port: PortKind::Stdout,
                    payload: b"testing
"
                    .to_vec(),
                    reset: true,
                    completed: false,
                    success: true,
                }))
                .await
                .expect("payload event");
            assert!(
                controller
                    .stream_states
                    .get("b")
                    .map(|state| state.running)
                    .unwrap_or(false),
                "argv payload plus queued completion should start the target once both deliveries drain in order"
            );
        }

        #[tokio::test]
        async fn argv_test_pull_run() {
            let context = argv_context(ExecutionAction::PullRun);
            context.clone().run().await.expect("run");

            assert_eq!(materialized_text(&context, "a", "stdout"), "testing\n");
            assert_eq!(materialized_text(&context, "b", "argv-1"), "testing\n");
            assert_eq!(materialized_text(&context, "b", "stdout"), "testing");
            assert_eq!(materialized_text(&context, "b", "stderr"), "");
        }

        #[tokio::test]
        async fn argv_test_rerun_push() {
            for iteration in 0..50 {
                let context = argv_context(ExecutionAction::RerunPush);
                context.clone().run().await.expect("run");

                assert_eq!(
                    materialized_text(&context, "a", "stdout"),
                    "testing\n",
                    "iteration {iteration}: source stdout"
                );
                assert_eq!(
                    materialized_text(&context, "b", "argv-1"),
                    "testing\n",
                    "iteration {iteration}: target argv-1"
                );
                assert_eq!(
                    materialized_text(&context, "b", "stdout"),
                    "testing",
                    "iteration {iteration}: target stdout"
                );
                assert_eq!(
                    materialized_text(&context, "b", "stderr"),
                    "",
                    "iteration {iteration}: target stderr"
                );
            }
        }

        #[tokio::test]
        async fn exec_test_configured_args_can_mix_literals_and_argv_slots() {
            let mut source = node(NodeKind::Script, "a");
            source.script = Some("printf 'wired'".to_string());
            let mut target = node(NodeKind::Exec, "b");
            target.path = Some("printf".to_string());
            target.args = Some(vec![
                crate::model::ExecArg::Literal {
                    value: "%s|%s".to_string(),
                },
                crate::model::ExecArg::Argv { slot: 1 },
                crate::model::ExecArg::Literal {
                    value: "fixed".to_string(),
                },
            ]);
            let context = context_for_action(
                "exec-configured-args",
                workspace(
                    vec![source, target],
                    vec![edge(
                        "edge-ab",
                        "a",
                        PortKind::Stdout,
                        "b",
                        PortKind::Argv,
                        Some(1),
                    )],
                ),
                HashMap::new(),
                "b",
                ExecutionAction::PullRun,
                broadcast::channel(64).0,
            );

            context.clone().run().await.expect("run");

            assert_eq!(materialized_text(&context, "b", "stdout"), "wired|fixed");
        }

        #[tokio::test]
        async fn argv_test_repush() {
            let mut store = HashMap::new();
            let mut source = node(NodeKind::Script, "a");
            seed_materialized_text(&mut source, &mut store, "stdout", "testing\n");
            seed_materialized_text(&mut source, &mut store, "stderr", "");
            let mut target = node(NodeKind::Script, "b");
            target.script = Some("printf '%s' \"$1\"".to_string());
            let context = context_for_action(
                "argv-repush",
                workspace(
                    vec![source, target],
                    vec![edge(
                        "edge-ab",
                        "a",
                        PortKind::Stdout,
                        "b",
                        PortKind::Argv,
                        Some(1),
                    )],
                ),
                store,
                "a",
                ExecutionAction::Repush,
                broadcast::channel(64).0,
            );

            context.clone().run().await.expect("run");

            assert_eq!(materialized_text(&context, "b", "argv-1"), "testing\n");
            assert_eq!(materialized_text(&context, "b", "stdout"), "testing");
            assert_eq!(materialized_text(&context, "b", "stderr"), "");
        }
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
            edge(id, from, PortKind::Stdout, to, PortKind::Stdin, None)
        }

        fn seed(node: &mut Node, store: &mut MaterializedOutputStore, key: &str, value: &str) {
            seed_materialized_text(node, store, key, value);
        }

        fn build_smoke_context(
            action: ExecutionAction,
        ) -> (Arc<ExecutionContext>, tempfile::TempDir) {
            let tempdir = tempdir().expect("tempdir");
            let mut store = HashMap::new();
            let mut a = smoke_script("a", "printf 'A' >> trace.log; printf 'a'");
            let mut b = smoke_script(
                "b",
                r#"printf 'B' >> trace.log; input=$(cat); printf '%s b' "$input""#,
            );
            let mut c = smoke_script(
                "c",
                r#"printf 'C' >> trace.log; input=$(cat); printf '%s c' "$input""#,
            );

            seed(&mut a, &mut store, "stdout", "old-a");
            seed(&mut a, &mut store, "stderr", "old-a-err");
            seed(&mut b, &mut store, "stdin", "old-b-in");
            seed(&mut b, &mut store, "stdout", "old-b-out");
            seed(&mut b, &mut store, "stderr", "old-b-err");
            seed(&mut c, &mut store, "stdin", "old-c-in");
            seed(&mut c, &mut store, "stdout", "old-c-out");
            seed(&mut c, &mut store, "stderr", "old-c-err");

            let mut ws = workspace(
                vec![a, b, c],
                vec![
                    smoke_edge("edge-ab", "a", "b"),
                    smoke_edge("edge-bc", "b", "c"),
                ],
            );
            ws.cwd = tempdir.path().to_string_lossy().into_owned();
            let context =
                context_for_action("smoke-exec", ws, store, "b", action, broadcast::channel(64).0);
            (context, tempdir)
        }

        fn trace_recomputed_nodes(tempdir: &tempfile::TempDir) -> BTreeSet<String> {
            let trace =
                std::fs::read_to_string(tempdir.path().join("trace.log")).unwrap_or_default();
            trace
                .chars()
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
            for node in &context.workspace.nodes {
                let mut ports = BTreeSet::new();
                ports.extend(node.materialized.inputs.keys().cloned());
                ports.extend(
                    materialized_output_ports(&node.kind)
                        .iter()
                        .map(|port| output_key(*port).to_string()),
                );
                let values = ports
                    .into_iter()
                    .map(|port| {
                        let bytes = materialized
                            .get(&node.id)
                            .and_then(|node_ports| node_ports.get(&port))
                            .cloned()
                            .unwrap_or_default();
                        (
                            port,
                            String::from_utf8(bytes).expect("materialized utf8"),
                        )
                    })
                    .collect();
                snapshot.insert(node.id.clone(), values);
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
            let (context, tempdir) = build_smoke_context(action);
            let seeded = final_snapshot(&context);
            context.clone().run().await.expect("run");

            let recomputed = trace_recomputed_nodes(&tempdir);
            let final_values = final_snapshot(&context);
            let rematerialized = rematerialized_ports(&seeded, &final_values);

            assert_eq!(
                recomputed,
                expected_recomputed
                    .iter()
                    .map(|node| (*node).to_string())
                    .collect(),
                "unexpected recomputed nodes for {:?}",
                action
            );
            assert_eq!(
                rematerialized,
                expected_rematerialized
                    .iter()
                    .map(|port| (*port).to_string())
                    .collect(),
                "unexpected rematerialized ports for {:?}",
                action
            );
            assert_eq!(
                final_values, expected_snapshot,
                "unexpected final snapshot for {:?}",
                action
            );
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
                BTreeMap::from([(
                    "b".to_string(),
                    BTreeMap::from([
                        ("stdin".to_string(), "old-b-in".to_string()),
                        ("stdout".to_string(), "old-b-in b".to_string()),
                        ("stderr".to_string(), "".to_string()),
                    ]),
                )]),
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
                        "b".to_string(),
                        BTreeMap::from([
                            ("stdin".to_string(), "old-b-in".to_string()),
                            ("stdout".to_string(), "old-b-out".to_string()),
                            ("stderr".to_string(), "".to_string()),
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
                edge(
                    "edge-source-a",
                    "source",
                    PortKind::Stdout,
                    "pass-a",
                    PortKind::Stdin,
                    None,
                ),
                edge(
                    "edge-source-b",
                    "source",
                    PortKind::Stdout,
                    "pass-b",
                    PortKind::Stdin,
                    None,
                ),
                edge(
                    "edge-a-target",
                    "pass-a",
                    PortKind::Stdout,
                    "target",
                    PortKind::Stdin,
                    None,
                ),
                edge(
                    "edge-b-target",
                    "pass-b",
                    PortKind::Stdout,
                    "target",
                    PortKind::Argv,
                    Some(1),
                ),
            ],
        );

        let exec_id = manager.run(
            request_for_action(&workspace, "target", ExecutionAction::PullInputs),
            HashMap::new(),
        );
        let mut source_starts = 0;
        timeout(Duration::from_secs(3), async {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecStarted {
                        exec_id: seen,
                        node_id,
                        ..
                    }) if seen == exec_id && node_id == "source" => {
                        source_starts += 1;
                    }
                    Ok(ServerEvent::ExecFinished {
                        exec_id: seen,
                        node_id,
                        ..
                    }) if seen == exec_id && node_id == "pass-b" => break,
                    Ok(ServerEvent::Error { message, .. }) => {
                        panic!("unexpected execution error: {message}")
                    }
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await
        .expect("pull_inputs execution did not finish");

        assert_eq!(
            source_starts, 1,
            "shared dependency should execute once per pull_inputs run"
        );
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
                edge(
                    "edge-source-a",
                    "source",
                    PortKind::Stdout,
                    "pass-a",
                    PortKind::Stdin,
                    None,
                ),
                edge(
                    "edge-source-b",
                    "source",
                    PortKind::Stdout,
                    "pass-b",
                    PortKind::Stdin,
                    None,
                ),
                edge(
                    "edge-a-target",
                    "pass-a",
                    PortKind::Stdout,
                    "target",
                    PortKind::Stdin,
                    None,
                ),
                edge(
                    "edge-b-target",
                    "pass-b",
                    PortKind::Stdout,
                    "target",
                    PortKind::Argv,
                    Some(1),
                ),
            ],
        );

        let exec_id = manager.run(
            request_for_action(&workspace, "target", ExecutionAction::PullRun),
            HashMap::new(),
        );
        let mut source_starts = 0;
        timeout(Duration::from_secs(3), async {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecStarted {
                        exec_id: seen,
                        node_id,
                        ..
                    }) if seen == exec_id && node_id == "source" => {
                        source_starts += 1;
                    }
                    Ok(ServerEvent::ExecFinished {
                        exec_id: seen,
                        node_id,
                        ..
                    }) if seen == exec_id && node_id == "target" => break,
                    Ok(ServerEvent::Error { message, .. }) => {
                        panic!("unexpected execution error: {message}")
                    }
                    Ok(_) => {}
                    Err(error) => panic!("event stream closed: {error}"),
                }
            }
        })
        .await
        .expect("pull_run execution did not finish");

        assert_eq!(
            source_starts, 1,
            "shared dependency should execute once per pull_run"
        );
    }

    #[tokio::test]
    async fn rerun_push_reuses_cached_sibling_inputs() {
        let (tx, _) = broadcast::channel(128);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut store = HashMap::new();
        let mut text = node(NodeKind::Text, "text-1");
        text.text = Some("hello\n".to_string());
        let mut script = node(NodeKind::Script, "script-1");
        script.script = Some("printf '%s %s\n' \"$1\" \"$(cat)\"".to_string());
        seed_materialized_text(&mut script, &mut store, "argv-1", "world\n");
        let workspace = workspace(
            vec![text, script],
            vec![
                edge(
                    "edge-1",
                    "text-1",
                    PortKind::Stdout,
                    "script-1",
                    PortKind::Stdin,
                    None,
                ),
                edge(
                    "edge-2",
                    "text-1",
                    PortKind::Stdout,
                    "script-1",
                    PortKind::Argv,
                    Some(1),
                ),
            ],
        );

        let exec_id = manager.run(
            request_for_action(&workspace, "text-1", ExecutionAction::RerunPush),
            store,
        );
        assert_eq!(
            wait_for_finish(&mut rx, &exec_id, "script-1").await,
            Some(0)
        );
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
            vec![edge(
                "edge-1",
                "script-1",
                PortKind::Stdout,
                "script-2",
                PortKind::Stdin,
                None,
            )],
        );

        let exec_id = manager.run(
            request_for_action(&workspace, "script-1", ExecutionAction::RerunPush),
            HashMap::new(),
        );
        let mut source_finished_at = None;
        let mut sink_started_at = None;
        timeout(Duration::from_secs(3), async {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::ExecStarted {
                        exec_id: seen,
                        node_id,
                        timestamp,
                    }) if seen == exec_id && node_id == "script-2" => {
                        sink_started_at = Some(timestamp);
                        if source_finished_at.is_some() {
                            break;
                        }
                    }
                    Ok(ServerEvent::ExecFinished {
                        exec_id: seen,
                        node_id,
                        timestamp,
                        ..
                    }) if seen == exec_id && node_id == "script-1" => {
                        source_finished_at = Some(timestamp);
                        if sink_started_at.is_some() {
                            break;
                        }
                    }
                    Ok(ServerEvent::Error { message, .. }) => {
                        panic!("unexpected execution error: {message}")
                    }
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
    async fn failed_rerun_push_commits_source_outputs_but_not_downstream() {
        let (tx, _) = broadcast::channel(256);
        let mut store = HashMap::new();
        let mut source = node(NodeKind::Script, "script-1");
        source.script = Some("printf 'fresh\n'; exit 1".to_string());
        seed_materialized_text(&mut source, &mut store, "stdout", "old-output\n");
        let mut sink = node(NodeKind::Script, "script-2");
        sink.script = Some("cat >/dev/null".to_string());
        seed_materialized_text(&mut sink, &mut store, "stdin", "old-input\n");
        let context = context_for_action(
            "exec-test",
            workspace(
                vec![source, sink],
                vec![edge(
                    "edge-1",
                    "script-1",
                    PortKind::Stdout,
                    "script-2",
                    PortKind::Stdin,
                    None,
                )],
            ),
            store,
            "script-1",
            ExecutionAction::RerunPush,
            tx,
        );

        context.clone().run().await.expect("run");

        assert_eq!(
            context
                .materialized_values
                .lock()
                .get("script-1")
                .and_then(|ports| ports.get("stdout"))
                .cloned(),
            Some(b"fresh\n".to_vec())
        );
        assert_eq!(context.node_last_exit_code("script-1"), Some(1));
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
        let mut store = HashMap::new();
        let mut file = node(NodeKind::File, "file-1");
        seed_materialized_text(&mut file, &mut store, "stdout", "");
        seed_materialized_text(&mut file, &mut store, "stderr", "");
        let workspace = workspace(vec![file], vec![]);

        let exec_id = manager.run(
            request_for_action(&workspace, "file-1", ExecutionAction::Repush),
            store,
        );
        assert_eq!(wait_for_finish(&mut rx, &exec_id, "file-1").await, Some(0));
    }

    #[tokio::test]
    async fn display_pull_run_materializes_stdout_from_stdin() {
        let (tx, _) = broadcast::channel(64);
        let context = context_for_action(
            "display-pull-run",
            workspace(
                {
                    let mut source = node(NodeKind::Text, "text-1");
                    source.text = Some("watch me".to_string());
                    let display = node(NodeKind::Display, "display-1");
                    vec![source, display]
                },
                vec![edge(
                    "edge-1",
                    "text-1",
                    PortKind::Stdout,
                    "display-1",
                    PortKind::Stdin,
                    None,
                )],
            ),
            HashMap::new(),
            "display-1",
            ExecutionAction::PullRun,
            tx,
        );

        context.clone().run().await.expect("run");
        assert_eq!(
            context
                .materialized_values
                .lock()
                .get("display-1")
                .and_then(|ports| ports.get("stdout"))
                .cloned(),
            Some(b"watch me".to_vec())
        );
    }

    #[tokio::test]
    async fn pull_run_commits_failing_upstream_but_not_downstream() {
        let (tx, _) = broadcast::channel(64);
        let mut store = HashMap::new();
        let mut a = node(NodeKind::Script, "a");
        a.script = Some("printf 'A'; exit 1".to_string());
        let mut b = node(NodeKind::Script, "b");
        b.script = Some("printf 'B'".to_string());
        let mut c = node(NodeKind::Script, "c");
        c.script = Some("printf '%s %s C' \"$1\" \"$2\"".to_string());
        seed_materialized_text(&mut c, &mut store, "stdout", "old-c");
        let mut d = node(NodeKind::Script, "d");
        d.script = Some("printf '%s D' \"$1\"".to_string());
        seed_materialized_text(&mut d, &mut store, "stdout", "old-d");
        let mut e = node(NodeKind::Script, "e");
        e.script = Some("printf '%s E' \"$1\"".to_string());
        seed_materialized_text(&mut e, &mut store, "stdout", "old-e");
        let context = context_for_action(
            "pull-run-fail",
            workspace(
                vec![a, b, c, d, e],
                vec![
                    edge(
                        "edge-a-c",
                        "a",
                        PortKind::Stdout,
                        "c",
                        PortKind::Argv,
                        Some(1),
                    ),
                    edge(
                        "edge-b-c",
                        "b",
                        PortKind::Stdout,
                        "c",
                        PortKind::Argv,
                        Some(2),
                    ),
                    edge(
                        "edge-c-d",
                        "c",
                        PortKind::Stdout,
                        "d",
                        PortKind::Argv,
                        Some(1),
                    ),
                    edge(
                        "edge-b-e",
                        "b",
                        PortKind::Stdout,
                        "e",
                        PortKind::Argv,
                        Some(1),
                    ),
                ],
            ),
            store,
            "d",
            ExecutionAction::PullRun,
            tx,
        );

        context.clone().run().await.expect("run");

        assert_eq!(materialized_text(&context, "a", "stdout"), "A");
        assert_eq!(context.node_last_exit_code("a"), Some(1));
        assert_eq!(materialized_text(&context, "b", "stdout"), "B");
        assert_eq!(context.node_last_exit_code("b"), Some(0));
        assert_eq!(materialized_text(&context, "c", "stdout"), "old-c");
        assert_eq!(materialized_text(&context, "d", "stdout"), "old-d");
    }

    #[tokio::test]
    async fn rerun_uses_materialized_inputs_even_if_upstream_last_exit_failed() {
        let (tx, _) = broadcast::channel(64);
        let mut store = HashMap::new();
        let mut source = node(NodeKind::Script, "source");
        source.materialized.last_exit_code = Some(1);
        let mut target = node(NodeKind::Script, "target");
        target.script = Some("cat".to_string());
        seed_materialized_text(&mut target, &mut store, "stdin", "old-input\n");
        let context = context_for_action(
            "rerun-materialized-inputs",
            workspace(
                vec![source, target],
                vec![edge(
                    "edge-1",
                    "source",
                    PortKind::Stdout,
                    "target",
                    PortKind::Stdin,
                    None,
                )],
            ),
            store,
            "target",
            ExecutionAction::Rerun,
            tx,
        );

        context.clone().run().await.expect("run");
        assert_eq!(
            materialized_text(&context, "target", "stdout"),
            "old-input\n"
        );
        assert_eq!(context.node_last_exit_code("target"), Some(0));
    }

    #[test]
    fn request_rejects_missing_provided_matout_ids() {
        let target = node(NodeKind::Script, "target");
        let request = ExecutionRequest {
            workspace: workspace(vec![target], vec![]),
            seed_node_ids: vec!["target".to_string()],
            provided_matout_ids: vec!["missing".to_string()],
            blocked_node_ids: Vec::new(),
        };
        let error = ExecutionContext::new(
            "missing-provided".to_string(),
            request,
            HashMap::new(),
            broadcast::channel(8).0,
            CancellationToken::new(),
        )
        .err()
        .expect("request should fail");
        assert!(error.contains("missing materialized output missing"));
    }

    #[tokio::test]
    async fn repush_replays_failed_exit_without_materializing_downstream() {
        let (tx, _) = broadcast::channel(64);
        let mut store = HashMap::new();
        let mut source = node(NodeKind::Script, "source");
        seed_materialized_text(&mut source, &mut store, "stdout", "watch me\n");
        seed_materialized_text(&mut source, &mut store, "stderr", "");
        source.materialized.last_exit_code = Some(1);
        let mut sink = node(NodeKind::Script, "sink");
        sink.script = Some("cat".to_string());
        seed_materialized_text(&mut sink, &mut store, "stdin", "old-input\n");
        seed_materialized_text(&mut sink, &mut store, "stdout", "old-output\n");
        let context = context_for_action(
            "repush-failed-status",
            workspace(
                vec![source, sink],
                vec![edge(
                    "edge-1",
                    "source",
                    PortKind::Stdout,
                    "sink",
                    PortKind::Stdin,
                    None,
                )],
            ),
            store,
            "source",
            ExecutionAction::Repush,
            tx,
        );

        context.clone().run().await.expect("run");
        assert_eq!(
            materialized_text(&context, "source", "stdout"),
            "watch me\n"
        );
        assert_eq!(context.node_last_exit_code("source"), Some(1));
        assert_eq!(materialized_text(&context, "sink", "stdin"), "old-input\n");
        assert_eq!(
            materialized_text(&context, "sink", "stdout"),
            "old-output\n"
        );
    }

    #[tokio::test]
    async fn display_repush_is_rejected_without_outputs() {
        let (tx, _) = broadcast::channel(64);
        let context = context_for_action(
            "display-repush",
            workspace(vec![node(NodeKind::Display, "display-1")], vec![]),
            HashMap::new(),
            "display-1",
            ExecutionAction::Repush,
            tx,
        );

        let error = context
            .clone()
            .run()
            .await
            .expect_err("repush should fail");
        assert!(
            error.contains("has no outputs to push"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn formula_pull_run_evaluates_from_argv_input() {
        let (tx, _) = broadcast::channel(64);
        let manager = ExecutionManager::new(tx.clone());
        let mut rx = tx.subscribe();
        let mut source = node(NodeKind::Text, "text-1");
        source.text = Some("4".to_string());
        let mut formula_node = node(NodeKind::Formula, "formula-1");
        formula_node.formula = Some("$1^2 + 1".to_string());
        let workspace = workspace(
            vec![source, formula_node],
            vec![edge(
                "edge-1",
                "text-1",
                PortKind::Stdout,
                "formula-1",
                PortKind::Argv,
                Some(1),
            )],
        );

        let exec_id = manager.run(
            request_for_action(&workspace, "formula-1", ExecutionAction::PullRun),
            HashMap::new(),
        );
        assert_eq!(
            wait_for_finish(&mut rx, &exec_id, "formula-1").await,
            Some(0)
        );
    }

    #[tokio::test]
    async fn formula_rerun_uses_materialized_argv() {
        let (tx, _) = broadcast::channel(64);
        let mut store = HashMap::new();
        let source = node(NodeKind::Text, "text-1");
        let mut formula_node = node(NodeKind::Formula, "formula-1");
        formula_node.formula = Some("let x = $1 + 2 in x * 3".to_string());
        seed_materialized_text(&mut formula_node, &mut store, "argv-1", "5");
        let context = context_for_action(
            "formula-rerun",
            workspace(
                vec![source, formula_node],
                vec![edge(
                    "edge-1",
                    "text-1",
                    PortKind::Stdout,
                    "formula-1",
                    PortKind::Argv,
                    Some(1),
                )],
            ),
            store,
            "formula-1",
            ExecutionAction::Rerun,
            tx,
        );

        context.clone().run().await.expect("run");
        assert_eq!(
            context
                .materialized_values
                .lock()
                .get("formula-1")
                .and_then(|ports| ports.get("stdout"))
                .cloned(),
            Some(b"21".to_vec())
        );
    }
}
