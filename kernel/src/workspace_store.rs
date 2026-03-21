use std::path::{Path, PathBuf};

use tokio::fs;

use crate::id::normalize_workspace_ids;
use crate::model::{sanitize_workspace_json_value, Workspace, WorkspaceSummary};

#[derive(Clone)]
pub struct WorkspaceStore {
    base_dir: PathBuf,
}

impl WorkspaceStore {
    pub async fn new(base_dir: impl AsRef<Path>) -> Result<Self, std::io::Error> {
        let base_dir = base_dir.as_ref().to_path_buf();
        fs::create_dir_all(&base_dir).await?;
        let store = Self { base_dir };
        if store.list().await?.is_empty() {
            let workspace = Workspace::example();
            store.save(&workspace.id, &workspace).await?;
        }
        store.migrate_ids().await?;
        Ok(store)
    }

    async fn migrate_ids(&self) -> Result<(), std::io::Error> {
        let mut entries = fs::read_dir(&self.base_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let content = fs::read(&path).await?;
            let mut value: serde_json::Value = serde_json::from_slice(&content).map_err(std::io::Error::other)?;
            sanitize_workspace_json_value(&mut value);
            let mut workspace: Workspace = serde_json::from_value(value).map_err(std::io::Error::other)?;
            let original_id = workspace.id.clone();
            let changed = normalize_workspace_ids(&mut workspace);
            let file_id = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default().to_string();
            if changed || workspace.id != file_id {
                self.save(&workspace.id, &workspace).await?;
                if file_id != workspace.id && fs::try_exists(&path).await? {
                    fs::remove_file(&path).await?;
                }
            } else if original_id != file_id {
                self.save(&workspace.id, &workspace).await?;
                if fs::try_exists(&path).await? {
                    fs::remove_file(&path).await?;
                }
            }
        }
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<WorkspaceSummary>, std::io::Error> {
        let mut entries = fs::read_dir(&self.base_dir).await?;
        let mut workspaces = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let content = fs::read(&path).await?;
            let mut value: serde_json::Value =
                serde_json::from_slice(&content).unwrap_or_else(|_| {
                    serde_json::to_value(Workspace::example()).expect("workspace example json")
                });
            sanitize_workspace_json_value(&mut value);
            let workspace: Workspace =
                serde_json::from_value(value).unwrap_or_else(|_| Workspace::example());
            workspaces.push(WorkspaceSummary {
                id: workspace.id,
                name: workspace.name,
                created_at: workspace.created_at,
                sort_order: workspace.sort_order,
            });
        }
        workspaces.sort_by(|left, right| left.sort_order.cmp(&right.sort_order).then_with(|| left.created_at.cmp(&right.created_at)).then_with(|| left.name.cmp(&right.name)));
        Ok(workspaces)
    }


    pub async fn load_all(&self) -> Result<Vec<Workspace>, std::io::Error> {
        let summaries = self.list().await?;
        let mut workspaces = Vec::with_capacity(summaries.len());
        for summary in summaries {
            workspaces.push(self.load(&summary.id).await?);
        }
        Ok(workspaces)
    }

    pub async fn load(&self, id: &str) -> Result<Workspace, std::io::Error> {
        let path = self.path_for(id);
        let content = fs::read(path).await?;
        let mut value: serde_json::Value =
            serde_json::from_slice(&content).map_err(std::io::Error::other)?;
        sanitize_workspace_json_value(&mut value);
        let workspace: Workspace = serde_json::from_value(value).map_err(std::io::Error::other)?;
        Ok(workspace)
    }

    pub async fn save(&self, id: &str, workspace: &Workspace) -> Result<(), std::io::Error> {
        let path = self.path_for(id);
        let content = serde_json::to_vec_pretty(workspace).map_err(std::io::Error::other)?;
        fs::write(path, content).await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> Result<(), std::io::Error> {
        let path = self.path_for(id);
        if fs::try_exists(&path).await? {
            fs::remove_file(path).await?;
        }
        Ok(())
    }

    pub async fn next_sort_order(&self) -> Result<u64, std::io::Error> {
        Ok(self
            .list()
            .await?
            .into_iter()
            .map(|workspace| workspace.sort_order)
            .max()
            .unwrap_or(0)
            .saturating_add(1))
    }

    pub async fn reorder(&self, ordered_ids: &[String]) -> Result<(), std::io::Error> {
        let mut workspaces = self.load_all().await?;
        workspaces.sort_by_key(|workspace| workspace.sort_order);
        let index_by_id = ordered_ids
            .iter()
            .enumerate()
            .map(|(index, id)| (id.as_str(), index))
            .collect::<std::collections::HashMap<_, _>>();
        workspaces.sort_by_key(|workspace| index_by_id.get(workspace.id.as_str()).copied().unwrap_or(usize::MAX));
        for (index, workspace) in workspaces.iter_mut().enumerate() {
            workspace.sort_order = index as u64;
            self.save(&workspace.id, workspace).await?;
        }
        Ok(())
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.base_dir.join(format!("{id}.json"))
    }
}
