//! Docker contexts: read/write `~/.docker/contexts` (the same files as `docker context ls`), plus WSL2 engines kept in the
//! app; connect to the engine (unix socket / named pipe, TCP, TCP+TLS, SSH and WSL2 through `bridge`), switch context.
use crate::bridge::{self, Bridge};
use crate::state::{ActiveCtx, AppState};
use crate::store::{Store, WslCtx};
use crate::util::*;
use bollard::{Docker, API_DEFAULT_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime, State};

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CtxInfo {
    pub id: String,
    pub name: String,
    /// local | ssh | tcp | wsl
    pub kind: String,
    pub endpoint: String,
    pub supported: bool,
    /// Why the context cannot be used here (when `supported` is false).
    pub reason: Option<String>,
    pub description: String,
    /// default (DOCKER_HOST / the local socket) | docker (`~/.docker/contexts`) | app (WSL2, stored by the app)
    pub source: String,
    pub tls: bool,
    pub tls_dir: Option<String>,
    pub skip_tls_verify: bool,
    pub ssh_key: Option<String>,
    pub wsl_distro: Option<String>,
    #[serde(skip)]
    pub meta_dir: Option<PathBuf>,
}

pub fn kind_of(endpoint: &str) -> &'static str {
    if endpoint.starts_with("ssh://") {
        "ssh"
    } else if endpoint.starts_with("tcp://") || endpoint.starts_with("http") {
        "tcp"
    } else if endpoint.starts_with("wsl://") {
        "wsl"
    } else {
        "local"
    }
}

const TLS_FILES: [&str; 3] = ["ca.pem", "cert.pem", "key.pem"];

/// Fill `supported` / `reason` for this machine.
fn finalize(mut c: CtxInfo) -> CtxInfo {
    let reason: Option<String> = match c.kind.as_str() {
        "local" if c.endpoint.starts_with("npipe://") && !cfg!(windows) => Some("Named pipes are only available on Windows".into()),
        "tcp" if c.skip_tls_verify => Some("Contexts that skip TLS verification are not supported".into()),
        "tcp" if c.tls => {
            let dir = c.tls_dir.clone().unwrap_or_default();
            TLS_FILES.iter().find(|f| !Path::new(&dir).join(f).exists()).map(|f| format!("{} is missing in {}", f, dir))
        }
        "wsl" if crate::wsl::program().is_none() => Some("WSL2 connections only work on Windows".into()),
        _ => None,
    };
    c.supported = reason.is_none();
    c.reason = reason;
    c
}

pub fn docker_config_dir() -> PathBuf {
    match std::env::var("DOCKER_CONFIG") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => home().join(".docker"),
    }
}

/// Directory name of a context in `~/.docker/contexts/{meta,tls}`: the SHA-256 of its name (as the docker CLI does).
pub fn ctx_dir_name(name: &str) -> String {
    Sha256::digest(name.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
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
        if Path::new(c).exists() {
            return format!("unix://{}", c);
        }
    }
    "unix:///var/run/docker.sock".into()
}

fn default_ctx() -> CtxInfo {
    let endpoint = default_endpoint();
    let tls = std::env::var("DOCKER_TLS_VERIFY").map(|v| !v.is_empty() && v != "0").unwrap_or(false);
    let tls_dir = tls.then(|| std::env::var("DOCKER_CERT_PATH").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| docker_config_dir().to_string_lossy().to_string()));
    finalize(CtxInfo {
        id: "default".into(),
        name: "default".into(),
        kind: kind_of(&endpoint).into(),
        endpoint,
        description: "Current DOCKER_HOST based configuration".into(),
        source: "default".into(),
        tls,
        tls_dir,
        ..Default::default()
    })
}

