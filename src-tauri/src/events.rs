//! Watch the engine: keep the `/events` stream, report on/off state, reconnect automatically.
use crate::ctx;
use crate::state::AppState;
use crate::util::*;
use bollard::query_parameters::EventsOptionsBuilder;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

async fn emit_status<R: Runtime>(app: &AppHandle<R>, on: bool) {
    let st = app.state::<AppState>();
    let active = st.active();
    let mut payload = json!({ "state": if on { "on" } else { "off" }, "ctx": active });
    if on {
        let cached = st.info.lock().unwrap().clone();
        let info = match cached {
            Some(i) => i,
            None => {
                let d = st.docker();
                if let Ok(d) = d {
                    let i = ctx::fetch_info(&d).await;
                    *st.info.lock().unwrap() = Some(i.clone());
                    i
                } else {
                    Value::Null
                }
            }
        };
        payload["info"] = info;
    }
    let _ = app.emit("engine://status", payload);
}

pub fn start_monitor<R: Runtime>(app: &AppHandle<R>) {
    let app2 = app.clone();
    let h = tauri::async_runtime::spawn(async move {
        let delays = [1u64, 2, 5, 10];
        let mut attempt = 0usize;
        loop {
            let st = app2.state::<AppState>();
            let conn = ctx::connect_active(&st).await.ok();
            if let Some(d) = conn {
                attempt = 0;
                *st.docker.lock().unwrap() = Some(d.clone());
                *st.info.lock().unwrap() = None;
                emit_status(&app2, true).await;
                let mut stream = d.events(Some(EventsOptionsBuilder::new().build()));
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(m) => {
                            let v = to_v(&m);
                            let attrs = v["Actor"]["Attributes"].clone();
                            let payload = json!({
                                "type": s(&v, "Type"),
                                "action": s(&v, "Action"),
                                "id": v["Actor"]["ID"],
                                "name": attrs.get("name").cloned().unwrap_or(Value::Null),
                                "image": attrs.get("image").cloned().unwrap_or(Value::Null),
                                "exitCode": attrs.get("exitCode").cloned().unwrap_or(Value::Null),
                                "attrs": attrs,
                                "time": i(&v, "time"),
                            });
                            let _ = app2.emit("docker://events", payload);
                        }
                        Err(_) => break,
                    }
                }
                // Stream broke: the engine stopped or the connection was lost.
                *st.docker.lock().unwrap() = None;
                emit_status(&app2, false).await;
            } else {
                *st.docker.lock().unwrap() = None;
                if attempt == 0 {
                    emit_status(&app2, false).await;
                }
            }
            let wait = delays[attempt.min(delays.len() - 1)];
            attempt += 1;
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    });
    app.state::<AppState>().spawn_task("events", h);
}

#[tauri::command]
pub async fn engine_status(state: State<'_, AppState>) -> CmdResult<Value> {
    let active = state.active();
    let mut d = state.docker.lock().unwrap().clone();
    if d.is_none() {
        // Right after the app opens, the monitor may not have connected yet: connect now so we do not wrongly report "stopped".
        if let Ok(c) = ctx::connect_active(&state).await {
            *state.docker.lock().unwrap() = Some(c.clone());
            d = Some(c);
        }
    }
    let Some(d) = d else {
        return Ok(json!({ "state": "off", "ctx": active }));
    };
    let ok = matches!(tokio::time::timeout(Duration::from_secs(3), d.ping()).await, Ok(Ok(_)));
    if !ok {
        return Ok(json!({ "state": "off", "ctx": active }));
    }
    let cached = state.info.lock().unwrap().clone();
    let info = match cached {
        Some(i) => i,
        None => {
            let i = ctx::fetch_info(&d).await;
            *state.info.lock().unwrap() = Some(i.clone());
            i
        }
    };
    Ok(json!({ "state": "on", "ctx": active, "info": info }))
}

/// Whether any process still accepts connections on the endpoint (connection refused/no file = fully stopped).
async fn endpoint_listening(endpoint: &str) -> bool {
    let t = Duration::from_secs(2);
    if let Some(_p) = endpoint.strip_prefix("unix://") {
        #[cfg(unix)]
        {
            return matches!(tokio::time::timeout(t, tokio::net::UnixStream::connect(_p)).await, Ok(Ok(_)));
        }
    }
    if let Some(h) = endpoint.strip_prefix("tcp://") {
        return matches!(tokio::time::timeout(t, tokio::net::TcpStream::connect(h)).await, Ok(Ok(_)));
    }
    false
}

