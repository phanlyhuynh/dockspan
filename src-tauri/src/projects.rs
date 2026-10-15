//! A project = a folder containing compose and/or a Dockerfile that the app remembers.
use crate::cli;
use crate::state::AppState;
use crate::store::{Project, ServiceInfo};
use crate::util::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_opener::OpenerExt;

const COMPOSE_NAMES: [&str; 4] = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub path: String,
    pub suggested_name: String,
    pub compose_file: Option<String>,
    pub has_dockerfile: bool,
    pub compose_project: String,
    pub services: Vec<ServiceInfo>,
    pub warning: Option<String>,
}

fn sanitize(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    let s = s.trim_matches(|c| c == '-' || c == '_').to_string();
    if s.is_empty() { "project".into() } else { s }
}

fn find_compose(dir: &Path) -> Option<String> {
    COMPOSE_NAMES.iter().find(|n| dir.join(n).is_file()).map(|n| n.to_string())
}

/// Read services with `docker compose config --format json` (`.env` and overrides already merged).
async fn compose_config(state: &AppState, dir: &Path, file: &str, project: Option<&str>) -> Result<(String, Vec<ServiceInfo>), String> {
    let mut cmd = cli::docker_cmd(state);
    cmd.current_dir(dir).args(["compose", "-f", file]);
    if let Some(p) = project {
        cmd.args(["-p", p]);
    }
    cmd.args(["config", "--format", "json"]);
    let out = cli::run_output(cmd).await?;
    let v: Value = serde_json::from_str(&out).map_err(|e| format!("Could not read the compose config output: {}", e))?;
    let name = s(&v, "name");
    let mut services: Vec<ServiceInfo> = Vec::new();
    if let Some(m) = v["services"].as_object() {
        for (svc, d) in m {
            let image = d["image"].as_str().map(String::from).unwrap_or_else(|| format!("{}-{}", name, svc));
            let ports = d["ports"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|p| {
                            let t = p["target"].as_i64().unwrap_or(0);
                            match p["published"].as_str().map(String::from).or_else(|| p["published"].as_i64().map(|x| x.to_string())) {
                                Some(h) if !h.is_empty() => format!("{}→{}", h, t),
                                _ => t.to_string(),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            services.push(ServiceInfo { name: svc.clone(), image, ports });
        }
    }
    services.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((name, services))
}

async fn scan(state: &AppState, path: &str) -> Result<ScanResult, String> {
    let dir = expand_tilde(path);
    if !dir.is_dir() {
        return Err("Folder not found".into());
    }
    let dir_name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "project".into());
    let compose_file = find_compose(&dir);
    let has_dockerfile = dir.join("Dockerfile").is_file();
    let mut services = Vec::new();
    let mut compose_project = sanitize(&dir_name);
    let mut warning = None;
    if let Some(f) = &compose_file {
        match compose_config(state, &dir, f, None).await {
            Ok((name, svcs)) => {
                if !name.is_empty() {
                    compose_project = name;
                }
                services = svcs;
            }
            Err(e) => warning = Some(format!("Could not read {}: {}", f, e)),
        }
    }
    Ok(ScanResult {
        path: dir.to_string_lossy().to_string(),
        suggested_name: dir_name,
        compose_file,
        has_dockerfile,
        compose_project,
        services,
        warning,
    })
}

#[tauri::command]
pub async fn project_scan(state: State<'_, AppState>, path: String) -> CmdResult<ScanResult> {
    scan(&state, &path).await
}

/// Suggest folders with compose/Dockerfile in common code directories (at most 2 levels).
#[tauri::command]
pub fn discover_projects() -> Vec<Value> {
    let h = home();
    let roots = ["code", "Sources", "dev", "projects", "workspace", "src", "work", "repos", "Projects", "Code"];
    let mut out: Vec<Value> = Vec::new();
    let mut check = |p: PathBuf| {
        let compose = find_compose(&p);
        let df = p.join("Dockerfile").is_file();
        if compose.is_some() || df {
            out.push(json!({
                "path": p.to_string_lossy(),
                "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "tag": if compose.is_some() { "compose" } else { "Dockerfile" },
            }));
        }
    };
    for r in roots {
        let root = h.join(r);
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() || e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            check(p.clone());
            if let Ok(rd2) = std::fs::read_dir(&p) {
                for e2 in rd2.flatten() {
                    let p2 = e2.path();
                    if p2.is_dir() && !e2.file_name().to_string_lossy().starts_with('.') && e2.file_name() != "node_modules" {
                        check(p2);
                    }
                }
            }
        }
    }
    out.truncate(12);
    out
}

#[tauri::command]
pub fn project_list(state: State<'_, AppState>) -> Vec<Project> {
    let ctx = state.active().id;
    state.store.lock().unwrap().projects.iter().filter(|p| p.context_id == ctx).cloned().collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSpec {
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub async fn project_add(state: State<'_, AppState>, spec: AddSpec) -> CmdResult<Project> {
    let sc = scan(&state, &spec.path).await?;
    if sc.compose_file.is_none() && !sc.has_dockerfile {
        return Err("No compose file or Dockerfile found in this folder".into());
    }
    let ctx = state.active().id;
    let name = spec.name.trim().to_string();
    if name.is_empty() {
        return Err("Please enter a project name".into());
    }
    {
        let st = state.store.lock().unwrap();
        if st.projects.iter().any(|p| p.context_id == ctx && p.path == sc.path) {
            return Err("This folder is already in the list".into());
        }
        if st.projects.iter().any(|p| p.context_id == ctx && p.name == name) {
            return Err("A project with this name already exists".into());
        }
    }
    let now = now_iso();
    let p = Project {
        id: format!("{:x}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)),
        name,
        path: sc.path,
        compose_project: sc.compose_project,
        context_id: ctx,
        compose_file: sc.compose_file,
        has_dockerfile: sc.has_dockerfile,
        services: sc.services,
        last_opened_at: now.clone(),
        created_at: now,
    };
    state.with_store(|s| s.projects.push(p.clone()));
    Ok(p)
}

/// Rename the display name; the Compose project name (the label on containers) stays unchanged so running containers are not affected.
#[tauri::command]
pub fn project_rename(state: State<'_, AppState>, id: String, name: String) -> CmdResult<Project> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Please enter a project name".into());
    }
    let cur = get_project(&state, &id)?;
    let clash = state.store.lock().unwrap().projects.iter().any(|p| p.id != id && p.context_id == cur.context_id && p.name == name);
    if clash {
        return Err("A project with this name already exists".into());
    }
    state.with_store(|s| {
        if let Some(x) = s.projects.iter_mut().find(|x| x.id == id) {
            x.name = name;
        }
    });
    get_project(&state, &id)
}

#[tauri::command]
pub fn project_remove(state: State<'_, AppState>, id: String) {
    state.with_store(|s| s.projects.retain(|p| p.id != id));
}

fn get_project(state: &AppState, id: &str) -> Result<Project, String> {
    state.store.lock().unwrap().projects.iter().find(|p| p.id == id).cloned().ok_or_else(|| "Project not found".to_string())
}

/// Re-read services (after editing compose/.env) and update `lastOpenedAt`.
#[tauri::command]
pub async fn project_refresh(state: State<'_, AppState>, id: String) -> CmdResult<Project> {
    let p = get_project(&state, &id)?;
    let sc = scan(&state, &p.path).await?;
    state.with_store(|s| {
        if let Some(x) = s.projects.iter_mut().find(|x| x.id == id) {
            x.compose_file = sc.compose_file.clone();
            x.has_dockerfile = sc.has_dockerfile;
            if sc.warning.is_none() {
                x.services = sc.services.clone();
                x.compose_project = sc.compose_project.clone();
            }
            x.last_opened_at = now_iso();
        }
    });
    get_project(&state, &id)
}

#[tauri::command]
pub async fn compose_run<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String, action: String) -> CmdResult<()> {
    let p = get_project(&state, &id)?;
    let file = p.compose_file.clone().ok_or("This project has no compose file")?;
    let mut cmd = cli::docker_cmd(&state);
    cmd.current_dir(&p.path).args(["compose", "-f", &file, "-p", &p.compose_project]);
    match action.as_str() {
        "up" => cmd.args(["up", "-d"]),
        "stop" => cmd.arg("stop"),
        "restart" => cmd.arg("restart"),
        "down" => cmd.arg("down"),
        _ => return Err(format!("Invalid compose action: {}", action)),
    };
    state.with_store(|s| {
        if let Some(x) = s.projects.iter_mut().find(|x| x.id == id) {
            x.last_opened_at = now_iso();
        }
    });
    cli::run_stream(&app, "compose://progress", &id, cmd).await
}

fn safe_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains("..") || name.contains('\\') || name.starts_with('/') {
        return Err("Invalid file name".into());
    }
    Ok(())
}

/// List of important files: compose, Dockerfile, .env, .dockerignore, README.md, src/.
#[tauri::command]
pub fn project_files(state: State<'_, AppState>, id: String) -> CmdResult<Vec<Value>> {
    let p = get_project(&state, &id)?;
    let dir = PathBuf::from(&p.path);
    let mut names: Vec<(String, bool)> = Vec::new();
    if let Some(c) = &p.compose_file {
        names.push((c.clone(), false));
    }
    for n in ["Dockerfile", ".env", ".dockerignore", "README.md"] {
        if dir.join(n).is_file() {
            names.push((n.to_string(), false));
        }
    }
    if dir.join("src").is_dir() {
        names.push(("src/".into(), true));
    }
    Ok(names.into_iter().map(|(n, d)| json!({ "name": n, "isDir": d })).collect())
}

#[tauri::command]
pub fn project_read_file(state: State<'_, AppState>, id: String, name: String) -> CmdResult<String> {
    let p = get_project(&state, &id)?;
    safe_name(&name)?;
    let path = Path::new(&p.path).join(name.trim_end_matches('/'));
    if path.is_dir() {
        let mut items: Vec<String> = std::fs::read_dir(&path)
            .map_err(err)?
            .flatten()
            .map(|e| format!("  {}{}", e.file_name().to_string_lossy(), if e.path().is_dir() { "/" } else { "" }))
            .collect();
        items.sort();
        return Ok(format!("Folder {} — {} items\n\n{}", name, items.len(), items.join("\n")));
    }
    let meta = std::fs::metadata(&path).map_err(err)?;
    if meta.len() > 512 * 1024 {
        return Err("File is too large to view (over 512 KB)".into());
    }
    std::fs::read_to_string(&path).map_err(|_| "The file is not UTF-8 text".to_string())
}

#[tauri::command]
pub fn project_write_file(state: State<'_, AppState>, id: String, name: String, content: String) -> CmdResult<()> {
    let p = get_project(&state, &id)?;
    safe_name(&name)?;
    if name.ends_with('/') {
        return Err("Cannot write to a folder".into());
    }
    std::fs::write(Path::new(&p.path).join(&name), content).map_err(err)
}

// ---------- opening outside the app ----------

#[tauri::command]
pub async fn open_in_editor(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let editor = state.store.lock().unwrap().settings.editor_command.clone();
    let r = tokio::process::Command::new(&editor).arg(&path).env("PATH", cli_path()).spawn();
    match r {
        Ok(_) => Ok(()),
        Err(e) => {
            if cfg!(target_os = "macos") && editor == "code" {
                // `code` may not be on PATH yet: open the application directly.
                return tokio::process::Command::new("open")
                    .args(["-a", "Visual Studio Code", &path])
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Could not open VS Code: {}", e));
            }
            Err(format!("Could not run `{}`: {}", editor, e))
        }
    }
}

#[tauri::command]
pub fn open_terminal(path: String) -> CmdResult<()> {
    let r = if cfg!(target_os = "macos") {
        std::process::Command::new("open").args(["-a", "Terminal", &path]).spawn()
    } else if cfg!(windows) {
        std::process::Command::new("cmd").args(["/C", "start", "cmd", "/K", &format!("cd /d \"{}\"", path)]).spawn()
    } else {
        std::process::Command::new("x-terminal-emulator")
            .arg(format!("--working-directory={}", path))
            .current_dir(&path)
            .spawn()
            .or_else(|_| std::process::Command::new("gnome-terminal").arg(format!("--working-directory={}", path)).spawn())
    };
    r.map(|_| ()).map_err(|e| format!("Could not open the terminal: {}", e))
}

#[tauri::command]
pub fn open_folder<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<()> {
    app.opener().open_path(path, None::<&str>).map_err(err)
}

#[tauri::command]
pub fn open_url<R: Runtime>(app: AppHandle<R>, url: String) -> CmdResult<()> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

/// Save text to the path returned by the operating system's "Save" dialog (download log).
#[tauri::command]
pub fn save_text(path: String, content: String) -> CmdResult<()> {
    std::fs::write(path, content).map_err(err)
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Value {
    json!({ "editorCommand": state.store.lock().unwrap().settings.editor_command })
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, editor_command: String) -> CmdResult<()> {
    let c = editor_command.trim().to_string();
    if c.is_empty() || c.contains(char::is_whitespace) {
        return Err("The editor command must be a single word, e.g. `code`".into());
    }
    state.with_store(|s| s.settings.editor_command = c);
    Ok(())
}
