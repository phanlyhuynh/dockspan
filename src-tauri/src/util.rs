use serde::Serialize;
use serde_json::Value;
use std::fmt::Display;

pub type CmdResult<T> = Result<T, String>;

/// Turn any error into a string to show in a toast.
pub fn err<E: Display>(e: E) -> String {
    e.to_string()
}

/// Error from the Docker Engine: take the API's `message` as-is, do not swallow the error.
pub fn derr(e: bollard::errors::Error) -> String {
    match e {
        bollard::errors::Error::DockerResponseServerError { message, .. } => message,
        other => other.to_string(),
    }
}

pub fn to_v<T: Serialize>(t: &T) -> Value {
    serde_json::to_value(t).unwrap_or(Value::Null)
}

pub fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

pub fn i(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_i64()).unwrap_or(0)
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn home() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// Expand a leading `~/` in a path.
pub fn expand_tilde(p: &str) -> std::path::PathBuf {
    if p == "~" {
        return home();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home().join(rest);
    }
    std::path::PathBuf::from(p)
}

/// Extended PATH: GUI apps on macOS/Linux usually do not inherit the shell's PATH,
/// so `docker`, `code`, `colima`… would not be found without adding it.
pub fn cli_path() -> std::ffi::OsString {
    let mut parts: Vec<std::path::PathBuf> = Vec::new();
    if let Some(p) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&p));
    }
    let h = home();
    let extras = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
        "/Applications/Docker.app/Contents/Resources/bin",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    ];
    for e in extras {
        parts.push(e.into());
    }
    parts.push(h.join(".docker/bin"));
    parts.push(h.join(".rd/bin"));
    parts.push(h.join(".orbstack/bin"));
    std::env::join_paths(parts).unwrap_or_default()
}