fn read_docker_ctx(meta_dir: &Path, store: &Store) -> Option<CtxInfo> {
    let t = std::fs::read_to_string(meta_dir.join("meta.json")).ok()?;
    let v: Value = serde_json::from_str(&t).ok()?;
    let name = s(&v, "Name");
    let ep = &v["Endpoints"]["docker"];
    let host = ep["Host"].as_str().unwrap_or("").to_string();
    if name.is_empty() || host.is_empty() {
        return None;
    }
    let dir_name = meta_dir.file_name()?.to_string_lossy().to_string();
    let tls_dir = docker_config_dir().join("contexts/tls").join(&dir_name).join("docker");
    let tls = kind_of(&host) == "tcp" && tls_dir.exists();
    Some(finalize(CtxInfo {
        id: name.clone(),
        kind: kind_of(&host).into(),
        endpoint: host,
        description: v["Metadata"]["Description"].as_str().unwrap_or("").to_string(),
        source: "docker".into(),
        tls,
        tls_dir: tls.then(|| tls_dir.to_string_lossy().to_string()),
        skip_tls_verify: ep["SkipTLSVerify"].as_bool().unwrap_or(false),
        ssh_key: store.ssh_keys.get(&name).cloned(),
        meta_dir: Some(meta_dir.to_path_buf()),
        name,
        ..Default::default()
    }))
}

fn wsl_ctx(w: &WslCtx) -> CtxInfo {
    finalize(CtxInfo {
        id: w.name.clone(),
        name: w.name.clone(),
        kind: "wsl".into(),
        endpoint: format!("wsl://{}", w.distro),
        description: format!("WSL2 · {}", w.distro),
        source: "app".into(),
        wsl_distro: Some(w.distro.clone()),
        ..Default::default()
    })
}

pub fn list_contexts(store: &Store) -> Vec<CtxInfo> {
    let mut out = vec![default_ctx()];
    if let Ok(rd) = std::fs::read_dir(docker_config_dir().join("contexts/meta")) {
        for e in rd.flatten() {
            if let Some(c) = read_docker_ctx(&e.path(), store) {
                out.push(c);
            }
        }
    }
    out.extend(store.wsl_contexts.iter().map(wsl_ctx));
    out[1..].sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn find(state: &AppState, id: &str) -> Result<CtxInfo, String> {
    let st = state.store.lock().unwrap();
    list_contexts(&st).into_iter().find(|c| c.id == id).ok_or_else(|| "Context not found".to_string())
}

fn cli_current_context() -> String {
    if let Ok(c) = std::env::var("DOCKER_CONTEXT") {
        if !c.is_empty() {
            return c;
        }
    }
    std::fs::read_to_string(docker_config_dir().join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["currentContext"].as_str().map(|x| x.to_string()))
        .unwrap_or_else(|| "default".into())
}

/// Pick the context at startup: the app's last used one, then the docker CLI's current context.
pub fn initial_context(store: &Store) -> ActiveCtx {
    let all = list_contexts(store);
    let pick = store
        .settings
        .active_context_id
        .clone()
        .and_then(|p| all.iter().find(|c| c.id == p && c.supported).cloned())
        .or_else(|| {
            let cur = cli_current_context();
            all.iter().find(|c| c.id == cur && c.supported).cloned()
        })
        .unwrap_or_else(|| all[0].clone());
    ActiveCtx::from_spec(pick)
}

// ---------------------------------------------------------------- connecting

/// Build a client (no request yet). `bridge_addr` replaces the endpoint for SSH/WSL2.
pub fn connect(c: &CtxInfo, bridge_addr: Option<&str>) -> Result<Docker, String> {
    const T: u64 = 24 * 3600;
    if let Some(a) = bridge_addr {
        return Docker::connect_with_http(a, T, API_DEFAULT_VERSION).map_err(err);
    }
    if let Some(r) = &c.reason {
        return Err(r.clone());
    }
    let endpoint = c.endpoint.as_str();
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
    } else if c.kind == "tcp" && c.tls {
        let dir = PathBuf::from(c.tls_dir.clone().unwrap_or_default());
        Docker::connect_with_ssl(endpoint, &dir.join("key.pem"), &dir.join("cert.pem"), &dir.join("ca.pem"), T, API_DEFAULT_VERSION)
    } else if c.kind == "tcp" {
        Docker::connect_with_http(endpoint, T, API_DEFAULT_VERSION)
    } else if bridge::needs_bridge(c) {
        return Err("This connection needs a bridge".into());
    } else {
        Docker::connect_with_unix(endpoint, T, API_DEFAULT_VERSION)
    };
    r.map_err(|e| match e {
        bollard::errors::Error::SocketNotFoundError(p) => format!("Docker socket not found: {}", p),
        o => o.to_string(),
    })
}

