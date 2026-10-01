use crate::activity::SharedActivityStore;
use crate::discovery::agent_registry::SharedRegistry;
use crate::managed_sessions::{control_capability, dispatch_prompt, find_executable, ManagedSession, ManagedSessionState, Provider, SharedManagedSessions};
use crate::models::AppStats;
use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_BYTES: usize = 4000;

pub async fn run_remote_server(
    port: u16,
    registry: SharedRegistry,
    token: String,
    start_time: Instant,
    activities: SharedActivityStore,
    sessions: SharedManagedSessions,
    control_enabled: Arc<AtomicBool>,
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
        let activities = activities.clone();
        let sessions = sessions.clone();
        let control_enabled = control_enabled.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, &registry, &token, start_time, &activities, &sessions, &control_enabled).await {
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
    activities: &SharedActivityStore,
    sessions: &SharedManagedSessions,
    control_enabled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let request = tokio::time::timeout(std::time::Duration::from_secs(10), read_request(&mut stream)).await.map_err(|_|"HTTP request timeout")??;
    let response = route(request, registry, token, start_time, activities, sessions, control_enabled).await;
    stream.write_all(response.as_bytes()).await.map_err(|error| error.to_string())
}

async fn route(
    request: Request,
    registry: &SharedRegistry,
    token: &str,
    start_time: Instant,
    activities: &SharedActivityStore,
    sessions: &SharedManagedSessions,
    control_enabled: &Arc<AtomicBool>,
) -> String {
    let path = request.path.split('?').next().unwrap_or(&request.path);
    if path == "/api/health" || path == "/api/v1/health" {
        return json_response(200, &serde_json::json!({"ok": true, "service": "office-ai"}).to_string());
    }
    if !authorized(&request.headers, token) {
        return error_response(401, "unauthorized", "Use Authorization: Bearer <token>");
    }
    match (request.method.as_str(), path) {
        ("GET", "/api/agents") | ("GET", "/api/v1/agents") => {
            let agents = registry.read().await.get_all();
            json_response(200, &serde_json::to_string(&agents).unwrap_or_else(|_| "[]".to_string()))
        }
        ("GET", "/api/stats") | ("GET", "/api/v1/stats") => {
            let registry = registry.read().await;
            let stats = AppStats { total_agents: registry.len() as u32, active_agents: registry.active_count(), total_tokens_in: registry.total_tokens_in(), total_tokens_out: registry.total_tokens_out(), uptime_seconds: start_time.elapsed().as_secs() };
            json_response(200, &serde_json::to_string(&stats).unwrap_or_else(|_| "{}".to_string()))
        }
        ("GET", path) if path.starts_with("/api/v1/agents/") && path.ends_with("/activities") => {
            let id = path.trim_start_matches("/api/v1/agents/").trim_end_matches("/activities");
            if registry.read().await.get(id).is_none() { return error_response(404, "agent_not_found", "Agent tidak ditemukan"); }
            let query = parse_query(request.path.split('?').nth(1).unwrap_or_default());
            let after = query.get("after").and_then(|value| value.parse().ok()).unwrap_or(0);
            let limit = query.get("limit").and_then(|value| value.parse().ok()).unwrap_or(50);
            let events = activities.lock().map(|store| store.after(id, after, limit)).unwrap_or_default();
            json_response(200, &serde_json::to_string(&events).unwrap_or_else(|_| "[]".to_string()))
        }
        ("GET", "/api/v1/capabilities") => capabilities_response(sessions, control_enabled.load(Ordering::Relaxed)),
        ("GET", path) if path.starts_with("/api/v1/agents/") && path.ends_with("/control") => {
            let id=path.trim_start_matches("/api/v1/agents/").trim_end_matches("/control");
            let Some(agent)=registry.read().await.get(id) else {return error_response(404,"agent_not_found","Agent tidak ditemukan");};
            let mut capability=control_capability(&agent,sessions).await;
            if !control_enabled.load(Ordering::Relaxed) {capability.can_send=false;capability.reason=Some("Aktifkan remote control di desktop".into());}
            json_response(200,&serde_json::to_string(&capability).unwrap())
        }
        ("GET", path) if path.starts_with("/api/v1/agents/") && !path.trim_start_matches("/api/v1/agents/").contains('/') => {
            match registry.read().await.get(path.trim_start_matches("/api/v1/agents/")) {
                Some(agent)=>json_response(200,&serde_json::to_string(&agent).unwrap()),
                None=>error_response(404,"agent_not_found","Agent sudah keluar dari office"),
            }
        }
        ("POST", "/api/v1/agents") => create_agent(request.body, sessions, control_enabled).await,
        ("POST", path) if path.starts_with("/api/v1/agents/") && path.ends_with("/messages") => {
            let id = path.trim_start_matches("/api/v1/agents/").trim_end_matches("/messages");
            send_agent_message(id, request.body, registry, activities, sessions, control_enabled).await
        }
        ("OPTIONS", _) => json_response(204, ""),
        _ => error_response(404, "not_found", "Endpoint tidak ditemukan"),
    }
}

