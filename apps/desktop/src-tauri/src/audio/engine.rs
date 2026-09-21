//! AI instrument separation engine: Python 3.12 discovery, venv install,
//! and driving the embedded `separate.py` script.
//!
//! Engine dir: `<home>/engine/` (see `workspace::home_dir`) holds `venv/`
//! (Python 3.12 virtualenv), `models/` (downloaded weights) and
//! `separate.py` (this repo's `engine/separate.py`, embedded via
//! `include_str!` and rewritten to disk before every run).

use super::{dsp_filters, silent_command, workspace};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The `engine/separate.py` script embedded at compile time. Path is
/// relative to this file: `src/audio/engine.rs` -> repo root is 5 levels up
/// (audio, src, src-tauri, desktop, apps).
const SEPARATE_PY: &str = include_str!("../../../../../engine/separate.py");

/// Canonical default pass list per the contract addendum.
pub const DEFAULT_PASSES: &[&str] = &["instruments", "vocals", "lead", "drums", "tag"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub installed: bool,
    pub python_found: bool,
    pub python_path: Option<String>,
    pub venv_path: Option<String>,
    pub torch_version: Option<String>,
    pub cuda: bool,
    pub gpu_name: Option<String>,
    pub models_present: Vec<String>,
    pub engine_path: String,
    /// True while a `separate()` call is in flight (contract v6 "GPU busy
    /// and low priority"); read live, never cached.
    #[serde(default)]
    pub busy: bool,
    #[serde(default)]
    pub busy_track_id: Option<String>,
}

// ---------------------------------------------------------------------
// Busy state: only one `separate()` runs at a time.
// ---------------------------------------------------------------------

static BUSY: AtomicBool = AtomicBool::new(false);
static BUSY_LABEL: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn busy_label_mutex() -> &'static Mutex<Option<String>> {
    BUSY_LABEL.get_or_init(|| Mutex::new(None))
}

fn busy_label() -> Option<String> {
    busy_label_mutex().lock().ok().and_then(|g| g.clone())
}

/// Guards the `BUSY` flag for the duration of a `separate()` call; clears it
/// (and the label) in every exit path, including a panic, via `Drop`.
#[derive(Debug)]
struct BusyGuard;

