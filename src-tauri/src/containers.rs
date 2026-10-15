use crate::state::{AppState, ExecSession};
use crate::util::*;
use base64::Engine;
use bollard::query_parameters::*;
use bollard::exec::StartExecOptions;
use bollard::container::LogOutput;
use bollard::exec::StartExecResults;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::AsyncWriteExt;

fn health_of(status: &str) -> Value {
    if status.contains("(healthy)") {
        json!("healthy")
    } else if status.contains("(unhealthy)") {
        json!("unhealthy")
    } else if status.contains("(health: starting)") {
        json!("starting")
    } else {
        Value::Null
    }
}

#[tauri::command]
pub async fn containers_list(state: State<'_, AppState>) -> CmdResult<Vec<Value>> {
    let d = state.docker()?;
    let list = d
        .list_containers(Some(ListContainersOptionsBuilder::new().all(true).build()))
        .await
        .map_err(derr)?;
    Ok(list
        .iter()
        .map(|c| {
            let v = to_v(c);
            let name = v["Names"][0].as_str().unwrap_or("").trim_start_matches('/').to_string();
            let labels = &v["Labels"];
            let status = s(&v, "Status");
            let ports: Vec<Value> = v["Ports"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|p| json!({ "ip": p["IP"], "privatePort": p["PrivatePort"], "publicPort": p["PublicPort"], "type": p["Type"] }))
                        .collect()
                })
                .unwrap_or_default();
            let networks: Vec<String> = v["NetworkSettings"]["Networks"]
                .as_object()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            let mounts: Vec<Value> = v["Mounts"]
                .as_array()
                .map(|a| a.iter().map(|m| json!({ "type": m["Type"], "name": m["Name"], "source": m["Source"], "destination": m["Destination"] })).collect())
                .unwrap_or_default();
            json!({
                "id": s(&v, "Id"),
                "name": name,
                "image": s(&v, "Image"),
                "imageId": s(&v, "ImageID"),
                "state": s(&v, "State"),
                "status": status,
                "health": health_of(&status),
                "created": i(&v, "Created"),
                "project": labels.get("com.docker.compose.project").cloned().unwrap_or(Value::Null),
                "service": labels.get("com.docker.compose.service").cloned().unwrap_or(Value::Null),
                "workingDir": labels.get("com.docker.compose.project.working_dir").cloned().unwrap_or(Value::Null),
                "ports": ports,
                "networks": networks,
                "mounts": mounts,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn container_start(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.docker()?.start_container(&id, None::<StartContainerOptions>).await.map_err(derr)
}

#[tauri::command]
pub async fn container_stop(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.docker()?.stop_container(&id, Some(StopContainerOptionsBuilder::new().t(10).build())).await.map_err(derr)
}

#[tauri::command]
pub async fn container_restart(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.docker()?.restart_container(&id, Some(RestartContainerOptionsBuilder::new().t(10).build())).await.map_err(derr)
}

#[tauri::command]
pub async fn container_remove(state: State<'_, AppState>, id: String, force: bool) -> CmdResult<()> {
    // Keep volumes (v=false).
    state
        .docker()?
        .remove_container(&id, Some(RemoveContainerOptionsBuilder::new().force(force).v(false).build()))
        .await
        .map_err(derr)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpec {
    pub image: String,
    pub name: Option<String>,
    #[serde(default)]
    pub ports: Vec<String>,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub binds: Vec<String>,
    /// Override the startup command (CMD); empty = use the image's CMD.
    #[serde(default)]
    pub cmd: Vec<String>,
    pub restart: Option<String>,
    #[serde(default)]
    pub start: bool,
}

/// `8080:80`, `127.0.0.1:8080:80/tcp`, or `80` -> (ip, host_port, container_port/proto)
fn parse_port(p: &str) -> Option<(String, String, String)> {
    let p = p.trim();
    if p.is_empty() {
        return None;
    }
    let (body, proto) = match p.rsplit_once('/') {
        Some((b, pr)) => (b, pr),
        None => (p, "tcp"),
    };
    let parts: Vec<&str> = body.split(':').collect();
    match parts.len() {
        1 => Some((String::new(), String::new(), format!("{}/{}", parts[0], proto))),
        2 => Some((String::new(), parts[0].to_string(), format!("{}/{}", parts[1], proto))),
        3 => Some((parts[0].to_string(), parts[1].to_string(), format!("{}/{}", parts[2], proto))),
        _ => None,
    }
}

#[tauri::command]
pub async fn container_create(state: State<'_, AppState>, spec: CreateSpec) -> CmdResult<Value> {
    let d = state.docker()?;
    let mut exposed = serde_json::Map::new();
    let mut bindings = serde_json::Map::new();
    for p in &spec.ports {
        let (ip, host, cport) = parse_port(p).ok_or_else(|| format!("Invalid port: {}", p))?;
        exposed.insert(cport.clone(), json!({}));
        if !host.is_empty() {
            let e = bindings.entry(cport).or_insert_with(|| json!([]));
            e.as_array_mut().unwrap().push(json!({ "HostIp": ip, "HostPort": host }));
        }
    }
    let body = json!({
        "Image": spec.image,
        "Env": spec.env,
        "Cmd": if spec.cmd.is_empty() { Value::Null } else { json!(spec.cmd) },
        "ExposedPorts": exposed,
        "HostConfig": {
            "PortBindings": bindings,
            "Binds": spec.binds,
            "RestartPolicy": { "Name": spec.restart.clone().unwrap_or_else(|| "no".into()) },
        },
    });
    let body: bollard::models::ContainerCreateBody = serde_json::from_value(body).map_err(err)?;
    let opts = spec
        .name
        .as_ref()
        .filter(|n| !n.is_empty())
        .map(|n| CreateContainerOptionsBuilder::new().name(n).build());
    let res = d.create_container(opts, body).await.map_err(derr)?;
    if spec.start {
        d.start_container(&res.id, None::<StartContainerOptions>).await.map_err(derr)?;
    }
    Ok(json!({ "id": res.id }))
}

#[tauri::command]
pub async fn container_inspect(state: State<'_, AppState>, id: String) -> CmdResult<Value> {
    let r = state.docker()?.inspect_container(&id, None::<InspectContainerOptions>).await.map_err(derr)?;
    Ok(to_v(&r))
}

// ---------- stats ----------

fn sum_blkio(v: &Value, op: &str) -> u64 {
    v["blkio_stats"]["io_service_bytes_recursive"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|e| e["op"].as_str().map(|o| o.eq_ignore_ascii_case(op)).unwrap_or(false))
                .map(|e| e["value"].as_u64().unwrap_or(0))
                .sum()
        })
        .unwrap_or(0)
}

/// CPU% = (Δcpu_total / Δsystem_cpu) × number of CPUs × 100; RAM = usage − cache.
pub fn parse_stats(v: &Value) -> Value {
    let cpu_total = v["cpu_stats"]["cpu_usage"]["total_usage"].as_f64().unwrap_or(0.0);
    let pre_total = v["precpu_stats"]["cpu_usage"]["total_usage"].as_f64().unwrap_or(0.0);
    let sys = v["cpu_stats"]["system_cpu_usage"].as_f64().unwrap_or(0.0);
    let pre_sys = v["precpu_stats"]["system_cpu_usage"].as_f64().unwrap_or(0.0);
    let ncpu = v["cpu_stats"]["online_cpus"]
        .as_f64()
        .filter(|n| *n > 0.0)
        .or_else(|| v["cpu_stats"]["cpu_usage"]["percpu_usage"].as_array().map(|a| a.len() as f64))
        .unwrap_or(1.0);
    let (dc, ds) = (cpu_total - pre_total, sys - pre_sys);
    let cpu = if ds > 0.0 && dc >= 0.0 { dc / ds * ncpu * 100.0 } else { 0.0 };
    let usage = v["memory_stats"]["usage"].as_f64().unwrap_or(0.0);
    let st = &v["memory_stats"]["stats"];
    let cache = st["inactive_file"].as_f64().or_else(|| st["total_inactive_file"].as_f64()).or_else(|| st["cache"].as_f64()).unwrap_or(0.0);
    let limit = v["memory_stats"]["limit"].as_f64().unwrap_or(0.0);
    let (mut rx, mut tx) = (0u64, 0u64);
    if let Some(n) = v["networks"].as_object() {
        for (_, e) in n {
            rx += e["rx_bytes"].as_u64().unwrap_or(0);
            tx += e["tx_bytes"].as_u64().unwrap_or(0);
        }
    }
    json!({
        "cpu": cpu,
        "memUsed": (usage - cache).max(0.0),
        "memLimit": limit,
        "netRx": rx, "netTx": tx,
        "blkRead": sum_blkio(v, "read"), "blkWrite": sum_blkio(v, "write"),
    })
}

/// Take one CPU/RAM sample for every running container (the table's CPU, RAM columns).
#[tauri::command]
pub async fn containers_stats(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<Value> {
    let d = state.docker()?;
    let futs = ids.into_iter().map(|id| {
        let d = d.clone();
        async move {
            let mut st = d.stats(&id, Some(StatsOptionsBuilder::new().stream(false).one_shot(false).build()));
            let r = tokio::time::timeout(Duration::from_secs(5), st.next()).await.ok().flatten();
            (id, r)
        }
    });
    let results = futures_util::future::join_all(futs).await;
    let mut out = serde_json::Map::new();
    for (id, r) in results {
        if let Some(Ok(sv)) = r {
            let p = parse_stats(&to_v(&sv));
            out.insert(id, json!({ "cpu": p["cpu"], "memUsed": p["memUsed"], "memLimit": p["memLimit"] }));
        }
    }
    Ok(Value::Object(out))
}

#[tauri::command]
pub fn stats_subscribe<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let d = state.docker()?;
    let key = format!("stats:{}", id);
    let ev = format!("stats://{}", id);
    let h = tauri::async_runtime::spawn(async move {
        let mut st = d.stats(&id, Some(StatsOptionsBuilder::new().stream(true).one_shot(false).build()));
        while let Some(item) = st.next().await {
            match item {
                Ok(v) => {
                    let mut p = parse_stats(&to_v(&v));
                    p["ts"] = json!(chrono::Utc::now().timestamp_millis());
                    let _ = app.emit(&ev, p);
                }
                Err(_) => break,
            }
        }
    });
    state.spawn_task(&key, h);
    Ok(())
}

#[tauri::command]
pub fn stats_unsubscribe(state: State<'_, AppState>, id: String) {
    state.abort_task(&format!("stats:{}", id));
}

// ---------- logs ----------

fn split_ts(line: &str) -> (String, String) {
    if let Some((first, rest)) = line.split_once(' ') {
        if first.len() >= 20 && first.as_bytes()[4] == b'-' && first.contains('T') {
            return (first.to_string(), rest.to_string());
        }
    }
    (String::new(), line.to_string())
}

#[tauri::command]
pub fn logs_subscribe<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String, tail: Option<u32>, since: Option<i64>) -> CmdResult<()> {
    let d = state.docker()?;
    let key = format!("logs:{}", id);
    let ev = format!("logs://{}", id);
    let tail = tail.unwrap_or(500);
    let h = tauri::async_runtime::spawn(async move {
        // Resume after a container restart: take every line since `since`, without cutting by tail.
        let tail_s = if since.is_some() { "all".to_string() } else { tail.to_string() };
        let mut b = LogsOptionsBuilder::new().follow(true).stdout(true).stderr(true).timestamps(true).tail(&tail_s);
        if let Some(sn) = since {
            b = b.since(sn as i32);
        }
        let stream = d.logs(&id, Some(b.build()));
        let mut chunks = stream.ready_chunks(128);
        // TTY logs have no header, so a line may be split across two chunks: keep the remainder.
        let mut carry = String::new();
        while let Some(batch) = chunks.next().await {
            let mut lines = Vec::new();
            for item in batch {
                let Ok(out) = item else { continue };
                let (stream_name, bytes) = match &out {
                    LogOutput::StdErr { message } => ("stderr", message),
                    LogOutput::StdOut { message } => ("stdout", message),
                    LogOutput::Console { message } => ("stdout", message),
                    LogOutput::StdIn { message } => ("stdout", message),
                };
                let text = format!("{}{}", carry, String::from_utf8_lossy(bytes));
                carry.clear();
                let mut parts: Vec<&str> = text.split('\n').collect();
                let last = parts.pop().unwrap_or("");
                if !last.is_empty() {
                    carry = last.to_string();
                }
                for p in parts {
                    let p = p.trim_end_matches('\r');
                    if p.is_empty() {
                        continue;
                    }
                    let (ts, msg) = split_ts(p);
                    lines.push(json!({ "ts": ts, "stream": stream_name, "text": msg }));
                }
            }
            if !lines.is_empty() {
                let _ = app.emit(&ev, lines);
            }
        }
    });
    state.spawn_task(&key, h);
    Ok(())
}

#[tauri::command]
pub fn logs_unsubscribe(state: State<'_, AppState>, id: String) {
    state.abort_task(&format!("logs:{}", id));
}

// ---------- exec (terminal) ----------

async fn try_exec(d: &bollard::Docker, container: &str, shell: &str, cols: u16, rows: u16) -> Result<(String, StartExecResults), String> {
    let cfg: bollard::models::ExecConfig = serde_json::from_value(json!({
        "AttachStdin": true, "AttachStdout": true, "AttachStderr": true, "Tty": true,
        "Cmd": [shell],
        "Env": ["TERM=xterm-256color"],
        "ConsoleSize": [rows, cols],
    }))
    .map_err(err)?;
    let created = d.create_exec(container, cfg).await.map_err(derr)?;
    let started = d
        .start_exec(&created.id, Some(StartExecOptions { detach: false, tty: true, output_capacity: None }))
        .await
        .map_err(derr)?;
    Ok((created.id, started))
}

#[tauri::command]
pub async fn exec_open<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, sid: String, container: String, shell: String, cols: u16, rows: u16) -> CmdResult<Value> {
    let d = state.docker()?;
    // "auto": try bash first, then fall back to sh.
    let order: Vec<&str> = match shell.as_str() {
        "bash" => vec!["/bin/bash"],
        "sh" => vec!["/bin/sh"],
        _ => vec!["/bin/bash", "/bin/sh"],
    };
    let mut last_err = String::new();
    let mut opened = None;
    for sh in &order {
        match try_exec(&d, &container, sh, cols, rows).await {
            Ok((id, StartExecResults::Attached { output, input })) => {
                // Shell does not exist: start_exec still succeeds, but the process cannot run.
                // Ask the engine again (Running / ExitCode / Pid) to know whether it really started.
                let mut alive = false;
                for _ in 0..12 {
                    tokio::time::sleep(Duration::from_millis(60)).await;
                    let v = d.inspect_exec(&id).await.map(|x| to_v(&x)).unwrap_or(Value::Null);
                    if v["Running"].as_bool().unwrap_or(false) || v["Pid"].as_i64().unwrap_or(0) > 0 {
                        alive = true;
                        break;
                    }
                    if !v["ExitCode"].is_null() && !v["Running"].as_bool().unwrap_or(true) {
                        break;
                    }
                }
                if !alive {
                    let _ = d.inspect_exec(&id).await;
                    last_err = format!("{} is missing or cannot run in this container", sh);
                    continue;
                }
                opened = Some((id, sh.to_string(), output, input));
                break;
            }
            Ok((_, StartExecResults::Detached)) => last_err = "exec was detached".into(),
            Err(e) => last_err = e,
        }
    }
    let (exec_id, used, mut output, input) = opened.ok_or(last_err)?;
    let ev = format!("exec://{}", sid);
    let app2 = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let b64 = base64::engine::general_purpose::STANDARD;
        while let Some(item) = output.next().await {
            match item {
                Ok(o) => {
                    let _ = app2.emit(&ev, json!({ "t": "data", "d": b64.encode(o.as_ref()) }));
                }
                Err(_) => break,
            }
        }
        let _ = app2.emit(&ev, json!({ "t": "close" }));
    });
    state.execs.lock().await.insert(sid.clone(), ExecSession { docker: d, exec_id, input, task });
    Ok(json!({ "sid": sid, "shell": used }))
}

