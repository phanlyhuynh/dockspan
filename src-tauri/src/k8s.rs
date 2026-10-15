//! Kubernetes: clusters read from kubeconfig, workloads/pods/services, logs, exec and port-forward (kube-rs).
//! Independent of the Docker context: switching one never touches the other, so these streams live in
//! `K8sState` and not in `AppState::tasks` (which `ctx_switch` clears).
use crate::state::AppState;
use crate::store::ExtraCluster;
use crate::util::*;
use base64::Engine;
use futures_util::{AsyncBufReadExt, SinkExt, StreamExt};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Namespace, Node, Pod, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use k8s_openapi::NamespaceResourceScope;
use kube::api::{Api, AttachParams, DeleteParams, ListParams, LogParams, Patch, PatchParams, TerminalSize};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::runtime::{watcher, WatchStreamExt};
use kube::{Client, Config, Resource};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt::Debug;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

// ---------------------------------------------------------------- state

#[derive(Clone)]
pub struct Conn {
    pub client: Client,
    /// Namespace of the kubeconfig context; used when the user may not list across all namespaces.
    pub default_ns: String,
    pub server: String,
}

pub struct K8sExec {
    input: Pin<Box<dyn AsyncWrite + Send>>,
    resize: tokio::sync::mpsc::UnboundedSender<(u16, u16)>,
    task: JoinHandle<()>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PfInfo {
    pub id: String,
    pub cluster_id: String,
    pub cluster_name: String,
    pub namespace: String,
    pub service: String,
    pub remote_port: u16,
    pub local_port: u16,
}

struct PortForward {
    info: PfInfo,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct K8sState {
    conns: StdMutex<HashMap<String, Conn>>,
    tasks: StdMutex<HashMap<String, JoinHandle<()>>>,
    execs: Mutex<HashMap<String, K8sExec>>,
    pfs: StdMutex<HashMap<String, PortForward>>,
}

impl K8sState {
    fn spawn_task(&self, key: &str, h: JoinHandle<()>) {
        if let Some(old) = self.tasks.lock().unwrap().insert(key.to_string(), h) {
            old.abort();
        }
    }

    fn abort_task(&self, key: &str) {
        if let Some(h) = self.tasks.lock().unwrap().remove(key) {
            h.abort();
        }
    }

    fn abort_prefix(&self, prefix: &str) {
        let mut t = self.tasks.lock().unwrap();
        let keys: Vec<String> = t.keys().filter(|k| k.starts_with(prefix)).cloned().collect();
        for k in keys {
            if let Some(h) = t.remove(&k) {
                h.abort();
            }
        }
    }

    /// Cached client for a cluster; built (and the kubeconfig exec plugin run) on first use.
    async fn conn(&self, app: &AppState, id: &str) -> Result<Conn, String> {
        if let Some(c) = self.conns.lock().unwrap().get(id).cloned() {
            return Ok(c);
        }
        let cl = find_cluster(app, id)?;
        let c = build_conn(&cl).await?;
        self.conns.lock().unwrap().insert(id.to_string(), c.clone());
        Ok(c)
    }

    fn forget(&self, id: &str) {
        self.conns.lock().unwrap().remove(id);
    }
}

// ---------------------------------------------------------------- clusters (kubeconfig)

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    pub id: String,
    pub name: String,
    /// Path shown to the user (`~/.kube/config`, the `$KUBECONFIG` list, or an added file).
    pub kubeconfig_path: String,
    pub kube_context: String,
    pub server: String,
    pub namespace: Option<String>,
    pub user: Option<String>,
    /// `default` = from `$KUBECONFIG` / `~/.kube/config`; `file` = added from another kubeconfig file.
    pub source: String,
}

fn default_kubeconfig_label() -> String {
    match std::env::var("KUBECONFIG") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => "~/.kube/config".into(),
    }
}

fn default_kubeconfig_paths() -> Vec<PathBuf> {
    match std::env::var_os("KUBECONFIG") {
        Some(v) if !v.is_empty() => std::env::split_paths(&v).filter(|p| !p.as_os_str().is_empty()).collect(),
        _ => vec![home().join(".kube/config")],
    }
}

fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

fn contexts_of(kc: &Kubeconfig) -> Vec<(String, String, Option<String>, Option<String>)> {
    kc.contexts
        .iter()
        .map(|nc| {
            let ctx = nc.context.as_ref();
            let cluster = ctx.map(|c| c.cluster.clone()).unwrap_or_default();
            let server = kc
                .clusters
                .iter()
                .find(|c| c.name == cluster)
                .and_then(|c| c.cluster.as_ref())
                .and_then(|c| c.server.clone())
                .unwrap_or_default();
            (nc.name.clone(), server, ctx.and_then(|c| c.namespace.clone()), ctx.and_then(|c| c.user.clone()))
        })
        .collect()
}

pub fn extra_id(e: &ExtraCluster) -> String {
    format!("{}@{}", e.context, e.path)
}

fn list_clusters(app: &AppState) -> Vec<ClusterInfo> {
    let cfg = app.store.lock().unwrap().kube.clone();
    let mut out = Vec::new();
    if let Ok(kc) = Kubeconfig::read() {
        let label = default_kubeconfig_label();
        for (name, server, namespace, user) in contexts_of(&kc) {
            if cfg.hidden.contains(&name) {
                continue;
            }
            out.push(ClusterInfo { id: name.clone(), name: name.clone(), kubeconfig_path: label.clone(), kube_context: name, server, namespace, user, source: "default".into() });
        }
    }
    for e in &cfg.extra {
        let Ok(kc) = Kubeconfig::read_from(expand_tilde(&e.path)) else { continue };
        if let Some((name, server, namespace, user)) = contexts_of(&kc).into_iter().find(|c| c.0 == e.context) {
            out.push(ClusterInfo { id: extra_id(e), name, kubeconfig_path: e.path.clone(), kube_context: e.context.clone(), server, namespace, user, source: "file".into() });
        }
    }
    out
}

