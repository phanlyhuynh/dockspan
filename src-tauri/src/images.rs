use crate::cli;
use crate::state::AppState;
use crate::util::*;
use base64::Engine;
use bollard::auth::DockerCredentials;
use bollard::query_parameters::*;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime, State};

#[tauri::command]
pub async fn images_list(state: State<'_, AppState>) -> CmdResult<Vec<Value>> {
    let d = state.docker()?;
    let list = d.list_images(Some(ListImagesOptionsBuilder::new().all(false).build())).await.map_err(derr)?;
    let mut rows = Vec::new();
    for im in list.iter() {
        let v = to_v(im);
        let id = s(&v, "Id");
        let tags: Vec<String> = v["RepoTags"]
            .as_array()
            .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).filter(|t| t != "<none>:<none>").collect())
            .unwrap_or_default();
        let base = json!({ "id": id, "size": i(&v, "Size"), "created": i(&v, "Created") });
        if tags.is_empty() {
            let mut r = base.clone();
            r["repo"] = json!("<none>");
            r["tag"] = json!("<none>");
            r["dangling"] = json!(true);
            rows.push(r);
        } else {
            for t in tags {
                let (repo, tag) = match t.rsplit_once(':') {
                    Some((r, tg)) if !tg.contains('/') => (r.to_string(), tg.to_string()),
                    _ => (t.clone(), "latest".to_string()),
                };
                let mut r = base.clone();
                r["repo"] = json!(repo);
                r["tag"] = json!(tag);
                r["dangling"] = json!(false);
                rows.push(r);
            }
        }
    }
    Ok(rows)
}

fn registry_of(image: &str) -> String {
    let first = image.split('/').next().unwrap_or("");
    if image.contains('/') && (first.contains('.') || first.contains(':') || first == "localhost") {
        first.to_string()
    } else {
        "docker.io".to_string()
    }
}

/// Read private registry credentials from `~/.docker/config.json` (the `auths` section).
fn creds_for(image: &str) -> Option<DockerCredentials> {
    let reg = registry_of(image);
    let t = std::fs::read_to_string(home().join(".docker/config.json")).ok()?;
    let v: Value = serde_json::from_str(&t).ok()?;
    let auths = v["auths"].as_object()?;
    let key = auths.keys().find(|k| {
        let host = k.trim_start_matches("https://").trim_start_matches("http://");
        let host = host.split('/').next().unwrap_or("");
        host == reg || (reg == "docker.io" && host == "index.docker.io")
    })?;
    let b = auths[key]["auth"].as_str()?;
    let raw = base64::engine::general_purpose::STANDARD.decode(b).ok()?;
    let raw = String::from_utf8(raw).ok()?;
    let (u, p) = raw.split_once(':')?;
    Some(DockerCredentials { username: Some(u.into()), password: Some(p.into()), serveraddress: Some(key.clone()), ..Default::default() })
}

#[tauri::command]
pub async fn image_pull<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, image: String) -> CmdResult<()> {
    let d = state.docker()?;
    let (repo, tag) = match image.rsplit_once(':') {
        Some((r, t)) if !t.contains('/') => (r.to_string(), t.to_string()),
        _ => (image.clone(), "latest".to_string()),
    };
    let opts = CreateImageOptionsBuilder::new().from_image(&repo).tag(&tag).build();
    let mut st = d.create_image(Some(opts), None, creds_for(&image));
    let mut last_err: Option<String> = None;
    while let Some(item) = st.next().await {
        match item {
            Ok(info) => {
                let v = to_v(&info);
                if let Some(e) = v["errorDetail"]["message"].as_str().or_else(|| v["error"].as_str()) {
                    last_err = Some(e.to_string());
                }
                let pd = if v["progressDetail"].is_null() { &v["progress_detail"] } else { &v["progressDetail"] };
                let _ = app.emit(
                    "pull://progress",
                    json!({
                        "image": image,
                        "id": v["id"],
                        "status": v["status"],
                        "current": pd["current"],
                        "total": pd["total"],
                    }),
                );
            }
            Err(e) => return Err(derr(e)),
        }
    }
    match last_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn clean_cmd(c: &str) -> String {
    let c = c.trim();
    let c = c.strip_prefix("/bin/sh -c #(nop) ").or_else(|| c.strip_prefix("/bin/sh -c ")).unwrap_or(c);
    let c = c.strip_prefix("|0 ").unwrap_or(c);
    c.trim().to_string()
}

#[tauri::command]
pub async fn image_history(state: State<'_, AppState>, id: String) -> CmdResult<Value> {
    let d = state.docker()?;
    let h = d.image_history(&id).await.map_err(derr)?;
    let ins = d.inspect_image(&id).await.map_err(derr)?;
    let iv = to_v(&ins);
    let layers: Vec<Value> = h
        .iter()
        .map(|x| {
            let v = to_v(x);
            json!({ "cmd": clean_cmd(&s(&v, "CreatedBy")), "size": i(&v, "Size") })
        })
        .collect();
    Ok(json!({
        "layers": layers,
        "os": s(&iv, "Os"),
        "architecture": s(&iv, "Architecture"),
    }))
}

#[tauri::command]
pub async fn image_remove(state: State<'_, AppState>, id: String, force: Option<bool>) -> CmdResult<()> {
    let d = state.docker()?;
    d.remove_image(&id, Some(RemoveImageOptionsBuilder::new().force(force.unwrap_or(false)).build()), None)
        .await
        .map_err(derr)?;
    Ok(())
}

#[tauri::command]
pub async fn image_build<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, project_id: String, tag: String, nocache: bool) -> CmdResult<()> {
    let path = state
        .store
        .lock()
        .unwrap()
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.path.clone())
        .ok_or("Project not found")?;
    let mut cmd = cli::docker_cmd(&state);
    cmd.args(["build", "--progress=plain", "-t", &tag]);
    if nocache {
        cmd.arg("--no-cache");
    }
    cmd.arg(&path);
    let _ = app.emit("build://log", json!({ "key": "build", "line": format!("$ docker build -t {}{} {}", tag, if nocache { " --no-cache" } else { "" }, path) }));
    cli::run_stream(&app, "build://log", "build", cmd).await
}