async fn create_agent(body: Vec<u8>, sessions: &SharedManagedSessions, enabled: &Arc<AtomicBool>) -> String {
    if !enabled.load(Ordering::Relaxed) { return error_response(403, "remote_control_disabled", "Aktifkan remote control di desktop"); }
    let request: CreateAgentRequest = match parse_json(&body) { Ok(value) => value, Err(error) => return error_response(400, "invalid_body", &error) };
    let Some(provider) = Provider::parse(&request.provider) else { return error_response(400, "invalid_provider", "Provider tidak didukung"); };
    if request.workspace_id.trim().is_empty() { return error_response(400, "invalid_workspace", "Workspace wajib dipilih"); }
    let initial = request.initial_message.filter(|message| !message.trim().is_empty());
    let result = sessions.lock().map_err(|_| "Session manager terkunci".to_string()).and_then(|mut manager| manager.create(provider, &request.workspace_id, initial));
    match result { Ok(session) => json_response(201, &serde_json::to_string(&public_session(&session)).unwrap()), Err(error) => error_response(403, "session_create_failed", &error) }
}

async fn send_agent_message(agent_id: &str, body: Vec<u8>, registry: &SharedRegistry, activities: &SharedActivityStore, sessions: &SharedManagedSessions, enabled: &Arc<AtomicBool>) -> String {
    if !enabled.load(Ordering::Relaxed) { return error_response(403, "remote_control_disabled", "Aktifkan remote control di desktop"); }
    let request: MessageRequest = match parse_json(&body) { Ok(value) => value, Err(error) => return error_response(400, "invalid_body", &error) };
    let message = request.message.trim();
    if message.is_empty() || message.len() > MAX_MESSAGE_BYTES { return error_response(413, "message_too_large", "Message harus 1-4000 karakter"); }
    if !matches!(request.mode.as_str(), "now" | "queue" | "interrupt") { return error_response(400, "invalid_mode", "Mode harus now, queue, atau interrupt"); }
    if registry.read().await.get(agent_id).is_none() {return error_response(404,"agent_not_found","Agent tidak ditemukan");}
    match dispatch_prompt(registry,sessions,activities,agent_id,message,&request.mode).await {
        Ok(queued) => json_response(200, if queued {"{\"queued\":true}"} else {"{\"sent\":true}"}),
        Err(error) => error_response(409, "send_failed", &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAgentRequest { provider: String, workspace_id: String, initial_message: Option<String> }

#[derive(Deserialize)]
struct MessageRequest { message: String, mode: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicSession { session_id: String, agent_id: Option<String>, provider: Provider, workspace_id: String, workspace_label: String, state: ManagedSessionState }

fn public_session(session: &ManagedSession) -> PublicSession { PublicSession { session_id: session.session_id.clone(), agent_id: session.agent_id.clone(), provider: session.provider.clone(), workspace_id: session.workspace_id.clone(), workspace_label: session.workspace_label.clone(), state: session.state.clone() } }

fn capabilities_response(sessions: &SharedManagedSessions, enabled: bool) -> String {
    let workspaces = sessions.lock().map(|manager| manager.workspaces()).unwrap_or_default();
    let providers = ["codex", "claude", "gemini"].into_iter().filter(|provider| executable_available(provider)).collect::<Vec<_>>();
    json_response(200, &serde_json::json!({"remoteControlEnabled": enabled, "terminalController": executable_available("kitty"), "providers": providers, "workspaces": workspaces}).to_string())
}

fn executable_available(name: &str) -> bool { find_executable(name).is_some() }

#[derive(Debug)]
struct Request { method: String, path: String, headers: String, body: Vec<u8> }

async fn read_request(stream: &mut tokio::net::TcpStream) -> Result<Request, String> {
    let mut data = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    while data.len() < MAX_REQUEST_BYTES && !data.windows(4).any(|window| window == b"\r\n\r\n") {
        let size = stream.read(&mut chunk).await.map_err(|error| error.to_string())?;
        if size == 0 { return Err("connection closed before headers".to_string()); }
        data.extend_from_slice(&chunk[..size]);
    }
    let header_end = data.windows(4).position(|window| window == b"\r\n\r\n").ok_or("request headers too large")?;
    let headers = std::str::from_utf8(&data[..header_end]).map_err(|error| error.to_string())?.to_string();
    let mut parts = headers.lines().next().ok_or("empty request")?.split_whitespace();
    let method = parts.next().ok_or("missing method")?.to_string();
    let path = parts.next().ok_or("missing path")?.to_string();
    let content_length = header_value(&headers, "content-length").and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
    if content_length > MAX_REQUEST_BYTES { return Err("request body too large".to_string()); }
    let body_start = header_end + 4;
    while data.len() - body_start < content_length {
        let size = stream.read(&mut chunk).await.map_err(|error| error.to_string())?;
        if size == 0 { return Err("connection closed before body".to_string()); }
        data.extend_from_slice(&chunk[..size]);
    }
    Ok(Request { method, path, headers, body: data[body_start..body_start + content_length].to_vec() })
}

fn parse_json<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, String> { serde_json::from_slice(body).map_err(|error| format!("JSON tidak valid: {error}")) }
fn header_value<'a>(headers: &'a str, wanted: &str) -> Option<&'a str> { headers.lines().find_map(|line| line.split_once(':').filter(|(name, _)| name.trim().eq_ignore_ascii_case(wanted)).map(|(_, value)| value.trim())) }
fn parse_query(query: &str) -> std::collections::HashMap<&str, &str> { query.split('&').filter_map(|part| part.split_once('=')).collect() }
fn authorized(headers: &str, token: &str) -> bool { header_value(headers, "authorization").is_some_and(|value| value == format!("Bearer {token}")) }
fn error_response(status: u16, error: &str, message: &str) -> String { json_response(status, &serde_json::json!({"error": error, "message": message}).to_string()) }
fn json_response(status: u16, body: &str) -> String {
    let reason = match status { 200 => "OK", 201 => "Created", 204 => "No Content", 400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found", 409 => "Conflict", 413 => "Payload Too Large", _ => "Error" };
    format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_is_case_insensitive_and_exact() {
        assert!(authorized("Authorization: Bearer abc", "abc"));
        assert!(authorized("authorization: Bearer abc", "abc"));
        assert!(!authorized("Authorization: Bearer abc2", "abc"));
    }
    #[test]
    fn json_error_has_stable_shape() {
        let body = error_response(409, "agent_busy", "busy");
        assert!(body.contains("\"error\":\"agent_busy\""));
        assert!(body.contains("\"message\":\"busy\""));
    }
}