fn find_cluster(app: &AppState, id: &str) -> Result<ClusterInfo, String> {
    list_clusters(app).into_iter().find(|c| c.id == id).ok_or_else(|| "Cluster not found".to_string())
}

async fn build_conn(c: &ClusterInfo) -> Result<Conn, String> {
    let kc = if c.source == "default" { Kubeconfig::read() } else { Kubeconfig::read_from(expand_tilde(&c.kubeconfig_path)) }
        .map_err(|e| format!("Could not read kubeconfig: {}", e))?;
    let opts = KubeConfigOptions { context: Some(c.kube_context.clone()), ..Default::default() };
    let mut cfg = Config::from_custom_kubeconfig(kc, &opts).await.map_err(|e| format!("Could not read kubeconfig: {}", e))?;
    cfg.connect_timeout = Some(Duration::from_secs(5));
    // Watches and `logs -f` stay open for a long time; unary calls get their own timeout (`tmo`).
    cfg.read_timeout = None;
    let default_ns = cfg.default_namespace.clone();
    let server = cfg.cluster_url.to_string().trim_end_matches('/').to_string();
    let client = Client::try_from(cfg).map_err(|e| format!("Could not connect to {}: {}", c.server, e))?;
    Ok(Conn { client, default_ns, server })
}

// ---------------------------------------------------------------- errors

/// Turn a kube error into toast text. 401 and failed exec plugins become "Unauthorized…" so the UI can offer to log in again.
pub fn kerr(e: kube::Error) -> String {
    match e {
        kube::Error::Api(s) => {
            if s.code == 401 {
                format!("Unauthorized: {}", if s.message.is_empty() { "the token was rejected (401)".to_string() } else { s.message.clone() })
            } else if s.message.is_empty() {
                format!("{} ({})", s.reason, s.code)
            } else {
                s.message.clone()
            }
        }
        kube::Error::Auth(a) => format!("Unauthorized: {}", a),
        other => other.to_string(),
    }
}

fn is_forbidden(e: &kube::Error) -> bool {
    matches!(e, kube::Error::Api(s) if s.code == 403)
}

/// 15 s timeout for one-shot API calls (the client itself has no read timeout because of watches).
async fn tmo<T>(f: impl Future<Output = Result<T, kube::Error>>) -> Result<T, String> {
    match tokio::time::timeout(Duration::from_secs(15), f).await {
        Ok(r) => r.map_err(kerr),
        Err(_) => Err("i/o timeout".into()),
    }
}

// ---------------------------------------------------------------- pure helpers (tested)

/// Status shown for a pod, close to the STATUS column of `kubectl get pods`.
pub fn pod_status(p: &Pod) -> String {
    if p.metadata.deletion_timestamp.is_some() {
        return "Terminating".into();
    }
    let Some(st) = p.status.as_ref() else { return "Pending".into() };
    let mut reason = st.reason.clone().unwrap_or_else(|| st.phase.clone().unwrap_or_else(|| "Pending".into()));
    for (i, c) in st.init_container_statuses.iter().flatten().enumerate() {
        let s = c.state.as_ref();
        if let Some(t) = s.and_then(|s| s.terminated.as_ref()) {
            if t.exit_code == 0 {
                continue;
            }
            return format!("Init:{}", t.reason.clone().unwrap_or_else(|| "Error".into()));
        }
        if let Some(w) = s.and_then(|s| s.waiting.as_ref()) {
            let r = w.reason.clone().unwrap_or_default();
            if !r.is_empty() && r != "PodInitializing" {
                return format!("Init:{}", r);
            }
        }
        let total = st.init_container_statuses.as_ref().map(|v| v.len()).unwrap_or(0);
        return format!("Init:{}/{}", i, total);
    }
    let mut running = false;
    for c in st.container_statuses.iter().flatten().rev() {
        let s = c.state.as_ref();
        if let Some(w) = s.and_then(|s| s.waiting.as_ref()).and_then(|w| w.reason.clone()) {
            reason = w;
        } else if let Some(t) = s.and_then(|s| s.terminated.as_ref()) {
            reason = t.reason.clone().unwrap_or_else(|| if t.exit_code == 0 { "Completed".into() } else { "Error".into() });
        } else if c.ready {
            running = true;
        }
    }
    if reason == "Completed" && running {
        reason = "Running".into();
    }
    reason
}

/// Local port proposed for a forward: the service port, +8000 when it is privileged (80 → 8080).
pub fn default_local_port(remote: u16) -> u16 {
    if remote < 1024 {
        remote + 8000
    } else {
        remote
    }
}

fn age_of(t: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::Time>) -> i64 {
    t.map(|x| x.0.as_second()).unwrap_or(0)
}

