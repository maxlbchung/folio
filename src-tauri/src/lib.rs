use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// The agent broker child (agent/broker.mjs under the user's Node), spawned on
/// demand when the Agent panel connects. Protocol lines flow stdin/stdout; the
/// broker exits by itself when its stdin closes, so it can never outlive the app.
struct AgentBroker {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

impl AgentBroker {
    fn kill(&self) {
        // Dropping stdin is the graceful shutdown signal; kill covers a hung child.
        self.stdin.lock().unwrap().take();
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

/// Locates agent/broker.mjs near the executable (the portable exe sits at the
/// repo root; dev builds sit under src-tauri/target/*), or via INKTILE_AGENT_DIR.
fn find_broker_script() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("INKTILE_AGENT_DIR") {
        let candidate = PathBuf::from(dir).join("broker.mjs");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        let mut dir: Option<&std::path::Path> = Some(root.as_path());
        for _ in 0..6 {
            let Some(current) = dir else { break };
            let candidate = current.join("agent").join("broker.mjs");
            if candidate.exists() {
                return Some(candidate);
            }
            dir = current.parent();
        }
    }
    None
}

fn node_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("INKTILE_NODE_PATH") {
        candidates.push(PathBuf::from(path));
    }
    // The bare name resolves through PATH at spawn time.
    candidates.push(PathBuf::from("node"));
    if cfg!(windows) {
        candidates.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
    } else {
        candidates.push(PathBuf::from("/usr/local/bin/node"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
    }
    candidates
}

fn spawn_broker(node: &PathBuf, script: &PathBuf) -> std::io::Result<Child> {
    let mut command = Command::new(node);
    command
        .arg(script)
        .current_dir(script.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

/// Starts the broker if it is not already running. Idempotent: a live child is
/// reused, so agent sessions survive panel remounts.
#[tauri::command]
fn agent_start(app: AppHandle, state: State<'_, AgentBroker>) -> Result<(), String> {
    let mut child_guard = state.child.lock().unwrap();
    if let Some(child) = child_guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return Ok(()),
            _ => {
                *child_guard = None;
                state.stdin.lock().unwrap().take();
            }
        }
    }

    let script = find_broker_script()
        .ok_or("The agent files were not found (agent/broker.mjs next to the app).")?;
    let mut spawned = None;
    let mut last_error = String::new();
    for node in node_candidates() {
        match spawn_broker(&node, &script) {
            Ok(child) => {
                spawned = Some(child);
                break;
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    let mut child = spawned.ok_or(format!(
        "Node.js was not found — the agent needs Node installed and on PATH. ({last_error})"
    ))?;

    let stdout = child.stdout.take().ok_or("The broker has no stdout.")?;
    let stderr = child.stderr.take().ok_or("The broker has no stderr.")?;
    *state.stdin.lock().unwrap() = child.stdin.take();
    *child_guard = Some(child);

    let emitter = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = emitter.emit("agent-broker-message", line);
        }
        let _ = emitter.emit("agent-broker-exit", ());
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("{line}");
        }
    });
    Ok(())
}

/// Forwards one protocol line to the broker's stdin.
#[tauri::command]
fn agent_send(state: State<'_, AgentBroker>, line: String) -> Result<(), String> {
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("The agent broker is not running.")?;
    writeln!(stdin, "{line}")
        .and_then(|_| stdin.flush())
        .map_err(|error| {
            guard.take();
            error.to_string()
        })
}

#[tauri::command]
fn agent_stop(state: State<'_, AgentBroker>) {
    state.kill();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AgentBroker {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![agent_start, agent_send, agent_stop])
        .build(tauri::generate_context!())
        .expect("error while running Inktile")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(broker) = app.try_state::<AgentBroker>() {
                    broker.kill();
                }
            }
        });
}