async fn run_quiet(prog: &str, args: &[&str]) -> Result<(), String> {
    let out = tokio::process::Command::new(prog)
        .args(args)
        .env("PATH", cli_path())
        .output()
        .await
        .map_err(|e| format!("Could not run `{}`: {}", prog, e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("`{} {}` failed: {}", prog, args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// Start/stop the engine depending on the operating system and the runtime in use.
async fn control(start: bool, c: &ctx::CtxInfo) -> Result<(), String> {
    let verb = if start { "start" } else { "stop" };
    let endpoint = c.endpoint.as_str();
    if c.kind == "wsl" {
        // dockerd inside the distro: systemd when the distro has it, otherwise the SysV service.
        let prog = crate::wsl::program().ok_or("WSL is not available on this machine")?;
        let distro = c.wsl_distro.clone().unwrap_or_default();
        let script = format!("systemctl {v} docker docker.socket 2>/dev/null || service docker {v}", v = verb);
        return run_quiet(prog, &["-d", &distro, "-u", "root", "--", "sh", "-c", &script]).await;
    }
    if cfg!(target_os = "macos") {
        if endpoint.contains(".colima") {
            return run_quiet("colima", &[verb]).await;
        }
        if endpoint.contains(".orbstack") {
            return run_quiet("orb", &[verb]).await;
        }
        return if start {
            run_quiet("open", &["-a", "Docker"]).await
        } else {
            // The app's display name is "Docker Desktop"; older versions use "Docker".
            match run_quiet("osascript", &["-e", "tell application \"Docker Desktop\" to quit"]).await {
                Ok(()) => Ok(()),
                Err(_) => run_quiet("osascript", &["-e", "tell application \"Docker\" to quit"]).await,
            }
        };
    }
    if cfg!(target_os = "linux") {
        return if start {
            run_quiet("pkexec", &["systemctl", "start", "docker"]).await
        } else {
            run_quiet("pkexec", &["systemctl", "stop", "docker.socket", "docker"]).await
        };
    }
    if cfg!(windows) {
        return if start {
            run_quiet("cmd", &["/C", "start", "", "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"]).await
        } else {
            run_quiet("taskkill", &["/IM", "Docker Desktop.exe", "/F"]).await
        };
    }
    Err("Starting/stopping the engine is not supported on this operating system".into())
}

#[tauri::command]
pub async fn engine_stop<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> CmdResult<()> {
    let active = state.active();
    if active.kind != "local" && active.kind != "wsl" {
        return Err("The engine can only be stopped on this machine. For remote machines use SSH.".into());
    }
    // Record the running containers so they can be started again when the engine starts.
    if let Ok(d) = state.docker() {
        let list = d
            .list_containers(Some(bollard::query_parameters::ListContainersOptionsBuilder::new().all(false).build()))
            .await
            .map(|l| l.into_iter().filter_map(|c| c.id).collect::<Vec<_>>())
            .unwrap_or_default();
        let id = active.id.clone();
        state.with_store(|s| {
            s.was_running.insert(id, list);
        });
    }
    control(false, &active.spec).await?;
    // A failed ping does not mean it has fully stopped: Docker Desktop needs ~30 s to exit. Starting again too early makes it hang,
    // so wait until nothing accepts connections on the socket any more (a stale socket file may remain), at most 90 s.
    for _ in 0..90 {
        let d = state.docker.lock().unwrap().clone();
        let alive = match d {
            Some(d) => matches!(tokio::time::timeout(Duration::from_secs(2), d.ping()).await, Ok(Ok(_))),
            None => false,
        };
        if !alive && (active.kind == "wsl" || !endpoint_listening(&active.endpoint).await) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let _ = app.emit("engine://stopped", ());
    Ok(())
}

#[tauri::command]
pub async fn engine_start(state: State<'_, AppState>) -> CmdResult<()> {
    let active = state.active();
    if active.kind != "local" && active.kind != "wsl" {
        return Err("The engine can only be started on this machine.".into());
    }
    control(true, &active.spec).await?;
    // Wait for the engine to be ready (at most 120 s).
    let mut ready: Option<bollard::Docker> = None;
    for _ in 0..120 {
        if let Ok(d) = ctx::connect_active(&state).await {
            ready = Some(d);
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let d = ready.ok_or("The engine was not ready after 120 seconds")?;
    // Start again the containers that were running before the stop, if their restart policy is not `no`.
    let ids = state.with_store(|s| s.was_running.remove(&active.id)).unwrap_or_default();
    for id in ids {
        if let Ok(ins) = d.inspect_container(&id, None).await {
            let v = to_v(&ins);
            let policy = v["HostConfig"]["RestartPolicy"]["Name"].as_str().unwrap_or("");
            let running = v["State"]["Running"].as_bool().unwrap_or(false);
            if !running && !policy.is_empty() && policy != "no" {
                let _ = d.start_container(&id, None).await;
            }
        }
    }
    Ok(())
}
