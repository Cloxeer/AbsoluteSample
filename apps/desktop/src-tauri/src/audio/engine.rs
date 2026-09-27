//! AI instrument separation engine: Python 3.12 discovery, venv install,
//! and driving the embedded `separate.py` script.
//!
//! Engine dir: `<home>/engine/` (see `workspace::home_dir`) holds `venv/`
//! (Python 3.12 virtualenv), `models/` (downloaded weights) and
//! `separate.py` (this repo's `engine/separate.py`, embedded via
//! `include_str!` and rewritten to disk before every run).

use super::stems::{self, StemSetKind};
use super::{engine_server, silent_command, workspace};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
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

/// Guards the global engine lock for the duration of a Python-spawning
/// command (`separate`, `separate_karaoke`, `analyze_pitch`,
/// `apply_autotune`, `analyze_frequencies`, `extract_notes`); clears it (and
/// the label) in every exit path, including a panic, via `Drop`. At most one
/// `EngineGuard` can be held at a time across the whole app (contract v8
/// addendum "Hard safety rules" #1).
#[derive(Debug)]
pub struct EngineGuard;

/// Backwards-compatible alias for `EngineGuard`'s prior internal name.
type BusyGuard = EngineGuard;

/// Tries to acquire the global engine lock for `label` (typically a track
/// title or a wav's file name), WITHOUT blocking. Returns
/// `Err("engine busy: <current label>")` immediately if another
/// Python-spawning command already holds it. The returned guard releases the
/// lock on `Drop`, so it must be held for the entire duration of the spawned
/// Python child process.
pub fn acquire_engine(label: &str) -> Result<EngineGuard, String> {
    EngineGuard::acquire(label)
}

impl EngineGuard {
    fn acquire(label: &str) -> Result<Self, String> {
        if BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            let current = busy_label().unwrap_or_else(|| "another track".to_string());
            return Err(format!("engine busy: {current}"));
        }
        if let Ok(mut g) = busy_label_mutex().lock() {
            *g = Some(label.to_string());
        }
        Ok(EngineGuard)
    }
}

impl Drop for EngineGuard {
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
    /// -inf was once written as null for silent stems: read it as silence.
    #[serde(deserialize_with = "db_or_silent")]
    pub peak_db: f64,
    #[serde(deserialize_with = "db_or_silent")]
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
    /// v11: a derived stem is a recipe over other stems (its `path` is
    /// empty); `stem_file` materializes it on demand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derived: Option<Derived>,
}

fn db_or_silent<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(stems::SILENT_DB))
}

/// v11 derived-stem recipe: `sum(plus) - sum(minus)`, where the pseudo key
/// `"mix"` is the song mix scaled by `mixGain` (falling back to the
/// manifest's `mixGain`, then 1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Derived {
    #[serde(default)]
    pub plus: Vec<String>,
    #[serde(default)]
    pub minus: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mix_gain: Option<f32>,
}

/// A time span in seconds (v11 `enhanced` regions).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Region {
    pub start: f64,
    pub end: f64,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
    /// v11: "quick" | "full" (None for pre-v11 manifests).
    #[serde(default)]
    pub quality: Option<String>,
    /// v11: the mix the stems were split from (derived stems' `"mix"`).
    #[serde(default)]
    pub mix_path: Option<String>,
    /// v11: stored stems sum to `mixGain * mix` (None = 1).
    #[serde(default)]
    pub mix_gain: Option<f32>,
    /// v11: regions re-run with the full chain by `enhance_region`.
    #[serde(default)]
    pub enhanced: Vec<Region>,
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

/// Writes the embedded `separate.py` into the engine dir and returns
/// `(venv python, script, models dir)`; errors if the venv is missing.
pub(crate) fn prepare_script() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let engine = engine_dir()?;
    std::fs::create_dir_all(&engine).map_err(|e| format!("failed to create engine dir: {e}"))?;
    let script_path = engine.join("separate.py");
    std::fs::write(&script_path, SEPARATE_PY).map_err(|e| format!("failed to write separate.py: {e}"))?;
    let venv_python = venv_python_path(&engine);
    if !venv_python.exists() {
        return Err(format!("engine not installed: {} not found", venv_python.display()));
    }
    Ok((venv_python, script_path, models_dir(&engine)))
}

