use crate::models::{AgentState, Status};
use crate::terminal_control::{self, TerminalSession, TerminalTarget};
use crate::discovery::agent_registry::SharedRegistry;
use crate::activity::{ActivityInput, ActivityKind, SharedActivityStore};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::time::{sleep, Duration, Instant};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Codex,
    Claude,
    Gemini,
}

impl Provider {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }

    fn executable(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Gemini => "gemini",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedSessionState {
    Starting,
    Running,
    Closed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSession {
    pub session_id: String,
    pub agent_id: Option<String>,
    pub provider: Provider,
    pub workspace_id: String,
    pub workspace_label: String,
    pub kitty_pid: Option<u32>,
    pub kitty_window_id: Option<u64>,
    pub cli_pid: Option<u32>,
    pub socket_path: PathBuf,
    pub state: ManagedSessionState,
    #[serde(skip_serializing)]
    pub queued_message: Option<String>,
    #[serde(skip_serializing)]
    pub terminal: Option<TerminalSession>,
    pub attached: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Default)]
pub struct ManagedSessions {
    sessions: HashMap<String, ManagedSession>,
    workspaces: Vec<PathBuf>,
    sending: HashSet<String>,
    pending_prompts: HashMap<String, PendingPrompt>,
    log_bindings: HashMap<String, String>,
}

#[derive(Debug)]
struct PendingPrompt {
    provider: String,
    workspace: PathBuf,
    message: String,
    sent_at: Instant,
}

pub type SharedManagedSessions = Arc<Mutex<ManagedSessions>>;

impl ManagedSessions {
    pub fn new(workspaces: Vec<PathBuf>) -> Self {
        Self { workspaces, ..Self::default() }
    }

    pub fn workspaces(&self) -> Vec<WorkspaceInfo> {
        self.workspaces.iter().filter_map(workspace_info).collect()
    }

    pub fn create(&mut self, provider: Provider, workspace_id: &str, initial_message: Option<String>) -> Result<ManagedSession, String> {
        if let Some(message)=&initial_message { validate_message(message)?; }
        let workspace = self.resolve_workspace(workspace_id)?;
        let kitty = find_executable("kitty").ok_or("Kitty tidak terpasang")?;
        let executable = find_executable(provider.executable()).ok_or_else(|| format!("Provider {} tidak terpasang", provider.executable()))?;
        let session_id = format!("session-{}", uuid_suffix());
        let runtime_dir = std::env::temp_dir().join("office-ai").join(&session_id);
        std::fs::create_dir_all(&runtime_dir).map_err(|error| format!("Runtime session gagal dibuat: {error}"))?;
        set_private(&runtime_dir)?;
        let socket_path = runtime_dir.join("kitty.sock");
        let label = workspace.file_name().and_then(|name| name.to_str()).unwrap_or("workspace");
        let title = format!("OfficeAI {} - {label}", provider.executable());
        let child = std::process::Command::new(kitty)
            .args(["--detach", "--working-directory"])
            .arg(&workspace)
            .args(["--title", &title, "--listen-on"])
            .arg(format!("unix:{}", socket_path.display()))
            .args(["--override", "allow_remote_control=socket-only"])
            // Node CLIs use /usr/bin/env node; use the same NVM version as the CLI.
            .env("PATH", executable_path(&executable)?)
            .arg(&executable)
            .spawn()
            .map_err(|error| format!("Kitty gagal dibuka: {error}"))?;
        let session = ManagedSession {
            session_id: session_id.clone(),
            agent_id: None,
            provider,
            workspace_id: workspace_id.to_string(),
            workspace_label: label.to_string(),
            kitty_pid: Some(child.id()),
            kitty_window_id: None,
            cli_pid: None,
            socket_path,
            state: ManagedSessionState::Starting,
            queued_message: initial_message.map(|message| limit_message(&message)),
            terminal: None,
            attached: false,
        };
        self.sessions.insert(session_id, session.clone());
        Ok(session)
    }

    fn bind_terminal(&mut self, agent: &AgentState, provider: Provider, terminal: TerminalSession) -> ManagedSession {
        // A matching cwd is insufficient: bind the actual socket and foreground PID.
        let starting = self.sessions.values_mut().find(|session| {
            session.state == ManagedSessionState::Starting && session.provider == provider &&
            matches!(&terminal.target, TerminalTarget::Kitty { address,.. } if address == &format!("unix:{}",session.socket_path.display()))
        });
        if let Some(session) = starting {
            session.agent_id = Some(agent.id.clone()); session.cli_pid = agent.pid;
            session.kitty_window_id = match terminal.target { TerminalTarget::Kitty {window_id,..} => Some(window_id), _ => None };
            session.terminal = Some(terminal); session.state = ManagedSessionState::Running;
            return session.clone();
        }
        let session = ManagedSession {
            session_id: format!("attached-{}",uuid_suffix()), agent_id: Some(agent.id.clone()), provider,
            workspace_id: workspace_id_for_path(&terminal.workspace), workspace_label: workspace_id_for_path(&terminal.workspace),
            kitty_pid: None, kitty_window_id: match terminal.target {TerminalTarget::Kitty {window_id,..}=>Some(window_id), _=>None},
            cli_pid: agent.pid, socket_path: match &terminal.target {TerminalTarget::Kitty {address,..}=>PathBuf::from(address.trim_start_matches("unix:")),TerminalTarget::Tmux {socket,..}=>socket.clone()},
            state: ManagedSessionState::Running, queued_message: None, terminal: Some(terminal), attached: true,
        };
        self.sessions.retain(|_,s|s.agent_id.as_deref()!=Some(&agent.id));
        self.sessions.insert(session.session_id.clone(),session.clone());
        session
    }

    pub fn session_for_agent(&self, agent_id: &str) -> Option<ManagedSession> {
        self.sessions.values().find(|session| session.agent_id.as_deref() == Some(agent_id)).cloned()
    }

    pub fn queue_for_agent(&mut self, agent_id: &str, message: String) -> Result<(), String> {
        let session = self.sessions.values_mut().find(|session| session.agent_id.as_deref() == Some(agent_id)).ok_or("Managed session tidak tersedia")?;
        if session.state != ManagedSessionState::Running { return Err("Session sudah tertutup".into()); }
        if session.queued_message.is_some() {
            return Err("Queue agent sudah terisi".to_string());
        }
        session.queued_message = Some(limit_message(&message));
        Ok(())
    }

    pub fn take_queued_for_agent(&mut self, agent_id: &str) -> Option<(ManagedSession, String)> {
        if self.sending.contains(agent_id) { return None; }
        let session = self.sessions.values_mut().find(|session| session.agent_id.as_deref() == Some(agent_id))?;
        let message = session.queued_message.take()?;
        self.sending.insert(agent_id.into());
        Some((session.clone(), message))
    }

    pub fn mark_closed(&mut self, agent_id: &str) {
        self.pending_prompts.remove(agent_id);
        self.log_bindings.retain(|_, id| id != agent_id);
        if let Some(session) = self.sessions.values_mut().find(|session| session.agent_id.as_deref() == Some(agent_id)) {
            session.state = ManagedSessionState::Closed;
        }
    }

    pub fn restore_queued(&mut self, agent_id: &str, message: String) {
        if let Some(session) = self.sessions.values_mut().find(|s|s.agent_id.as_deref()==Some(agent_id)) {
            if session.queued_message.is_none() { session.queued_message=Some(message); }
        }
    }

    fn track_prompt(&mut self, session: &ManagedSession, message: &str) {
        if let (Some(id), Some(terminal)) = (&session.agent_id, &session.terminal) {
            self.pending_prompts.insert(id.clone(), PendingPrompt {
                provider: session.provider.executable().into(), workspace: terminal.workspace.clone(),
                message: message.trim().into(), sent_at: Instant::now(),
            });
        }
    }

    /// Bind by the full provider prompt echo, never by a truncated preview or PID order.
    pub fn agent_for_log(&mut self, log_id: &str, line: &str, provider: Option<&str>, cwd: Option<&str>) -> Option<String> {
        self.pending_prompts.retain(|_, prompt| prompt.sent_at.elapsed() < Duration::from_secs(300));
        if self.pending_prompts.is_empty() { return self.log_bindings.get(log_id).cloned(); }
        if let Some(message) = provider.and_then(|provider| prompt_echo(line, provider)) {
            let candidates: Vec<_> = self.pending_prompts.iter().filter(|(_, prompt)| {
                Some(prompt.provider.as_str()) == provider && prompt.message == message.trim()
                    && cwd.is_none_or(|cwd| Path::new(cwd).starts_with(&prompt.workspace) || prompt.workspace.starts_with(cwd))
            }).map(|(id, _)| id.clone()).collect();
            if let [id] = candidates.as_slice() {
                self.log_bindings.retain(|_, target| target != id);
                self.log_bindings.insert(log_id.into(), id.clone());
                self.pending_prompts.remove(id);
            }
        }
        self.log_bindings.get(log_id).cloned()
    }

    fn resolve_workspace(&self, id: &str) -> Result<PathBuf, String> {
        let path = self.workspaces.iter().find(|path| workspace_id_for_path(path) == id).ok_or("Workspace tidak diizinkan")?;
        let canonical = path.canonicalize().map_err(|error| format!("Workspace tidak valid: {error}"))?;
        if !self.workspaces.iter().any(|allowed| allowed.canonicalize().ok().as_ref() == Some(&canonical)) {
            return Err("Workspace di luar allowlist".to_string());
        }
        Ok(canonical)
    }
}

pub async fn send_message(session: &ManagedSession, message: &str, mode: &str, status: &Status) -> Result<(), String> {
    if session.state != ManagedSessionState::Running {
        return Err("Session terminal sudah tertutup".to_string());
    }
    if mode == "now" && !matches!(status, Status::Idle | Status::TaskComplete) {
        return Err("Agent masih sibuk".to_string());
    }
    if mode != "now" { return Err("Mode delivery terminal harus now".into()); }
    validate_message(message)?;
    session.terminal.as_ref().ok_or("Terminal belum dihubungkan")?.paste(message).await
}

fn prompt_echo(line: &str, provider: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let content = match provider {
        "codex" if value["type"] == "event_msg" && value["payload"]["type"] == "user_message" => &value["payload"]["message"],
        "claude" if value["type"] == "user" && value["message"]["role"] == "user" => &value["message"]["content"],
        "gemini" if value["type"] == "user" => value.get("content").or_else(|| value.get("parts"))?,
        _ => return None,
    };
    if let Some(text) = content.as_str() { return Some(text.into()); }
    let parts = content.as_array()?;
    if parts.iter().any(|part| part.get("text").and_then(|text| text.as_str()).is_none()) { return None; }
    Some(parts.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("\n"))
}

async fn send_tracked(registry: &SharedRegistry, sessions: &SharedManagedSessions, session: &ManagedSession, message: &str, status: &Status) -> Result<(), String> {
    let id = session.agent_id.as_deref().ok_or("Agent session belum terhubung")?;
    let before = registry.read().await.get(id).map(|agent| agent.last_activity);
    sessions.lock().map_err(|_| "Session manager terkunci")?.track_prompt(session, message);
    if let Err(error) = send_message(session, message, "now", status).await {
        if let Ok(mut manager) = sessions.lock() { manager.pending_prompts.remove(id); }
        return Err(error);
    }
    let mut reg = registry.write().await;
    // A fast provider may already have emitted its response. Don't overwrite it.
    let stamp = if reg.get(id).is_some_and(|agent| Some(agent.last_activity) == before) {
        reg.mark_prompt_sent(id, message)
    } else { None };
    drop(reg);
    if let Some(stamp) = stamp {
        let registry = registry.clone(); let id = id.to_string();
        tokio::spawn(async move {
            sleep(Duration::from_secs(120)).await;
            let mut reg = registry.write().await;
            if let Some(mut agent) = reg.get(&id) {
                if agent.last_activity == stamp {
                    agent.status = Status::Idle;
                    agent.current_activity = Some("Belum ada aktivitas log · periksa terminal".into());
                    reg.update_local(&id, agent);
                }
            }
        });
    }
    Ok(())
}

pub async fn attach_agent(agent: &AgentState, sessions: &SharedManagedSessions) -> Result<ManagedSession,String> {
    let existing=sessions.lock().map_err(|_|"Session manager terkunci")?.session_for_agent(&agent.id);
    if let Some(session)=existing {
        if session.state==ManagedSessionState::Running {
            if let Some(terminal)=&session.terminal { terminal.verify().await?; return Ok(session); }
        }
    }
    let name=agent.name.to_lowercase();
    let provider=["codex","claude","gemini"].into_iter().find(|p|name==*p||name.starts_with(&format!("{p}-"))).and_then(Provider::parse).ok_or("Provider ini belum menyediakan transport CLI")?;
    let terminal=terminal_control::discover(agent.pid.ok_or("Agent ini tidak mempunyai proses lokal")?,provider.executable()).await?;
    let mut manager=sessions.lock().map_err(|_|"Session manager terkunci")?;
    // Another concurrent capability request may have connected it already.
    if let Some(existing)=manager.session_for_agent(&agent.id) { if existing.state==ManagedSessionState::Running {return Ok(existing);} }
    Ok(manager.bind_terminal(agent,provider,terminal))
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ControlCapability {
    pub can_send: bool, pub reason: Option<String>, pub transport: Option<String>,
    pub control_mode: String, pub queued: bool, pub send_modes: Vec<&'static str>,
}

pub async fn control_capability(agent:&AgentState,sessions:&SharedManagedSessions)->ControlCapability {
    match attach_agent(agent,sessions).await {
        Ok(session)=>ControlCapability {can_send:true,reason:None,transport:session.terminal.as_ref().map(|t|t.transport().into()),control_mode:if session.attached {"attached"}else{"managed"}.into(),queued:session.queued_message.is_some(),send_modes:vec!["now","queue","interrupt"]},
        Err(reason)=>ControlCapability {can_send:false,reason:Some(reason),transport:None,control_mode:"attach_required".into(),queued:false,send_modes:vec![]},
    }
}

pub fn validate_message(message:&str)->Result<(),String> {
    if message.trim().is_empty()||message.len()>4000 {return Err("Prompt harus 1–4000 byte".into());}
    if message.chars().any(|c|c.is_control()&&c!='\n'&&c!='\t') {return Err("Prompt berisi terminal control character".into());}
    Ok(())
}

struct DeliveryGuard { sessions: SharedManagedSessions, id: String }
impl DeliveryGuard {
    fn acquire(sessions:&SharedManagedSessions,id:&str)->Result<Self,String> {
        if !sessions.lock().map_err(|_|"Session manager terkunci")?.sending.insert(id.into()) {return Err("Pengiriman agent masih berlangsung. Tunggu sebentar.".into());}
        Ok(Self {sessions:sessions.clone(),id:id.into()})
    }
}
impl Drop for DeliveryGuard {fn drop(&mut self){if let Ok(mut manager)=self.sessions.lock(){manager.sending.remove(&self.id);}}}

pub async fn dispatch_prompt(registry:&SharedRegistry,sessions:&SharedManagedSessions,activities:&SharedActivityStore,id:&str,message:&str,mode:&str)->Result<bool,String> {
    validate_message(message)?;
    if !matches!(mode,"now"|"queue"|"interrupt"){return Err("Mode harus now, queue, atau interrupt".into());}
    let _guard=DeliveryGuard::acquire(sessions,id)?;
    let mut agent=registry.read().await.get(id).ok_or("Agent tidak ditemukan")?;
    let session=attach_agent(&agent,sessions).await?;
    agent=registry.read().await.get(id).ok_or("Agent berhenti saat terminal dihubungkan")?;
    if mode=="queue" && !matches!(agent.status,Status::Idle|Status::TaskComplete) {
        sessions.lock().map_err(|_|"Session manager terkunci")?.queue_for_agent(id,message.into())?;
        if let Ok(mut store)=activities.lock(){store.append(id,&chrono::Utc::now().to_rfc3339(),agent.status,ActivityInput {kind:ActivityKind::Prompt,title:"Prompt menunggu task selesai".into(),detail:Some(message.into())});}
        return Ok(true);
    }
    if mode=="interrupt" && !matches!(agent.status,Status::Idle|Status::TaskComplete) {
        session.terminal.as_ref().ok_or("Terminal belum dihubungkan")?.key("ctrl+c").await?;
        // Wait for the actual log pipeline; do not paste into a CLI still cancelling.
        for _ in 0..25 {
            sleep(Duration::from_millis(200)).await;
            agent=registry.read().await.get(id).ok_or("Agent berhenti setelah interrupt")?;
            if matches!(agent.status,Status::Idle|Status::TaskComplete){break;}
        }
    }
    send_tracked(registry,sessions,&session,message,&agent.status).await?;
    let status=registry.read().await.get(id).map(|agent|agent.status).unwrap_or(agent.status);
    if let Ok(mut store)=activities.lock(){store.append(id,&chrono::Utc::now().to_rfc3339(),status,ActivityInput {kind:ActivityKind::Prompt,title:"Prompt dikirim ke terminal".into(),detail:Some(message.into())});}
    Ok(false)
}

pub async fn deliver_queued(session:ManagedSession,message:String,sessions:SharedManagedSessions,activities:SharedActivityStore,registry:SharedRegistry) {
    let id=session.agent_id.as_deref().unwrap_or_default();
    // take_queued_for_agent reserves delivery atomically; keep it reserved through restore.
    let _guard=DeliveryGuard { sessions:sessions.clone(), id:id.into() };
    let result=send_tracked(&registry,&sessions,&session,&message,&Status::TaskComplete).await;
    if let Err(error)=result {
        if let Ok(mut manager)=sessions.lock(){manager.restore_queued(id,message);}
        if let Ok(mut store)=activities.lock(){store.append(id,&chrono::Utc::now().to_rfc3339(),Status::Error,ActivityInput {kind:ActivityKind::Error,title:"Prompt antrean belum terkirim".into(),detail:Some(error)});}
    } else {
        let status=registry.read().await.get(id).map(|agent|agent.status).unwrap_or(Status::Thinking);
        if let Ok(mut store)=activities.lock(){store.append(id,&chrono::Utc::now().to_rfc3339(),status,ActivityInput {kind:ActivityKind::Prompt,title:"Prompt antrean dikirim".into(),detail:Some(message)});}
    }
}

pub fn workspace_id_for_path(path: &Path) -> String {
    path.file_name().and_then(|name| name.to_str()).unwrap_or("workspace").to_string()
}

fn workspace_info(path: &PathBuf) -> Option<WorkspaceInfo> {
    Some(WorkspaceInfo { id: workspace_id_for_path(path), label: path.file_name()?.to_string_lossy().to_string() })
}

pub(crate) fn find_executable(name: &str) -> Option<PathBuf> {
    let home = dirs::home_dir();
    let nvm = std::env::var_os("NVM_DIR").map(PathBuf::from)
        .or_else(|| home.as_ref().map(|path| path.join(".nvm")));
    let mut paths: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    if let Some(bin) = std::env::var_os("NVM_BIN") { paths.push(bin.into()); }
    find_in_paths(name, paths, home.as_deref(), nvm.as_deref())
}

fn find_in_paths(name: &str, mut paths: Vec<PathBuf>, home: Option<&Path>, nvm: Option<&Path>) -> Option<PathBuf> {
    if Path::new(name).components().count() != 1 { return None; }
    if let Some(home) = home {
        paths.extend([home.join(".local/bin"), home.join(".npm-global/bin")]);
    }
    // GUI launchers don't source shell profiles. Search only known NVM bin folders,
    // not a login shell (which would execute arbitrary startup scripts).
    if let Some(nvm) = nvm {
        let mut versions = Vec::new();
        if let Ok(entries) = std::fs::read_dir(nvm.join("versions/node")) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(version) = name.to_str().and_then(|name| name.strip_prefix('v')) else { continue; };
                let Ok(parts) = version.split('.').map(str::parse::<u32>).collect::<Result<Vec<_>, _>>() else { continue; };
                if parts.len() == 3 { versions.push((parts, entry.path().join("bin"))); }
            }
        }
        versions.sort_by(|a, b| b.0.cmp(&a.0));
        paths.extend(versions.into_iter().map(|(_, path)| path));
    }
    paths.into_iter().map(|dir| dir.join(name)).find(|path| path.is_file() && is_executable(path))
}

