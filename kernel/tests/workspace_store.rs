use shell_ws_kernel::model::Workspace;
use shell_ws_kernel::workspace_store::WorkspaceStore;

#[tokio::test]
async fn workspace_store_bootstraps_default_workspace() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let store = WorkspaceStore::new(temp_dir.path()).await.expect("store");
    let workspaces = store.list().await.expect("list");
    assert_eq!(workspaces.len(), 1);
    let workspace: Workspace = store.load(&workspaces[0].id).await.expect("workspace");
    assert!(workspace.id.starts_with("workspace-"));
}


#[tokio::test]
async fn workspace_store_lists_and_reorders_by_sort_order() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let store = WorkspaceStore::new(temp_dir.path()).await.expect("store");

    let mut alpha = Workspace::empty();
    alpha.id = "alpha".to_string();
    alpha.name = "Alpha".to_string();
    alpha.sort_order = 1;
    store.save(&alpha.id, &alpha).await.expect("save alpha");

    let mut beta = Workspace::empty();
    beta.id = "beta".to_string();
    beta.name = "Beta".to_string();
    beta.sort_order = 2;
    store.save(&beta.id, &beta).await.expect("save beta");

    let listed = store.list().await.expect("list before reorder");
    let bootstrapped_id = listed[0].id.clone();
    assert_eq!(listed.iter().map(|workspace| workspace.id.as_str()).collect::<Vec<_>>(), vec![bootstrapped_id.as_str(), "alpha", "beta"]);

    store
        .reorder(&["beta".to_string(), bootstrapped_id.clone(), "alpha".to_string()])
        .await
        .expect("reorder workspaces");

    let reordered = store.list().await.expect("list after reorder");
    assert_eq!(reordered.iter().map(|workspace| workspace.id.as_str()).collect::<Vec<_>>(), vec!["beta", bootstrapped_id.as_str(), "alpha"]);
}