impl BusyGuard {
    fn acquire(label: &str) -> Result<Self, String> {
        if BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            let current = busy_label().unwrap_or_else(|| "another track".to_string());
            return Err(format!("engine busy: {current}"));
        }
        if let Ok(mut g) = busy_label_mutex().lock() {
            *g = Some(label.to_string());
        }
        Ok(BusyGuard)
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut g) = busy_label_mutex().lock() {
            *g = None;
        }
        BUSY.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentTag {
    pub label: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentStem {
    pub key: String,
    pub label: String,
    pub group: String,
    pub parent: Option<String>,
    pub path: String,
    pub bytes: u64,
    pub peak_db: f64,
    pub rms_db: f64,
    pub model: String,
    pub order: u32,
    #[serde(default)]
    pub duration_sec: f64,
    #[serde(default)]
    pub peaks: Vec<f32>,
    /// AST instrument-family tags (contract v5 addendum "Instrument tags"),
    /// produced by the Python `tag` pass; absent (never-fatal) if that pass
    /// didn't run or failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<InstrumentTag>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sounds_like: Option<String>,
    /// v6: honest naming and confidence from the tag pass.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detections: Option<Vec<InstrumentTag>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<StemConfidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StemConfidence {
    pub score: f64,
    #[serde(default)]
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedPass {
    pub pass: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentsManifest {
    pub stems: Vec<InstrumentStem>,
    pub device: String,
    pub failed_passes: Vec<FailedPass>,
    /// Honest total wall-clock time (contract v5 addendum "Honest timing"),
    /// measured independently of anything the Python script reports.
    #[serde(default)]
    pub elapsed_sec: f64,
    /// Per-pass seconds, parsed from the script's `pass_done.seconds`
    /// events.
    #[serde(default)]
    pub pass_seconds: std::collections::HashMap<String, f64>,
}

/// Returns the engine root dir: `<home>/engine`.
pub fn engine_dir() -> Result<PathBuf, String> {
    Ok(workspace::home_dir()?.join("engine"))
}

pub(crate) fn venv_python_path(engine: &Path) -> PathBuf {
    engine.join("venv").join("Scripts").join("python.exe")
}

fn models_dir(engine: &Path) -> PathBuf {
    engine.join("models")
}

// ---------------------------------------------------------------------
// Python 3.12 discovery
// ---------------------------------------------------------------------

/// Parses `py -0` (or `py -0p`) output into candidate 3.12 launcher tags,
/// e.g. lines like ` -V:Astral\CPython3.12.14 CPython 3.12.14 (64-bit)`
/// or ` -V:3.12 *` -> tags `"Astral\CPython3.12.14"`, `"3.12"`.
pub fn parse_py_list_312(output: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("-V:") {
            continue;
        }
        // token is "-V:<tag>" up to the next whitespace.
        let rest = &trimmed[3..];
        let tag = rest.split_whitespace().next().unwrap_or("");
        if tag.contains("3.12") {
            tags.push(tag.to_string());
        }
    }
    tags
}

/// A discovered Python 3.12 interpreter: how to invoke it.
#[derive(Debug, Clone, PartialEq)]
pub enum PythonInvocation {
    /// Direct executable path or PATH name (invoked as `<exe> ...args`).
    Direct(String),
    /// The `py` launcher with a specific version tag (invoked as
    /// `py -V:<tag> ...args`).
    PyLauncher(String),
}

impl PythonInvocation {
    pub fn command(&self) -> std::process::Command {
        match self {
            PythonInvocation::Direct(exe) => silent_command(exe),
            PythonInvocation::PyLauncher(tag) => {
                let mut cmd = silent_command("py");
                cmd.arg(format!("-V:{tag}"));
                cmd
            }
        }
    }

    pub fn display(&self) -> String {
        match self {
            PythonInvocation::Direct(exe) => exe.clone(),
            PythonInvocation::PyLauncher(tag) => format!("py -V:{tag}"),
        }
    }
}

/// Locates a Python 3.12 interpreter per the contract's discovery order.
pub fn find_python_312() -> Result<PythonInvocation, String> {
    // 1. env ABSOLUTESAMPLE_PYTHON
    if let Ok(p) = std::env::var("ABSOLUTESAMPLE_PYTHON") {
        if !p.is_empty() {
            return Ok(PythonInvocation::Direct(p));
        }
    }

    // 2. `py -3.12`
    if let Ok(out) = silent_command("py").arg("-3.12").arg("--version").output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let text = if text.trim().is_empty() {
                String::from_utf8_lossy(&out.stderr).to_string()
            } else {
                text.to_string()
            };
            if text.trim_start().starts_with("Python 3.12") {
                return Ok(PythonInvocation::PyLauncher("3.12".to_string()));
            }
        }
    }

    // 3. `py -0` listing.
    if let Ok(out) = silent_command("py").arg("-0").output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let tags = parse_py_list_312(&text);
            if let Some(tag) = tags.into_iter().next() {
                return Ok(PythonInvocation::PyLauncher(tag));
            }
        }
    }

    // 4. `python3.12` / `python` on PATH.
    for name in ["python3.12", "python"] {
        if let Ok(out) = silent_command(name).arg("--version").output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                let text = if text.trim().is_empty() {
                    String::from_utf8_lossy(&out.stderr).to_string()
                } else {
                    text.to_string()
                };
                if text.trim_start().starts_with("Python 3.12") {
                    return Ok(PythonInvocation::Direct(name.to_string()));
                }
            }
        }
    }

    Err(
        "Python 3.12 not found (hint: winget install Python.Python.3.12)"
            .to_string(),
    )
}

// ---------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------

