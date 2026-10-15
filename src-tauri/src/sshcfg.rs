//! Hosts from `~/.ssh/config` for the "Add connection" modal. Aliases are read from the file (following `Include`);
//! their effective settings come from `ssh -G <alias>`, so OpenSSH itself resolves `Match`, wildcards and includes.
use crate::util::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: u16,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

fn ssh_dir() -> PathBuf {
    home().join(".ssh")
}

/// `Keyword value` or `Keyword=value`; keywords are case-insensitive.
fn split_kv(line: &str) -> Option<(String, String)> {
    let l = line.trim();
    if l.is_empty() || l.starts_with('#') {
        return None;
    }
    let i = l.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = l[..i].to_ascii_lowercase();
    let val = l[i..].trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim().trim_matches('"').to_string();
    Some((key, val))
}

/// Expand an `Include` argument: `~`, relative to `~/.ssh`, and `*`/`?` globs in the file name.
fn include_paths(arg: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for word in arg.split_whitespace() {
        let p = expand_tilde(word);
        let p = if p.is_absolute() { p } else { ssh_dir().join(p) };
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if !name.contains(['*', '?']) {
            out.push(p);
            continue;
        }
        let re = regex::Regex::new(&format!("^{}$", regex::escape(&name).replace(r"\*", ".*").replace(r"\?", "."))).unwrap();
        if let Some(dir) = p.parent() {
            let mut found: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|f| f.is_file() && re.is_match(&f.file_name().unwrap_or_default().to_string_lossy())).collect();
            found.sort();
            out.extend(found);
        }
    }
    out
}

/// Concrete `Host` aliases in file order (patterns with `*`, `?` or `!` are skipped), with what the file itself says about them.
pub fn parse_hosts(path: &Path, depth: u8, out: &mut Vec<SshHost>) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let mut current: Vec<usize> = Vec::new();
    for line in text.lines() {
        let Some((k, v)) = split_kv(line) else { continue };
        match k.as_str() {
            "include" if depth < 5 => {
                for p in include_paths(&v) {
                    parse_hosts(&p, depth + 1, out);
                }
            }
            "host" => {
                current.clear();
                for a in v.split_whitespace() {
                    if a.contains(['*', '?', '!']) || out.iter().any(|h| h.alias == a) {
                        continue;
                    }
                    out.push(SshHost { alias: a.to_string(), hostname: a.to_string(), port: 22, ..Default::default() });
                    current.push(out.len() - 1);
                }
            }
            "match" => current.clear(),
            _ => {
                for &i in &current {
                    let h = &mut out[i];
                    match k.as_str() {
                        "hostname" => h.hostname = v.clone(),
                        "user" => h.user = Some(v.clone()),
                        "port" => h.port = v.parse().unwrap_or(22),
                        "identityfile" if h.identity_file.is_none() => h.identity_file = Some(v.clone()),
                        "proxyjump" => h.proxy_jump = Some(v.clone()).filter(|x| x != "none"),
                        _ => {}
                    }
                }
            }
        }
    }
}

/// Apply the output of `ssh -G <alias>` (effective config, lower-case keys). Only an identity file that exists is kept,
/// because `ssh -G` also lists the default ones (`~/.ssh/id_rsa`…).
pub fn apply_ssh_g(h: &mut SshHost, text: &str) {
    for line in text.lines() {
        let Some((k, v)) = line.split_once(' ') else { continue };
        let v = v.trim().to_string();
        match k {
            "hostname" => h.hostname = v,
            "user" => h.user = Some(v),
            "port" => h.port = v.parse().unwrap_or(h.port),
            "identityfile" => {
                if h.identity_file.as_deref().is_none_or(|f| !expand_tilde(f).exists()) && expand_tilde(&v).exists() {
                    h.identity_file = Some(v);
                }
            }
            "proxyjump" => h.proxy_jump = Some(v).filter(|x| x != "none"),
            _ => {}
        }
    }
    if h.identity_file.as_deref().is_some_and(|f| !expand_tilde(f).exists()) {
        h.identity_file = None;
    }
    // Show paths under the home folder as ~/…
    let home = home().to_string_lossy().to_string();
    if let Some(f) = h.identity_file.as_mut() {
        if let Some(rest) = f.strip_prefix(&home) {
            *f = format!("~{}", rest);
        }
    }
}

