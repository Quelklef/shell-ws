mod execution;
mod formula;
mod id;
mod materialized_output_store;
mod materialized_outputs;
mod model;
mod openai;
mod port_schema;
mod tuckspace_store;
mod workspace_store;

use std::{
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    process::Stdio,
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use execution::ExecutionManager;
use futures::{sink::SinkExt, stream::StreamExt};
use id::encode_workspace_id;
use materialized_output_store::MaterializedOutputStoreHandle;
use model::{ClientEvent, MaterializedOutputStore, ServerEvent, TuckedSubgraph, Workspace};
use openai::{generate_script, GenerateScriptRequest, GenerateScriptResponse};
use tokio::{fs, sync::broadcast};
use tower_http::{cors::CorsLayer, services::ServeDir};
use tracing::{debug, error, info};
use tuckspace_store::TuckspaceStore;
use workspace_store::WorkspaceStore;

#[derive(Clone)]
struct AppState {
    store: WorkspaceStore,
    tuckspace_store: TuckspaceStore,
    materialized_output_store: MaterializedOutputStoreHandle,
    // Persistence stays separate from execution. The execution manager consumes
    // workspace snapshots, but save/load state must not be hidden inside it.
    execution: ExecutionManager,
    broadcaster: broadcast::Sender<ServerEvent>,
    openai_client: reqwest::Client,
}

const APP_DATA_DIR: &str = "app-data";
const APP_WORKSPACES_DIR: &str = "workspaces";
const APP_TUCKSPACE_FILE: &str = "tuckspace.json";
const APP_MATERIALIZED_OUTPUTS_FILE: &str = "materialized-outputs.json";

fn app_data_dir(root: &FsPath) -> PathBuf {
    root.join(APP_DATA_DIR)
}

fn app_workspaces_dir(root: &FsPath) -> PathBuf {
    app_data_dir(root).join(APP_WORKSPACES_DIR)
}

fn app_tuckspace_path(root: &FsPath) -> PathBuf {
    app_data_dir(root).join(APP_TUCKSPACE_FILE)
}

fn app_materialized_outputs_path(root: &FsPath) -> PathBuf {
    app_data_dir(root).join(APP_MATERIALIZED_OUTPUTS_FILE)
}

async fn prepare_app_data_layout(
    root: &FsPath,
) -> Result<(PathBuf, PathBuf, PathBuf), std::io::Error> {
    let workspaces_dir = app_workspaces_dir(root);
    let tuckspace_path = app_tuckspace_path(root);
    let materialized_outputs_path = app_materialized_outputs_path(root);
    fs::create_dir_all(&workspaces_dir).await?;
    Ok((workspaces_dir, tuckspace_path, materialized_outputs_path))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "shell_ws_kernel=debug,tower_http=info".to_string()),
        )
        .init();

    let (workspaces_dir, tuckspace_path, materialized_outputs_path) =
        prepare_app_data_layout(FsPath::new("."))
            .await
            .expect("prepare app data");
    let store = WorkspaceStore::new(&workspaces_dir)
        .await
        .expect("workspace store");
    let tuckspace_store = TuckspaceStore::new(&tuckspace_path, &store)
        .await
        .expect("tuckspace store");
    let materialized_output_store = MaterializedOutputStoreHandle::new(&materialized_outputs_path)
        .await
        .expect("materialized output store");
    let (broadcaster, _) = broadcast::channel(512);
    let execution = ExecutionManager::new(broadcaster.clone());
    let openai_client = reqwest::Client::builder()
        .build()
        .expect("openai http client");
    let state = AppState {
        store,
        tuckspace_store,
        materialized_output_store,
        execution,
        broadcaster,
        openai_client,
    };

    let app = Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/workspaces",
            get(list_workspaces).post(create_workspace),
        )
        .route("/api/workspaces/order", put(reorder_workspaces))
        .route(
            "/api/workspaces/:id",
            get(get_workspace)
                .put(save_workspace)
                .delete(delete_workspace),
        )
        .route("/api/tuckspace", get(get_tuckspace).put(save_tuckspace))
        .route(
            "/api/materialized-outputs",
            get(get_materialized_outputs).put(save_materialized_outputs),
        )
        .route("/api/pick-file", post(pick_file))
        .route("/api/generate-script", post(generate_script_handler))
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new("ui/dist").append_index_html_on_directories(true))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let address = SocketAddr::from(([127, 0, 0, 1], 4000));
    info!("shell-ws kernel listening on http://{address}");
    axum::serve(
        tokio::net::TcpListener::bind(address)
            .await
            .expect("bind address"),
        app,
    )
    .await
    .expect("start server");
}

