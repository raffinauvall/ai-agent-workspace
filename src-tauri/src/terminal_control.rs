//! Attach only to a verified foreground CLI in an exact Kitty window or tmux pane.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

#[derive(Clone, Debug)]
pub enum TerminalTarget {
    Kitty { address: String, window_id: u64 },
    Tmux { socket: PathBuf, pane_id: String },
}

#[derive(Clone, Debug)]
pub struct TerminalSession {
    pub pid: u32,
    pub start_time: u64,
    pub workspace: PathBuf,
    pub provider: String,
    pub target: TerminalTarget,
}

#[derive(Debug)]
struct Process {
    parent: u32,
    group: i32,
    foreground: i32,
    start_time: u64,
}

fn parse_stat(stat: &str) -> Result<Process, String> {
    // comm may contain spaces and parentheses; fields start after its final ')'.
    let fields: Vec<_> = stat.rsplit_once(')').ok_or("Process stat tidak valid")?.1.split_whitespace().collect();
    let field = |i: usize| fields.get(i).ok_or("Process stat tidak lengkap");
    Ok(Process {
        parent: field(1)?.parse().map_err(|_| "Parent PID tidak valid")?,
        group: field(2)?.parse().map_err(|_| "Process group tidak valid")?,
        foreground: field(5)?.parse().map_err(|_| "Foreground group tidak valid")?,
        start_time: field(19)?.parse().map_err(|_| "Process identity tidak valid")?,
    })
}

fn process(pid: u32) -> Result<Process, String> {
    parse_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|_| "Agent sudah berhenti. Refresh daftar agent.")?)
}

fn descendant(mut pid: u32, parent: u32) -> bool {
    for _ in 0..64 {
        if pid == parent { return true; }
        let Ok(info) = process(pid) else { return false; };
        if info.parent == 0 || info.parent == pid { return false; }
        pid = info.parent;
    }
    false
}

fn env_value<'a>(env: &'a [u8], name: &str) -> Option<&'a str> {
    env.split(|byte| *byte == 0).find_map(|entry| {
        let (key, value) = std::str::from_utf8(entry).ok()?.split_once('=')?;
        (key == name).then_some(value)
    })
}

fn provider_matches(cmdline: &[u8], provider: &str) -> bool {
    cmdline.split(|byte| *byte == 0).take(2).any(|arg| {
        let Ok(arg) = std::str::from_utf8(arg) else { return false; };
        Path::new(arg).file_stem().is_some_and(|name| name == provider)
            || (provider == "claude" && arg.ends_with("/@anthropic-ai/claude-code/cli.js"))
            || (provider == "gemini" && arg.ends_with("/@google/gemini-cli/dist/index.js"))
    })
}

fn tmux_address(value: &str, pane: &str) -> Result<TerminalTarget, String> {
    if !pane.starts_with('%') || pane.len() < 2 || !pane[1..].bytes().all(|b| b.is_ascii_digit()) {
        return Err("Pane tmux tidak valid".into());
    }
    let mut parts = value.rsplitn(3, ',');
    let _session = parts.next().ok_or("Session tmux tidak valid")?;
    let _server = parts.next().ok_or("Server tmux tidak valid")?;
    let socket = parts.next().ok_or("Socket tmux tidak valid")?;
    if !Path::new(socket).is_absolute() { return Err("Socket tmux harus Unix path absolut".into()); }
    Ok(TerminalTarget::Tmux { socket: PathBuf::from(socket), pane_id: pane.to_string() })
}