async fn resolve(h: &mut SshHost, config: Option<&Path>) {
    let mut c = tokio::process::Command::new("ssh");
    if let Some(f) = config {
        c.arg("-F").arg(f);
    }
    c.arg("-G").arg(&h.alias).env("PATH", cli_path()).stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(3), c.output()).await {
        if out.status.success() {
            apply_ssh_g(h, &String::from_utf8_lossy(&out.stdout));
        }
    }
}

pub async fn hosts_from(config: &Path, pass_f: bool) -> Vec<SshHost> {
    let mut hosts = Vec::new();
    parse_hosts(config, 0, &mut hosts);
    let futs = hosts.iter().cloned().map(|mut h| async move {
        resolve(&mut h, pass_f.then_some(config)).await;
        h
    });
    futures_util::future::join_all(futs).await
}

/// Hosts of `~/.ssh/config` (empty when there is no such file).
#[tauri::command]
pub async fn ssh_hosts() -> Vec<SshHost> {
    hosts_from(&ssh_dir().join("config"), false).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dockspan-sshcfg-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ssh_config_parsing() {
        let d = tmp("parse");
        std::fs::write(d.join("extra.conf"), "Host from-include\n  HostName 10.1.1.1\n").unwrap();
        let cfg = d.join("config");
        std::fs::write(
            &cfg,
            format!(
                "# comment\nInclude {}/*.conf\n\nHost prod prod-alias\n  HostName 203.0.113.10\n  User deploy\n  Port=2222\n  IdentityFile ~/.ssh/id_prod\n  ProxyJump bastion\n\nHost *.internal !skip\n  User nobody\n\nMatch host x\n  User matched\n\nHost bastion\n  HostName bastion.example.com\n",
                d.display()
            ),
        )
        .unwrap();
        let mut hosts = Vec::new();
        parse_hosts(&cfg, 0, &mut hosts);
        let aliases: Vec<&str> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, ["from-include", "prod", "prod-alias", "bastion"]);
        let p = &hosts[1];
        assert_eq!((p.hostname.as_str(), p.user.as_deref(), p.port, p.proxy_jump.as_deref()), ("203.0.113.10", Some("deploy"), 2222, Some("bastion")));
        assert_eq!(hosts[2].hostname, "203.0.113.10");
        assert_eq!(hosts[3].user, None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ssh_g_output() {
        let mut h = SshHost { alias: "prod".into(), hostname: "prod".into(), port: 22, identity_file: Some("~/.ssh/does-not-exist".into()), ..Default::default() };
        apply_ssh_g(&mut h, "host prod\nhostname 203.0.113.10\nuser deploy\nport 2222\nidentityfile /nonexistent/id_rsa\nproxyjump none\n");
        assert_eq!((h.hostname.as_str(), h.user.as_deref(), h.port), ("203.0.113.10", Some("deploy"), 2222));
        assert_eq!(h.identity_file, None);
        assert_eq!(h.proxy_jump, None);
    }

    /// Resolution through the real `ssh -G` with a temporary config file.
    #[tokio::test]
    async fn ssh_g_real_binary() {
        if std::process::Command::new("ssh").arg("-V").output().is_err() {
            return;
        }
        let d = tmp("real");
        let key = d.join("id_test");
        std::fs::write(&key, "x").unwrap();
        let cfg = d.join("config");
        std::fs::write(&cfg, format!("Host box\n  HostName 198.51.100.7\n  User ops\n  Port 2200\n  IdentityFile {}\n\nHost *\n  ServerAliveInterval 30\n", key.display())).unwrap();
        let hosts = hosts_from(&cfg, true).await;
        assert_eq!(hosts.len(), 1);
        let h = &hosts[0];
        assert_eq!((h.alias.as_str(), h.hostname.as_str(), h.user.as_deref(), h.port), ("box", "198.51.100.7", Some("ops"), 2200));
        assert_eq!(h.identity_file.as_deref(), Some(key.to_string_lossy().as_ref()));
        let _ = std::fs::remove_dir_all(&d);
    }
}
