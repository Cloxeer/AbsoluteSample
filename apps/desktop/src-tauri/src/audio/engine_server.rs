//! Resident Python engine server (contract v11 addendum "Python engine
//! server"): one long-lived `separate.py --serve` child that keeps models
//! loaded between jobs. Requests are JSON lines on its stdin; replies are
//! JSON lines on stdout, routed back to the waiting caller by `"id"`.
//!
//! This type does NOT take the global engine gate itself (so it can be
//! tested in isolation); callers hold `engine::acquire_engine` around every
//! job and around load/offload.

use super::silent_command;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Reply events that end a request (the route is dropped after them).
const TERMINAL: &[&str] = &["done", "error", "loaded", "unloaded", "status", "bye"];
/// Importing torch + audio-separator on a cold disk can take a while.
const READY_TIMEOUT: Duration = Duration::from_secs(180);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
const STDERR_TAIL: usize = 40;

/// `engine_models_status()` result (contract v11 "Rust (Tauri) additions").
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelsStatus {
    /// Models are resident in a running server process.
    pub loaded: bool,
    /// A `engine_keep_loaded` is starting the server / loading models.
    pub loading: bool,
    /// The user asked to keep models loaded between jobs.
    pub kept: bool,
    pub models: Vec<String>,
    /// Server-reported VRAM while loaded; after an offload, the GPU's total
    /// used memory from nvidia-smi (None without an NVIDIA GPU).
    pub vram_mb: Option<u64>,
}

/// Payload of the `engine://models` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsEvent {
    #[serde(flatten)]
    pub status: ModelsStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// How to spawn the server process.
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

type Launcher = Box<dyn Fn(bool) -> Result<Launch, String> + Send + Sync>;
type Listener = Box<dyn Fn(&ModelsEvent) + Send + Sync>;
/// `None` once the reader hit EOF (process gone): new requests must fail
/// instead of waiting forever.
type Routes = Arc<Mutex<Option<HashMap<String, Sender<Value>>>>>;

struct Running {
    child: Child,
    stdin: ChildStdin,
    routes: Routes,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    threads: Vec<JoinHandle<()>>,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    kept: bool,
    loading: bool,
    models: Vec<String>,
    vram_mb: Option<u64>,
}

pub struct EngineServer {
    launcher: Launcher,
    state: Mutex<State>,
    next_id: AtomicU64,
    listener: Mutex<Option<Listener>>,
}

/// The app-wide server running the embedded `separate.py --serve`.
pub fn global() -> &'static EngineServer {
    static SERVER: OnceLock<EngineServer> = OnceLock::new();
    SERVER.get_or_init(|| {
        EngineServer::new(Box::new(|low_priority| {
            let (python, script, models) = super::engine::prepare_script()?;
            let mut args: Vec<OsString> = vec![
                script.into(),
                "--serve".into(),
                "--models-dir".into(),
                models.into(),
                "--device".into(),
                "auto".into(),
            ];
            if low_priority {
                args.push("--low-priority".into());
            }
            Ok(Launch { program: python, args })
        }))
    })
}

fn tail_text(tail: &Mutex<VecDeque<String>>) -> String {
    let lines: Vec<String> = tail.lock().map(|t| t.iter().cloned().collect()).unwrap_or_default();
    if lines.is_empty() {
        String::new()
    } else {
        format!("\n--- stderr tail ---\n{}", lines.join("\n"))
    }
}

fn event_name(v: &Value) -> &str {
    v.get("event").and_then(|e| e.as_str()).unwrap_or("")
}

