//! Raw GET to the Docker Engine API over a unix socket / TCP.
//! Used for `/system/df`: bollard 0.21 only models the API ≥ 1.52 format, so with
//! older engines (Docker 27…) the fields are lost. Call API v1.44 for a stable format.
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(mut s: S, path: &str) -> Result<(u16, Vec<u8>), String> {
    let req = format!("GET {} HTTP/1.0\r\nHost: docker\r\nAccept: application/json\r\nConnection: close\r\n\r\n", path);
    s.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("invalid HTTP response")?;
    let head = String::from_utf8_lossy(&buf[..split]).to_string();
    let status: u16 = head.split_whitespace().nth(1).and_then(|x| x.parse().ok()).ok_or("missing HTTP status code")?;
    let mut body = buf[split + 4..].to_vec();
    if head.to_lowercase().contains("transfer-encoding: chunked") {
        body = dechunk(&body);
    }
    Ok((status, body))
}

fn dechunk(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() {
        let Some(nl) = data[i..].windows(2).position(|w| w == b"\r\n") else { break };
        let size = usize::from_str_radix(String::from_utf8_lossy(&data[i..i + nl]).trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
        i += nl + 2;
        if size == 0 || i + size > data.len() {
            break;
        }
        out.extend_from_slice(&data[i..i + size]);
        i += size + 2;
    }
    out
}

async fn request(endpoint: &str, path: &str) -> Result<(u16, Vec<u8>), String> {
    if let Some(p) = endpoint.strip_prefix("unix://") {
        #[cfg(unix)]
        {
            let s = tokio::net::UnixStream::connect(p).await.map_err(|e| format!("{}: {}", p, e))?;
            return exchange(s, path).await;
        }
        #[cfg(not(unix))]
        {
            let _ = p;
            return Err("unix sockets are not available on this operating system".into());
        }
    }
    if let Some(h) = endpoint.strip_prefix("tcp://").or_else(|| endpoint.strip_prefix("http://")) {
        let s = tokio::net::TcpStream::connect(h.trim_end_matches('/')).await.map_err(|e| format!("{}: {}", h, e))?;
        return exchange(s, path).await;
    }
    Err("this connection type does not support raw GET".into())
}

/// GET `path` (query included) and return JSON. Try `/v1.44` first, fall back to unversioned for older engines.
pub async fn get_json(endpoint: &str, path: &str) -> Result<Value, String> {
    for prefix in ["/v1.44", ""] {
        let (status, body) = request(endpoint, &format!("{}{}", prefix, path)).await?;
        if status == 200 {
            return serde_json::from_slice(&body).map_err(|e| format!("invalid JSON: {}", e));
        }
        if status != 400 && status != 404 {
            return Err(format!("The engine returned status {}: {}", status, String::from_utf8_lossy(&body).chars().take(200).collect::<String>()));
        }
    }
    Err("The engine rejected the request".into())
}
