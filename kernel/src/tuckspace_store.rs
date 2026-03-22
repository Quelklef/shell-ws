use std::path::{Path, PathBuf};

use tokio::fs;

use crate::model::TuckedSubgraph;

#[derive(Clone)]
pub struct TuckspaceStore {
    path: PathBuf,
}

impl TuckspaceStore {
    pub async fn new(
        path: impl AsRef<Path>,
        _workspace_store: &crate::workspace_store::WorkspaceStore,
    ) -> Result<Self, std::io::Error> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let store = Self { path };
        store.ensure_initialized().await?;
        Ok(store)
    }

    pub async fn load(&self) -> Result<Vec<TuckedSubgraph>, std::io::Error> {
        if !fs::try_exists(&self.path).await? {
            return Ok(Vec::new());
        }
        let content = fs::read(&self.path).await?;
        serde_json::from_slice(&content).map_err(std::io::Error::other)
    }

    pub async fn save(&self, tuckspace: &[TuckedSubgraph]) -> Result<(), std::io::Error> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let content = serde_json::to_vec_pretty(tuckspace).map_err(std::io::Error::other)?;
        fs::write(&self.path, content).await
    }

    async fn ensure_initialized(&self) -> Result<(), std::io::Error> {
        if fs::try_exists(&self.path).await? {
            return Ok(());
        }
        self.save(&[]).await
    }
}
