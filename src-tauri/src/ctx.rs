//! Docker context: read from `~/.docker`, connect to the engine, switch context.
use crate::state::{ActiveCtx, AppState};
use crate::util::*;
use bollard::{Docker, API_DEFAULT_VERSION};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime, State};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CtxInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub endpoint: String,
    pub supported: bool,
}

fn kind_of(endpoint: &str) -> &'static str {
    if endpoint.starts_with("ssh://") {
        "ssh"
    } else if endpoint.starts_with("tcp://") || endpoint.starts_with("http") {
        "tcp"
    } else {
        "local"
    }
}

fn supported(endpoint: &str) -> bool {
    matches!(kind_of(endpoint), "local") || (endpoint.starts_with("tcp://") && !endpoint.contains("2376"))
}

fn default_endpoint() -> String {
    if let Ok(h) = std::env::var("DOCKER_HOST") {
        if !h.is_empty() {
            return h;
        }
    }
    if cfg!(windows) {
        return "npipe:////./pipe/docker_engine".into();
    }
    let candidates = [
        "/var/run/docker.sock".to_string(),
        home().join(".docker/run/docker.sock").to_string_lossy().into(),
        home().join(".colima/default/docker.sock").to_string_lossy().into(),
        home().join(".orbstack/run/docker.sock").to_string_lossy().into(),
        home().join(".rd/docker.sock").to_string_lossy().into(),
    ];
    for c in candidates.iter() {
        if std::path::Path::new(c).exists() {
            return format!("unix://{}", c);
        }
    }
    "unix:///var/run/docker.sock".into()
}