fn pod_row(p: &Pod) -> Value {
    let st = p.status.as_ref();
    let cs = st.and_then(|s| s.container_statuses.clone()).unwrap_or_default();
    let spec_containers: Vec<String> = p.spec.as_ref().map(|s| s.containers.iter().map(|c| c.name.clone()).collect()).unwrap_or_default();
    let ready = cs.iter().filter(|c| c.ready).count();
    let restarts: i32 = cs.iter().map(|c| c.restart_count).sum();
    let waiting = cs.iter().filter_map(|c| c.state.as_ref()?.waiting.as_ref()?.reason.clone()).next();
    let last_term = cs.iter().filter_map(|c| c.last_state.as_ref()?.terminated.as_ref()).next();
    let owner = p.metadata.owner_references.as_ref().and_then(|o| o.first()).map(|o| json!({ "kind": o.kind, "name": o.name }));
    json!({
        "namespace": p.metadata.namespace.clone().unwrap_or_default(),
        "name": p.metadata.name.clone().unwrap_or_default(),
        "status": pod_status(p),
        "phase": st.and_then(|s| s.phase.clone()).unwrap_or_default(),
        "ready": format!("{}/{}", ready, spec_containers.len().max(cs.len())),
        "restarts": restarts,
        "created": age_of(p.metadata.creation_timestamp.as_ref()),
        "node": p.spec.as_ref().and_then(|s| s.node_name.clone()).unwrap_or_default(),
        "containers": spec_containers,
        "labels": p.metadata.labels.clone().unwrap_or_default(),
        "owner": owner,
        "waitingReason": waiting,
        "waitingMessage": cs.iter().filter_map(|c| c.state.as_ref()?.waiting.as_ref()?.message.clone()).next(),
        "lastTerminatedReason": last_term.and_then(|t| t.reason.clone()),
        "lastExitCode": last_term.map(|t| t.exit_code),
        "deleting": p.metadata.deletion_timestamp.is_some(),
    })
}

fn deploy_row(d: &Deployment) -> Value {
    let spec = d.spec.as_ref();
    let st = d.status.as_ref();
    let image = spec.and_then(|s| s.template.spec.as_ref()).and_then(|s| s.containers.first()).and_then(|c| c.image.clone()).unwrap_or_default();
    json!({
        "namespace": d.metadata.namespace.clone().unwrap_or_default(),
        "name": d.metadata.name.clone().unwrap_or_default(),
        "replicas": spec.and_then(|s| s.replicas).unwrap_or(1),
        "ready": st.and_then(|s| s.ready_replicas).unwrap_or(0),
        "updated": st.and_then(|s| s.updated_replicas).unwrap_or(0),
        "available": st.and_then(|s| s.available_replicas).unwrap_or(0),
        "image": image,
        "selector": spec.and_then(|s| s.selector.match_labels.clone()).unwrap_or_default(),
        "created": age_of(d.metadata.creation_timestamp.as_ref()),
    })
}

fn service_row(s: &Service) -> Value {
    let spec = s.spec.as_ref();
    let ports: Vec<Value> = spec
        .and_then(|x| x.ports.clone())
        .unwrap_or_default()
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "port": p.port,
                "targetPort": p.target_port.as_ref().map(|t| match t { IntOrString::Int(i) => i.to_string(), IntOrString::String(s) => s.clone() }),
                "nodePort": p.node_port,
                "protocol": p.protocol.clone().unwrap_or_else(|| "TCP".into()),
            })
        })
        .collect();
    json!({
        "namespace": s.metadata.namespace.clone().unwrap_or_default(),
        "name": s.metadata.name.clone().unwrap_or_default(),
        "type": spec.and_then(|x| x.type_.clone()).unwrap_or_else(|| "ClusterIP".into()),
        "clusterIp": spec.and_then(|x| x.cluster_ip.clone()).unwrap_or_default(),
        "ports": ports,
        "selector": spec.and_then(|x| x.selector.clone()).unwrap_or_default(),
        "created": age_of(s.metadata.creation_timestamp.as_ref()),
    })
}

// ---------------------------------------------------------------- listing

/// List in one namespace, or in all of them; a user restricted to their namespace (403 on the cluster-wide list)
/// falls back to the context's namespace.
async fn list_kind<K>(c: &Conn, ns: Option<&str>) -> Result<Vec<K>, String>
where
    K: Resource<Scope = NamespaceResourceScope> + Clone + DeserializeOwned + Debug,
    <K as Resource>::DynamicType: Default,
{
    let lp = ListParams::default();
    if let Some(n) = ns {
        return Ok(tmo(Api::<K>::namespaced(c.client.clone(), n).list(&lp)).await?.items);
    }
    match tokio::time::timeout(Duration::from_secs(15), Api::<K>::all(c.client.clone()).list(&lp)).await {
        Err(_) => Err("i/o timeout".into()),
        Ok(Ok(l)) => Ok(l.items),
        Ok(Err(e)) if is_forbidden(&e) => Ok(tmo(Api::<K>::namespaced(c.client.clone(), &c.default_ns).list(&lp)).await?.items),
        Ok(Err(e)) => Err(kerr(e)),
    }
}