impl EngineServer {
    /// `launcher(low_priority)` describes the process to spawn.
    pub fn new(launcher: Launcher) -> Self {
        EngineServer {
            launcher,
            state: Mutex::new(State::default()),
            next_id: AtomicU64::new(1),
            listener: Mutex::new(None),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Registers the `engine://models` sink (the Tauri app emits it).
    pub fn set_listener(&self, f: impl Fn(&ModelsEvent) + Send + Sync + 'static) {
        *self.listener.lock().unwrap_or_else(|p| p.into_inner()) = Some(Box::new(f));
    }

    fn notify(&self, reason: Option<String>) {
        let event = ModelsEvent { status: self.status(), reason };
        if let Some(f) = self.listener.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            f(&event);
        }
    }

    pub fn status(&self) -> ModelsStatus {
        let s = self.lock();
        ModelsStatus {
            loaded: s.running.is_some() && !s.models.is_empty(),
            loading: s.loading,
            kept: s.kept,
            models: s.models.clone(),
            vram_mb: s.vram_mb,
        }
    }

    pub fn is_kept(&self) -> bool {
        self.lock().kept
    }

    /// Whether a server process is currently running (test/diagnostics).
    pub fn child_pid(&self) -> Option<u32> {
        self.lock().running.as_ref().map(|r| r.child.id())
    }

    /// Spawns the server if it isn't running and waits for its `ready`
    /// line. Returns the device it reported.
    pub fn ensure_started(&self, low_priority: bool) -> Result<(), String> {
        {
            let mut s = self.lock();
            if let Some(r) = s.running.as_mut() {
                if matches!(r.child.try_wait(), Ok(None)) {
                    return Ok(());
                }
            }
        }
        // A dead leftover (exited on its own): reap it first.
        self.reap();

        let launch = (self.launcher)(low_priority)?;
        let mut cmd = silent_command(&launch.program.to_string_lossy());
        cmd.args(&launch.args)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        if low_priority {
            use std::os::windows::process::CommandExt;
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
            cmd.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | super::CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("failed to spawn engine server: {e}"))?;
        let stdin = child.stdin.take().ok_or("engine server has no stdin")?;
        let stdout = child.stdout.take().ok_or("engine server has no stdout")?;
        let stderr = child.stderr.take().ok_or("engine server has no stderr")?;

        let (ready_tx, ready_rx) = mpsc::channel();
        let routes: Routes = Arc::new(Mutex::new(Some(HashMap::from([(String::new(), ready_tx)]))));
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));

