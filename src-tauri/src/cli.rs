//! Run the `docker` CLI (only for compose, build, and volume commands that use temporary containers).
//! Every command goes to the selected engine through the DOCKER_HOST variable.
use crate::state::AppState;
use crate::util::*;
use serde_json::json;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub fn docker_cmd(state: &AppState) -> Command {
    let mut c = Command::new("docker");
    c.env("PATH", cli_path())
        .env_remove("DOCKER_CONTEXT")
        .env_remove("DOCKER_TLS_VERIFY")
        .env_remove("DOCKER_CERT_PATH")
        .envs(crate::ctx::cli_env(state))
        .env("BUILDKIT_PROGRESS", "plain")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c
}

/// Run the command, push each stdout/stderr line through event `event` with `key`, return an error (the last few lines) if it exits non-zero.
pub async fn run_stream<R: Runtime>(app: &AppHandle<R>, event: &str, key: &str, mut cmd: Command) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not run the docker CLI: {}. Is the Docker CLI installed?", e))?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)]
        .into_iter()
        .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(pipe).split(b'\n');
            while let Ok(Some(l)) = lines.next_segment().await {
                // The process uses \r to overwrite lines; take the last segment.
                let t = String::from_utf8_lossy(&l).to_string();
                let t = t.rsplit('\r').next().unwrap_or("").trim_end().to_string();
                if !t.is_empty() {
                    let _ = tx.send(t);
                }
            }
        });
    }
    drop(tx);
    let mut tail: Vec<String> = Vec::new();
    while let Some(line) = rx.recv().await {
        let _ = app.emit(event, json!({ "key": key, "line": line }));
        tail.push(line);
        if tail.len() > 12 {
            tail.remove(0);
        }
    }
    let st = child.wait().await.map_err(err)?;
    if st.success() {
        Ok(())
    } else {
        Err(tail.last().cloned().unwrap_or_else(|| format!("docker exited with code {}", st.code().unwrap_or(-1))))
    }
}

/// Run the command and capture all of stdout.
pub async fn run_output(mut cmd: Command) -> Result<String, String> {
    let out = cmd.output().await.map_err(|e| format!("Could not run the docker CLI: {}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if e.is_empty() { format!("docker exited with code {}", out.status.code().unwrap_or(-1)) } else { e })
    }
}
