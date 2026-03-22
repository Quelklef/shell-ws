use std::path::{Path, PathBuf};

use tokio::fs;

use crate::model::MaterializedOutputStore;

#[derive(Clone)]
pub struct MaterializedOutputStoreHandle {
    path: PathBuf,
}

impl MaterializedOutputStoreHandle {
    pub async fn new(path: impl AsRef<Path>) -> Result<Self, std::io::Error> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let store = Self { path };
        if !fs::try_exists(&store.path).await? {
            store.save(&MaterializedOutputStore::new()).await?;
        }
        Ok(store)
    }

    pub async fn load(&self) -> Result<MaterializedOutputStore, std::io::Error> {
        if !fs::try_exists(&self.path).await? {
            return Ok(MaterializedOutputStore::new());
        }
        let content = fs::read(&self.path).await?;
        serde_json::from_slice(&content).map_err(std::io::Error::other)
    }

    pub async fn save(&self, store: &MaterializedOutputStore) -> Result<(), std::io::Error> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let content = serde_json::to_vec_pretty(store).map_err(std::io::Error::other)?;
        fs::write(&self.path, content).await
    }
}