/// `None` = all namespaces may be listed; otherwise the namespace the user is limited to.
async fn scope(c: &Conn, ns: Option<String>) -> Option<String> {
    if ns.is_some() {
        return ns;
    }
    match tokio::time::timeout(Duration::from_secs(10), Api::<Pod>::all(c.client.clone()).list(&ListParams::default().limit(1))).await {
        Ok(Err(e)) if is_forbidden(&e) => Some(c.default_ns.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------------- commands: clusters

#[tauri::command]
pub fn k8s_clusters(app: State<'_, AppState>) -> Value {
    let all = list_clusters(&app);
    let stored = app.store.lock().unwrap().kube.active_cluster_id.clone();
    let current = Kubeconfig::read().ok().and_then(|k| k.current_context);
    let active = stored
        .filter(|id| all.iter().any(|c| &c.id == id))
        .or_else(|| current.filter(|id| all.iter().any(|c| &c.id == id)))
        .or_else(|| all.first().map(|c| c.id.clone()));
    json!({ "clusters": all, "activeId": active })
}

/// Contexts found in a kubeconfig file (for the "Add cluster" modal). An empty path means the default kubeconfig.
#[tauri::command]
pub fn k8s_kubeconfig_contexts(app: State<'_, AppState>, path: String) -> CmdResult<Vec<Value>> {
    let path = path.trim();
    let default = is_default_path(path);
    let kc = if default { Kubeconfig::read() } else { Kubeconfig::read_from(expand_tilde(path)) }.map_err(|e| format!("Could not read kubeconfig: {}", e))?;
    let shown: Vec<String> = list_clusters(&app).into_iter().map(|c| c.id).collect();
    Ok(contexts_of(&kc)
        .into_iter()
        .map(|(name, server, namespace, _)| {
            let id = if default { name.clone() } else { extra_id(&ExtraCluster { path: path.to_string(), context: name.clone() }) };
            json!({ "name": name, "server": server, "namespace": namespace, "added": shown.contains(&id) })
        })
        .collect())
}

fn is_default_path(path: &str) -> bool {
    path.is_empty() || default_kubeconfig_paths().iter().any(|d| same_file(d, &expand_tilde(path)))
}

/// Cluster entry for `context` in kubeconfig `path` (empty = the default kubeconfig), whether or not it is added.
fn cluster_from(path: &str, context: &str) -> Result<ClusterInfo, String> {
    let path = path.trim();
    let default = is_default_path(path);
    let kc = if default { Kubeconfig::read() } else { Kubeconfig::read_from(expand_tilde(path)) }.map_err(|e| format!("Could not read kubeconfig: {}", e))?;
    let (name, server, namespace, user) = contexts_of(&kc).into_iter().find(|c| c.0 == context).ok_or_else(|| format!("Context {} is not in this kubeconfig", context))?;
    Ok(if default {
        ClusterInfo { id: name.clone(), name, kubeconfig_path: default_kubeconfig_label(), kube_context: context.to_string(), server, namespace, user, source: "default".into() }
    } else {
        let e = ExtraCluster { path: path.to_string(), context: context.to_string() };
        ClusterInfo { id: extra_id(&e), name, kubeconfig_path: e.path, kube_context: e.context, server, namespace, user, source: "file".into() }
    })
}

#[tauri::command]
pub fn k8s_add(app: State<'_, AppState>, path: String, context: String) -> CmdResult<ClusterInfo> {
    let c = cluster_from(&path, &context)?;
    app.with_store(|s| {
        if c.source == "default" {
            s.kube.hidden.retain(|h| h != &c.id);
        } else {
            let e = ExtraCluster { path: c.kubeconfig_path.clone(), context: c.kube_context.clone() };
            if !s.kube.extra.contains(&e) {
                s.kube.extra.push(e);
            }
        }
    });
    Ok(c)
}

/// Remove a cluster from the app only (the kubeconfig is left alone) and stop its port-forwards.
#[tauri::command]
pub async fn k8s_remove(app: State<'_, AppState>, k: State<'_, K8sState>, id: String) -> CmdResult<()> {
    let c = find_cluster(&app, &id)?;
    app.with_store(|s| {
        if c.source == "default" {
            if !s.kube.hidden.contains(&id) {
                s.kube.hidden.push(id.clone());
            }
        } else {
            s.kube.extra.retain(|e| extra_id(e) != id);
        }
        if s.kube.active_cluster_id.as_deref() == Some(id.as_str()) {
            s.kube.active_cluster_id = None;
        }
    });
    stop_pfs(&k, |p| p.cluster_id == id);
    k.abort_prefix(&format!("watch:{}", id));
    k.forget(&id);
    Ok(())
}

#[tauri::command]
pub fn k8s_select(app: State<'_, AppState>, id: String) {
    app.with_store(|s| s.kube.active_cluster_id = Some(id));
}

/// `GET /version` + count nodes (`nodes` is null when the user may not list nodes).
async fn check_conn(c: &Conn, t0: Instant) -> Result<Value, String> {
    let v = match tokio::time::timeout(Duration::from_secs(8), c.client.apiserver_version()).await {
        Err(_) => return Err(format!("Could not connect to {}: i/o timeout", c.server)),
        Ok(Err(e @ (kube::Error::Api(_) | kube::Error::Auth(_)))) => return Err(kerr(e)),
        Ok(Err(e)) => return Err(format!("Could not connect to {}: {}", c.server, kerr(e))),
        Ok(Ok(v)) => v,
    };
    let ms = t0.elapsed().as_millis() as i64;
    let nodes = match tokio::time::timeout(Duration::from_secs(8), Api::<Node>::all(c.client.clone()).list(&ListParams::default())).await {
        Ok(Ok(l)) => json!(l.items.len()),
        Ok(Err(e)) if !is_forbidden(&e) => return Err(kerr(e)),
        _ => Value::Null,
    };
    Ok(json!({ "version": v.git_version, "nodes": nodes, "latencyMs": ms, "server": c.server, "namespace": c.default_ns }))
}

/// Check a saved cluster. `relogin` drops the cached client so the kubeconfig exec plugin runs again.
#[tauri::command]
pub async fn k8s_test(app: State<'_, AppState>, k: State<'_, K8sState>, id: String, relogin: Option<bool>) -> CmdResult<Value> {
    if relogin.unwrap_or(false) {
        k.forget(&id);
    }
    let t0 = Instant::now();
    let c = k.conn(&app, &id).await?;
    // A broken token/plugin stays broken in the cached client: build a new one next time.
    check_conn(&c, t0).await.inspect_err(|_| k.forget(&id))
}

/// Check a kubeconfig context before it is added (the "Add cluster" modal).
#[tauri::command]
pub async fn k8s_probe(path: String, context: String) -> CmdResult<Value> {
    let c = cluster_from(&path, &context)?;
    let t0 = Instant::now();
    check_conn(&build_conn(&c).await?, t0).await
}

#[tauri::command]
pub async fn k8s_namespaces(app: State<'_, AppState>, k: State<'_, K8sState>, id: String) -> CmdResult<Vec<String>> {
    let c = k.conn(&app, &id).await?;
    match tokio::time::timeout(Duration::from_secs(15), Api::<Namespace>::all(c.client.clone()).list(&ListParams::default())).await {
        Err(_) => Err("i/o timeout".into()),
        Ok(Ok(l)) => Ok(l.items.into_iter().filter_map(|n| n.metadata.name).collect()),
        Ok(Err(e)) if is_forbidden(&e) => Ok(vec![c.default_ns.clone()]),
        Ok(Err(e)) => Err(kerr(e)),
    }
}

/// `kind`: deployments | pods | services. `ns` = None for all namespaces.
#[tauri::command]
pub async fn k8s_list(app: State<'_, AppState>, k: State<'_, K8sState>, id: String, kind: String, ns: Option<String>) -> CmdResult<Vec<Value>> {
    let c = k.conn(&app, &id).await?;
    let ns = ns.as_deref();
    let mut rows: Vec<Value> = match kind.as_str() {
        "deployments" => list_kind::<Deployment>(&c, ns).await?.iter().map(deploy_row).collect(),
        "pods" => list_kind::<Pod>(&c, ns).await?.iter().map(pod_row).collect(),
        "services" => list_kind::<Service>(&c, ns).await?.iter().map(service_row).collect(),
        other => return Err(format!("Unknown kind: {}", other)),
    };
    rows.sort_by_key(|r| (s(r, "namespace"), s(r, "name")));
    Ok(rows)
}

// ---------------------------------------------------------------- commands: actions

#[tauri::command]
pub async fn k8s_scale(app: State<'_, AppState>, k: State<'_, K8sState>, id: String, ns: String, name: String, replicas: i32) -> CmdResult<()> {
    let c = k.conn(&app, &id).await?;
    let api = Api::<Deployment>::namespaced(c.client, &ns);
    tmo(api.patch_scale(&name, &PatchParams::default(), &Patch::Merge(json!({ "spec": { "replicas": replicas.max(0) } })))).await?;
    Ok(())
}

/// `kubectl rollout restart`: bump the `restartedAt` annotation of the pod template.
#[tauri::command]
pub async fn k8s_restart(app: State<'_, AppState>, k: State<'_, K8sState>, id: String, ns: String, name: String) -> CmdResult<()> {
    let c = k.conn(&app, &id).await?;
    let api = Api::<Deployment>::namespaced(c.client, &ns);
    let patch = json!({ "spec": { "template": { "metadata": { "annotations": { "kubectl.kubernetes.io/restartedAt": now_iso() } } } } });
    tmo(api.patch(&name, &PatchParams::default(), &Patch::Merge(patch))).await?;
    Ok(())
}

#[tauri::command]
pub async fn k8s_delete_pod(app: State<'_, AppState>, k: State<'_, K8sState>, id: String, ns: String, name: String) -> CmdResult<()> {
    let c = k.conn(&app, &id).await?;
    tmo(Api::<Pod>::namespaced(c.client, &ns).delete(&name, &DeleteParams::default())).await?;
    Ok(())
}

// ---------------------------------------------------------------- watch

/// Watch deployments/pods/services of the shown cluster + namespace and emit `k8s://watch` `{cluster, kind}` on each change
/// (the frontend debounces and reloads the list). Only one watch is open at a time.
#[tauri::command]
pub async fn k8s_watch<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, k: State<'_, K8sState>, id: String, ns: Option<String>) -> CmdResult<()> {
    k.abort_prefix("watch:");
    let c = k.conn(&st, &id).await?;
    let ns = scope(&c, ns).await;
    fn spawn_one<K, R: Runtime>(app: AppHandle<R>, api: Api<K>, cluster: String, kind: &'static str) -> JoinHandle<()>
    where
        K: Resource + Clone + DeserializeOwned + Debug + Send + 'static,
    {
        tauri::async_runtime::spawn(async move {
            let mut stream = watcher(api, watcher::Config::default()).default_backoff().boxed();
            let mut ready = false;
            while let Some(ev) = stream.next().await {
                match ev {
                    Ok(watcher::Event::InitDone) => ready = true,
                    Ok(watcher::Event::Apply(_) | watcher::Event::Delete(_)) if ready => {
                        let _ = app.emit("k8s://watch", json!({ "cluster": cluster, "kind": kind }));
                    }
                    _ => {}
                }
            }
        })
    }
    macro_rules! api {
        ($t:ty) => {
            match &ns {
                Some(n) => Api::<$t>::namespaced(c.client.clone(), n),
                None => Api::<$t>::all(c.client.clone()),
            }
        };
    }
    k.spawn_task(&format!("watch:{}:pods", id), spawn_one(app.clone(), api!(Pod), id.clone(), "pods"));
    k.spawn_task(&format!("watch:{}:deployments", id), spawn_one(app.clone(), api!(Deployment), id.clone(), "deployments"));
    k.spawn_task(&format!("watch:{}:services", id), spawn_one(app, api!(Service), id.clone(), "services"));
    Ok(())
}

#[tauri::command]
pub fn k8s_unwatch(k: State<'_, K8sState>) {
    k.abort_prefix("watch:");
}

// ---------------------------------------------------------------- logs

/// Stream a pod's log to `k8s://logs/<key>` in batches of `{ts, stream, text}` (same shape as container logs).
/// The frontend generates `key` and listens before calling.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn k8s_logs<R: Runtime>(
    app: AppHandle<R>, st: State<'_, AppState>, k: State<'_, K8sState>,
    key: String, id: String, ns: String, pod: String, container: Option<String>, previous: bool, follow: bool, tail: Option<i64>,
) -> CmdResult<()> {
    let c = k.conn(&st, &id).await?;
    let api = Api::<Pod>::namespaced(c.client, &ns);
    let lp = LogParams { container, follow, previous, tail_lines: Some(tail.unwrap_or(500)), timestamps: true, ..Default::default() };
    // Open the stream here so errors (previous container missing, 403…) come back to the caller.
    let reader = tmo(api.log_stream(&pod, &lp)).await?;
    let ev = format!("k8s://logs/{}", key);
    let h = tauri::async_runtime::spawn(async move {
        let mut chunks = reader.lines().ready_chunks(128);
        while let Some(batch) = chunks.next().await {
            let lines: Vec<Value> = batch
                .into_iter()
                .filter_map(|l| l.ok())
                .map(|l| {
                    let (ts, text) = crate::containers::split_ts(l.trim_end_matches('\r'));
                    json!({ "ts": ts, "stream": "stdout", "text": text })
                })
                .collect();
            if !lines.is_empty() {
                let _ = app.emit(&ev, lines);
            }
        }
        let _ = app.emit(&ev, json!({ "end": true }));
    });
    k.spawn_task(&format!("logs:{}", key), h);
    Ok(())
}

#[tauri::command]
pub fn k8s_logs_stop(k: State<'_, K8sState>, key: String) {
    k.abort_task(&format!("logs:{}", key));
}

// ---------------------------------------------------------------- exec

/// Interactive shell in a pod's container, streamed to `exec://<sid>` like `docker exec` (`{t: 'data', d: base64}` / `{t: 'close'}`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn k8s_exec<R: Runtime>(
    app: AppHandle<R>, st: State<'_, AppState>, k: State<'_, K8sState>,
    sid: String, id: String, ns: String, pod: String, container: Option<String>, shell: String, cols: u16, rows: u16,
) -> CmdResult<Value> {
    let c = k.conn(&st, &id).await?;
    let api = Api::<Pod>::namespaced(c.client, &ns);
    let cmd: Vec<&str> = match shell.as_str() {
        "bash" => vec!["bash"],
        "sh" => vec!["sh"],
        // "auto": bash when the image has it, otherwise sh.
        _ => vec!["sh", "-c", "export TERM=xterm-256color; command -v bash >/dev/null 2>&1 && exec bash || exec sh"],
    };
    let mut ap = AttachParams::interactive_tty();
    if let Some(cn) = container.filter(|x| !x.is_empty()) {
        ap = ap.container(cn);
    }
    let mut proc = tmo(api.exec(&pod, cmd, &ap)).await?;
    let input = proc.stdin().ok_or("exec: no stdin")?;
    let mut output = proc.stdout().ok_or("exec: no stdout")?;
    let status = proc.take_status();
    let mut size_tx = proc.terminal_size();
    let (resize, mut resize_rx) = tokio::sync::mpsc::unbounded_channel::<(u16, u16)>();
    let _ = resize.send((cols, rows));
    let ev = format!("exec://{}", sid);
    let task = tauri::async_runtime::spawn(async move {
        let b64 = base64::engine::general_purpose::STANDARD;
        let resizer = async move {
            while let Some((w, h)) = resize_rx.recv().await {
                if let Some(tx) = size_tx.as_mut() {
                    let _ = tx.send(TerminalSize { width: w, height: h }).await;
                }
            }
        };
        let reader = async {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match output.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = app.emit(&ev, json!({ "t": "data", "d": b64.encode(&buf[..n]) }));
                    }
                }
            }
        };
        tokio::select! { _ = reader => {}, _ = resizer => {} }
        // Command not found & co: the API returns a failure Status instead of output; show it in the terminal.
        if let Some(fut) = status {
            if let Ok(Some(s)) = tokio::time::timeout(Duration::from_secs(2), fut).await {
                if s.status.as_deref() == Some("Failure") {
                    let msg = format!("\r\n\x1b[31m{}\x1b[0m\r\n", s.message.unwrap_or_default());
                    let _ = app.emit(&ev, json!({ "t": "data", "d": b64.encode(msg.as_bytes()) }));
                }
            }
        }
        let _ = app.emit(&ev, json!({ "t": "close" }));
        drop(proc);
    });
    k.execs.lock().await.insert(sid.clone(), K8sExec { input: Box::pin(input), resize, task });
    Ok(json!({ "sid": sid, "shell": if shell == "auto" { String::new() } else { shell } }))
}