async fn health() -> &'static str {
    "ok"
}

async fn list_workspaces(
    State(state): State<AppState>,
) -> Result<Json<Vec<model::WorkspaceSummary>>, AppError> {
    Ok(Json(state.store.list().await?))
}

async fn create_workspace(State(state): State<AppState>) -> Result<Json<Workspace>, AppError> {
    let mut workspace = Workspace::empty();
    workspace.id = encode_workspace_id();
    let label = workspace.id.rsplit('-').next().unwrap_or(&workspace.id);
    workspace.name = format!("Workspace {}", &label[..label.len().min(8)]);
    workspace.created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    workspace.sort_order = state.store.next_sort_order().await?;
    state.store.save(&workspace.id, &workspace).await?;
    Ok(Json(workspace))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderWorkspacesRequest {
    ordered_ids: Vec<String>,
}

async fn reorder_workspaces(
    State(state): State<AppState>,
    Json(request): Json<ReorderWorkspacesRequest>,
) -> Result<StatusCode, AppError> {
    state.store.reorder(&request.ordered_ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_workspace(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Workspace>, AppError> {
    Ok(Json(state.store.load(&id).await?))
}

async fn save_workspace(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(workspace): Json<Workspace>,
) -> Result<StatusCode, AppError> {
    state.store.save(&id, &workspace).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_tuckspace(
    State(state): State<AppState>,
) -> Result<Json<Vec<TuckedSubgraph>>, AppError> {
    Ok(Json(state.tuckspace_store.load().await?))
}

async fn save_tuckspace(
    State(state): State<AppState>,
    Json(tuckspace): Json<Vec<TuckedSubgraph>>,
) -> Result<StatusCode, AppError> {
    state.tuckspace_store.save(&tuckspace).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_materialized_outputs(
    State(state): State<AppState>,
) -> Result<Json<MaterializedOutputStore>, AppError> {
    Ok(Json(state.materialized_output_store.load().await?))
}

async fn save_materialized_outputs(
    State(state): State<AppState>,
    Json(store): Json<MaterializedOutputStore>,
) -> Result<StatusCode, AppError> {
    state.materialized_output_store.save(&store).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_workspace(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, AppError> {
    state.store.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Serialize)]
struct PickedPath {
    path: String,
}

async fn pick_file() -> Result<Json<PickedPath>, AppError> {
    Ok(Json(PickedPath {
        path: pick_file_path().await?,
    }))
}

async fn generate_script_handler(
    State(state): State<AppState>,
    Json(request): Json<GenerateScriptRequest>,
) -> Result<Json<GenerateScriptResponse>, AppError> {
    Ok(Json(
        generate_script(&state.openai_client, request)
            .await
            .map_err(AppError::Message)?,
    ))
}

async fn pick_file_path() -> Result<String, AppError> {
    let pickers: [(&str, &[&str]); 3] = [
        (
            "zenity",
            &["--file-selection", "--title=shell-ws file picker"],
        ),
        ("kdialog", &["--getopenfilename"]),
        ("yad", &["--file-selection", "--title=shell-ws file picker"]),
    ];

    let mut saw_picker = false;
    for (program, args) in pickers {
        let output = tokio::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .await;
        match output {
            Ok(output) => {
                saw_picker = true;
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !path.is_empty() {
                        return Ok(path);
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(AppError::Io(error)),
        }
    }

    if saw_picker {
        Err(AppError::Message("file picker cancelled".to_string()))
    } else {
        Err(AppError::Message(
            "no supported native file picker found (tried zenity, kdialog, yad)".to_string(),
        ))
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let mut rx = state.broadcaster.subscribe();
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut sender = tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            match serde_json::to_string(&event) {
                Ok(message) => {
                    debug_ws_line("<-", summarize_server_event(&event));
                    if ws_tx.send(Message::Text(message.into())).await.is_err() {
                        break;
                    }
                }
                Err(error) => {
                    error!("failed to serialize ws event: {error}");
                }
            }
        }
    });

    loop {
        tokio::select! {
            message = &mut sender => {
                if let Err(error) = message {
                    error!("ws sender failed: {error}");
                }
                break;
            }
            maybe_message = ws_rx.next() => {
                let Some(Ok(message)) = maybe_message else {
                    break;
                };
                if let Message::Text(text) = message {
                    match serde_json::from_str::<ClientEvent>(&text) {
                        Ok(event) => {
                            debug_ws_line("->", summarize_client_event(&event));
                            if let Err(error) = handle_client_event(event, state.clone()).await {
                                let _ = state.broadcaster.send(ServerEvent::Error {
                                    message: error.to_string(),
                                    timestamp: current_ms(),
                                });
                            }
                        }
                        Err(error) => {
                            let _ = state.broadcaster.send(ServerEvent::Error {
                                message: format!("Invalid client event: {error}"),
                                timestamp: current_ms(),
                            });
                        }
                    }
                }
            }
        }
    }
}

async fn handle_client_event(event: ClientEvent, state: AppState) -> Result<(), AppError> {
    match event {
        ClientEvent::RunNode { request } => {
            let materialized_output_store = state.materialized_output_store.load().await?;
            state.execution.run(request, materialized_output_store);
        }
        ClientEvent::StopExecution { exec_id, node_id } => {
            if let Some(exec_id) = exec_id {
                state.execution.stop_by_id(&exec_id);
            } else if let Some(node_id) = node_id {
                state.execution.stop_by_node(&node_id);
            }
        }
    }
    Ok(())
}

#[derive(thiserror::Error, Debug)]
enum AppError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string()).into_response()
    }
}

fn summarize_client_event(event: &ClientEvent) -> String {
    match event {
        ClientEvent::RunNode { request } => format!(
            "run nodes={} wires={} matouts={} active={}",
            request.graph.nodes.len(),
            request.graph.edges.len(),
            request.matouts.len(),
            request.active_matouts.len(),
        ),
        ClientEvent::StopExecution { exec_id, node_id } => {
            format!(
                "stop exec={} node={}",
                exec_id.as_deref().unwrap_or("-"),
                node_id.as_deref().unwrap_or("-")
            )
        }
    }
}

fn summarize_server_event(event: &ServerEvent) -> String {
    match event {
        ServerEvent::ExecStarted {
            exec_id, node_id, ..
        } => format!("start {} {}", node_id, exec_id),
        ServerEvent::MaterializedState {
            node_id,
            upserted_entries,
            deleted_ids,
            ..
        } => {
            format!(
                "mat {} upserts={} deletes={}",
                node_id,
                upserted_entries.len(),
                deleted_ids.len()
            )
        }
        ServerEvent::ExecFinished {
            exec_id,
            node_id,
            exit_code,
            materialized,
            ..
        } => {
            format!(
                "finish {} {} code={} mat={}",
                node_id,
                exec_id,
                exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "null".to_string()),
                if *materialized { 1 } else { 0 }
            )
        }
        ServerEvent::PortActivity {
            node_id,
            port,
            bytes,
            ..
        } => format!("port {}.{:?} bytes={}", node_id, port, bytes),
        ServerEvent::NodeOutput {
            node_id,
            port,
            data_base64,
            ..
        } => {
            format!("out {}.{:?} b64={}", node_id, port, data_base64.len())
        }
        ServerEvent::StreamChunk {
            from_node_id,
            to_node_id,
            port,
            data_base64,
            ..
        } => {
            format!(
                "chunk {}->{}.{:?} b64={}",
                from_node_id,
                to_node_id,
                port,
                data_base64.len()
            )
        }
        ServerEvent::DisplayUpdate {
            node_id,
            data_base64,
            completed,
            ..
        } => {
            format!(
                "display {} b64={} done={}",
                node_id,
                data_base64.len(),
                completed
            )
        }
        ServerEvent::ExecutionStopped { exec_id, .. } => format!("stopped {}", exec_id),
        ServerEvent::Error { message, .. } => format!("error {}", message),
    }
}

fn debug_ws_line(direction: &str, summary: String) {
    let line = format!("ws{} {}", direction, summary);
    debug!("{}", line.chars().take(100).collect::<String>());
}

fn current_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
