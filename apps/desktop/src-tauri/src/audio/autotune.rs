//! Pitch analysis (WORLD f0) and pitch-correction via the embedded
//! `engine/autotune.py` (contract v7 addendum "Autotune / Voice enhancer").
//! Mirrors `notes.rs`'s pattern: `engine/autotune.py` is embedded via
//! `include_str!` and rewritten to disk before every run, then driven with
//! the engine's venv python.

use super::engine::{acquire_engine, engine_dir, parse_metrics_line, venv_python_path};
use super::silent_command;
use super::workspace::log_perf;
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
    /// Wall-clock seconds for the analyze run (contract v8 addendum
    /// "Performance metrics"), from the script's final `metrics` line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_rss_mb: Option<f64>,
    /// Path to the `<stem>.pitch.json` cache this result was written to (or
    /// read from), so the frontend can pass it back as `pitchCachePath` for
    /// fast region previews (contract v8 addendum "Region preview").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutotuneResult {
    pub path: String,
    pub peaks: Vec<f32>,
    pub duration_sec: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_rss_mb: Option<f64>,
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
/// JSON object (as a `serde_json::Value`) plus any trailing `"metrics"`
/// event on success.
fn run_autotune_py(args: &[&str]) -> Result<(serde_json::Value, Option<super::engine::MetricsEvent>), String> {
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
    let mut metrics: Option<super::engine::MetricsEvent> = None;
    if let Some(stdout) = stdout {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(m) = parse_metrics_line(&line) {
                metrics = Some(m);
                continue;
            }
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

    let done = done.ok_or_else(|| "autotune.py did not emit a done event".to_string())?;
    Ok((done, metrics))
}

/// Analyzes pitch (WORLD f0) for `path` (any wav) via `autotune.py --mode
/// analyze`. Cached next to the wav as `<wav dir>/<stem>.pitch.json`; a
/// fresh cache (mtime >= wav's mtime) is returned without re-running the
/// script.
pub fn analyze_pitch(path: &Path) -> Result<PitchResult, String> {
    let cache = pitch_cache_path_for(path);
    let cache_path_str = cache.to_string_lossy().to_string();
    if cache_is_fresh(&cache, path) {
        let text = std::fs::read_to_string(&cache).map_err(|e| format!("failed to read {}: {e}", cache.display()))?;
        if let Ok(mut result) = serde_json::from_str::<PitchResult>(&text) {
            result.cache_path = Some(cache_path_str);
            return Ok(result);
        }
    }

    let label = format!(
        "analyze_pitch: {}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("wav")
    );
    let _guard = acquire_engine(&label)?;

    let path_s = path.to_string_lossy().to_string();
    let (value, metrics) = run_autotune_py(&["--mode", "analyze", "--input", &path_s])?;
    let mut result: PitchResult =
        serde_json::from_value(value).map_err(|e| format!("failed to parse autotune.py analyze result: {e}"))?;

    if let Some(m) = &metrics {
        result.seconds = Some(m.seconds);
        result.peak_rss_mb = m.peak_rss_mb;
        let _ = log_perf("analyze_pitch", None, m.seconds, m.peak_rss_mb);
    }
    result.cache_path = Some(cache_path_str);

    if let Ok(json) = serde_json::to_string_pretty(&result) {
        let _ = std::fs::write(&cache, json);
    }
    Ok(result)
}

/// Applies pitch-correction `edits` (contract shape: `{snapStrength, scale,
/// transitionMs, notes}`, passed through verbatim) to `path` via
/// `autotune.py --mode apply`, writing the result to
/// `<wav dir>/autotune/<stem>_tuned.wav`.
pub fn apply_autotune(
    path: &Path,
    edits: &serde_json::Value,
    region_start_sec: Option<f64>,
    region_end_sec: Option<f64>,
    pitch_cache_path: Option<&str>,
) -> Result<AutotuneResult, String> {
    let label = format!(
        "apply_autotune: {}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("wav")
    );
    let _guard = acquire_engine(&label)?;

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
    let mut args: Vec<String> = vec![
        "--mode".to_string(), "apply".to_string(),
        "--input".to_string(), path_s,
        "--edits".to_string(), edits_s,
        "--out".to_string(), out_s.clone(),
    ];
    if let Some(start) = region_start_sec {
        args.push("--region-start".to_string());
        args.push(start.to_string());
    }
    if let Some(end) = region_end_sec {
        args.push("--region-end".to_string());
        args.push(end.to_string());
    }
    if let Some(cache) = pitch_cache_path {
        args.push("--pitch-cache".to_string());
        args.push(cache.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (value, metrics) = run_autotune_py(&arg_refs)?;

    let result_path = value.get("path").and_then(|v| v.as_str()).unwrap_or(&out_s).to_string();
    let result_path_buf = PathBuf::from(&result_path);
    let peaks = super::peaks::compute_peaks_for_path(&result_path_buf).unwrap_or_default();
    let duration_sec = super::downloader::probe(&result_path_buf).map(|p| p.duration_sec).unwrap_or(0.0);

    let (seconds, peak_rss_mb) = match &metrics {
        Some(m) => {
            let _ = log_perf("apply_autotune", None, m.seconds, m.peak_rss_mb);
            (Some(m.seconds), m.peak_rss_mb)
        }
        None => (None, None),
    };

    Ok(AutotuneResult { path: result_path, peaks, duration_sec, seconds, peak_rss_mb })
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