#[tauri::command]
pub async fn k8s_exec_write(k: State<'_, K8sState>, sid: String, data: String) -> CmdResult<()> {
    let mut ex = k.execs.lock().await;
    let s = ex.get_mut(&sid).ok_or("The terminal session is closed")?;
    s.input.write_all(data.as_bytes()).await.map_err(err)?;
    s.input.flush().await.map_err(err)
}

#[tauri::command]
pub async fn k8s_exec_resize(k: State<'_, K8sState>, sid: String, cols: u16, rows: u16) -> CmdResult<()> {
    let ex = k.execs.lock().await;
    let s = ex.get(&sid).ok_or("The terminal session is closed")?;
    let _ = s.resize.send((cols, rows));
    Ok(())
}

#[tauri::command]
pub async fn k8s_exec_close(k: State<'_, K8sState>, sid: String) -> CmdResult<()> {
    if let Some(s) = k.execs.lock().await.remove(&sid) {
        s.task.abort();
    }
    Ok(())
}

// ---------------------------------------------------------------- port-forward

fn stop_pfs(k: &K8sState, pred: impl Fn(&PfInfo) -> bool) {
    let mut pfs = k.pfs.lock().unwrap();
    let ids: Vec<String> = pfs.values().filter(|p| pred(&p.info)).map(|p| p.info.id.clone()).collect();
    for id in ids {
        if let Some(p) = pfs.remove(&id) {
            p.task.abort();
        }
    }
}

