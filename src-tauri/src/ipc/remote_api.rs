// Read-only HTTP API for the Flutter companion app.
// This server has its own port so the Chrome extension POST endpoint never
// becomes reachable through the public tunnel.

use crate::discovery::agent_registry::SharedRegistry;
use crate::models::AppStats;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const MAX_REQUEST_BYTES: usize = 16 * 1024;

pub async fn run_remote_server(
    port: u16,
    registry: SharedRegistry,
    token: String,
    start_time: Instant,
) {
    let addr = format!("127.0.0.1:{port}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(listener) => {
            app_log!("REMOTE_API", "listening on {addr}");
            listener
        }
        Err(error) => {
            app_log!("REMOTE_API", "failed to bind {addr}: {error}");
            return;
        }
    };

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(connection) => connection,
            Err(error) => {
                app_log!("REMOTE_API", "accept error: {error}");
                continue;
            }
        };

        let registry = registry.clone();
        let token = token.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, &registry, &token, start_time).await {
                app_log!("REMOTE_API", "connection from {peer} error: {error}");
            }
        });
    }
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    registry: &SharedRegistry,
    token: &str,
    start_time: Instant,
) -> Result<(), String> {
    let mut request = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    while request.len() < MAX_REQUEST_BYTES && !request.windows(4).any(|w| w == b"\r\n\r\n") {
        let size = stream
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if size == 0 {
            return Err("connection closed before headers".to_string());
        }
        request.extend_from_slice(&chunk[..size]);
    }
    if !request.windows(4).any(|w| w == b"\r\n\r\n") {
        return Err("request headers too large".to_string());
    }
    let (method, path, headers) = parse_request(&request)?;

    let response = match (method.as_str(), path.as_str()) {
        ("GET", "/api/health") => json_response(200, r#"{"ok":true,"service":"office-ai"}"#),
        ("GET", "/api/agents") if authorized(&headers, token) => {
            let agents = registry.read().await.get_all();
            json_response(200, &serde_json::to_string(&agents).map_err(|error| error.to_string())?)
        }
        ("GET", "/api/stats") if authorized(&headers, token) => {
            let registry = registry.read().await;
            let stats = AppStats {
                total_agents: registry.len() as u32,
                active_agents: registry.active_count(),
                total_tokens_in: registry.total_tokens_in(),
                total_tokens_out: registry.total_tokens_out(),
                uptime_seconds: start_time.elapsed().as_secs(),
            };
            json_response(200, &serde_json::to_string(&stats).map_err(|error| error.to_string())?)
        }
        ("GET", "/api/agents") | ("GET", "/api/stats") => json_response(
            401,
            r#"{"error":"unauthorized","message":"Use Authorization: Bearer <token>"}"#,
        ),
        _ => json_response(404, r#"{"error":"not_found"}"#),
    };

    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

fn parse_request(request: &[u8]) -> Result<(String, String, String), String> {
    let text = std::str::from_utf8(request).map_err(|error| error.to_string())?;
    let header_end = text.find("\r\n\r\n").unwrap_or(text.len());
    let headers = &text[..header_end];
    let request_line = headers.lines().next().ok_or("empty request")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("missing method")?.to_string();
    let path = parts.next().ok_or("missing path")?.to_string();
    Ok((method, path, headers.to_string()))
}

fn authorized(headers: &str, token: &str) -> bool {
    headers.lines().any(|line| {
        line.strip_prefix("Authorization:")
            .or_else(|| line.strip_prefix("authorization:"))
            .is_some_and(|value| value.trim() == format!("Bearer {token}"))
    })
}

fn json_response(status: u16, body: &str) -> String {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorized_accepts_bearer_token() {
        assert!(authorized("GET / HTTP/1.1\r\nAuthorization: Bearer abc", "abc"));
        assert!(!authorized("GET / HTTP/1.1\r\nAuthorization: Bearer wrong", "abc"));
    }

    #[test]
    fn parse_request_reads_method_path_and_headers() {
        let (method, path, headers) = parse_request(b"GET /api/agents HTTP/1.1\r\nHost: local\r\n\r\n").unwrap();
        assert_eq!(method, "GET");
        assert_eq!(path, "/api/agents");
        assert!(headers.contains("Host: local"));
    }
}
