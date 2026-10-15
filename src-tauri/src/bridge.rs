//! Local TCP bridge for SSH and WSL2 engines. Listens on `127.0.0.1:<random port>`; every accepted connection runs
//! `docker system dial-stdio` on the target (through `ssh` or `wsl.exe`) and pipes bytes both ways, the same way the
//! docker CLI handles `ssh://` hosts. bollard and the docker CLI then talk plain HTTP to the local port.
use crate::ctx::CtxInfo;
use crate::util::*;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

pub struct Bridge {
    pub ctx_id: String,
    pub port: u16,
    /// Last stderr text of a bridge process (e.g. `ssh: connect to host … Connection timed out`), shown when connecting fails.
    pub last_error: Arc<StdMutex<String>>,
    task: JoinHandle<()>,
}

impl Bridge {
    pub fn addr(&self) -> String {
        format!("tcp://127.0.0.1:{}", self.port)
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub fn needs_bridge(c: &CtxInfo) -> bool {
    c.kind == "ssh" || c.kind == "wsl"
}

/// `ssh://user@host:port` → (user@host, port).
pub fn split_ssh(endpoint: &str) -> (String, Option<u16>) {
    let rest = endpoint.strip_prefix("ssh://").unwrap_or(endpoint).trim_end_matches('/');
    if let Some((h, p)) = rest.rsplit_once(':') {
        // A bare IPv6 address has colons of its own; `[::1]:22` keeps its brackets.
        if !h.contains(':') || h.ends_with(']') {
            if let Ok(n) = p.parse::<u16>() {
                return (h.to_string(), Some(n));
            }
        }
    }
    (rest.to_string(), None)
}

/// Program and arguments that open a raw connection to the remote Docker daemon on stdin/stdout.
pub fn dial_command(c: &CtxInfo) -> Result<(String, Vec<String>), String> {
    match c.kind.as_str() {
        "ssh" => {
            let (dest, port) = split_ssh(&c.endpoint);
            // BatchMode: never prompt (no TTY); known_hosts is respected, an unknown host fails with a clear message.
            let mut a: Vec<String> = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=30"].iter().map(|x| x.to_string()).collect();
            if let Some(p) = port {
                a.extend(["-p".into(), p.to_string()]);
            }
            if let Some(k) = c.ssh_key.as_ref().filter(|k| !k.trim().is_empty()) {
                a.extend(["-i".into(), expand_tilde(k.trim()).to_string_lossy().to_string(), "-o".into(), "IdentitiesOnly=yes".into()]);
            }
            // Reuse one SSH connection for the many short HTTP connections (OpenSSH multiplexing is not available on Windows).
            #[cfg(unix)]
            {
                let dir = std::env::temp_dir().join("dockspan-ssh");
                let _ = std::fs::create_dir_all(&dir);
                a.extend(["-o".into(), "ControlMaster=auto".into(), "-o".into(), format!("ControlPath={}/%C", dir.display()), "-o".into(), "ControlPersist=60".into()]);
            }
            a.extend(["--".into(), dest, "docker".into(), "system".into(), "dial-stdio".into()]);
            Ok(("ssh".into(), a))
        }
        "wsl" => {
            let prog = crate::wsl::program().ok_or("WSL is not available on this machine")?;
            let distro = c.wsl_distro.clone().ok_or("The WSL2 distro is missing")?;
            // Run as root so the default user does not need to be in the docker group; start dockerd if the distro has no systemd.
            let script = "[ -S /var/run/docker.sock ] || service docker start >/dev/null 2>&1 || systemctl start docker >/dev/null 2>&1; exec docker system dial-stdio";
            Ok((prog.into(), vec!["-d".into(), distro, "-u".into(), "root".into(), "--".into(), "sh".into(), "-c".into(), script.into()]))
        }
        k => Err(format!("No bridge for connection type {}", k)),
    }
}

async fn pipe(sock: tokio::net::TcpStream, prog: String, args: Vec<String>, last_error: Arc<StdMutex<String>>) {
    let mut cmd = Command::new(&prog);
    cmd.args(&args).env("PATH", cli_path()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            *last_error.lock().unwrap() = format!("Could not run {}: {}", prog, e);
            return;
        }
    };
    let (Some(mut stdin), Some(mut stdout), Some(mut stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else { return };
    let errs = last_error.clone();
    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        let t = buf.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("").to_string();
        if !t.is_empty() {
            *errs.lock().unwrap() = t;
        }
    });
    let (mut rd, mut wr) = sock.into_split();
    let up = async {
        let _ = tokio::io::copy(&mut rd, &mut stdin).await;
        // Client finished sending: close stdin so dial-stdio half-closes towards the daemon.
        drop(stdin);
    };
    let down = async {
        let _ = tokio::io::copy(&mut stdout, &mut wr).await;
        let _ = wr.shutdown().await;
    };
    tokio::join!(up, down);
    let _ = child.kill().await;
    let _ = err_task.await;
}

pub async fn start(c: &CtxInfo) -> Result<Bridge, String> {
    let (prog, args) = dial_command(c)?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let last_error = Arc::new(StdMutex::new(String::new()));
    let le = last_error.clone();
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let _ = sock.set_nodelay(true);
            tokio::spawn(pipe(sock, prog.clone(), args.clone(), le.clone()));
        }
    });
    Ok(Bridge { ctx_id: c.id.clone(), port, last_error, task })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_endpoint_split() {
        assert_eq!(split_ssh("ssh://deploy@203.0.113.10"), ("deploy@203.0.113.10".into(), None));
        assert_eq!(split_ssh("ssh://deploy@203.0.113.10:2222"), ("deploy@203.0.113.10".into(), Some(2222)));
        assert_eq!(split_ssh("ssh://host"), ("host".into(), None));
        assert_eq!(split_ssh("ssh://me@[::1]:22"), ("me@[::1]".into(), Some(22)));
    }
}