fn labels_selector(sel: &std::collections::BTreeMap<String, String>) -> String {
    sel.iter().map(|(k, v)| format!("{}={}", k, v)).collect::<Vec<_>>().join(",")
}

fn pod_ready(p: &Pod) -> bool {
    p.metadata.deletion_timestamp.is_none()
        && p.status.as_ref().and_then(|s| s.conditions.as_ref()).is_some_and(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
}

/// Pick a Ready pod behind the service and the container port the service port points to.
async fn pick_target(client: &Client, ns: &str, svc: &Service, port: u16) -> Result<(String, u16), String> {
    let spec = svc.spec.as_ref().ok_or("Service has no spec")?;
    let name = svc.metadata.name.clone().unwrap_or_default();
    let sel = spec.selector.clone().unwrap_or_default();
    if sel.is_empty() {
        return Err(format!("Service {} has no selector, so there is no pod to forward to", name));
    }
    let sp = spec.ports.iter().flatten().find(|p| p.port as u16 == port).ok_or_else(|| format!("Service {} has no port {}", name, port))?;
    let pods = tmo(Api::<Pod>::namespaced(client.clone(), ns).list(&ListParams::default().labels(&labels_selector(&sel)))).await?;
    let pod = pods.items.into_iter().find(pod_ready).ok_or_else(|| format!("No ready pod behind service {}", name))?;
    let target = match &sp.target_port {
        None => port,
        Some(IntOrString::Int(i)) => *i as u16,
        Some(IntOrString::String(named)) => pod
            .spec
            .as_ref()
            .and_then(|s| s.containers.iter().flat_map(|c| c.ports.iter().flatten()).find(|p| p.name.as_deref() == Some(named.as_str())))
            .map(|p| p.container_port as u16)
            .ok_or_else(|| format!("Named port {} not found in pod", named))?,
    };
    Ok((pod.metadata.name.unwrap_or_default(), target))
}

async fn bind_local(want: Option<u16>, remote: u16, taken: &[u16]) -> Result<tokio::net::TcpListener, String> {
    if let Some(p) = want.filter(|p| *p > 0) {
        if taken.contains(&p) {
            return Err(format!("Port {} is already in use", p));
        }
        return tokio::net::TcpListener::bind(("127.0.0.1", p)).await.map_err(|_| format!("Port {} is already in use", p));
    }
    let mut p = default_local_port(remote);
    for _ in 0..50 {
        if !taken.contains(&p) {
            if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", p)).await {
                return Ok(l);
            }
        }
        p = p.checked_add(1).ok_or("No free local port")?;
    }
    Err("No free local port".into())
}

