//! WSL2 distros on this machine (`wsl.exe -l -v`): Docker version inside each one, and installing Docker Engine.
//! Works on Windows and from inside WSL through interop (`wsl.exe` on PATH); elsewhere `program()` is None.
use crate::state::AppState;
use crate::util::*;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Runtime, State};
use tokio::process::Command;

/// The `wsl` launcher, when this machine has one.
pub fn program() -> Option<&'static str> {
    if cfg!(windows) {
        return Some("wsl.exe");
    }
    // Inside WSL, Windows executables run through the WSLInterop binfmt handler.
    const WIN: &str = "/mnt/c/Windows/system32/wsl.exe";
    let interop = ["/proc/sys/fs/binfmt_misc/WSLInterop", "/proc/sys/fs/binfmt_misc/WSLInterop-late"].iter().any(|p| std::path::Path::new(p).exists());
    if !interop {
        return None;
    }
    if std::path::Path::new(WIN).exists() {
        return Some(WIN);
    }
    std::env::split_paths(&cli_path()).any(|d| d.join("wsl.exe").exists()).then_some("wsl.exe")
}

fn wsl_cmd(prog: &str) -> Command {
    let mut c = Command::new(prog);
    c.env("PATH", cli_path()).env("WSL_UTF8", "1").stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c
}

/// `wsl.exe` prints UTF-16LE unless WSL_UTF8=1 reaches it (it does not through interop).
pub fn decode(b: &[u8]) -> String {
    let zeros = b.iter().skip(1).step_by(2).filter(|x| **x == 0).count();
    if b.len() >= 4 && zeros * 2 >= b.len() / 2 {
        let u: Vec<u16> = b.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
        String::from_utf16_lossy(&u).trim_start_matches('\u{feff}').to_string()
    } else {
        String::from_utf8_lossy(b).to_string()
    }
}

/// Parse `wsl -l -v`: `[*] NAME STATE VERSION` per line after the header.
pub fn parse_list(text: &str) -> Vec<Value> {
    text.lines()
        .filter(|l| !l.trim().is_empty() && !l.contains("NAME"))
        .filter_map(|l| {
            let l = l.trim();
            let default = l.starts_with('*');
            let mut parts = l.trim_start_matches('*').split_whitespace();
            let (name, state, version) = (parts.next()?, parts.next()?, parts.next()?);
            Some(json!({ "name": name, "state": state, "version": version.parse::<u8>().unwrap_or(0), "default": default }))
        })
        .filter(|d| !d["name"].as_str().unwrap_or("").starts_with("docker-desktop"))
        .collect()
}

/// Docker inside a distro: server version when dockerd answers, the installed version otherwise, None when not installed.
async fn docker_in(prog: &str, distro: &str) -> (Option<String>, bool) {
    let script = "command -v dockerd >/dev/null 2>&1 || exit 3; docker version --format '{{.Server.Version}}' 2>/dev/null || dockerd --version";
    let mut c = wsl_cmd(prog);
    c.args(["-d", distro, "-u", "root", "--", "sh", "-c", script]);
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(15), c.output()).await else { return (None, false) };
    if out.status.code() == Some(3) {
        return (None, false);
    }
    let text = decode(&out.stdout);
    let first = text.lines().next().unwrap_or("").trim().to_string();
    match first.strip_prefix("Docker version ") {
        // dockerd --version: installed but the daemon is not running.
        Some(rest) => (Some(rest.split(',').next().unwrap_or(rest).to_string()), false),
        None if !first.is_empty() => (Some(first), true),
        None => (None, false),
    }
}

#[tauri::command]
pub async fn wsl_list(state: State<'_, AppState>) -> CmdResult<Value> {
    let Some(prog) = program() else { return Ok(json!({ "available": false, "distros": [] })) };
    let mut c = wsl_cmd(prog);
    c.args(["-l", "-v"]);
    let out = tokio::time::timeout(Duration::from_secs(15), c.output()).await.map_err(|_| "wsl.exe did not answer".to_string())?.map_err(|e| format!("Could not run wsl.exe: {}", e))?;
    let mut distros = parse_list(&decode(&out.stdout));
    let added: Vec<String> = state.store.lock().unwrap().wsl_contexts.iter().map(|w| w.distro.clone()).collect();
    // Only look inside running WSL 2 distros: checking a stopped one would boot it.
    let checks = distros.iter().map(|d| {
        let name = d["name"].as_str().unwrap_or("").to_string();
        let run = d["state"] == "Running" && d["version"] == 2;
        async move { if run { Some(docker_in(prog, &name).await) } else { None } }
    });
    let results = futures_util::future::join_all(checks).await;
    for (d, r) in distros.iter_mut().zip(results) {
        d["added"] = json!(added.iter().any(|a| Some(a.as_str()) == d["name"].as_str()));
        d["checked"] = json!(r.is_some());
        let (ver, running) = r.unwrap_or((None, false));
        d["docker"] = json!(ver);
        d["dockerRunning"] = json!(running);
    }
    Ok(json!({ "available": true, "distros": distros }))
}

/// Install Docker Engine in a distro with the official convenience script, streaming the log to `wsl://install`.
#[tauri::command]
pub async fn wsl_install_docker<R: Runtime>(app: AppHandle<R>, distro: String) -> CmdResult<String> {
    let prog = program().ok_or("WSL is not available on this machine")?;
    if distro.is_empty() || distro.contains(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
        return Err("Invalid distro name".into());
    }
    let script = "set -e; command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl); \
                  curl -fsSL https://get.docker.com | sh; \
                  systemctl enable --now docker 2>/dev/null || service docker start; docker version --format 'Docker {{.Server.Version}}'";
    let mut c = wsl_cmd(prog);
    c.args(["-d", &distro, "-u", "root", "--", "sh", "-c", script]);
    crate::cli::run_stream(&app, "wsl://install", &distro, c).await?;
    Ok(docker_in(prog, &distro).await.0.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_list_parsing() {
        let raw: Vec<u8> = "  NAME            STATE           VERSION\r\n* Ubuntu-24.04    Running         2\r\n  Debian          Stopped         2\r\n  docker-desktop  Running         2\r\n"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let text = decode(&raw);
        let l = parse_list(&text);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0]["name"], "Ubuntu-24.04");
        assert_eq!(l[0]["default"], true);
        assert_eq!(l[1]["state"], "Stopped");
        assert_eq!(decode(b"plain utf8"), "plain utf8");
    }
}