fn executable_path(executable: &Path) -> Result<std::ffi::OsString, String> {
    let mut paths = vec![executable.parent().ok_or("Folder CLI tidak valid")?.to_path_buf()];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
    std::env::join_paths(paths).map_err(|error| format!("PATH CLI tidak valid: {error}"))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().map(|meta| meta.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool { path.is_file() }

fn set_private(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn uuid_suffix() -> String {
    use rand::{rngs::OsRng, RngCore};
    let mut bytes = [0u8; 12];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn limit_message(message: &str) -> String { message.chars().take(4000).collect() }

pub fn shared_managed_sessions(workspaces: Vec<PathBuf>) -> SharedManagedSessions {
    Arc::new(Mutex::new(ManagedSessions::new(workspaces)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_echo_pins_the_selected_agent_not_the_other_pid_in_same_workspace() {
        let mut manager = ManagedSessions::default();
        let pending = |message: String| PendingPrompt {
            provider: "codex".into(), workspace: "/project".into(), message, sent_at: Instant::now(),
        };
        let message = format!("{} second agent", "same preview ".repeat(30));
        manager.pending_prompts.insert("pid-100".into(), pending(format!("{} first agent", "same preview ".repeat(30))));
        manager.pending_prompts.insert("pid-200".into(), pending(message.clone()));
        let echo = serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":message}}).to_string();
        assert!(manager.agent_for_log("session-b", &echo, Some("codex"), Some("/project-other")).is_none());
        assert!(manager.agent_for_log("session-b", &echo, Some("claude"), Some("/project")).is_none());
        assert_eq!(manager.agent_for_log("session-b", &echo, Some("codex"), Some("/project")), Some("pid-200".into()));
        let response = r#"{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}"#;
        assert_eq!(manager.agent_for_log("session-b", response, Some("codex"), Some("/project")), Some("pid-200".into()));
        assert!(manager.agent_for_log("unrelated-session", response, Some("codex"), Some("/project")).is_none());
        manager.mark_closed("pid-200");
        assert!(manager.agent_for_log("session-b", response, Some("codex"), Some("/project")).is_none());
        for id in ["pid-100", "pid-200"] { manager.pending_prompts.insert(id.into(), pending(message.clone())); }
        assert!(manager.agent_for_log("ambiguous-session", &echo, Some("codex"), None).is_none());
        manager.pending_prompts.clear();
        let mut expired = pending(message); expired.sent_at -= Duration::from_secs(301);
        manager.pending_prompts.insert("pid-200".into(), expired);
        assert!(manager.agent_for_log("expired-session", &echo, Some("codex"), None).is_none());
        assert_eq!(prompt_echo(r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#, "claude"), Some("hi".into()));
        assert_eq!(prompt_echo(r#"{"type":"user","parts":[{"text":"hi"}]}"#, "gemini"), Some("hi".into()));
    }

    #[cfg(unix)]
    #[test]
    fn gui_launcher_finds_nvm_cli_and_preserves_its_node_version() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let nvm = root.path().join(".nvm");
        for version in ["v9.0.0", "v22.23.2", "v23.11.1"] {
            let bin = nvm.join("versions/node").join(version).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            let cli = bin.join("codex");
            std::fs::write(&cli, "#!/usr/bin/env node\n").unwrap();
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(if version == "v23.11.1" { 0o644 } else { 0o755 })).unwrap();
        }
        let expected = nvm.join("versions/node/v22.23.2/bin/codex");
        let found = find_in_paths("codex", vec![], Some(root.path()), Some(&nvm)).unwrap();
        assert_eq!(found, expected);
        assert_eq!(std::env::split_paths(&executable_path(&found).unwrap()).next().unwrap(), found.parent().unwrap());
        let path_cli = nvm.join("versions/node/v9.0.0/bin/codex");
        assert_eq!(find_in_paths("codex", vec![path_cli.parent().unwrap().into()], None, Some(&nvm)), Some(path_cli));
        assert!(find_in_paths("../codex", vec![], None, Some(&nvm)).is_none());
        assert!(find_in_paths("missing", vec![], None, Some(&nvm)).is_none());
    }

    #[tokio::test]
    async fn failed_queue_delivery_preserves_prompt_and_reserves_slot() {
        let sessions=shared_managed_sessions(vec![]);
        let session=ManagedSession {
            session_id:"test".into(), agent_id:Some("agent".into()), provider:Provider::Codex,
            workspace_id:"test".into(), workspace_label:"test".into(), kitty_pid:None,
            kitty_window_id:None, cli_pid:None, socket_path:PathBuf::new(),
            state:ManagedSessionState::Running, queued_message:Some("original prompt".into()),
            terminal:None, attached:true,
        };
        sessions.lock().unwrap().sessions.insert("test".into(),session);
        let (session,prompt)=sessions.lock().unwrap().take_queued_for_agent("agent").unwrap();
        assert!(DeliveryGuard::acquire(&sessions,"agent").is_err());
        deliver_queued(session,prompt,sessions.clone(),crate::activity::shared_activity_store(),crate::discovery::agent_registry::new_shared_registry()).await;
        assert_eq!(sessions.lock().unwrap().session_for_agent("agent").unwrap().queued_message.as_deref(),Some("original prompt"));
        assert!(DeliveryGuard::acquire(&sessions,"agent").is_ok());
    }

    #[test]
    fn prompt_boundary_rejects_terminal_controls_and_counts_utf8_bytes() {
        for message in ["", "  ", "\u{1b}[2J", "\u{3}", "bad\rinput"] {assert!(validate_message(message).is_err());}
        assert!(validate_message("line one\n\tline two").is_ok());
        assert!(validate_message(&"é".repeat(2000)).is_ok());
        assert!(validate_message(&"é".repeat(2001)).is_err());
    }
}
