//! Interactive SSH terminals: the system `ssh` runs inside a real pseudo-terminal (portable-pty: openpty on Unix, ConPTY
//! on Windows), so password prompts, host-key questions, full-screen programs and window resizes all work.
//! Output goes to `exec://<sid>` with the same payload as `docker exec` (`{t: 'data', d: base64}` then `{t: 'close'}`),
//! so the frontend reuses `TerminalView`. The frontend generates `sid` and listens before calling `ssh_open`.
use crate::state::AppState;
use crate::store::SavedSsh;
use crate::util::*;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct SshState {
    sessions: StdMutex<HashMap<String, Session>>,
}

/// Where to connect: a `~/.ssh/config` alias (only `host`), or host + optional user / port / key.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub key: Option<String>,
}

/// A host or user that starts with `-` would be read by ssh as an option; whitespace or control characters are never valid.
fn safe_word(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Arguments for `ssh` (the program itself excluded).
pub fn ssh_args(t: &SshTarget) -> Result<Vec<String>, String> {
    let host = t.host.trim();
    if !safe_word(host) {
        return Err("Invalid host".into());
    }
    let mut a: Vec<String> = vec!["-o".into(), "ServerAliveInterval=30".into()];
    if let Some(u) = t.user.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        if !safe_word(u) {
            return Err("Invalid user".into());
        }
        a.extend(["-l".into(), u.into()]);
    }
    if let Some(p) = t.port.filter(|p| *p != 0 && *p != 22) {
        a.extend(["-p".into(), p.to_string()]);
    }
    if let Some(k) = t.key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        a.extend(["-i".into(), expand_tilde(k).to_string_lossy().to_string()]);
    }
    a.push("--".into());
    a.push(host.into());
    Ok(a)
}

#[tauri::command]
pub fn ssh_open<R: Runtime>(app: AppHandle<R>, state: State<'_, SshState>, sid: String, target: SshTarget, cols: u16, rows: u16) -> CmdResult<()> {
    let args = ssh_args(&target)?;
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Could not open a terminal: {}", e))?;
    let mut cmd = CommandBuilder::new("ssh");
    cmd.args(&args);
    cmd.env("TERM", "xterm-256color");
    cmd.env("PATH", cli_path());
    cmd.cwd(home());
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Could not run ssh: {}. Is the OpenSSH client installed?", e))?;
    // The slave belongs to ssh now; keeping it open here would hide the end of the session.
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let killer = child.clone_killer();
    state.sessions.lock().unwrap().insert(sid.clone(), Session { writer, master: pair.master, killer });

    let ev = format!("exec://{}", sid);
    // PTY reads block: plain threads, not the async runtime.
    let app_r = app.clone();
    let ev_r = ev.clone();
    std::thread::spawn(move || {
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app_r.emit(&ev_r, json!({ "t": "data", "d": b64.encode(&buf[..n]) }));
                }
            }
        }
    });
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        // Let the reader forward the last output (e.g. "Permission denied") before the session goes away.
        std::thread::sleep(Duration::from_millis(200));
        // Dropping the master ends the reader (needed on Windows, where ConPTY does not report EOF by itself).
        app.state::<SshState>().sessions.lock().unwrap().remove(&sid);
        let _ = app.emit(&ev, json!({ "t": "close", "code": code }));
    });
    Ok(())
}

#[tauri::command]
pub fn ssh_write(state: State<'_, SshState>, sid: String, data: String) -> CmdResult<()> {
    let mut s = state.sessions.lock().unwrap();
    let sess = s.get_mut(&sid).ok_or("The terminal session is closed")?;
    sess.writer.write_all(data.as_bytes()).map_err(err)?;
    sess.writer.flush().map_err(err)
}

#[tauri::command]
pub fn ssh_resize(state: State<'_, SshState>, sid: String, cols: u16, rows: u16) -> CmdResult<()> {
    let s = state.sessions.lock().unwrap();
    let sess = s.get(&sid).ok_or("The terminal session is closed")?;
    sess.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(err)
}

#[tauri::command]
pub fn ssh_close(state: State<'_, SshState>, sid: String) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&sid) {
        let _ = s.killer.kill();
    }
}

// ---------------------------------------------------------------- hosts saved in the app

fn valid_saved(h: &SavedSsh) -> Result<(), String> {
    if h.name.trim().is_empty() {
        return Err("Enter a display name".into());
    }
    ssh_args(&SshTarget { host: h.host.clone(), user: h.user.clone(), port: h.port, key: h.key.clone() }).map(|_| ())
}

#[tauri::command]
pub fn ssh_saved_list(state: State<'_, AppState>) -> Vec<SavedSsh> {
    state.store.lock().unwrap().ssh_saved.clone()
}

#[tauri::command]
pub fn ssh_saved_add(state: State<'_, AppState>, host: SavedSsh) -> CmdResult<SavedSsh> {
    let mut h = host;
    h.name = h.name.trim().to_string();
    h.host = h.host.trim().to_string();
    valid_saved(&h)?;
    if state.store.lock().unwrap().ssh_saved.iter().any(|x| x.name.eq_ignore_ascii_case(&h.name)) {
        return Err(format!("A host named {} already exists", h.name));
    }
    let out = h.clone();
    state.with_store(|s| s.ssh_saved.push(h));
    Ok(out)
}

#[tauri::command]
pub fn ssh_saved_remove(state: State<'_, AppState>, name: String) {
    state.with_store(|s| s.ssh_saved.retain(|x| x.name != name));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_terminal_args() {
        let t = SshTarget { host: "prod".into(), ..Default::default() };
        assert_eq!(ssh_args(&t).unwrap(), ["-o", "ServerAliveInterval=30", "--", "prod"]);
        let t = SshTarget { host: "203.0.113.10".into(), user: Some("deploy".into()), port: Some(2222), key: Some("/k/id".into()) };
        assert_eq!(ssh_args(&t).unwrap(), ["-o", "ServerAliveInterval=30", "-l", "deploy", "-p", "2222", "-i", "/k/id", "--", "203.0.113.10"]);
        // Option injection and garbage are refused.
        assert!(ssh_args(&SshTarget { host: "-oProxyCommand=x".into(), ..Default::default() }).is_err());
        assert!(ssh_args(&SshTarget { host: "a b".into(), ..Default::default() }).is_err());
        assert!(ssh_args(&SshTarget { host: "h".into(), user: Some("-x".into()), ..Default::default() }).is_err());
    }
}