pub fn list_contexts() -> Vec<CtxInfo> {
    let mut out = vec![CtxInfo {
        id: "default".into(),
        name: "default".into(),
        kind: kind_of(&default_endpoint()).into(),
        endpoint: default_endpoint(),
        supported: supported(&default_endpoint()),
    }];
    let meta = home().join(".docker/contexts/meta");
    if let Ok(rd) = std::fs::read_dir(meta) {
        for e in rd.flatten() {
            let f = e.path().join("meta.json");
            let Ok(t) = std::fs::read_to_string(&f) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
            let name = s(&v, "Name");
            let host = v["Endpoints"]["docker"]["Host"].as_str().unwrap_or("").to_string();
            if name.is_empty() || host.is_empty() {
                continue;
            }
            out.push(CtxInfo { id: name.clone(), name, kind: kind_of(&host).into(), supported: supported(&host), endpoint: host });
        }
    }
    out[1..].sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn cli_current_context() -> String {
    if let Ok(c) = std::env::var("DOCKER_CONTEXT") {
        if !c.is_empty() {
            return c;
        }
    }
    std::fs::read_to_string(home().join(".docker/config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["currentContext"].as_str().map(|x| x.to_string()))
        .unwrap_or_else(|| "default".into())
}

/// Pick the context at startup: the app's last used one, then the docker CLI's current context.
pub fn initial_context(preferred: Option<String>) -> ActiveCtx {
    let all = list_contexts();
    let pick = preferred
        .and_then(|p| all.iter().find(|c| c.id == p).cloned())
        .or_else(|| {
            let cur = cli_current_context();
            all.iter().find(|c| c.id == cur).cloned()
        })
        .unwrap_or_else(|| all[0].clone());
    ActiveCtx { id: pick.id, name: pick.name, endpoint: pick.endpoint, kind: pick.kind }
}

pub fn connect(endpoint: &str) -> Result<Docker, String> {
    const T: u64 = 24 * 3600;
    let r = if let Some(p) = endpoint.strip_prefix("unix://") {
        Docker::connect_with_unix(p, T, API_DEFAULT_VERSION)
    } else if endpoint.starts_with("npipe://") {
        #[cfg(windows)]
        {
            Docker::connect_with_named_pipe(endpoint, T, API_DEFAULT_VERSION)
        }
        #[cfg(not(windows))]
        {
            return Err("Named pipes are only available on Windows".into());
        }
    } else if endpoint.starts_with("tcp://") || endpoint.starts_with("http://") {
        Docker::connect_with_http(endpoint, T, API_DEFAULT_VERSION)
    } else if endpoint.starts_with("ssh://") {
        return Err("SSH connections are not supported at this stage".into());
    } else {
        Docker::connect_with_unix(endpoint, T, API_DEFAULT_VERSION)
    };
    r.map_err(|e| match e {
        bollard::errors::Error::SocketNotFoundError(p) => format!("Docker socket not found: {}", p),
        o => o.to_string(),
    })
}

/// Connect then lower the API version to match the engine (Docker 27 only speaks up to API 1.47).
pub async fn connect_negotiated(endpoint: &str) -> Result<Docker, String> {
    let d = connect(endpoint)?;
    match tokio::time::timeout(Duration::from_secs(5), d.clone().negotiate_version()).await {
        Ok(Ok(n)) => Ok(n),
        Ok(Err(e)) => Err(derr(e)),
        Err(_) => Err("i/o timeout".into()),
    }
}

pub async fn fetch_info(d: &Docker) -> Value {
    let v = tokio::time::timeout(Duration::from_secs(5), d.version()).await.ok().and_then(|r| r.ok()).map(|x| to_v(&x)).unwrap_or(Value::Null);
    let i = tokio::time::timeout(Duration::from_secs(5), d.info()).await.ok().and_then(|r| r.ok()).map(|x| to_v(&x)).unwrap_or(Value::Null);
    json!({
        "version": s(&v, "Version"),
        "apiVersion": s(&v, "ApiVersion"),
        "os": format!("{} {}", s(&i, "OperatingSystem"), s(&i, "Architecture")).trim().to_string(),
        "osType": s(&i, "OSType"),
        "kernel": s(&i, "KernelVersion"),
        "cpus": i["NCPU"].as_i64().unwrap_or(0),
        "memTotal": i["MemTotal"].as_i64().unwrap_or(0),
        "name": s(&i, "Name"),
    })
}

#[tauri::command]
pub fn ctx_list(state: State<'_, AppState>) -> Vec<Value> {
    let active = state.active();
    list_contexts()
        .into_iter()
        .map(|c| {
            let mut v = to_v(&c);
            v["active"] = json!(c.id == active.id);
            v
        })
        .collect()
}

#[tauri::command]
pub async fn ctx_test(id: String) -> CmdResult<Value> {
    let c = list_contexts().into_iter().find(|c| c.id == id).ok_or("Context not found")?;
    let t0 = Instant::now();
    let d = connect_negotiated(&c.endpoint).await.map_err(|e| format!("Could not connect to {}: {}", c.endpoint, e))?;
    tokio::time::timeout(Duration::from_secs(5), d.ping())
        .await
        .map_err(|_| format!("Could not connect to {}: i/o timeout", c.endpoint))?
        .map_err(|e| format!("Could not connect to {}: {}", c.endpoint, derr(e)))?;
    let ms = t0.elapsed().as_millis() as i64;
    let mut info = fetch_info(&d).await;
    info["latencyMs"] = json!(ms);
    Ok(info)
}

#[tauri::command]
pub async fn ctx_switch<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String) -> CmdResult<ActiveCtx> {
    let c = list_contexts().into_iter().find(|c| c.id == id).ok_or("Context not found")?;
    if !c.supported {
        return Err(format!("This connection type ({}) is not supported yet; it will arrive in the multi-engine phase", c.endpoint));
    }
    // On failure keep the old context.
    let d = connect_negotiated(&c.endpoint).await.map_err(|e| format!("Could not connect to {}: {}", c.endpoint, e))?;
    tokio::time::timeout(Duration::from_secs(5), d.ping())
        .await
        .map_err(|_| format!("Could not connect to {}: i/o timeout", c.endpoint))?
        .map_err(|e| format!("Could not connect to {}: {}", c.endpoint, derr(e)))?;
    // Cancel every stream (events, logs, stats, exec) of the old context before opening the new one.
    state.abort_prefix("");
    {
        let mut ex = state.execs.lock().await;
        for (_, s) in ex.drain() {
            s.task.abort();
        }
    }
    let next = ActiveCtx { id: c.id.clone(), name: c.name, endpoint: c.endpoint, kind: c.kind };
    *state.active.lock().unwrap() = next.clone();
    *state.docker.lock().unwrap() = Some(d);
    *state.info.lock().unwrap() = None;
    state.with_store(|s| s.settings.active_context_id = Some(c.id));
    crate::events::start_monitor(&app);
    Ok(next)
}