/// Forward `127.0.0.1:<local>` to `svc/<service>:<port>`. Each new local connection picks a Ready pod again,
/// so the forward keeps working when the pod behind the service is replaced.
#[tauri::command]
pub async fn k8s_pf_start(st: State<'_, AppState>, k: State<'_, K8sState>, id: String, ns: String, service: String, port: u16, local_port: Option<u16>) -> CmdResult<PfInfo> {
    let cl = find_cluster(&st, &id)?;
    let c = k.conn(&st, &id).await?;
    let svc = tmo(Api::<Service>::namespaced(c.client.clone(), &ns).get(&service)).await?;
    // Fail now (no Ready pod, unknown port) instead of on the first connection.
    pick_target(&c.client, &ns, &svc, port).await?;
    let taken: Vec<u16> = k.pfs.lock().unwrap().values().map(|p| p.info.local_port).collect();
    let listener = bind_local(local_port, port, &taken).await?;
    let local = listener.local_addr().map_err(err)?.port();
    let info = PfInfo {
        id: format!("{}|{}|{}|{}", id, ns, service, port),
        cluster_id: id,
        cluster_name: cl.name,
        namespace: ns.clone(),
        service: service.clone(),
        remote_port: port,
        local_port: local,
    };
    if let Some(old) = k.pfs.lock().unwrap().remove(&info.id) {
        old.task.abort();
    }
    let client = c.client.clone();
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { continue };
            let client = client.clone();
            let ns = ns.clone();
            let service = service.clone();
            tokio::spawn(async move {
                let Ok(svc) = Api::<Service>::namespaced(client.clone(), &ns).get(&service).await else { return };
                let Ok((pod, target)) = pick_target(&client, &ns, &svc, port).await else { return };
                let Ok(mut pf) = Api::<Pod>::namespaced(client, &ns).portforward(&pod, &[target]).await else { return };
                let Some(mut upstream) = pf.take_stream(target) else { return };
                let _ = tokio::io::copy_bidirectional(&mut sock, &mut upstream).await;
                drop(upstream);
                let _ = pf.join().await;
            });
        }
    });
    k.pfs.lock().unwrap().insert(info.id.clone(), PortForward { info: info.clone(), task });
    Ok(info)
}

