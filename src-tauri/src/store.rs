//! App-local configuration (projects, cleanup schedule, settings, Kubernetes clusters). Docker/K8s data is not stored here.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub name: String,
    pub image: String,
    pub ports: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    /// The real Compose project name (the `com.docker.compose.project` label on containers).
    pub compose_project: String,
    pub context_id: String,
    pub compose_file: Option<String>,
    pub has_dockerfile: bool,
    #[serde(default)]
    pub services: Vec<ServiceInfo>,
    pub last_opened_at: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub context_id: String,
    pub enabled: bool,
    pub freq: String,
    pub keep_cache_days: u32,
    pub containers: bool,
    pub dangling_images: bool,
    pub build_cache: bool,
    pub last_run_at: Option<String>,
    pub last_reclaimed_bytes: Option<u64>,
}

impl Schedule {
    pub fn default_for(ctx: &str) -> Self {
        Schedule {
            context_id: ctx.to_string(),
            enabled: false,
            freq: "weekly".into(),
            keep_cache_days: 7,
            containers: true,
            dangling_images: true,
            build_cache: true,
            last_run_at: None,
            last_reclaimed_bytes: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub active_context_id: Option<String>,
    pub editor_command: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { active_context_id: None, editor_command: "code".into() }
    }
}

/// A kubeconfig context added from a file other than the default kubeconfig.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtraCluster {
    pub path: String,
    pub context: String,
}

/// Kubernetes settings. Clusters are the contexts of the default kubeconfig (`$KUBECONFIG` or `~/.kube/config`)
/// minus `hidden`, plus `extra`; the kubeconfig itself is never modified.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct KubeCfg {
    #[serde(default)]
    pub active_cluster_id: Option<String>,
    #[serde(default)]
    pub hidden: Vec<String>,
    #[serde(default)]
    pub extra: Vec<ExtraCluster>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub schedules: HashMap<String, Schedule>,
    #[serde(default)]
    pub settings: Settings,
    /// Containers that were running right before the app stopped the engine, per context.
    #[serde(default)]
    pub was_running: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub kube: KubeCfg,
    #[serde(skip)]
    pub path: PathBuf,
}

impl Store {
    pub fn load(path: PathBuf) -> Store {
        let mut st: Store = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        st.path = path;
        st
    }

    pub fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(t) = serde_json::to_string_pretty(self) {
            // Write through a temp file so the config is not corrupted if the app is killed midway.
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, t).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }
}