/// True while any engine job holds the global gate.
pub fn engine_busy() -> bool {
    BUSY.load(Ordering::SeqCst)
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
            "import torch,audio_separator,soundfile,torchcrepe,pyworld,librosa,transformers;\
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
        "torch==2.6.0+cu124",
        "torchaudio==2.6.0+cu124",
        "torchvision==0.21.0+cu124",
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

    // 4b. Feature engines: CREPE (accurate pitch), pyworld (autotune resynth),
    // basic-pitch (MIDI), transformers (instrument tags), plus audio helpers.
    progress(EngineProgress::install("separator", -1.0, "installing analysis engines".to_string()));
    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.args([
        "-m", "pip", "install",
        "torchcrepe", "pyworld", "librosa", "audioread", "transformers",
        "pretty_midi", "mir_eval", "scipy",
    ]);
    let (ok, tail) = run_streaming(cmd, |line| {
        progress(EngineProgress::install("separator", -1.0, line.to_string()));
    })?;
    if !ok {
        return Err(format!("analysis engine install failed:
{}", tail.join("
")));
    }
    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.args(["-m", "pip", "install", "--no-deps", "basic-pitch"]);
    let _ = run_streaming(cmd, |line| {
        progress(EngineProgress::install("separator", -1.0, line.to_string()));
    });
    progress(EngineProgress::install("torch", -1.0, "pinning CUDA torch stack".to_string()));
    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.args([
        "-m", "pip", "install",
        "torch==2.6.0+cu124", "torchaudio==2.6.0+cu124", "torchvision==0.21.0+cu124",
        "--index-url", "https://download.pytorch.org/whl/cu124",
    ]);
    let (ok, tail) = run_streaming(cmd, |line| {
        progress(EngineProgress::install("torch", -1.0, line.to_string()));
    })?;
    if !ok {
        return Err(format!("torch re-pin failed:
{}", tail.join("
")));
    }
    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.args(["-m", "pip", "install", "--upgrade", "--force-reinstall", "onnxruntime"]);
    let _ = run_streaming(cmd, |line| {
        progress(EngineProgress::install("separator", -1.0, line.to_string()));
    });

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

// ---------------------------------------------------------------------
// Performance metrics (contract v8 addendum "Performance metrics")
// ---------------------------------------------------------------------

/// A parsed `{"event":"metrics","seconds":..,"peakRssMb":..,"device":..}`
/// line, emitted as the final stdout line by every engine script.
#[derive(Debug, Clone, PartialEq)]
pub struct MetricsEvent {
    pub seconds: f64,
    pub peak_rss_mb: Option<f64>,
    pub device: String,
}

/// Parses one stdout line as a `metrics` event, if it is one. Any other
/// event (or unparsable line) returns `None`; callers should keep scanning
/// their own event types on `None`.
pub fn parse_metrics_line(line: &str) -> Option<MetricsEvent> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("event").and_then(|v| v.as_str()) != Some("metrics") {
        return None;
    }
    let seconds = value.get("seconds").and_then(|v| v.as_f64())?;
    let peak_rss_mb = value.get("peakRssMb").and_then(|v| v.as_f64());
    let device = value.get("device").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Some(MetricsEvent { seconds, peak_rss_mb, device })
}

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
    #[serde(default)]
    pub derived: Option<Derived>,
}

impl From<RawStem> for InstrumentStem {
    /// A stem with no measurements yet (see `stems::measure_all`).
    fn from(raw: RawStem) -> Self {
        InstrumentStem {
            key: raw.key,
            label: raw.label,
            group: raw.group,
            parent: raw.parent,
            path: raw.path,
            bytes: 0,
            peak_db: 0.0,
            rms_db: 0.0,
            model: raw.model,
            order: raw.order,
            duration_sec: 0.0,
            peaks: Vec::new(),
            tags: raw.tags,
            sounds_like: raw.sounds_like,
            display_label: raw.display_label,
            detections: raw.detections,
            confidence: raw.confidence,
            derived: raw.derived,
        }
    }
}

/// Parses one JSON line from separate.py's stdout into a `SeparateEvent`.
pub fn parse_separate_line(line: &str) -> SeparateEvent {
    match serde_json::from_str::<Value>(line) {
        Ok(v) => parse_separate_value(&v),
        Err(_) => SeparateEvent::Unknown,
    }
}

/// `parse_separate_line` for an already-parsed reply.
pub fn parse_separate_value(value: &Value) -> SeparateEvent {
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
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub mix_path: Option<String>,
    #[serde(default)]
    pub mix_gain: Option<f32>,
    #[serde(default)]
    pub enhanced: Vec<Region>,
}

impl From<&InstrumentsManifest> for InstrumentsMeta {
    fn from(m: &InstrumentsManifest) -> Self {
        InstrumentsMeta {
            elapsed_sec: m.elapsed_sec,
            pass_seconds: m.pass_seconds.clone(),
            device: m.device.clone(),
            failed_passes: m.failed_passes.clone(),
            quality: m.quality.clone(),
            mix_path: m.mix_path.clone(),
            mix_gain: m.mix_gain,
            enhanced: m.enhanced.clone(),
        }
    }
}

/// Result of the one-shot `separate` (CLI `full` pipeline).
pub struct SeparateResult {
    pub stems: Vec<InstrumentStem>,
    pub device: String,
    pub failed_passes: Vec<(String, String)>,
    pub elapsed_sec: f64,
    pub pass_seconds: HashMap<String, f64>,
    /// From the script's optional trailing `metrics` line (contract v8
    /// addendum "Performance metrics"); absent if the script didn't emit one.
    pub seconds: Option<f64>,
    pub peak_rss_mb: Option<f64>,
}

/// Pass timings/failures collected while a job runs, forwarding each
/// progress event to the caller.
#[derive(Default)]
struct JobLog {
    pass_seconds: HashMap<String, f64>,
    failed: Vec<FailedPass>,
}

impl JobLog {
    fn handle(&mut self, event: SeparateEvent, stage: &str, progress: &mut dyn FnMut(EngineProgress)) {
        let (pass, percent, message, failed) = match event {
            SeparateEvent::Progress { pass, percent, message } => (pass, percent, message, false),
            SeparateEvent::PassDone { pass, seconds } => {
                self.pass_seconds.insert(pass.clone(), seconds);
                (pass, 100.0, format!("done in {seconds:.1}s"), false)
            }
            SeparateEvent::PassFailed { pass, error } => {
                self.failed.push(FailedPass { pass: pass.clone(), error: error.clone() });
                (pass, -1.0, error, true)
            }
            _ => return,
        };
        progress(EngineProgress { stage: stage.to_string(), percent, message, pass: Some(pass), failed });
    }
}

/// Parses a `done` reply (the contract's SplitResult) into a manifest whose
/// stems are not measured yet.
pub fn manifest_from_done(done: &Value) -> InstrumentsManifest {
    let text = |k: &str| done.get(k).and_then(|v| v.as_str()).map(String::from);
    let stems: Vec<RawStem> = done
        .get("stems")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    InstrumentsManifest {
        stems: stems.into_iter().map(InstrumentStem::from).collect(),
        device: text("device").unwrap_or_default(),
        quality: text("quality"),
        mix_path: text("mixPath").filter(|p| !p.is_empty()),
        mix_gain: done.get("mixGain").and_then(|v| v.as_f64()).map(|g| g as f32),
        enhanced: done
            .get("enhanced")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default(),
        ..Default::default()
    }
}

/// A stem as the engine's StemEntry (no measurements) for `enhance`.
fn stem_entry(stem: &InstrumentStem) -> Value {
    let mut v = serde_json::to_value(stem).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        for k in ["bytes", "peakDb", "rmsDb", "durationSec", "peaks"] {
            o.remove(k);
        }
        o.entry("derived").or_insert(Value::Null);
    }
    v
}

/// Measures, stamps timing on, and saves a finished job's manifest.
/// `known` are stems whose measurements are still valid if unchanged.
#[allow(clippy::too_many_arguments)]
fn finish_job(
    work_dir: &Path,
    kind: StemSetKind,
    mut manifest: InstrumentsManifest,
    known: &[InstrumentStem],
    log: JobLog,
    timer: &super::progress::Timer,
    label: &str,
    perf_name: &str,
    done: &Value,
    keep_split_timing: Option<(f64, std::collections::HashMap<String, f64>, Vec<FailedPass>)>,
) -> Result<InstrumentsManifest, String> {
    // Materializations made mid-job may predate the final mixGain.
    let _ = std::fs::remove_dir_all(kind.out_dir(work_dir).join(stems::DERIVED_DIR));
    stems::measure_all(work_dir, kind, &mut manifest, known);
    // Enhance / sub-parts refine an existing split: its "Split took" timing stays the split's.
    if let Some((elapsed, pass_seconds, failed)) = keep_split_timing {
        manifest.elapsed_sec = elapsed;
        manifest.pass_seconds = pass_seconds;
        manifest.failed_passes = failed;
    } else {
        manifest.elapsed_sec = timer.elapsed_sec();
        manifest.pass_seconds = log.pass_seconds;
        manifest.failed_passes = log.failed;
    }
    stems::save_manifest(work_dir, kind, &manifest)?;
    let seconds = done.get("seconds").and_then(|v| v.as_f64()).unwrap_or(manifest.elapsed_sec);
    let peak = done.get("peakRssMb").and_then(|v| v.as_f64());
    let _ = workspace::log_perf(perf_name, Some(label), seconds, peak);
    Ok(manifest)
}

/// Runs one engine-server job under the global gate: forwards progress,
/// measures every `stem_ready` stem and hands it to `on_stem`, and returns
/// the `done` reply, the pass log and the stems reported early.
#[allow(clippy::too_many_arguments)]
fn server_job(
    label: &str,
    stage: &str,
    low_priority: bool,
    cmd: Value,
    work_dir: &Path,
    kind: StemSetKind,
    mix_path: &Path,
    progress: &mut dyn FnMut(EngineProgress),
    on_stem: &mut dyn FnMut(&InstrumentStem),
) -> Result<(Value, JobLog, Vec<InstrumentStem>), String> {
    let _gate = acquire_engine(label)?;
    let mut log = JobLog::default();
    let mut ready: Vec<InstrumentStem> = Vec::new();
    let done = engine_server::global().job(low_priority, cmd, |v| {
        if v.get("event").and_then(|e| e.as_str()) == Some("stem_ready") {
            let raw = v.get("stem").cloned().and_then(|s| serde_json::from_value::<RawStem>(s).ok());
            if let Some(raw) = raw {
                let mut stem = InstrumentStem::from(raw);
                stems::measure_one(work_dir, kind, &ready, mix_path, &mut stem);
                on_stem(&stem);
                ready.retain(|s| s.key != stem.key);
                ready.push(stem);
            }
        } else {
            log.handle(parse_separate_value(v), stage, progress);
        }
    })?;
    Ok((done, log, ready))
}

/// v11 split through the resident engine server: `quality` "quick" (top-level
/// stems, `other` derived) or "full" (the whole chain + sub-stems). Stems are
/// passed to `on_stem` as soon as each exists; writes `instruments.json`.
#[allow(clippy::too_many_arguments)]
pub fn split_song(
    source: &Path,
    work_dir: &Path,
    quality: &str,
    passes: Option<&[String]>,
    label: &str,
    low_priority: bool,
    mut progress: impl FnMut(EngineProgress),
    mut on_stem: impl FnMut(&InstrumentStem),
) -> Result<InstrumentsManifest, String> {
    let timer = super::progress::Timer::start();
    let kind = StemSetKind::Instruments;
    let out = kind.out_dir(work_dir);
    std::fs::create_dir_all(&out).map_err(|e| format!("failed to create instruments dir: {e}"))?;
    let _ = std::fs::remove_dir_all(out.join(stems::DERIVED_DIR));
    let mut cmd = json!({"cmd": "split", "input": source, "out": out, "quality": quality, "lowPriority": low_priority});
    if let Some(p) = passes {
        cmd["tag"] = json!(p.iter().any(|x| x == "tag"));
    }
    let (done, log, ready) =
        server_job(label, "separate", low_priority, cmd, work_dir, kind, source, &mut progress, &mut on_stem)?;
    let mut manifest = manifest_from_done(&done);
    manifest.quality.get_or_insert_with(|| quality.to_string());
    manifest.mix_path.get_or_insert_with(|| source.to_string_lossy().to_string());
    finish_job(work_dir, kind, manifest, &ready, log, &timer, label, "separate", &done, None)
}

/// Fast 2-stem karaoke split (contract v7 "Karaoke", v11 server form):
/// `vocals` (file) + `instrumental` (derived), and with `lead` also
/// `lead_vocals` + `backing_vocals`; writes `karaoke/karaoke.json`.
pub fn separate_karaoke(
    source: &Path,
    work_dir: &Path,
    lead: bool,
    low_priority: bool,
    label: &str,
    mut progress: impl FnMut(EngineProgress),
) -> Result<InstrumentsManifest, String> {
    let timer = super::progress::Timer::start();
    let kind = StemSetKind::Karaoke;
    let out = kind.out_dir(work_dir);
    std::fs::create_dir_all(&out).map_err(|e| format!("failed to create karaoke dir: {e}"))?;
    let cmd = json!({"cmd": "karaoke", "input": source, "out": out, "lead": lead});
    let (done, log, ready) =
        server_job(label, "karaoke", low_priority, cmd, work_dir, kind, source, &mut progress, &mut |_| {})?;
    let mut manifest = manifest_from_done(&done);
    manifest.mix_path.get_or_insert_with(|| source.to_string_lossy().to_string());
    finish_job(work_dir, kind, manifest, &ready, log, &timer, label, "separate_karaoke", &done, None)
}

/// `enhance_region`: re-runs the full chain over `[start, end]` (the engine
/// pads and crossfades it) and rewrites the affected stems as new versioned
/// files. Updates `instruments.json` atomically.
pub fn enhance(
    work_dir: &Path,
    start: f64,
    end: f64,
    label: &str,
    mut progress: impl FnMut(EngineProgress),
) -> Result<InstrumentsManifest, String> {
    if !(end > start && start >= 0.0) {
        return Err("enhance region end must be after start".to_string());
    }
    let timer = super::progress::Timer::start();
    let kind = StemSetKind::Instruments;
    let old = stems::load_manifest(work_dir, kind).ok_or("split the song before enhancing it")?;
    let mix = stems::StemSet::new(work_dir, kind, &old).mix_path;
    let cmd = json!({
        "cmd": "enhance", "input": mix, "out": kind.out_dir(work_dir), "start": start, "end": end,
        "stems": old.stems.iter().map(stem_entry).collect::<Vec<_>>(),
        "mixGain": old.mix_gain.unwrap_or(1.0), "enhanced": old.enhanced, "quality": old.quality,
    });
    let (done, log, _) =
        server_job(label, "enhance", false, cmd, work_dir, kind, &mix, &mut progress, &mut |_| {})?;
    let mut manifest = manifest_from_done(&done);
    if manifest.device.is_empty() {
        manifest.device = old.device.clone();
    }
    manifest.quality = manifest.quality.or(old.quality.clone());
    manifest.mix_path = manifest.mix_path.or(old.mix_path.clone());
    manifest.mix_gain = manifest.mix_gain.or(old.mix_gain);
    if done.get("enhanced").is_none() {
        manifest.enhanced = old.enhanced.clone();
        manifest.enhanced.push(Region { start, end });
    }
    drop_stale_analysis(work_dir, &old, &manifest);
    // Derived stems keep their recipe but their inputs changed: re-measure.
    let timing = Some((old.elapsed_sec, old.pass_seconds.clone(), old.failed_passes.clone()));
    let known: Vec<InstrumentStem> = old.stems.into_iter().filter(|s| !stems::is_derived(s)).collect();
    finish_job(work_dir, kind, manifest, &known, log, &timer, label, "enhance", &done, timing)
}

/// `split_substems`: splits `parent` ("vocals" | "drums") into its sub-parts
/// and replaces that parent's existing children in `instruments.json`.
pub fn substems(
    work_dir: &Path,
    parent: &str,
    label: &str,
    mut progress: impl FnMut(EngineProgress),
    mut on_stem: impl FnMut(&InstrumentStem),
) -> Result<InstrumentsManifest, String> {
    if !matches!(parent, "vocals" | "drums") {
        return Err(format!("no sub-parts for '{parent}' (vocals or drums only)"));
    }
    let timer = super::progress::Timer::start();
    let kind = StemSetKind::Instruments;
    let old = stems::load_manifest(work_dir, kind).ok_or("split the song before splitting its parts")?;
    let set = stems::StemSet::new(work_dir, kind, &old);
    let input = set.file_for(parent)?;
    let mix = set.mix_path.clone();
    let cmd = json!({
        "cmd": "substems", "parent": parent, "input": input, "out": kind.out_dir(work_dir),
        "mixGain": old.mix_gain.unwrap_or(1.0),
    });
    let (done, log, ready) =
        server_job(label, "substems", false, cmd, work_dir, kind, &mix, &mut progress, &mut on_stem)?;
    let children = manifest_from_done(&done).stems;
    let timing = Some((old.elapsed_sec, old.pass_seconds.clone(), old.failed_passes.clone()));
    let mut manifest = old.clone();
    manifest.stems.retain(|s| s.parent.as_deref() != Some(parent));
    manifest.stems.extend(children);
    drop_stale_analysis(work_dir, &old, &manifest);
    // Old children may be overwritten in place: never reuse their numbers.
    let mut known: Vec<InstrumentStem> =
        old.stems.into_iter().filter(|s| s.parent.as_deref() != Some(parent)).collect();
    known.extend(ready);
    finish_job(work_dir, kind, manifest, &known, log, &timer, label, "substems", &done, timing)
}

/// Removes per-file analysis caches (`analysis/<file stem>.json`) of stem
/// files that are gone or may have been rewritten in place.
fn drop_stale_analysis(work_dir: &Path, old: &InstrumentsManifest, new: &InstrumentsManifest) {
    for s in old.stems.iter().filter(|s| !s.path.is_empty()) {
        let replaced = !new.stems.iter().any(|n| n.path == s.path) || s.parent.is_some();
        if let (true, Some(stem)) = (replaced, Path::new(&s.path).file_stem()) {
            let _ = std::fs::remove_file(work_dir.join("analysis").join(format!("{}.json", stem.to_string_lossy())));
        }
    }
}

/// One-shot `separate.py` run (no server; used by the CLI `full` pipeline):
/// writes `instruments.json` and returns the measured stems.
pub fn separate(
    loop_wav: &Path,
    work_dir: &Path,
    passes: &[String],
    label: &str,
    low_priority: bool,
    mut progress: impl FnMut(EngineProgress),
) -> Result<SeparateResult, String> {
    let _busy_guard = BusyGuard::acquire(label)?;
    let timer = super::progress::Timer::start();
    let (venv_python, script_path, models) = prepare_script()?;
    let kind = StemSetKind::Instruments;
    let instruments_out = kind.out_dir(work_dir);
    std::fs::create_dir_all(&instruments_out).map_err(|e| format!("failed to create instruments dir: {e}"))?;

    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.arg(&script_path)
        .arg("--input")
        .arg(loop_wav)
        .arg("--out")
        .arg(&instruments_out)
        .arg("--passes")
        .arg(passes.join(","))
        .arg("--models-dir")
        .arg(models)
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
            // BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW (this call
            // replaces the flags `silent_command` set).
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
            cmd.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | super::CREATE_NO_WINDOW);
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn separate.py: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stderr_lines = std::thread::spawn(move || -> Vec<String> {
        stderr.map(|s| BufReader::new(s).lines().map_while(Result::ok).collect()).unwrap_or_default()
    });

    let mut device = String::new();
    let mut done: Option<Value> = None;
    let mut fatal_error: Option<String> = None;
    let mut metrics: Option<MetricsEvent> = None;
    let mut log = JobLog::default();
    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(m) = parse_metrics_line(&line) {
                metrics = Some(m);
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            match parse_separate_value(&value) {
                SeparateEvent::Device { device: d, .. } => device = d,
                SeparateEvent::Done { .. } => done = Some(value),
                SeparateEvent::Fatal { error } => fatal_error = Some(error),
                event => log.handle(event, "separate", &mut progress),
            }
        }
    }

    let status = child.wait().map_err(|e| format!("failed to wait on separate.py: {e}"))?;
    let stderr_all = stderr_lines.join().unwrap_or_default();
    if !status.success() || fatal_error.is_some() {
        let mut msg = match &fatal_error {
            Some(err) => format!("separate.py fatal error: {err}\n"),
            None => format!("separate.py exited with {:?}\n", status.code()),
        };
        let tail = &stderr_all[stderr_all.len().saturating_sub(20)..];
        if !tail.is_empty() {
            msg.push_str("--- stderr tail ---\n");
            msg.push_str(&tail.join("\n"));
        }
        return Err(msg);
    }

    let done = done.unwrap_or(Value::Null);
    let mut manifest = manifest_from_done(&done);
    if manifest.device.is_empty() {
        manifest.device = device;
    }
    manifest.mix_path.get_or_insert_with(|| loop_wav.to_string_lossy().to_string());
    let perf = match &metrics {
        Some(m) => json!({"seconds": m.seconds, "peakRssMb": m.peak_rss_mb}),
        None => json!({}),
    };
    let manifest = finish_job(work_dir, kind, manifest, &[], log, &timer, label, "separate", &perf, None)?;
    Ok(SeparateResult {
        stems: manifest.stems,
        device: manifest.device,
        failed_passes: manifest.failed_passes.into_iter().map(|f| (f.pass, f.error)).collect(),
        elapsed_sec: manifest.elapsed_sec,
        pass_seconds: manifest.pass_seconds,
        seconds: metrics.as_ref().map(|m| m.seconds),
        peak_rss_mb: metrics.and_then(|m| m.peak_rss_mb),
    })
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

    /// Serializes tests that touch the process-wide `BUSY` static, so
    /// parallel test threads don't see each other's acquire/release.
    fn busy_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn busy_guard_clears_on_drop() {
        let _lock = busy_test_lock().lock().unwrap();
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

    /// Global engine gate (contract v8 addendum "Hard safety rules" #1):
    /// a second concurrent `acquire_engine` while the first guard is still
    /// held must be rejected immediately, without blocking.
    #[test]
    fn acquire_engine_rejects_second_concurrent_acquire() {
        let _lock = busy_test_lock().lock().unwrap();
        let _g1 = acquire_engine("analyze_pitch: song.wav").expect("first acquire should succeed");
        let err = acquire_engine("apply_autotune: song.wav").expect_err("second acquire must fail");
        assert!(err.contains("engine busy"));
        assert!(err.contains("analyze_pitch: song.wav"));
        drop(_g1);
        let _g2 = acquire_engine("apply_autotune: song.wav").expect("acquire after drop should succeed");
    }

    #[test]
    fn parses_metrics_line_from_sample_transcript() {
        let transcript = concat!(
            "{\"event\":\"progress\",\"pass\":\"analyze\",\"percent\":50,\"message\":\"running\"}\n",
            "{\"event\":\"metrics\",\"seconds\":23.4,\"peakRssMb\":1096.7,\"device\":\"cuda\"}\n",
        );
        let mut metrics = None;
        for line in transcript.lines() {
            if let Some(m) = parse_metrics_line(line) {
                metrics = Some(m);
            }
        }
        let metrics = metrics.expect("metrics line should parse");
        assert_eq!(metrics.seconds, 23.4);
        assert_eq!(metrics.peak_rss_mb, Some(1096.7));
        assert_eq!(metrics.device, "cuda");
    }

    #[test]
    fn parses_metrics_line_with_missing_peak_rss() {
        let line = r#"{"event":"metrics","seconds":1.5,"device":"cpu"}"#;
        let metrics = parse_metrics_line(line).expect("should parse");
        assert_eq!(metrics.peak_rss_mb, None);
    }

    #[test]
    fn non_metrics_lines_are_ignored() {
        assert!(parse_metrics_line(r#"{"event":"done"}"#).is_none());
        assert!(parse_metrics_line("not json").is_none());
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