        let tail = stderr_tail.clone();
        let err_thread = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut t) = tail.lock() {
                    if t.len() >= STDERR_TAIL {
                        t.pop_front();
                    }
                    t.push_back(line);
                }
            }
        });

        let reader_routes = routes.clone();
        let tail = stderr_tail.clone();
        let out_thread = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                if event_name(&value) == "fatal" {
                    if let Ok(mut t) = tail.lock() {
                        t.push_back(format!("fatal: {}", value.get("error").and_then(|e| e.as_str()).unwrap_or("")));
                    }
                }
                let id = value.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                let terminal = TERMINAL.contains(&event_name(&value));
                let mut guard = reader_routes.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(map) = guard.as_mut() {
                    if let Some(tx) = map.get(&id) {
                        let _ = tx.send(value);
                        if terminal && !id.is_empty() {
                            map.remove(&id);
                        }
                    }
                }
            }
            // EOF: the process is gone. Dropping every sender wakes all
            // waiting jobs with a disconnect.
            *reader_routes.lock().unwrap_or_else(|p| p.into_inner()) = None;
        });

        let mut running = Running { child, stdin, routes, stderr_tail, threads: vec![out_thread, err_thread] };
        let deadline = Instant::now() + READY_TIMEOUT;
        let outcome = loop {
            match ready_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(v) if event_name(&v) == "ready" => break Ok(()),
                Ok(v) if event_name(&v) == "fatal" => {
                    break Err(format!(
                        "engine server failed to start: {}",
                        v.get("error").and_then(|e| e.as_str()).unwrap_or("")
                    ))
                }
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => break Err("engine server did not become ready in time".to_string()),
                Err(RecvTimeoutError::Disconnected) => break Err("engine server exited during startup".to_string()),
            }
        };
        if let Some(map) = running.routes.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            map.remove("");
        }
        if let Err(e) = outcome {
            let _ = running.child.kill();
            let _ = running.child.wait();
            let tail = tail_text(&running.stderr_tail);
            for t in running.threads.drain(..) {
                let _ = t.join();
            }
            return Err(format!("{e}{tail}"));
        }
        self.lock().running = Some(running);
        Ok(())
    }

    /// Sends `cmd` (an id is added) and returns the receiver of every reply
    /// carrying that id, up to and including the terminal one.
    pub fn request(&self, mut cmd: Value) -> Result<Receiver<Value>, String> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        cmd["id"] = Value::String(id.clone());
        let (tx, rx) = mpsc::channel();
        let mut s = self.lock();
        let r = s.running.as_mut().ok_or("engine server is not running")?;
        match r.routes.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            Some(map) => map.insert(id.clone(), tx),
            None => return Err("engine server exited".to_string()),
        };
        let line = format!("{cmd}\n");
        if let Err(e) = r.stdin.write_all(line.as_bytes()).and_then(|_| r.stdin.flush()) {
            if let Some(map) = r.routes.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
                map.remove(&id);
            }
            return Err(format!("failed to write to engine server: {e}"));
        }
        Ok(rx)
    }

    /// Sends `cmd` and blocks until its terminal reply, passing every
    /// non-terminal reply to `on_event`. `{"event":"error"}` becomes `Err`.
    /// If the process dies mid-request, the state is reset and the error
    /// carries the stderr tail.
    pub fn call(&self, cmd: Value, mut on_event: impl FnMut(&Value)) -> Result<Value, String> {
        let rx = self.request(cmd)?;
        loop {
            match rx.recv() {
                Ok(v) => match event_name(&v) {
                    "error" => {
                        return Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("engine error").to_string())
                    }
                    e if TERMINAL.contains(&e) => return Ok(v),
                    _ => on_event(&v),
                },
                Err(_) => {
                    let tail = self.reap();
                    let was_kept = std::mem::take(&mut self.lock().kept);
                    if was_kept {
                        self.notify(Some("The engine stopped unexpectedly; models were unloaded.".to_string()));
                    }
                    return Err(format!("engine server exited unexpectedly{tail}"));
                }
            }
        }
    }

    /// Runs one job end to end: starts the server if needed, runs `cmd`, and
    /// afterwards either shuts the server down (models not kept, so VRAM and
    /// RAM are released) or refreshes the resident model list.
    pub fn job(&self, low_priority: bool, cmd: Value, on_event: impl FnMut(&Value)) -> Result<Value, String> {
        self.ensure_started(low_priority)?;
        let result = self.call(cmd, on_event);
        if self.is_kept() {
            self.refresh_status();
        } else {
            self.shutdown();
        }
        result
    }

    fn refresh_status(&self) {
        if let Ok(v) = self.call(json!({"cmd": "status"}), |_| {}) {
            self.apply_models(&v);
            self.notify(None);
        }
    }

    fn apply_models(&self, v: &Value) {
        let models = v
            .get("models")
            .and_then(|m| m.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let mut s = self.lock();
        s.models = models;
        s.vram_mb = v.get("vramMb").and_then(|x| x.as_f64()).map(|x| x.round() as u64);
    }

    /// Starts the server and loads model `set`, marking models as kept.
    pub fn keep_loaded(&self, set: &str) -> Result<ModelsStatus, String> {
        self.lock().loading = true;
        self.notify(None);
        let result = self
            .ensure_started(false)
            .and_then(|_| self.call(json!({"cmd": "load", "set": set}), |_| {}));
        self.lock().loading = false;
        match result {
            Ok(v) => {
                self.apply_models(&v);
                self.lock().kept = true;
                self.notify(None);
                Ok(self.status())
            }
            Err(e) => {
                self.shutdown();
                self.notify(None);
                Err(e)
            }
        }
    }

    /// Shuts the server down (no python process left), clears `kept`, and
    /// reports the GPU's used memory from nvidia-smi afterwards.
    pub fn offload(&self, reason: Option<String>) -> ModelsStatus {
        self.lock().kept = false;
        self.shutdown();
        self.lock().vram_mb = super::sysload::query_gpu().map(|g| g.used_mb.round() as u64);
        self.notify(reason);
        self.status()
    }

    /// Asks the server to exit (`shutdown`), waits up to 10 s, then kills it.
    /// Idempotent; leaves `kept` untouched.
    pub fn shutdown(&self) {
        let running = self.lock().running.take();
        if let Some(mut r) = running {
            if matches!(r.child.try_wait(), Ok(None)) {
                let _ = writeln!(r.stdin, "{}", json!({"cmd": "shutdown", "id": "shutdown"}));
                let _ = r.stdin.flush();
            }
            drop(r.stdin);
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            loop {
                match r.child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                    _ => {
                        let _ = r.child.kill();
                        let _ = r.child.wait();
                        break;
                    }
                }
            }
            for t in r.threads {
                let _ = t.join();
            }
        }
        let mut s = self.lock();
        s.models.clear();
        s.vram_mb = None;
    }

    /// Kills and reaps a dead/broken server, returning its stderr tail.
    fn reap(&self) -> String {
        let running = self.lock().running.take();
        let tail = match running {
            Some(mut r) => {
                let _ = r.child.kill();
                let _ = r.child.wait();
                drop(r.stdin);
                for t in r.threads {
                    let _ = t.join();
                }
                tail_text(&r.stderr_tail)
            }
            None => String::new(),
        };
        let mut s = self.lock();
        s.models.clear();
        s.vram_mb = None;
        tail
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fake_server() -> Option<EngineServer> {
        let python = super::super::workspace::home_dir()
            .ok()?
            .join("engine")
            .join("venv")
            .join("Scripts")
            .join("python.exe");
        if !python.exists() {
            eprintln!("skipping: venv python not found at {}", python.display());
            return None;
        }
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_engine_server.py");
        Some(EngineServer::new(Box::new(move |_| {
            Ok(Launch { program: python.clone(), args: vec![script.clone().into()] })
        })))
    }

    fn process_alive(pid: u32) -> bool {
        let out = silent_command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }

    fn split_cmd() -> Value {
        json!({"cmd": "split", "input": "in.wav", "out": "outdir", "quality": "quick", "lowPriority": false})
    }

    #[test]
    fn routes_replies_by_id() {
        let Some(server) = fake_server() else { return };
        server.ensure_started(false).unwrap();
        // Two requests in flight at once: each receiver only sees its own id.
        let split = server.request(split_cmd()).unwrap();
        let status = server.request(json!({"cmd": "status"})).unwrap();
        let split_events: Vec<Value> = split.iter().collect::<Vec<_>>();
        let status_events: Vec<Value> = status.iter().take(1).collect();
        let split_id = split_events[0]["id"].as_str().unwrap().to_string();
        assert!(split_events.iter().all(|e| e["id"] == split_id.as_str()));
        assert_eq!(event_name(split_events.last().unwrap()), "done");
        assert!(split_events.iter().any(|e| event_name(e) == "stem_ready"));
        assert_eq!(event_name(&status_events[0]), "status");
        assert_ne!(status_events[0]["id"], split_id.as_str());
        server.shutdown();
        server.shutdown(); // idempotent
        assert!(server.child_pid().is_none());
    }

    #[test]
    fn not_kept_shuts_down_after_each_job() {
        let Some(server) = fake_server() else { return };
        let mut stems = 0;
        let done = server
            .job(false, split_cmd(), |e| {
                if event_name(e) == "stem_ready" {
                    stems += 1;
                }
            })
            .unwrap();
        assert_eq!(stems, 2);
        assert_eq!(done["stems"].as_array().unwrap().len(), 3);
        assert!(server.child_pid().is_none(), "server must exit when models are not kept");
        assert!(!server.status().loaded);
    }

    #[test]
    fn kept_models_survive_jobs_and_offload_leaves_no_process() {
        let Some(server) = fake_server() else { return };
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        server.set_listener(move |e| sink.lock().unwrap().push(e.clone()));

        let st = server.keep_loaded("quick").unwrap();
        assert!(st.kept && st.loaded && !st.loading);
        assert_eq!(st.models, vec!["quick-vocals".to_string(), "quick-inst".to_string()]);
        assert_eq!(st.vram_mb, Some(2048));
        let pid = server.child_pid().unwrap();

        server.job(false, split_cmd(), |_| {}).unwrap();
        assert_eq!(server.child_pid(), Some(pid), "kept server must be reused");

        let st = server.offload(Some("test".into()));
        assert!(!st.kept && !st.loaded);
        assert!(server.child_pid().is_none());
        assert!(!process_alive(pid), "offload must leave no python process");
        let events = events.lock().unwrap();
        assert!(events.iter().any(|e| e.status.loading));
        assert_eq!(events.last().unwrap().reason.as_deref(), Some("test"));
    }

    #[test]
    fn crash_mid_job_errors_and_resets() {
        let Some(server) = fake_server() else { return };
        server.keep_loaded("quick").unwrap();
        let pid = server.child_pid().unwrap();
        let err = server.job(false, json!({"cmd": "crash"}), |_| {}).unwrap_err();
        assert!(err.contains("exited unexpectedly"), "{err}");
        assert!(err.contains("boom"), "stderr tail missing: {err}");
        let st = server.status();
        assert!(!st.kept && !st.loaded && st.models.is_empty());
        assert!(server.child_pid().is_none());
        assert!(!process_alive(pid));
        // The next job starts a fresh server.
        server.job(false, split_cmd(), |_| {}).unwrap();
        assert!(server.child_pid().is_none());
    }

    /// Against the real embedded separate.py (loads ~2 GB of models):
    /// `cargo test ... -- --ignored real_server`.
    #[test]
    #[ignore]
    fn real_server_load_and_offload() {
        let server = global();
        let st = server.keep_loaded("quick").expect("load quick set");
        assert!(st.loaded && st.kept && !st.models.is_empty(), "{st:?}");
        let pid = server.child_pid().unwrap();
        let st = server.offload(None);
        assert!(!st.loaded && !st.kept);
        assert!(!process_alive(pid));
    }

    /// Real quick split of 8 s of synthetic audio into a temp work dir,
    /// through `engine::split_song`: `cargo test ... -- --ignored real_quick`.
    #[test]
    #[ignore]
    fn real_quick_split_writes_manifest() {
        use crate::audio::stems::{self, StemSetKind};
        let work = std::env::temp_dir().join(format!("as_real_split_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let source = work.join("source.wav");
        let st = silent_command("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=110:d=8", "-f", "lavfi", "-i", "anoisesrc=d=8:a=0.05"])
            .args(["-filter_complex", "[0][1]amix=inputs=2,aformat=channel_layouts=stereo", "-ar", "44100"])
            .arg(&source)
            .status()
            .unwrap();
        assert!(st.success());
        let mut early = Vec::new();
        let m = crate::audio::engine::split_song(&source, &work, "quick", None, "test", false, |_| {}, |s| {
            early.push(s.key.clone())
        })
        .expect("split");
        eprintln!("early: {early:?}\nstems: {:?}", m.stems.iter().map(|s| (&s.key, &s.path, s.bytes, s.peaks.len())).collect::<Vec<_>>());
        assert!(!early.is_empty());
        assert_eq!(m.quality.as_deref(), Some("quick"));
        let saved = stems::load_manifest(&work, StemSetKind::Instruments).unwrap();
        assert_eq!(saved.stems.len(), m.stems.len());
        for s in &m.stems {
            assert!(!s.peaks.is_empty(), "{} has no peaks", s.key);
        }
        let derived = m.stems.iter().find(|s| stems::is_derived(s)).expect("a derived stem");
        let set = stems::StemSet::new(&work, StemSetKind::Instruments, &saved);
        assert!(set.file_for(&derived.key).unwrap().exists());
        assert!(server_idle());
        let _ = std::fs::remove_dir_all(&work);
    }

    fn server_idle() -> bool {
        global().child_pid().is_none()
    }

    #[test]
    fn job_error_keeps_server_usable() {
        let Some(server) = fake_server() else { return };
        server.ensure_started(false).unwrap();
        let err = server.call(json!({"cmd": "nope"}), |_| {}).unwrap_err();
        assert!(err.contains("unknown cmd"), "{err}");
        assert_eq!(event_name(&server.call(json!({"cmd": "status"}), |_| {}).unwrap()), "status");
        server.shutdown();
    }
}