pub async fn discover(pid: u32, provider: &str) -> Result<TerminalSession, String> {
    if !cfg!(target_os = "linux") { return Err("Attach terminal saat ini tersedia di Linux".into()); }
    let info = process(pid)?;
    let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).map_err(|_| "Identitas agent tidak terbaca")?;
    if !provider_matches(&cmdline, provider) { return Err("Proses ini bukan CLI provider yang dipilih".into()); }
    let workspace = std::fs::read_link(format!("/proc/{pid}/cwd")).and_then(|p| p.canonicalize()).map_err(|_| "Workspace agent tidak terbaca")?;
    let env = std::fs::read(format!("/proc/{pid}/environ")).map_err(|_| "Environment terminal tidak terbaca")?;
    // A nested tmux pane takes priority over the outer Kitty window.
    let target = if let (Some(tmux), Some(pane)) = (env_value(&env,"TMUX"), env_value(&env,"TMUX_PANE")) {
        tmux_address(tmux,pane)?
    } else if let (Some(address), Some(window)) = (env_value(&env,"KITTY_LISTEN_ON"), env_value(&env,"KITTY_WINDOW_ID")) {
        if !address.starts_with("unix:/") { return Err("Kitty perlu socket Unix: aktifkan listen_on dan allow_remote_control socket-only".into()); }
        TerminalTarget::Kitty { address: address.into(), window_id: window.parse().map_err(|_| "Window Kitty tidak valid")? }
    } else {
        return Err("Hubungkan terminal: agent harus berjalan di Kitty dengan Unix remote-control socket, atau di dalam tmux. Percakapan yang aktif tidak bisa ditulis hanya dari PID.".into());
    };
    let session = TerminalSession { pid, start_time: info.start_time, workspace, provider: provider.into(), target };
    session.verify().await?;
    Ok(session)
}

impl TerminalSession {
    pub fn transport(&self) -> &'static str { match self.target { TerminalTarget::Kitty {..} => "Kitty", TerminalTarget::Tmux {..} => "tmux" } }

    pub async fn verify(&self) -> Result<(), String> {
        let info = process(self.pid)?;
        if info.start_time != self.start_time { return Err("Identitas proses berubah. Hubungkan agent kembali.".into()); }
        if info.foreground <= 0 || info.foreground != info.group { return Err("Agent bukan proses foreground. Kembalikan agent ke depan di terminal.".into()); }
        let cwd = std::fs::read_link(format!("/proc/{}/cwd",self.pid)).and_then(|p|p.canonicalize()).map_err(|_|"Workspace sudah hilang")?;
        let cmd = std::fs::read(format!("/proc/{}/cmdline",self.pid)).map_err(|_|"Agent sudah berhenti")?;
        if cwd != self.workspace || !provider_matches(&cmd, &self.provider) { return Err("Provider atau workspace berubah. Hubungkan ulang agent.".into()); }
        let socket = match &self.target { TerminalTarget::Kitty { address,.. } => Path::new(address.trim_start_matches("unix:")), TerminalTarget::Tmux { socket,.. }=>socket.as_path() };
        verify_socket(socket,self.pid)?;
        match &self.target {
            TerminalTarget::Kitty { address, window_id } => {
                let output = run("kitten", &["@","--to",address,"ls"],None).await?;
                let tree: serde_json::Value = serde_json::from_slice(&output).map_err(|_|"Daftar window Kitty tidak valid")?;
                if !kitty_window_matches(&tree,*window_id,self.pid) { return Err("Window Kitty tidak lagi menjalankan agent ini. Prompt tidak dikirim.".into()); }
            }
            TerminalTarget::Tmux { socket,pane_id } => {
                let socket=socket.to_string_lossy();
                let output=run("tmux", &["-S",&socket,"display-message","-p","-t",pane_id,"#{pane_pid}\t#{pane_dead}\t#{pane_in_mode}"],None).await?;
                let text=String::from_utf8_lossy(&output);
                let fields: Vec<_>=text.trim().split('\t').collect();
                let parent=fields.first().and_then(|v|v.parse().ok()).ok_or("Pane tmux tidak valid")?;
                if fields.get(1)!=Some(&"0") || fields.get(2)!=Some(&"0") || !descendant(self.pid,parent) { return Err("Pane tmux sudah berubah atau sedang copy-mode. Kembali ke agent sebelum mengirim.".into()); }
            }
        }
        // Re-read identity after the external query, before allowing a write.
        if process(self.pid)?.start_time != self.start_time { return Err("Agent sudah berubah".into()); }
        Ok(())
    }

    pub async fn key(&self, key: &str) -> Result<(), String> {
        self.verify().await?;
        match &self.target {
            TerminalTarget::Kitty {address,window_id} => {
                run("kitten", &["@","--to",address,"send-key","--match",&format!("id:{window_id}"),key],None).await?;
            }
            TerminalTarget::Tmux {socket,pane_id} => {
                run("tmux", &["-S",&socket.to_string_lossy(),"send-keys","-t",pane_id,if key=="ctrl+c" {"C-c"} else {"Enter"}],None).await?;
            }
        }
        Ok(())
    }