/// Address and error log of a running bridge.
pub type BridgeRef = (String, Arc<StdMutex<String>>);

/// Connect, negotiate the API version (Docker 27 only speaks up to API 1.47) and ping. For bridged engines the error is the bridge's stderr when it has one
/// (`Permission denied (publickey)`, `docker: not found`…), which says much more than a closed connection.
pub async fn open(c: &CtxInfo, bridge: Option<BridgeRef>) -> Result<Docker, String> {
    let d = connect(c, bridge.as_ref().map(|b| b.0.as_str()))?;
    let secs = if bridge.is_some() { 15 } else { 5 };
    let r = tokio::time::timeout(Duration::from_secs(secs), async {
        let n = d.negotiate_version().await.map_err(derr)?;
        n.ping().await.map_err(derr)?;
        Ok::<Docker, String>(n)
    })
    .await
    .unwrap_or_else(|_| Err("i/o timeout".into()));
    match (r, bridge) {
        (Ok(n), _) => Ok(n),
        (Err(e), Some((_, log))) => {
            // The bridge process may still be writing its error.
            for _ in 0..10 {
                let t = log.lock().unwrap().clone();
                if !t.is_empty() {
                    return Err(explain_bridge_error(&t));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e)
        }
        (Err(e), None) => Err(e),
    }
}

/// Add a hint to the usual SSH / WSL failures; the original text stays first.
pub fn explain_bridge_error(e: &str) -> String {
    let hint = if e.contains("Host key verification failed") {
        "the host is not in known_hosts yet: connect once with `ssh` in a terminal to trust its key"
    } else if e.contains("Permission denied") {
        "the SSH key was rejected: check the user, the key file or ssh-agent"
    } else if e.contains("docker: not found") || e.contains("docker: command not found") || e.contains("exec: docker") {
        "the docker CLI is not installed on that machine"
    } else if e.contains("permission denied while trying to connect to the Docker daemon") {
        "the user cannot access /var/run/docker.sock: add it to the docker group"
    } else {
        return e.to_string();
    };
    format!("{} ({})", e.trim_end_matches('.'), hint)
}

/// Connect to a context that is not (necessarily) the active one. The returned bridge must be kept alive with the client.
pub async fn open_spec(c: &CtxInfo) -> Result<(Docker, Option<Bridge>), String> {
    if !bridge::needs_bridge(c) {
        return Ok((open(c, None).await?, None));
    }
    if let Some(r) = &c.reason {
        return Err(r.clone());
    }
    let b = bridge::start(c).await?;
    let d = open(c, Some((b.addr(), b.last_error.clone()))).await?;
    Ok((d, Some(b)))
}

/// Connect to the active context, reusing (or starting) its bridge.
pub async fn connect_active(st: &AppState) -> Result<Docker, String> {
    let c = st.active().spec;
    if !bridge::needs_bridge(&c) {
        return open(&c, None).await;
    }
    let existing = st.bridge.lock().unwrap().as_ref().filter(|b| b.ctx_id == c.id).map(|b| (b.addr(), b.last_error.clone()));
    let br = match existing {
        Some(b) => b,
        None => {
            let b = bridge::start(&c).await?;
            let r = (b.addr(), b.last_error.clone());
            *st.bridge.lock().unwrap() = Some(b);
            r
        }
    };
    br.1.lock().unwrap().clear();
    open(&c, Some(br)).await
}

/// `DOCKER_HOST` & co for the docker CLI (compose, build, volume helpers) on the active context.
pub fn cli_env(st: &AppState) -> Vec<(&'static str, String)> {
    let c = st.active().spec;
    let host = if bridge::needs_bridge(&c) {
        st.bridge.lock().unwrap().as_ref().filter(|b| b.ctx_id == c.id).map(|b| b.addr()).unwrap_or_else(|| c.endpoint.clone())
    } else {
        c.endpoint.clone()
    };
    let mut v = vec![("DOCKER_HOST", host)];
    if c.kind == "tcp" && c.tls {
        v.push(("DOCKER_TLS_VERIFY", "1".into()));
        v.push(("DOCKER_CERT_PATH", c.tls_dir.clone().unwrap_or_default()));
    }
    v
}

/// Endpoint for the raw `/system/df` GET: plain sockets and bridges only (empty = use bollard).
pub fn raw_endpoint(st: &AppState) -> String {
    let c = st.active().spec;
    if bridge::needs_bridge(&c) {
        return st.bridge.lock().unwrap().as_ref().filter(|b| b.ctx_id == c.id).map(|b| b.addr()).unwrap_or_default();
    }
    if c.tls {
        return String::new();
    }
    c.endpoint
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

// ---------------------------------------------------------------- new connections

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewCtx {
    pub name: String,
    /// local | ssh | tcp | wsl
    pub kind: String,
    pub socket: Option<String>,
    pub host: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub key: Option<String>,
    pub tls: Option<bool>,
    pub cert_dir: Option<String>,
    pub distro: Option<String>,
}

fn valid_name(n: &str) -> bool {
    let mut ch = n.chars();
    matches!(ch.next(), Some(c) if c.is_ascii_alphanumeric()) && ch.all(|c| c.is_ascii_alphanumeric() || "_.+-".contains(c))
}

fn opt(v: &Option<String>) -> String {
    v.as_deref().unwrap_or("").trim().to_string()
}

/// Turn the "Add connection" form into a context (not saved). Shared by `ctx_probe` and `ctx_add`.
pub fn from_form(f: &NewCtx) -> Result<CtxInfo, String> {
    let name = f.name.trim().to_string();
    if !valid_name(&name) {
        return Err("Invalid name: use letters, digits, '.', '_', '+' or '-' (starting with a letter or digit)".into());
    }
    let mut c = CtxInfo { id: name.clone(), name, kind: f.kind.clone(), source: "docker".into(), description: "Created by Dockspan".into(), ..Default::default() };
    match f.kind.as_str() {
        "local" => {
            let sock = opt(&f.socket);
            if sock.is_empty() {
                return Err("Enter the socket path".into());
            }
            c.endpoint = if sock.contains("://") { sock } else { format!("unix://{}", expand_tilde(&sock).to_string_lossy()) };
        }
        "ssh" => {
            let host = opt(&f.host);
            if host.is_empty() {
                return Err("Enter the host".into());
            }
            let user = opt(&f.user);
            let port = f.port.unwrap_or(22);
            c.endpoint = format!("ssh://{}{}{}", if user.is_empty() { String::new() } else { format!("{}@", user) }, host, if port == 22 { String::new() } else { format!(":{}", port) });
            c.ssh_key = Some(opt(&f.key)).filter(|k| !k.is_empty());
        }
        "tcp" => {
            let host = opt(&f.host).trim_start_matches("tcp://").to_string();
            if host.is_empty() {
                return Err("Enter host:port".into());
            }
            c.tls = f.tls.unwrap_or(false);
            let addr = if host.rsplit_once(':').is_some_and(|(_, p)| p.parse::<u16>().is_ok()) { host } else { format!("{}:{}", host, if c.tls { 2376 } else { 2375 }) };
            c.endpoint = format!("tcp://{}", addr);
            if c.tls {
                let dir = opt(&f.cert_dir);
                if dir.is_empty() {
                    return Err("Choose the certificate folder (ca.pem, cert.pem, key.pem)".into());
                }
                c.tls_dir = Some(expand_tilde(&dir).to_string_lossy().to_string());
            }
        }
        "wsl" => {
            let d = opt(&f.distro);
            if d.is_empty() {
                return Err("Choose a WSL2 distro".into());
            }
            c.endpoint = format!("wsl://{}", d);
            c.wsl_distro = Some(d);
            c.source = "app".into();
        }
        k => return Err(format!("Unknown connection type: {}", k)),
    }
    Ok(finalize(c))
}

/// Write a docker context exactly like `docker context create` (meta.json + copied TLS files).
fn write_docker_ctx(c: &CtxInfo) -> Result<(), String> {
    let base = docker_config_dir().join("contexts");
    let id = ctx_dir_name(&c.name);
    let meta = json!({
        "Name": c.name,
        "Metadata": { "Description": c.description },
        "Endpoints": { "docker": { "Host": c.endpoint, "SkipTLSVerify": false } },
    });
    let mdir = base.join("meta").join(&id);
    std::fs::create_dir_all(&mdir).map_err(err)?;
    if c.tls {
        let src = PathBuf::from(c.tls_dir.clone().unwrap_or_default());
        let dst = base.join("tls").join(&id).join("docker");
        std::fs::create_dir_all(&dst).map_err(err)?;
        for f in TLS_FILES {
            std::fs::copy(src.join(f), dst.join(f)).map_err(|e| format!("Could not copy {}: {}", f, e))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(dst.join(f), std::fs::Permissions::from_mode(if f == "key.pem" { 0o600 } else { 0o644 }));
            }
        }
    }
    std::fs::write(mdir.join("meta.json"), serde_json::to_vec(&meta).map_err(err)?).map_err(err)
}

/// Check a connection from the "Add connection" form before saving it.
#[tauri::command]
pub async fn ctx_probe(spec: NewCtx) -> CmdResult<Value> {
    let c = from_form(&spec)?;
    test_ctx(&c).await
}

async fn test_ctx(c: &CtxInfo) -> CmdResult<Value> {
    let t0 = Instant::now();
    let (d, _bridge) = open_spec(c).await.map_err(|e| format!("Could not connect to {}: {}", c.endpoint, e))?;
    let ms = t0.elapsed().as_millis() as i64;
    let mut info = fetch_info(&d).await;
    info["latencyMs"] = json!(ms);
    Ok(info)
}

/// Save a new connection. SSH/TCP/local ones become docker contexts (visible in `docker context ls`); WSL2 ones stay in the app.
#[tauri::command]
pub fn ctx_add(state: State<'_, AppState>, spec: NewCtx) -> CmdResult<CtxInfo> {
    let c = from_form(&spec)?;
    let exists = { list_contexts(&state.store.lock().unwrap()).iter().any(|x| x.name.eq_ignore_ascii_case(&c.name)) };
    if exists {
        return Err(format!("A connection named {} already exists", c.name));
    }
    if let Some(r) = c.reason.as_ref().filter(|_| c.kind == "tcp" && c.tls) {
        return Err(r.clone());
    }
    if c.source == "app" {
        let w = WslCtx { name: c.name.clone(), distro: c.wsl_distro.clone().unwrap_or_default() };
        state.with_store(|s| s.wsl_contexts.push(w));
    } else {
        write_docker_ctx(&c)?;
        if let Some(k) = &c.ssh_key {
            let (n, k) = (c.name.clone(), k.clone());
            state.with_store(|s| s.ssh_keys.insert(n, k));
        }
    }
    find(&state, &c.id)
}

/// Remove a connection: the docker context files (as `docker context rm`) or the app's WSL2 entry.
/// The engine itself and its containers are not touched.
#[tauri::command]
pub fn ctx_remove(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let c = find(&state, &id)?;
    if c.source == "default" {
        return Err("The default context cannot be removed".into());
    }
    if state.active().id == id {
        return Err("Switch to another context before removing this one".into());
    }
    if c.source == "docker" {
        if cli_current_context() == c.name {
            return Err("This is the docker CLI's current context; run `docker context use default` first".into());
        }
        if let Some(m) = &c.meta_dir {
            std::fs::remove_dir_all(m).map_err(err)?;
            if let Some(dir) = m.file_name() {
                let _ = std::fs::remove_dir_all(docker_config_dir().join("contexts/tls").join(dir));
            }
        }
    }
    state.with_store(|s| {
        s.wsl_contexts.retain(|w| w.name != id);
        s.ssh_keys.remove(&id);
        s.schedules.remove(&id);
    });
    Ok(())
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn ctx_list(state: State<'_, AppState>) -> Vec<Value> {
    let active = state.active();
    let all = list_contexts(&state.store.lock().unwrap());
    all.into_iter()
        .map(|c| {
            let mut v = to_v(&c);
            v["active"] = json!(c.id == active.id);
            v
        })
        .collect()
}

#[tauri::command]
pub async fn ctx_test(state: State<'_, AppState>, id: String) -> CmdResult<Value> {
    let c = find(&state, &id)?;
    test_ctx(&c).await
}

#[tauri::command]
pub async fn ctx_switch<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String) -> CmdResult<ActiveCtx> {
    let c = find(&state, &id)?;
    if let Some(r) = &c.reason {
        return Err(r.clone());
    }
    // On failure keep the old context.
    let (d, bridge) = open_spec(&c).await.map_err(|e| format!("Could not connect to {}: {}", c.endpoint, e))?;
    // Cancel every stream (events, logs, stats, exec) of the old context before opening the new one.
    state.abort_prefix("");
    {
        let mut ex = state.execs.lock().await;
        for (_, s) in ex.drain() {
            s.task.abort();
        }
    }
    let next = ActiveCtx::from_spec(c.clone());
    *state.active.lock().unwrap() = next.clone();
    *state.docker.lock().unwrap() = Some(d);
    *state.info.lock().unwrap() = None;
    // Replacing the bridge drops (stops) the old context's one.
    *state.bridge.lock().unwrap() = bridge;
    state.with_store(|s| s.settings.active_context_id = Some(c.id));
    crate::events::start_monitor(&app);
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(kind: &str) -> NewCtx {
        NewCtx { name: "prod".into(), kind: kind.into(), ..Default::default() }
    }

    #[test]
    fn ctx_form_endpoints() {
        let mut f = form("ssh");
        f.host = Some("203.0.113.10".into());
        f.user = Some("deploy".into());
        assert_eq!(from_form(&f).unwrap().endpoint, "ssh://deploy@203.0.113.10");
        f.port = Some(2222);
        assert_eq!(from_form(&f).unwrap().endpoint, "ssh://deploy@203.0.113.10:2222");
        let mut t = form("tcp");
        t.host = Some("10.0.0.25".into());
        assert_eq!(from_form(&t).unwrap().endpoint, "tcp://10.0.0.25:2375");
        t.tls = Some(true);
        assert!(from_form(&t).is_err(), "TLS needs a certificate folder");
        t.cert_dir = Some("/nonexistent".into());
        let c = from_form(&t).unwrap();
        assert_eq!(c.endpoint, "tcp://10.0.0.25:2376");
        assert!(!c.supported && c.reason.unwrap().contains("ca.pem"));
        let mut w = form("wsl");
        w.distro = Some("Ubuntu-24.04".into());
        let c = from_form(&w).unwrap();
        assert_eq!((c.endpoint.as_str(), c.source.as_str()), ("wsl://Ubuntu-24.04", "app"));
        let mut bad = form("ssh");
        bad.name = "-x".into();
        assert!(from_form(&bad).is_err());
    }

    #[test]
    fn ctx_bridge_error_hints() {
        assert_eq!(explain_bridge_error("Host key verification failed."), "Host key verification failed (the host is not in known_hosts yet: connect once with `ssh` in a terminal to trust its key)");
        assert_eq!(explain_bridge_error("something else"), "something else");
    }

    #[test]
    fn ctx_dir_name_is_sha256() {
        // Same value as the docker CLI: digest.FromString("default").Encoded()
        assert_eq!(ctx_dir_name("default"), "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f");
    }
}