#[tauri::command]
pub fn k8s_pf_stop(k: State<'_, K8sState>, pf_id: String) {
    stop_pfs(&k, |p| p.id == pf_id);
}

#[tauri::command]
pub fn k8s_pf_list(k: State<'_, K8sState>) -> Vec<PfInfo> {
    let mut v: Vec<PfInfo> = k.pfs.lock().unwrap().values().map(|p| p.info.clone()).collect();
    v.sort_by_key(|p| p.local_port);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pod(v: Value) -> Pod {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn k8s_pod_status_like_kubectl() {
        let running = pod(json!({ "metadata": { "name": "a" }, "status": { "phase": "Running", "containerStatuses": [
            { "name": "c", "ready": true, "restartCount": 0, "image": "x", "imageID": "", "state": { "running": {} } } ] } }));
        assert_eq!(pod_status(&running), "Running");
        let crash = pod(json!({ "metadata": { "name": "a" }, "status": { "phase": "Running", "containerStatuses": [
            { "name": "c", "ready": false, "restartCount": 7, "image": "x", "imageID": "", "state": { "waiting": { "reason": "CrashLoopBackOff" } } } ] } }));
        assert_eq!(pod_status(&crash), "CrashLoopBackOff");
        let creating = pod(json!({ "metadata": { "name": "a" }, "status": { "phase": "Pending", "containerStatuses": [
            { "name": "c", "ready": false, "restartCount": 0, "image": "x", "imageID": "", "state": { "waiting": { "reason": "ContainerCreating" } } } ] } }));
        assert_eq!(pod_status(&creating), "ContainerCreating");
        let done = pod(json!({ "metadata": { "name": "a" }, "status": { "phase": "Succeeded", "containerStatuses": [
            { "name": "c", "ready": false, "restartCount": 0, "image": "x", "imageID": "", "state": { "terminated": { "exitCode": 0, "reason": "Completed" } } } ] } }));
        assert_eq!(pod_status(&done), "Completed");
        let oom = pod(json!({ "metadata": { "name": "a" }, "status": { "phase": "Running", "containerStatuses": [
            { "name": "c", "ready": false, "restartCount": 1, "image": "x", "imageID": "", "state": { "terminated": { "exitCode": 137, "reason": "OOMKilled" } } } ] } }));
        assert_eq!(pod_status(&oom), "OOMKilled");
        let init = pod(json!({ "metadata": { "name": "a" }, "status": { "phase": "Pending", "initContainerStatuses": [
            { "name": "i", "ready": false, "restartCount": 0, "image": "x", "imageID": "", "state": { "waiting": { "reason": "PodInitializing" } } } ] } }));
        assert_eq!(pod_status(&init), "Init:0/1");
        let term = pod(json!({ "metadata": { "name": "a", "deletionTimestamp": "2026-01-01T00:00:00Z" }, "status": { "phase": "Running" } }));
        assert_eq!(pod_status(&term), "Terminating");
        let evicted = pod(json!({ "metadata": { "name": "a" }, "status": { "phase": "Failed", "reason": "Evicted" } }));
        assert_eq!(pod_status(&evicted), "Evicted");
    }

    #[test]
    fn k8s_default_local_port() {
        assert_eq!(default_local_port(80), 8080);
        assert_eq!(default_local_port(443), 8443);
        assert_eq!(default_local_port(3000), 3000);
    }

    #[test]
    fn k8s_pod_row_fields() {
        let p = pod(json!({ "metadata": { "name": "api-1", "namespace": "shop", "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "api-7f", "uid": "u" }] },
            "spec": { "nodeName": "n1", "containers": [{ "name": "api" }, { "name": "sidecar" }] },
            "status": { "phase": "Running", "containerStatuses": [
                { "name": "api", "ready": true, "restartCount": 2, "image": "x", "imageID": "", "state": { "running": {} },
                  "lastState": { "terminated": { "exitCode": 137, "reason": "OOMKilled" } } },
                { "name": "sidecar", "ready": false, "restartCount": 3, "image": "x", "imageID": "", "state": { "waiting": { "reason": "ImagePullBackOff", "message": "pull access denied" } } } ] } }));
        let r = pod_row(&p);
        assert_eq!(r["ready"], "1/2");
        assert_eq!(r["restarts"], 5);
        assert_eq!(r["status"], "ImagePullBackOff");
        assert_eq!(r["waitingReason"], "ImagePullBackOff");
        assert_eq!(r["lastTerminatedReason"], "OOMKilled");
        assert_eq!(r["owner"]["kind"], "ReplicaSet");
        assert_eq!(r["containers"], json!(["api", "sidecar"]));
    }
}
