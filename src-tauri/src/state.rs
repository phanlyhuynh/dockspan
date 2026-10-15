use crate::store::Store;
use bollard::Docker;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Mutex as StdMutex;
use tauri::async_runtime::JoinHandle;
use tokio::io::AsyncWrite;
use tokio::sync::Mutex;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveCtx {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub kind: String,
}

pub struct ExecSession {
    pub docker: Docker,
    pub exec_id: String,
    pub input: Pin<Box<dyn AsyncWrite + Send>>,
    pub task: JoinHandle<()>,
}

pub struct AppState {
    pub docker: StdMutex<Option<Docker>>,
    pub active: StdMutex<ActiveCtx>,
    pub info: StdMutex<Option<serde_json::Value>>,
    pub tasks: StdMutex<HashMap<String, JoinHandle<()>>>,
    pub execs: Mutex<HashMap<String, ExecSession>>,
    pub store: StdMutex<Store>,
}

impl AppState {
    pub fn docker(&self) -> Result<Docker, String> {
        self.docker
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "Docker Engine is not running".to_string())
    }

    pub fn active(&self) -> ActiveCtx {
        self.active.lock().unwrap().clone()
    }

    pub fn spawn_task(&self, key: &str, h: JoinHandle<()>) {
        if let Some(old) = self.tasks.lock().unwrap().insert(key.to_string(), h) {
            old.abort();
        }
    }

    pub fn abort_task(&self, key: &str) {
        if let Some(h) = self.tasks.lock().unwrap().remove(key) {
            h.abort();
        }
    }

    pub fn abort_prefix(&self, prefix: &str) {
        let mut t = self.tasks.lock().unwrap();
        let keys: Vec<String> = t.keys().filter(|k| k.starts_with(prefix)).cloned().collect();
        for k in keys {
            if let Some(h) = t.remove(&k) {
                h.abort();
            }
        }
    }

    pub fn with_store<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R {
        let mut st = self.store.lock().unwrap();
        let r = f(&mut st);
        st.save();
        r
    }
}
