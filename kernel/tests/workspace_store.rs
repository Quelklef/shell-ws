use shell_ws_kernel::model::Workspace;
use shell_ws_kernel::workspace_store::WorkspaceStore;

#[tokio::test]
async fn workspace_store_bootstraps_default_workspace() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let store = WorkspaceStore::new(temp_dir.path()).await.expect("store");
    let workspaces = store.list().await.expect("list");
    assert_eq!(workspaces.len(), 1);
    let workspace: Workspace = store.load("default").await.expect("workspace");
    assert_eq!(workspace.id, "default");
}
