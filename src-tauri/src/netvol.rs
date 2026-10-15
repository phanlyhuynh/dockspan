use crate::cli;
use crate::state::AppState;
use crate::util::*;
use bollard::query_parameters::*;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

// ---------- networks ----------

#[tauri::command]
pub async fn networks_list(state: State<'_, AppState>) -> CmdResult<Vec<Value>> {
    let d = state.docker()?;
    let list = d.list_networks(None::<ListNetworksOptions>).await.map_err(derr)?;
    Ok(list
        .iter()
        .map(|n| {
            let v = to_v(n);
            let name = s(&v, "Name");
            let cfg = &v["IPAM"]["Config"][0];
            let system = ["bridge", "host", "none"].contains(&name.as_str());
            json!({
                "id": s(&v, "Id"),
                "name": name,
                "driver": s(&v, "Driver"),
                "scope": s(&v, "Scope"),
                "subnet": cfg["Subnet"].as_str().unwrap_or("—"),
                "gateway": cfg["Gateway"].as_str().unwrap_or("—"),
                "system": system,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn network_inspect(state: State<'_, AppState>, id: String) -> CmdResult<Value> {
    let d = state.docker()?;
    let r = d.inspect_network(&id, None::<InspectNetworkOptions>).await.map_err(derr)?;
    let v = to_v(&r);
    let cfg = &v["IPAM"]["Config"][0];
    let containers: Vec<Value> = v["Containers"]
        .as_object()
        .map(|m| m.iter().map(|(cid, c)| json!({ "id": cid, "name": c["Name"], "ip": c["IPv4Address"] })).collect())
        .unwrap_or_default();
    Ok(json!({
        "id": s(&v, "Id"), "name": s(&v, "Name"), "driver": s(&v, "Driver"), "scope": s(&v, "Scope"),
        "subnet": cfg["Subnet"].as_str().unwrap_or("—"), "gateway": cfg["Gateway"].as_str().unwrap_or("—"),
        "containers": containers,
    }))
}

#[derive(Deserialize)]
pub struct NetCreate {
    pub name: String,
    pub driver: String,
    pub subnet: Option<String>,
}

#[tauri::command]
pub async fn network_create(state: State<'_, AppState>, spec: NetCreate) -> CmdResult<String> {
    let d = state.docker()?;
    let mut body = json!({ "Name": spec.name, "Driver": spec.driver, "CheckDuplicate": true });
    if let Some(sn) = spec.subnet.as_ref().filter(|x| !x.trim().is_empty()) {
        body["IPAM"] = json!({ "Config": [{ "Subnet": sn.trim() }] });
    }
    let req: bollard::models::NetworkCreateRequest = serde_json::from_value(body).map_err(err)?;
    let r = d.create_network(req).await.map_err(derr)?;
    Ok(r.id)
}

#[tauri::command]
pub async fn network_remove(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.docker()?.remove_network(&id).await.map_err(derr)
}

#[tauri::command]
pub async fn network_connect(state: State<'_, AppState>, network: String, container: String) -> CmdResult<()> {
    let req: bollard::models::NetworkConnectRequest = serde_json::from_value(json!({ "Container": container })).map_err(err)?;
    state.docker()?.connect_network(&network, req).await.map_err(derr)
}

#[tauri::command]
pub async fn network_disconnect(state: State<'_, AppState>, network: String, container: String) -> CmdResult<()> {
    let req: bollard::models::NetworkDisconnectRequest = serde_json::from_value(json!({ "Container": container, "Force": true })).map_err(err)?;
    state.docker()?.disconnect_network(&network, req).await.map_err(derr)
}

// ---------- volumes ----------

#[tauri::command]
pub async fn volumes_list(state: State<'_, AppState>) -> CmdResult<Vec<Value>> {
    let d = state.docker()?;
    let r = d.list_volumes(None::<ListVolumesOptions>).await.map_err(derr)?;
    let v = to_v(&r);
    Ok(v["Volumes"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|x| json!({ "name": s(x, "Name"), "driver": s(x, "Driver"), "mountpoint": s(x, "Mountpoint"), "createdAt": s(x, "CreatedAt") }))
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn volume_create(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    let req: bollard::models::VolumeCreateRequest = serde_json::from_value(json!({ "Name": name })).map_err(err)?;
    state.docker()?.create_volume(req).await.map_err(derr)?;
    Ok(())
}

#[tauri::command]
pub async fn volume_remove(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    state.docker()?.remove_volume(&name, None::<RemoveVolumeOptions>).await.map_err(derr)
}

fn backup_dir() -> std::path::PathBuf {
    home().join("docker-backups")
}

/// List files/folders in a volume using a temporary `alpine` container (the Mountpoint lives inside the VM so it cannot be read directly).
#[tauri::command]
pub async fn volume_ls_files(state: State<'_, AppState>, name: String, path: Option<String>) -> CmdResult<Vec<Value>> {
    let mut cmd = cli::docker_cmd(&state);
    let script = r#"cd "/v/$1" 2>/dev/null || exit 3
for f in .[!.]* ..?* *; do [ -e "$f" ] || [ -L "$f" ] || continue; stat -c '%F|%s|%Y|%n' "$f"; done"#;
    cmd.args(["run", "--rm", "-v"]).arg(format!("{}:/v:ro", name)).args(["alpine", "sh", "-c", script, "_"]).arg(path.unwrap_or_default());
    let out = cli::run_output(cmd).await?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(4, '|');
            let kind = p.next()?;
            let size = p.next()?.parse::<i64>().ok()?;
            let mtime = p.next()?.parse::<i64>().ok()?;
            let name = p.next()?.to_string();
            Some(json!({ "name": name, "isDir": kind.contains("directory"), "size": size, "mtime": mtime }))
        })
        .collect())
}

#[tauri::command]
pub async fn volume_download_file(state: State<'_, AppState>, name: String, path: String, dest: String) -> CmdResult<()> {
    let mut cmd = cli::docker_cmd(&state);
    cmd.args(["run", "--rm", "-v"]).arg(format!("{}:/v:ro", name)).args(["alpine", "cat"]).arg(format!("/v/{}", path.trim_start_matches('/')));
    let out = std::fs::File::create(&dest).map_err(err)?;
    // Do not use `.output()`: tokio forces stdout into a pipe and ignores the target file.
    cmd.stdout(out).stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not run the docker CLI: {}", e))?;
    let mut errtxt = String::new();
    if let Some(mut e) = child.stderr.take() {
        use tokio::io::AsyncReadExt;
        let _ = e.read_to_string(&mut errtxt).await;
    }
    let st = child.wait().await.map_err(err)?;
    if st.success() {
        Ok(())
    } else {
        let _ = std::fs::remove_file(&dest);
        Err(errtxt.trim().to_string())
    }
}

#[tauri::command]
pub async fn volume_backup(state: State<'_, AppState>, name: String) -> CmdResult<String> {
    let dir = backup_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    let file = format!("{}-{}.tar.gz", name, chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let mut cmd = cli::docker_cmd(&state);
    cmd.args(["run", "--rm", "-v"])
        .arg(format!("{}:/v:ro", name))
        .arg("-v")
        .arg(format!("{}:/b", dir.to_string_lossy()))
        .args(["alpine", "tar", "czf"])
        .arg(format!("/b/{}", file))
        .args(["-C", "/v", "."]);
    cli::run_output(cmd).await?;
    Ok(dir.join(file).to_string_lossy().to_string())
}

#[tauri::command]
pub fn backups_list() -> Vec<Value> {
    let mut out: Vec<(std::time::SystemTime, Value)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(backup_dir()) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.ends_with(".tar.gz") {
                let m = e.metadata().ok();
                let t = m.as_ref().and_then(|m| m.modified().ok()).unwrap_or(std::time::UNIX_EPOCH);
                out.push((t, json!({ "name": n, "size": m.map(|m| m.len()).unwrap_or(0) })));
            }
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|x| x.1).collect()
}

#[tauri::command]
pub async fn volume_restore(state: State<'_, AppState>, name: String, file: String) -> CmdResult<()> {
    if file.contains('/') || file.contains("..") {
        return Err("Invalid backup file name".into());
    }
    let mut cmd = cli::docker_cmd(&state);
    cmd.args(["run", "--rm", "-v"])
        .arg(format!("{}:/v", name))
        .arg("-v")
        .arg(format!("{}:/b:ro", backup_dir().to_string_lossy()))
        .args(["alpine", "tar", "xzf"])
        .arg(format!("/b/{}", file))
        .args(["-C", "/v"]);
    cli::run_output(cmd).await.map(|_| ())
}