#[tauri::command]
pub async fn exec_write(state: State<'_, AppState>, sid: String, data: String) -> CmdResult<()> {
    let mut ex = state.execs.lock().await;
    let s = ex.get_mut(&sid).ok_or("The terminal session is closed")?;
    s.input.write_all(data.as_bytes()).await.map_err(err)?;
    s.input.flush().await.map_err(err)
}

#[tauri::command]
pub async fn exec_resize(state: State<'_, AppState>, sid: String, cols: u16, rows: u16) -> CmdResult<()> {
    let (d, id) = {
        let ex = state.execs.lock().await;
        let s = ex.get(&sid).ok_or("The terminal session is closed")?;
        (s.docker.clone(), s.exec_id.clone())
    };
    // Right after opening the session the process may not be running yet: retry a few times.
    let mut last = String::new();
    for _ in 0..8 {
        match d.resize_exec(&id, ResizeExecOptionsBuilder::new().w(cols as i32).h(rows as i32).build()).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                last = derr(e);
                if !last.contains("not started") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
    Err(last)
}

#[tauri::command]
pub async fn exec_close(state: State<'_, AppState>, sid: String) -> CmdResult<()> {
    if let Some(s) = state.execs.lock().await.remove(&sid) {
        s.task.abort();
    }
    Ok(())
}