static STATUS_CACHE: OnceLock<Mutex<Option<(Instant, EngineStatus)>>> = OnceLock::new();

fn status_cache() -> &'static Mutex<Option<(Instant, EngineStatus)>> {
    STATUS_CACHE.get_or_init(|| Mutex::new(None))
}

/// Runs the verify import, returning (torch_version, cuda, gpu_name) on
/// success or None if the import fails.
fn verify_import(python: &Path) -> Option<(String, bool, Option<String>)> {
    let out = silent_command(python.to_str()?)
        .arg("-c")
        .arg(
            "import torch,audio_separator,soundfile;\
print(torch.__version__, torch.cuda.is_available(), \
torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')",
        )
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    let mut parts = line.splitn(3, ' ');
    let version = parts.next()?.to_string();
    let cuda = parts.next()? == "True";
    let gpu = parts.next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Some((version, cuda, gpu))
}

fn list_models_present(models_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(models_dir) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    out.push(name.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

fn compute_status() -> EngineStatus {
    let engine = match engine_dir() {
        Ok(d) => d,
        Err(_) => {
            return EngineStatus {
                installed: false,
                python_found: false,
                python_path: None,
                venv_path: None,
                torch_version: None,
                cuda: false,
                gpu_name: None,
                models_present: Vec::new(),
                engine_path: String::new(),
                busy: false,
                busy_track_id: None,
            };
        }
    };

    let python_found = find_python_312().is_ok();
    let venv_python = venv_python_path(&engine);
    let venv_exists = venv_python.exists();
    let venv_path = if engine.join("venv").exists() {
        Some(engine.join("venv").to_string_lossy().to_string())
    } else {
        None
    };

    let (torch_version, cuda, gpu_name, installed) = if venv_exists {
        match verify_import(&venv_python) {
            Some((v, cuda, gpu)) => (Some(v), cuda, gpu, true),
            None => (None, false, None, false),
        }
    } else {
        (None, false, None, false)
    };

    EngineStatus {
        installed,
        python_found,
        python_path: if venv_exists {
            Some(venv_python.to_string_lossy().to_string())
        } else {
            None
        },
        venv_path,
        torch_version,
        cuda,
        gpu_name,
        models_present: list_models_present(&models_dir(&engine)),
        engine_path: engine.to_string_lossy().to_string(),
        busy: false,
        busy_track_id: None,
    }
}

/// Returns the current engine status. Never panics/errors; caches the
/// expensive-to-compute fields for 60 seconds, but `busy`/`busyTrackId` are
/// always read live so a poller sees the split finish promptly.
pub fn status() -> EngineStatus {
    let cache = status_cache();
    let mut guard = match cache.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some((at, cached)) = guard.as_ref() {
        if at.elapsed() < Duration::from_secs(60) {
            let mut s = cached.clone();
            s.busy = BUSY.load(Ordering::SeqCst);
            s.busy_track_id = busy_label();
            return s;
        }
    }
    let mut fresh = compute_status();
    *guard = Some((Instant::now(), fresh.clone()));
    fresh.busy = BUSY.load(Ordering::SeqCst);
    fresh.busy_track_id = busy_label();
    fresh
}

fn invalidate_status_cache() {
    if let Ok(mut guard) = status_cache().lock() {
        *guard = None;
    }
}

// ---------------------------------------------------------------------
// install()
// ---------------------------------------------------------------------

/// Runs a subprocess with piped stdout+stderr, streaming each combined
/// line to `on_line`, and returns the exit status plus the last 20 stderr
/// lines (for error reporting).
fn run_streaming(
    mut cmd: std::process::Command,
    mut on_line: impl FnMut(&str),
) -> Result<(bool, Vec<String>), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn process: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stderr_lines = std::thread::spawn(move || -> Vec<String> {
        let mut lines = Vec::new();
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                lines.push(line);
            }
        }
        lines
    });

    if let Some(stdout) = stdout {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            on_line(&line);
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("failed to wait on process: {e}"))?;
    let mut stderr_all = stderr_lines.join().unwrap_or_default();
    let tail: Vec<String> = stderr_all
        .split_off(stderr_all.len().saturating_sub(20))
        .into_iter()
        .collect();
    Ok((status.success(), tail))
}

