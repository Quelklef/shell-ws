use std::path::{Path, PathBuf};

use tokio::fs;

use crate::id::normalize_tucked_subgraph_ids;
use crate::model::{sanitize_tuckspace_json_value, TuckedSubgraph};

#[derive(Clone)]
pub struct TuckspaceStore {
    path: PathBuf,
}

impl TuckspaceStore {
    pub async fn new(
        path: impl AsRef<Path>,
        workspace_store: &crate::workspace_store::WorkspaceStore,
    ) -> Result<Self, std::io::Error> {
        let path = path.as_ref().to_path_buf();
        let store = Self { path };
        store.ensure_initialized(workspace_store).await?;
        store.migrate_ids().await?;
        Ok(store)
    }

    pub async fn load(&self) -> Result<Vec<TuckedSubgraph>, std::io::Error> {
        if !fs::try_exists(&self.path).await? {
            return Ok(Vec::new());
        }
        let content = fs::read(&self.path).await?;
        let mut value: serde_json::Value =
            serde_json::from_slice(&content).map_err(std::io::Error::other)?;
        sanitize_tuckspace_json_value(&mut value);
        serde_json::from_value(value).map_err(std::io::Error::other)
    }

    pub async fn save(&self, tuckspace: &[TuckedSubgraph]) -> Result<(), std::io::Error> {
        let content = serde_json::to_vec_pretty(tuckspace).map_err(std::io::Error::other)?;
        fs::write(&self.path, content).await
    }

    async fn migrate_ids(&self) -> Result<(), std::io::Error> {
        let mut tuckspace = self.load().await?;
        let mut changed = false;
        for item in tuckspace.iter_mut() {
            changed |= normalize_tucked_subgraph_ids(item);
        }
        if changed {
            self.save(&tuckspace).await?;
        }
        Ok(())
    }

    async fn ensure_initialized(
        &self,
        workspace_store: &crate::workspace_store::WorkspaceStore,
    ) -> Result<(), std::io::Error> {
        if fs::try_exists(&self.path).await? {
            return Ok(());
        }
        let mut migrated = Vec::new();
        for workspace in workspace_store.load_all().await? {
            migrated.extend(workspace.tuckspace);
        }
        self.save(&migrated).await
    }
}
