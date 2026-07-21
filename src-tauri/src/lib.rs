use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
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

/// Open Graph metadata for the link popup's preview card. Fetched natively because the
/// webview cannot read cross-origin HTML (CORS) — the shell unfurls links the same way
/// chat apps' servers do.
#[derive(Default, serde::Serialize)]
struct LinkMetadata {
    title: Option<String>,
    description: Option<String>,
    image: Option<String>,
}

/// og: tags live in <head>; half a megabyte is generous headroom before giving up.
const METADATA_HTML_CAP: u64 = 512 * 1024;

/// Value of `name="value"` (or single-quoted) inside one tag snippet, case-insensitive.
fn html_attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let at = from + found;
        from = at + name.len();
        let starts_attr = at > 0 && bytes[at - 1].is_ascii_whitespace();
        if !starts_attr {
            continue;
        }
        let mut cursor = at + name.len();
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'=') {
            continue;
        }
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let quote = *bytes.get(cursor)?;
        if quote != b'"' && quote != b'\'' {
            continue;
        }
        let value_start = cursor + 1;
        let end = lower[value_start..].find(quote as char)? + value_start;
        return Some(tag[value_start..end].to_string());
    }
    None
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn clamp_chars(value: String, max: usize) -> String {
    if value.chars().count() <= max {
        value
    } else {
        let mut clamped: String = value.chars().take(max).collect();
        clamped.push('…');
        clamped
    }
}

fn parse_link_metadata(html: &str, base: &str) -> LinkMetadata {
    let lower = html.to_ascii_lowercase();
    let mut meta = LinkMetadata::default();
    let mut position = 0;
    while let Some(found) = lower[position..].find("<meta") {
        let start = position + found;
        let end = lower[start..].find('>').map_or(lower.len(), |offset| start + offset);
        let tag = &html[start..end];
        position = end;
        let Some(content) = html_attr(tag, "content") else { continue };
        // Sites use property= (Open Graph) or name= (Twitter cards, description).
        let Some(key) = html_attr(tag, "property").or_else(|| html_attr(tag, "name")) else { continue };
        let value = decode_entities(content.trim());
        if value.is_empty() {
            continue;
        }
        match key.to_ascii_lowercase().as_str() {
            "og:title" | "twitter:title" => {
                if meta.title.is_none() {
                    meta.title = Some(value);
                }
            }
            "og:description" | "twitter:description" | "description" => {
                if meta.description.is_none() {
                    meta.description = Some(value);
                }
            }
            "og:image" | "og:image:url" | "og:image:secure_url" | "twitter:image" | "twitter:image:src" => {
                if meta.image.is_none() {
                    meta.image = Some(value);
                }
            }
            _ => {}
        }
    }
    if meta.title.is_none() {
        if let Some(open) = lower.find("<title") {
            if let Some(after) = lower[open..].find('>') {
                let text_start = open + after + 1;
                if let Some(close) = lower[text_start..].find("</title") {
                    let title = decode_entities(html[text_start..text_start + close].trim());
                    if !title.is_empty() {
                        meta.title = Some(title);
                    }
                }
            }
        }
    }
    // Absolutize the image against the final (post-redirect) URL; only http(s) survives.
    if let Some(image) = meta.image.take() {
        if let Ok(base_url) = tauri::Url::parse(base) {
            if let Ok(resolved) = base_url.join(image.trim()) {
                if resolved.scheme() == "http" || resolved.scheme() == "https" {
                    meta.image = Some(resolved.to_string());
                }
            }
        }
    }
    meta.title = meta.title.take().map(|title| clamp_chars(title, 200));
    meta.description = meta.description.take().map(|description| clamp_chars(description, 400));
    meta
}

fn fetch_link_metadata_blocking(url: &str) -> LinkMetadata {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return LinkMetadata::default();
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(8))
        .redirects(4)
        .build();
    let Ok(response) = agent
        .get(url)
        .set("User-Agent", "Mozilla/5.0 (compatible; Inktile/0.1; link-preview)")
        .set("Accept", "text/html,application/xhtml+xml")
        .call()
    else {
        return LinkMetadata::default();
    };
    let content_type = response.content_type().to_ascii_lowercase();
    if content_type != "text/html" && content_type != "application/xhtml+xml" {
        return LinkMetadata::default();
    }
    let final_url = response.get_url().to_string();
    let mut bytes = Vec::new();
    use std::io::Read;
    let _ = response
        .into_reader()
        .take(METADATA_HTML_CAP)
        .read_to_end(&mut bytes);
    parse_link_metadata(&String::from_utf8_lossy(&bytes), &final_url)
}

/// Fetch a page's Open Graph card for the link popup. Never fails: any problem (network,
/// non-HTML content, parse) returns an empty card and the popup falls back to its embed.
#[tauri::command]
async fn fetch_link_metadata(url: String) -> LinkMetadata {
    tauri::async_runtime::spawn_blocking(move || fetch_link_metadata_blocking(&url))
        .await
        .unwrap_or_default()
}

/// Writes bytes to a `.tmp` sibling, flushes to disk, and renames it over `path`, so a
/// crash mid-write can never leave a truncated archive (std rename replaces existing
/// files on both Windows and Unix). Creates missing parent directories.
fn write_file_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp_path = PathBuf::from(tmp_name);
    let result = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp_path, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
}

/// Atomically saves a document at a user-chosen path. Lives here rather than on the fs
/// plugin because the plugin's scope only ever covers the exact dialog-picked path — its
/// `.tmp` sibling would be rejected as a forbidden path. The payload arrives as the raw
/// request body; the destination rides in the percent-encoded `x-inktile-path` header
/// (header values must be ASCII, titles need not be).
#[tauri::command]
async fn save_file_atomic(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file_atomic expects a raw byte payload".into());
    };
    let encoded_path = request
        .headers()
        .get("x-inktile-path")
        .ok_or("save_file_atomic requires the x-inktile-path header")?
        .to_str()
        .map_err(|error| error.to_string())?;
    let path = PathBuf::from(
        percent_encoding::percent_decode_str(encoded_path)
            .decode_utf8()
            .map_err(|error| error.to_string())?
            .as_ref(),
    );
    if !path.is_absolute() {
        return Err(format!("refusing to save to a relative path: {}", path.display()));
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || write_file_atomic(&path, &bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("The file could not be saved: {error}"))
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
        .invoke_handler(tauri::generate_handler![
            agent_start,
            agent_send,
            agent_stop,
            fetch_link_metadata,
            save_file_atomic
        ])
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