/// Progress message for install/separate operations.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProgress {
    pub stage: String,
    pub percent: f32,
    pub message: String,
    /// The separation pass this progress belongs to (only set by `separate`).
    pub pass: Option<String>,
    /// True when this update reports a failed pass (only set by `separate`).
    pub failed: bool,
}

impl EngineProgress {
    fn install(stage: &str, percent: f32, message: impl Into<String>) -> Self {
        EngineProgress {
            stage: stage.to_string(),
            percent,
            message: message.into(),
            pass: None,
            failed: false,
        }
    }
}

/// Runs the full install: venv creation, pip upgrade, torch (cu124), the
/// audio-separator[gpu]+soundfile install, and the verify import.
pub fn install(mut progress: impl FnMut(EngineProgress)) -> Result<EngineStatus, String> {
    let engine = engine_dir()?;
    std::fs::create_dir_all(&engine).map_err(|e| format!("failed to create engine dir: {e}"))?;

    let python = find_python_312()?;
    progress(EngineProgress::install("python", -1.0, format!("using Python: {}", python.display())));

    // 1. venv creation.
    progress(EngineProgress::install("venv", -1.0, "creating virtual environment".to_string()));
    let venv_dir = engine.join("venv");
    let mut cmd = python.command();
    cmd.arg("-m").arg("venv").arg(&venv_dir);
    let (ok, tail) = run_streaming(cmd, |line| {
        progress(EngineProgress::install("venv", -1.0, line.to_string()));
    })?;
    if !ok {
        return Err(format!(
            "venv creation failed:\n{}",
            tail.join("\n")
        ));
    }

    let venv_python = venv_python_path(&engine);

    // 2. pip upgrade.
    progress(EngineProgress::install("venv", -1.0, "upgrading pip".to_string()));
    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.args(["-m", "pip", "install", "--upgrade", "pip"]);
    let (ok, tail) = run_streaming(cmd, |line| {
        progress(EngineProgress::install("venv", -1.0, line.to_string()));
    })?;
    if !ok {
        return Err(format!("pip upgrade failed:\n{}", tail.join("\n")));
    }

    // 3. torch install.
    progress(EngineProgress::install("torch", -1.0, "installing torch (cu124)".to_string()));
    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.args([
        "-m",
        "pip",
        "install",
        "torch",
        "torchaudio",
        "--index-url",
        "https://download.pytorch.org/whl/cu124",
    ]);
    let (ok, tail) = run_streaming(cmd, |line| {
        progress(EngineProgress::install("torch", -1.0, line.to_string()));
    })?;
    if !ok {
        return Err(format!("torch install failed:\n{}", tail.join("\n")));
    }

    // 4. audio-separator[gpu] + soundfile.
    progress(EngineProgress::install("separator", -1.0, "installing audio-separator[gpu] + soundfile".to_string()));
    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.args(["-m", "pip", "install", "audio-separator[gpu]", "soundfile"]);
    let (ok, tail) = run_streaming(cmd, |line| {
        progress(EngineProgress::install("separator", -1.0, line.to_string()));
    })?;
    if !ok {
        return Err(format!("audio-separator install failed:\n{}", tail.join("\n")));
    }

    // 5. verify.
    progress(EngineProgress::install("verify", -1.0, "verifying install".to_string()));
    invalidate_status_cache();
    let final_status = status();
    if !final_status.installed {
        return Err("verify import failed after install".to_string());
    }
    progress(EngineProgress::install("verify", 100.0, "install complete".to_string()));
    Ok(final_status)
}

// ---------------------------------------------------------------------
// separate()
// ---------------------------------------------------------------------