    pub async fn paste(&self, message: &str) -> Result<(), String> {
        self.verify().await?;
        match &self.target {
            TerminalTarget::Kitty {address,window_id} => {
                run("kitten", &["@","--to",address,"send-text","--match",&format!("id:{window_id}"),"--bracketed-paste","enable","--stdin"],Some(message)).await?;
            }
            TerminalTarget::Tmux {socket,pane_id} => {
                let name=format!("officeai-{}-{:016x}",self.pid,rand::random::<u64>());
                let socket=socket.to_string_lossy();
                run("tmux", &["-S",&socket,"load-buffer","-b",&name,"-"],Some(message)).await?;
                let result=run("tmux", &["-S",&socket,"paste-buffer","-d","-p","-r","-b",&name,"-t",pane_id],None).await;
                if result.is_err() { let _=run("tmux", &["-S",&socket,"delete-buffer","-b",&name],None).await; }
                result?;
            }
        }
        self.key("enter").await
    }
}

fn kitty_window_matches(tree:&serde_json::Value,window:u64,pid:u32)->bool {
    tree.as_array().into_iter().flatten().flat_map(|os|os["tabs"].as_array().into_iter().flatten())
        .flat_map(|tab|tab["windows"].as_array().into_iter().flatten())
        .any(|w|w["id"].as_u64()==Some(window) && w["foreground_processes"].as_array().is_some_and(|processes|processes.iter().any(|p| {
            p["pid"].as_u64().is_some_and(|foreground| descendant(pid,foreground as u32)||descendant(foreground as u32,pid))
        })))
}

fn verify_socket(path:&Path,pid:u32)->Result<(),String> {
    #[cfg(unix)] {
        use std::os::unix::fs::{FileTypeExt,MetadataExt};
        let meta=path.metadata().map_err(|_|"Socket terminal sudah tertutup")?;
        let owner=std::fs::metadata(format!("/proc/{pid}")).map_err(|_|"Agent sudah berhenti")?.uid();
        if !meta.file_type().is_socket() || meta.uid()!=owner {return Err("Socket terminal bukan milik user agent".into());}
    }
    Ok(())
}

