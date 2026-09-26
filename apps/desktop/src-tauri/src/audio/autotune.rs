//! Pitch analysis (WORLD f0) and pitch-correction via the embedded
//! `engine/autotune.py` (contract v7 addendum "Autotune / Voice enhancer").
//! Mirrors `notes.rs`'s pattern: `engine/autotune.py` is embedded via
//! `include_str!` and rewritten to disk before every run, then driven with
//! the engine's venv python.

use super::engine::{engine_dir, venv_python_path};
use super::silent_command;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// The `engine/autotune.py` script embedded at compile time. Path is
/// relative to this file: `src/audio/autotune.rs` -> repo root is 5 levels
/// up (audio, src, src-tauri, desktop, apps).
const AUTOTUNE_PY: &str = include_str!("../../../../../engine/autotune.py");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct F0Point {
    pub t: f64,
    pub hz: f64,
    pub midi: Option<f64>,
    pub cents: Option<f64>,
    pub voiced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PitchNote {
    pub start_sec: f64,
    pub end_sec: f64,
    pub midi: i64,
    pub cents: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PitchKey {
    pub tonic: String,
    pub mode: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PitchResult {
    pub sample_rate: u32,
    pub hop_sec: f64,
    pub f0: Vec<F0Point>,
    pub notes: Vec<PitchNote>,
    pub key: PitchKey,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutotuneResult {
    pub path: String,
    pub peaks: Vec<f32>,
    pub duration_sec: f64,
}

/// `<wav dir>/<stem>.pitch.json` cache path for a given wav path.
fn pitch_cache_path_for(wav: &Path) -> PathBuf {
    let stem = wav.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    wav.parent().unwrap_or_else(|| Path::new(".")).join(format!("{stem}.pitch.json"))
}

/// True if `cache` exists and its mtime is newer than `wav`'s.
fn cache_is_fresh(cache: &Path, wav: &Path) -> bool {
    let (Ok(cache_meta), Ok(wav_meta)) = (std::fs::metadata(cache), std::fs::metadata(wav)) else {
        return false;
    };
    let (Ok(cache_mtime), Ok(wav_mtime)) = (cache_meta.modified(), wav_meta.modified()) else {
        return false;
    };
    cache_mtime >= wav_mtime
}

fn write_script(engine: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(engine).map_err(|e| format!("failed to create engine dir: {e}"))?;
    let script_path = engine.join("autotune.py");
    std::fs::write(&script_path, AUTOTUNE_PY).map_err(|e| format!("failed to write autotune.py: {e}"))?;
    Ok(script_path)
}

/// Runs `autotune.py` with the given args, returning the single `"done"`
/// JSON object (as a `serde_json::Value`) on success.
fn run_autotune_py(args: &[&str]) -> Result<serde_json::Value, String> {
    let engine = engine_dir()?;
    let script_path = write_script(&engine)?;
    let venv_python = venv_python_path(&engine);
    if !venv_python.exists() {
        return Err(format!("engine not installed: {} not found", venv_python.display()));
    }

    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.arg(&script_path)
        .args(args)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn autotune.py: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stderr_lines = std::thread::spawn(move || -> Vec<String> {
        let mut lines = Vec::new();
        if let Some(stderr) = stderr {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                lines.push(line);
            }
        }
        lines
    });

    let mut done: Option<serde_json::Value> = None;
    let mut fatal: Option<String> = None;
    if let Some(stdout) = stdout {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match value.get("event").and_then(|v| v.as_str()).unwrap_or("") {
                "done" => done = Some(value),
                "fatal" => fatal = Some(value.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string()),
                _ => {}
            }
        }
    }

    let status = child.wait().map_err(|e| format!("failed to wait on autotune.py: {e}"))?;
    let stderr_tail: Vec<String> = stderr_lines.join().unwrap_or_default().into_iter().rev().take(20).rev().collect();

    if !status.success() || fatal.is_some() {
        let mut msg = String::new();
        if let Some(err) = &fatal {
            msg.push_str(&format!("autotune.py fatal error: {err}\n"));
        } else {
            msg.push_str(&format!("autotune.py exited with {:?}\n", status.code()));
        }
        if !stderr_tail.is_empty() {
            msg.push_str("--- stderr tail ---\n");
            msg.push_str(&stderr_tail.join("\n"));
        }
        return Err(msg);
    }

    done.ok_or_else(|| "autotune.py did not emit a done event".to_string())
}

/// Analyzes pitch (WORLD f0) for `path` (any wav) via `autotune.py --mode
/// analyze`. Cached next to the wav as `<wav dir>/<stem>.pitch.json`; a
/// fresh cache (mtime >= wav's mtime) is returned without re-running the
/// script.
pub fn analyze_pitch(path: &Path) -> Result<PitchResult, String> {
    let cache = pitch_cache_path_for(path);
    if cache_is_fresh(&cache, path) {
        let text = std::fs::read_to_string(&cache).map_err(|e| format!("failed to read {}: {e}", cache.display()))?;
        if let Ok(result) = serde_json::from_str::<PitchResult>(&text) {
            return Ok(result);
        }
    }

    let path_s = path.to_string_lossy().to_string();
    let value = run_autotune_py(&["--mode", "analyze", "--input", &path_s])?;
    let result: PitchResult =
        serde_json::from_value(value).map_err(|e| format!("failed to parse autotune.py analyze result: {e}"))?;

    if let Ok(json) = serde_json::to_string_pretty(&result) {
        let _ = std::fs::write(&cache, json);
    }
    Ok(result)
}

/// Applies pitch-correction `edits` (contract shape: `{snapStrength, scale,
/// transitionMs, notes}`, passed through verbatim) to `path` via
/// `autotune.py --mode apply`, writing the result to
/// `<wav dir>/autotune/<stem>_tuned.wav`.
pub fn apply_autotune(path: &Path, edits: &serde_json::Value) -> Result<AutotuneResult, String> {
    let out_dir = path.parent().unwrap_or_else(|| Path::new(".")).join("autotune");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("failed to create autotune dir: {e}"))?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");

    let edits_path = out_dir.join(format!("{stem}_edits.json"));
    let edits_json = serde_json::to_string(edits).map_err(|e| format!("failed to serialize edits: {e}"))?;
    std::fs::write(&edits_path, edits_json).map_err(|e| format!("failed to write edits json: {e}"))?;

    let out_path = out_dir.join(format!("{stem}_tuned.wav"));

    let path_s = path.to_string_lossy().to_string();
    let edits_s = edits_path.to_string_lossy().to_string();
    let out_s = out_path.to_string_lossy().to_string();
    let value = run_autotune_py(&["--mode", "apply", "--input", &path_s, "--edits", &edits_s, "--out", &out_s])?;

    let result_path = value.get("path").and_then(|v| v.as_str()).unwrap_or(&out_s).to_string();
    let result_path_buf = PathBuf::from(&result_path);
    let peaks = super::peaks::compute_peaks_for_path(&result_path_buf).unwrap_or_default();
    let duration_sec = super::downloader::probe(&result_path_buf).map(|p| p.duration_sec).unwrap_or(0.0);

    Ok(AutotuneResult { path: result_path, peaks, duration_sec })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_analyze_result_sample() {
        let sample = r#"{
            "event":"done",
            "sampleRate":44100,
            "hopSec":0.01,
            "f0":[{"t":0.0,"hz":220.0,"midi":57.0,"cents":0.0,"voiced":true},{"t":0.01,"hz":0.0,"midi":null,"cents":null,"voiced":false}],
            "notes":[{"startSec":0.0,"endSec":0.5,"midi":57,"cents":1.2,"confidence":0.9}],
            "key":{"tonic":"A","mode":"minor","confidence":0.5}
        }"#;
        let value: serde_json::Value = serde_json::from_str(sample).unwrap();
        let result: PitchResult = serde_json::from_value(value).expect("parse");
        assert_eq!(result.sample_rate, 44100);
        assert_eq!(result.f0.len(), 2);
        assert_eq!(result.f0[0].midi, Some(57.0));
        assert_eq!(result.f0[1].midi, None);
        assert!(!result.f0[1].voiced);
        assert_eq!(result.notes[0].midi, 57);
        assert_eq!(result.key.tonic, "A");
    }

    #[test]
    fn parses_apply_result_sample() {
        let sample = r#"{"event":"done","path":"C:/out/vocals_tuned.wav"}"#;
        let value: serde_json::Value = serde_json::from_str(sample).unwrap();
        assert_eq!(value.get("path").and_then(|v| v.as_str()), Some("C:/out/vocals_tuned.wav"));
    }

    #[test]
    fn cache_freshness_checks_mtime() {
        let dir = std::env::temp_dir().join(format!("autotune_rs_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("a.wav");
        let cache = dir.join("a.pitch.json");
        std::fs::write(&wav, b"wav").unwrap();
        assert!(!cache_is_fresh(&cache, &wav));

        std::fs::write(&cache, b"{}").unwrap();
        assert!(cache_is_fresh(&cache, &wav));

        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&wav, b"wav2").unwrap();
        assert!(!cache_is_fresh(&cache, &wav));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