/// One parsed line of the separate.py stdout JSON protocol.
#[derive(Debug, Clone, PartialEq)]
pub enum SeparateEvent {
    Device { device: String, gpu: Option<String> },
    Progress { pass: String, percent: f32, message: String },
    PassDone { pass: String, seconds: f64 },
    PassFailed { pass: String, error: String },
    Done { stems: Vec<RawStem>, device: String },
    Fatal { error: String },
    Unknown,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
pub struct RawStem {
    pub key: String,
    pub label: String,
    pub group: String,
    pub parent: Option<String>,
    pub path: String,
    pub model: String,
    pub order: u32,
    #[serde(default)]
    pub tags: Option<Vec<InstrumentTag>>,
    #[serde(default, rename = "soundsLike")]
    pub sounds_like: Option<String>,
    #[serde(default, rename = "displayLabel")]
    pub display_label: Option<String>,
    #[serde(default)]
    pub detections: Option<Vec<InstrumentTag>>,
    #[serde(default)]
    pub confidence: Option<StemConfidence>,
}

/// Parses one JSON line from separate.py's stdout into a `SeparateEvent`.
pub fn parse_separate_line(line: &str) -> SeparateEvent {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return SeparateEvent::Unknown,
    };
    let event = value.get("event").and_then(|v| v.as_str()).unwrap_or("");
    match event {
        "device" => SeparateEvent::Device {
            device: value.get("device").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            gpu: value.get("gpu").and_then(|v| v.as_str()).map(|s| s.to_string()),
        },
        "progress" => SeparateEvent::Progress {
            pass: value.get("pass").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            percent: value.get("percent").and_then(|v| v.as_f64()).unwrap_or(-1.0) as f32,
            message: value.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        },
        "pass_done" => SeparateEvent::PassDone {
            pass: value.get("pass").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            seconds: value.get("seconds").and_then(|v| v.as_f64()).unwrap_or(0.0),
        },
        "pass_failed" => SeparateEvent::PassFailed {
            pass: value.get("pass").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            error: value.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        },
        "done" => {
            let stems: Vec<RawStem> = value
                .get("stems")
                .cloned()
                .map(|v| serde_json::from_value(v).unwrap_or_default())
                .unwrap_or_default();
            SeparateEvent::Done {
                stems,
                device: value.get("device").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            }
        }
        "fatal" => SeparateEvent::Fatal {
            error: value.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        },
        _ => SeparateEvent::Unknown,
    }
}

/// The non-stem portion of `InstrumentsManifest` (contract v5 addendum:
/// `TrackSession` gains `instruments: InstrumentStem[]` plus this separate
/// `instrumentsMeta` -- see the "TrackSession instruments shape" note
/// appended to `docs/CONTRACT.md`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentsMeta {
    pub elapsed_sec: f64,
    pub pass_seconds: std::collections::HashMap<String, f64>,
    pub device: String,
    pub failed_passes: Vec<FailedPass>,
}

impl From<&InstrumentsManifest> for InstrumentsMeta {
    fn from(m: &InstrumentsManifest) -> Self {
        InstrumentsMeta {
            elapsed_sec: m.elapsed_sec,
            pass_seconds: m.pass_seconds.clone(),
            device: m.device.clone(),
            failed_passes: m.failed_passes.clone(),
        }
    }
}

/// Writes the embedded `separate.py` to `<engine>/separate.py`, runs it
/// against `loop_wav`, streams progress, and returns the resulting stems
/// (with bytes/peakDb/rmsDb filled in), the device used, and any failed
/// passes.
pub struct SeparateResult {
    pub stems: Vec<InstrumentStem>,
    pub device: String,
    pub failed_passes: Vec<(String, String)>,
    pub elapsed_sec: f64,
    pub pass_seconds: std::collections::HashMap<String, f64>,
}