async fn run(executable:&str,args:&[&str],input:Option<&str>)->Result<Vec<u8>,String> {
    let executable=crate::managed_sessions::find_executable(executable).ok_or_else(||format!("{executable} tidak terpasang"))?;
    let mut command=Command::new(executable);
    command.args(args).kill_on_drop(true).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.stdin(if input.is_some(){Stdio::piped()}else{Stdio::null()});
    let output=timeout(Duration::from_secs(4),async {
        let mut child=command.spawn().map_err(|e|e.to_string())?;
        if let Some(input)=input { let mut stdin=child.stdin.take().ok_or("stdin terminal tidak tersedia")?; stdin.write_all(input.as_bytes()).await.map_err(|e|e.to_string())?; drop(stdin); }
        child.wait_with_output().await.map_err(|e|e.to_string())
    }).await.map_err(|_|"Terminal tidak merespons dalam 4 detik")??;
    if !output.status.success() {return Err("Terminal menolak kontrol. Periksa remote control Kitty atau session tmux.".into());}
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn stat_handles_spaces_and_parentheses() {
        let info=parse_stat("17 (agent (cli)) S 12 17 10 34816 17 0 0 0 0 0 0 0 0 0 20 0 1 0 9876 0").unwrap();
        assert_eq!((info.parent,info.group,info.foreground,info.start_time),(12,17,17,9876));
        assert!(parse_stat("bad").is_err());
    }
    #[test] fn provider_is_an_executable_not_prompt_text() {
        assert!(provider_matches(b"/usr/bin/node\0/app/claude.js\0","claude"));
        assert!(provider_matches(b"/usr/bin/codex\0","codex"));
        assert!(!provider_matches(b"/bin/bash\0-c\0codex\0","codex"));
        assert!(provider_matches(b"node\0/app/node_modules/@anthropic-ai/claude-code/cli.js\0", "claude"));
        assert!(!provider_matches(b"node\0/app/cli.js\0claude\0", "claude"));
    }
    #[test] fn tmux_validates_target_and_preserves_commas_in_path() {
        assert!(tmux_address("/tmp/a,b,9,0","%2").is_ok());
        assert!(tmux_address("/tmp/a,9,0","%2; kill").is_err());
        assert!(tmux_address("a,9,0","%2").is_err());
    }
    #[test] fn kitty_requires_exact_window_and_foreground() {
        let pid=std::process::id();
        let tree=serde_json::json!([{"tabs":[{"windows":[{"id":7,"foreground_processes":[{"pid":pid}]}]}]}]);
        assert!(kitty_window_matches(&tree,7,pid));
        assert!(!kitty_window_matches(&tree,8,pid));
        assert!(!kitty_window_matches(&serde_json::json!([]),7,pid));
    }

    #[tokio::test]
    #[ignore = "requires a graphical session and Kitty; uses an isolated fake CLI only"]
    async fn kitty_delivers_literal_prompt_only_to_verified_window() {
        use tokio::time::sleep;
        let dir=std::env::temp_dir().join(format!("officeai-control-test.{:016x}",rand::random::<u64>()));
        std::fs::create_dir(&dir).unwrap();
        let address=format!("unix:{}/kitty.sock",dir.display());
        struct Cleanup {dir:PathBuf,address:String, windows:Vec<u64>}
        impl Drop for Cleanup {fn drop(&mut self) {
            for id in &self.windows {
                let _=std::process::Command::new("kitten").args(["@","--to",&self.address,"close-window","--match",&format!("id:{id}")]).output();
            }
            let _=std::fs::remove_dir_all(&self.dir);
        }}
        let mut cleanup=Cleanup{dir:dir.clone(),address:address.clone(),windows:vec![]};
        let node=crate::managed_sessions::find_executable("node").unwrap();
        let script=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("scripts/terminal-control-fixture.mjs");
        let first=dir.join("first.json"); let second=dir.join("second.json");
        std::process::Command::new("kitty").args(["--detach","--title","OfficeAI isolated control check","--listen-on",&address,"--override","allow_remote_control=socket-only","--working-directory"])
            .arg(&dir).args(["bash","-c","exec -a codex \"$1\" \"$2\" \"$3\"","fixture"]).arg(&node).arg(&script).arg(&first).status().unwrap();
        async fn snapshot(path:&Path)->serde_json::Value {
            for _ in 0..100 { if let Ok(bytes)=std::fs::read(path){if let Ok(value)=serde_json::from_slice(&bytes){return value;}} sleep(Duration::from_millis(100)).await; }
            panic!("fixture did not start");
        }
        let pid=snapshot(&first).await["pid"].as_u64().unwrap() as u32;
        let terminal=discover(pid,"codex").await.unwrap();
        if let TerminalTarget::Kitty {window_id,..}=terminal.target {cleanup.windows.push(window_id);}
        // Focus a different window on the same server: delivery must still target the first.
        let second_window=run("kitten", &["@","--to",&address,"launch","--type","tab","--cwd",&dir.to_string_lossy(),"bash","-c","exec -a codex \"$1\" \"$2\" \"$3\"","fixture",&node.to_string_lossy(),&script.to_string_lossy(),&second.to_string_lossy()],None).await.unwrap();
        cleanup.windows.push(String::from_utf8(second_window).unwrap().trim().parse().unwrap());
        snapshot(&second).await;
        let message="literal $(do-not-execute); `also literal`\nsecond line";
        terminal.paste(message).await.unwrap();
        sleep(Duration::from_millis(300)).await;
        assert_eq!(snapshot(&first).await["events"][0]["message"],message);
        assert_eq!(snapshot(&second).await["events"].as_array().unwrap().len(),0);
        let mut stale=terminal.clone(); stale.start_time+=1;
        assert!(stale.paste("must not arrive").await.is_err());
        let mut wrong=terminal.clone(); if let TerminalTarget::Kitty {window_id,..}=&mut wrong.target {*window_id=u64::MAX;}
        assert!(wrong.paste("wrong window").await.is_err());
        terminal.key("ctrl+c").await.unwrap();
        sleep(Duration::from_millis(200)).await;
        assert_eq!(snapshot(&first).await["events"][1]["kind"],"interrupt");
    }
}