pub fn separate(
    loop_wav: &Path,
    work_dir: &Path,
    passes: &[String],
    label: &str,
    low_priority: bool,
    mut progress: impl FnMut(EngineProgress),
) -> Result<SeparateResult, String> {
    // Only one split runs at a time; cleared on every exit path (including
    // panics) via `Drop`.
    let _busy_guard = BusyGuard::acquire(label)?;

    let timer = super::progress::Timer::start();
    let engine = engine_dir()?;
    std::fs::create_dir_all(&engine).map_err(|e| format!("failed to create engine dir: {e}"))?;

    let script_path = engine.join("separate.py");
    std::fs::write(&script_path, SEPARATE_PY)
        .map_err(|e| format!("failed to write separate.py: {e}"))?;

    let venv_python = venv_python_path(&engine);
    if !venv_python.exists() {
        return Err(format!(
            "engine not installed: {} not found",
            venv_python.display()
        ));
    }

    let instruments_out = work_dir.join("instruments");
    std::fs::create_dir_all(&instruments_out)
        .map_err(|e| format!("failed to create instruments dir: {e}"))?;

    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.arg(&script_path)
        .arg("--input")
        .arg(loop_wav)
        .arg("--out")
        .arg(&instruments_out)
        .arg("--passes")
        .arg(passes.join(","))
        .arg("--models-dir")
        .arg(models_dir(&engine))
        .arg("--device")
        .arg("auto")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if low_priority {
        cmd.arg("--low-priority");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW. `silent_command`
            // already set CREATE_NO_WINDOW alone; this call replaces those
            // flags, so CREATE_NO_WINDOW is included explicitly here too.
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
            cmd.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | super::CREATE_NO_WINDOW);
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn separate.py: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stderr_lines = std::thread::spawn(move || -> Vec<String> {
        let mut lines = Vec::new();
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                lines.push(line);
            }
        }
        lines
    });

    let mut device = String::new();
    let mut raw_stems: Vec<RawStem> = Vec::new();
    let mut failed_passes: Vec<(String, String)> = Vec::new();
    let mut fatal_error: Option<String> = None;
    let mut pass_seconds: std::collections::HashMap<String, f64> = std::collections::HashMap::new();

    if let Some(stdout) = stdout {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            match parse_separate_line(&line) {
                SeparateEvent::Device { device: d, .. } => {
                    device = d;
                }
                SeparateEvent::Progress { pass, percent, message } => {
                    progress(EngineProgress {
                        stage: "separate".to_string(),
                        percent,
                        message: message.clone(),
                        pass: Some(pass),
                        failed: false,
                    });
                }
                SeparateEvent::PassDone { pass, seconds } => {
                    pass_seconds.insert(pass.clone(), seconds);
                    progress(EngineProgress {
                        stage: "separate".to_string(),
                        percent: 100.0,
                        message: format!("done in {seconds:.1}s"),
                        pass: Some(pass),
                        failed: false,
                    });
                }
                SeparateEvent::PassFailed { pass, error } => {
                    progress(EngineProgress {
                        stage: "separate".to_string(),
                        percent: -1.0,
                        message: error.clone(),
                        pass: Some(pass.clone()),
                        failed: true,
                    });
                    failed_passes.push((pass, error));
                }
                SeparateEvent::Done { stems, device: d } => {
                    raw_stems = stems;
                    device = d;
                }
                SeparateEvent::Fatal { error } => {
                    fatal_error = Some(error);
                }
                SeparateEvent::Unknown => {}
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("failed to wait on separate.py: {e}"))?;
    let stderr_all = stderr_lines.join().unwrap_or_default();
    let stderr_tail: Vec<String> = stderr_all
        .iter()
        .rev()
        .take(20)
        .rev()
        .cloned()
        .collect();

    if !status.success() || fatal_error.is_some() {
        let mut msg = String::new();
        if let Some(err) = &fatal_error {
            msg.push_str(&format!("separate.py fatal error: {err}\n"));
        } else {
            msg.push_str(&format!(
                "separate.py exited with {:?}\n",
                status.code()
            ));
        }
        if !stderr_tail.is_empty() {
            msg.push_str("--- stderr tail ---\n");
            msg.push_str(&stderr_tail.join("\n"));
        }
        return Err(msg);
    }

    let mut stems = Vec::with_capacity(raw_stems.len());
    for raw in raw_stems {
        let path = PathBuf::from(&raw.path);
        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let loudness = dsp_filters::measure_loudness(&path).unwrap_or(dsp_filters::StemLoudness {
            peak_db: 0.0,
            rms_db: 0.0,
            duration_sec: 0.0,
            peaks: Vec::new(),
        });
        let stem_peaks = super::peaks::compute_peaks_for_path(&path).unwrap_or_default();
        let duration_sec = super::downloader::probe(&path).map(|p| p.duration_sec).unwrap_or(0.0);
        stems.push(InstrumentStem {
            key: raw.key,
            label: raw.label,
            group: raw.group,
            parent: raw.parent,
            path: raw.path,
            bytes,
            peak_db: loudness.peak_db,
            rms_db: loudness.rms_db,
            model: raw.model,
            order: raw.order,
            duration_sec,
            peaks: stem_peaks,
            tags: raw.tags,
            sounds_like: raw.sounds_like,
            display_label: raw.display_label,
            detections: raw.detections,
            confidence: raw.confidence,
        });
    }

    let elapsed_sec = timer.elapsed_sec();

    let manifest = InstrumentsManifest {
        stems: stems.clone(),
        device: device.clone(),
        failed_passes: failed_passes
            .iter()
            .map(|(p, e)| FailedPass { pass: p.clone(), error: e.clone() })
            .collect(),
        elapsed_sec,
        pass_seconds: pass_seconds.clone(),
    };
    let manifest_path = work_dir.join("instruments.json");
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("failed to serialize instruments manifest: {e}"))?;
    std::fs::write(&manifest_path, manifest_json)
        .map_err(|e| format!("failed to write instruments.json: {e}"))?;

    Ok(SeparateResult { stems, device, failed_passes, elapsed_sec, pass_seconds })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_py_list_with_bracket_tags() {
        let sample = " -V:Astral\\CPython3.12.14 CPython 3.12.14 (64-bit)\n -V:Astral\\CPython3.13.2 CPython 3.13.2 (64-bit)\n -V:3.11 *\n";
        let tags = parse_py_list_312(sample);
        assert_eq!(tags, vec!["Astral\\CPython3.12.14".to_string()]);
    }

    #[test]
    fn parses_py_list_with_plain_version_tag() {
        let sample = " -V:3.12 *\n -V:3.9\n";
        let tags = parse_py_list_312(sample);
        assert_eq!(tags, vec!["3.12".to_string()]);
    }

    #[test]
    fn parses_py_list_with_no_312() {
        let sample = " -V:3.9\n -V:3.11 *\n";
        assert!(parse_py_list_312(sample).is_empty());
    }

    #[test]
    fn parses_device_line() {
        let line = r#"{"event":"device","device":"cuda","gpu":"RTX 4090"}"#;
        match parse_separate_line(line) {
            SeparateEvent::Device { device, gpu } => {
                assert_eq!(device, "cuda");
                assert_eq!(gpu, Some("RTX 4090".to_string()));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_progress_line() {
        let line = r#"{"event":"progress","pass":"vocals","percent":-1,"message":"loading model"}"#;
        match parse_separate_line(line) {
            SeparateEvent::Progress { pass, percent, message } => {
                assert_eq!(pass, "vocals");
                assert_eq!(percent, -1.0);
                assert_eq!(message, "loading model");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_pass_done_and_pass_failed() {
        let done = r#"{"event":"pass_done","pass":"drums","seconds":12.5}"#;
        match parse_separate_line(done) {
            SeparateEvent::PassDone { pass, seconds } => {
                assert_eq!(pass, "drums");
                assert_eq!(seconds, 12.5);
            }
            other => panic!("unexpected: {other:?}"),
        }

        let failed = r#"{"event":"pass_failed","pass":"lead","error":"oom"}"#;
        match parse_separate_line(failed) {
            SeparateEvent::PassFailed { pass, error } => {
                assert_eq!(pass, "lead");
                assert_eq!(error, "oom");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_done_line_with_stems() {
        let line = r#"{"event":"done","device":"cpu","stems":[{"key":"vocals","label":"Vocals","group":"vocals","parent":null,"path":"C:/out/vocals.wav","model":"htdemucs_6s.yaml","order":10}]}"#;
        match parse_separate_line(line) {
            SeparateEvent::Done { stems, device } => {
                assert_eq!(device, "cpu");
                assert_eq!(stems.len(), 1);
                assert_eq!(stems[0].key, "vocals");
                assert_eq!(stems[0].parent, None);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_fatal_line() {
        let line = r#"{"event":"fatal","error":"boom"}"#;
        match parse_separate_line(line) {
            SeparateEvent::Fatal { error } => assert_eq!(error, "boom"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn full_transcript_dispatches_all_event_types() {
        let transcript = concat!(
            "{\"event\":\"device\",\"device\":\"cuda\",\"gpu\":\"RTX 4090\"}\n",
            "{\"event\":\"progress\",\"pass\":\"instruments\",\"percent\":20,\"message\":\"Separating\"}\n",
            "{\"event\":\"pass_done\",\"pass\":\"instruments\",\"seconds\":30.2}\n",
            "{\"event\":\"pass_failed\",\"pass\":\"lead\",\"error\":\"cuda oom\"}\n",
            "{\"event\":\"done\",\"device\":\"cuda\",\"stems\":[]}\n",
        );
        let mut saw = [false; 5];
        for line in transcript.lines() {
            match parse_separate_line(line) {
                SeparateEvent::Device { .. } => saw[0] = true,
                SeparateEvent::Progress { .. } => saw[1] = true,
                SeparateEvent::PassDone { .. } => saw[2] = true,
                SeparateEvent::PassFailed { .. } => saw[3] = true,
                SeparateEvent::Done { .. } => saw[4] = true,
                SeparateEvent::Fatal { .. } | SeparateEvent::Unknown => {}
            }
        }
        assert!(saw.iter().all(|&b| b));
    }

    #[test]
    fn busy_guard_clears_on_drop() {
        assert!(!BUSY.load(Ordering::SeqCst));
        {
            let _g = BusyGuard::acquire("track1").expect("first acquire should succeed");
            assert!(BUSY.load(Ordering::SeqCst));
            assert_eq!(busy_label().as_deref(), Some("track1"));
            let err = BusyGuard::acquire("track2").unwrap_err();
            assert!(err.contains("engine busy"));
            assert!(err.contains("track1"));
        }
        assert!(!BUSY.load(Ordering::SeqCst));
        assert_eq!(busy_label(), None);
    }

    #[test]
    fn instruments_manifest_round_trips() {
        let sample = r#"{
            "stems": [
                {"key":"vocals","label":"Vocals","group":"vocals","parent":null,"path":"C:/w/vocals.wav","bytes":1234,"peakDb":-1.5,"rmsDb":-12.3,"model":"htdemucs_6s.yaml","order":10}
            ],
            "device": "cuda",
            "failedPasses": [{"pass":"lead","error":"cuda oom"}]
        }"#;
        let manifest: InstrumentsManifest = serde_json::from_str(sample).expect("deserialize");
        assert_eq!(manifest.device, "cuda");
        assert_eq!(manifest.stems.len(), 1);
        assert_eq!(manifest.stems[0].key, "vocals");
        assert_eq!(manifest.failed_passes.len(), 1);
        assert_eq!(manifest.failed_passes[0].pass, "lead");

        let reserialized = serde_json::to_string(&manifest).expect("serialize");
        let roundtrip: InstrumentsManifest =
            serde_json::from_str(&reserialized).expect("round trip deserialize");
        assert_eq!(roundtrip.stems[0].bytes, 1234);
        assert_eq!(roundtrip.stems[0].peak_db, -1.5);
    }
}
