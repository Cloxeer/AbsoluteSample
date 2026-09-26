//! Spectrum/band/tuning analysis via the embedded `engine/frequencies.py`
//! (contract v7 addendum "Frequencies tab"). Mirrors `notes.rs`'s pattern:
//! `engine/frequencies.py` is embedded via `include_str!` and rewritten to
//! disk before every run, then driven with the engine's venv python.

use super::engine::{engine_dir, venv_python_path};
use super::silent_command;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// The `engine/frequencies.py` script embedded at compile time. Path is
/// relative to this file: `src/audio/frequencies.rs` -> repo root is 5
/// levels up (audio, src, src-tauri, desktop, apps).
const FREQUENCIES_PY: &str = include_str!("../../../../../engine/frequencies.py");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpectrumPoint {
    pub hz: f64,
    pub db: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrequencyBand {
    pub key: String,
    pub name: String,
    pub low_hz: f64,
    pub high_hz: f64,
    pub db: f64,
    pub share_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerNote {
    pub name: String,
    pub cents: f64,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    pub reference_hz: f64,
    pub avg_cents_off: f64,
    pub in_tune_pct: f64,
    pub estimated_ref_hz: f64,
    #[serde(default)]
    pub per_note: Vec<PerNote>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrequencyKey {
    pub tonic: String,
    pub mode: String,
    pub confidence: f64,
    pub camelot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrequencyResult {
    pub spectrum: Vec<SpectrumPoint>,
    pub bands: Vec<FrequencyBand>,
    pub tuning: Tuning,
    pub key: FrequencyKey,
    pub duration_sec: f64,
}

/// `<wav dir>/<stem>.freq.json` cache path for a given wav path.
fn cache_path_for(wav: &Path) -> PathBuf {
    let stem = wav.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    wav.parent().unwrap_or_else(|| Path::new(".")).join(format!("{stem}.freq.json"))
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

/// Parses one stdout JSON line from `frequencies.py` into a `FrequencyResult`
/// (on `"done"`) or an error message (on `"fatal"` or an unrecognized line).
fn parse_frequencies_line(line: &str) -> Result<Option<FrequencyResult>, String> {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    match value.get("event").and_then(|v| v.as_str()).unwrap_or("") {
        "done" => {
            let result: FrequencyResult = serde_json::from_value(value)
                .map_err(|e| format!("failed to parse frequencies.py done event: {e}"))?;
            Ok(Some(result))
        }
        "fatal" => Err(format!(
            "frequencies.py fatal error: {}",
            value.get("error").and_then(|v| v.as_str()).unwrap_or("")
        )),
        _ => Ok(None),
    }
}

/// Analyzes `path` (any wav) via `frequencies.py`. Cached next to the wav as
/// `<wav dir>/<stem>.freq.json`; a fresh cache (mtime >= wav's mtime) is
/// returned without re-running the script.
pub fn analyze_frequencies(path: &Path, bpm: Option<f64>) -> Result<FrequencyResult, String> {
    let cache = cache_path_for(path);
    if cache_is_fresh(&cache, path) {
        let text = std::fs::read_to_string(&cache).map_err(|e| format!("failed to read {}: {e}", cache.display()))?;
        if let Ok(result) = serde_json::from_str::<FrequencyResult>(&text) {
            return Ok(result);
        }
    }

    let engine = engine_dir()?;
    std::fs::create_dir_all(&engine).map_err(|e| format!("failed to create engine dir: {e}"))?;
    let script_path = engine.join("frequencies.py");
    std::fs::write(&script_path, FREQUENCIES_PY).map_err(|e| format!("failed to write frequencies.py: {e}"))?;

    let venv_python = venv_python_path(&engine);
    if !venv_python.exists() {
        return Err(format!("engine not installed: {} not found", venv_python.display()));
    }

    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.arg(&script_path)
        .arg("--input")
        .arg(path)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(bpm) = bpm {
        cmd.arg("--bpm").arg(bpm.to_string());
    }

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn frequencies.py: {e}"))?;
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

    let mut result: Option<FrequencyResult> = None;
    let mut error: Option<String> = None;
    if let Some(stdout) = stdout {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            match parse_frequencies_line(&line) {
                Ok(Some(r)) => result = Some(r),
                Ok(None) => {}
                Err(e) => error = Some(e),
            }
        }
    }

    let status = child.wait().map_err(|e| format!("failed to wait on frequencies.py: {e}"))?;
    let stderr_tail: Vec<String> = stderr_lines.join().unwrap_or_default().into_iter().rev().take(20).rev().collect();

    if let Some(e) = error {
        return Err(e);
    }
    if !status.success() {
        let mut msg = format!("frequencies.py exited with {:?}\n", status.code());
        if !stderr_tail.is_empty() {
            msg.push_str("--- stderr tail ---\n");
            msg.push_str(&stderr_tail.join("\n"));
        }
        return Err(msg);
    }

    let result = result.ok_or_else(|| "frequencies.py did not emit a done event".to_string())?;

    if let Ok(json) = serde_json::to_string_pretty(&result) {
        let _ = std::fs::write(&cache, json);
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_done_event_sample() {
        let line = r#"{"event":"done","spectrum":[{"hz":20.0,"db":-30.0}],"bands":[{"key":"sub","name":"Sub","lowHz":20.0,"highHz":60.0,"db":-40.0,"sharePct":1.5}],"tuning":{"referenceHz":440.0,"avgCentsOff":2.3,"inTunePct":82.0,"estimatedRefHz":442.0,"perNote":[{"name":"A4","cents":1.0,"count":10}]},"key":{"tonic":"G","mode":"major","confidence":0.7,"camelot":"9B"},"durationSec":123.4}"#;
        let result = parse_frequencies_line(line).unwrap().expect("done result");
        assert_eq!(result.spectrum.len(), 1);
        assert_eq!(result.bands[0].key, "sub");
        assert_eq!(result.tuning.estimated_ref_hz, 442.0);
        assert_eq!(result.key.camelot, "9B");
        assert_eq!(result.duration_sec, 123.4);
    }

    #[test]
    fn parses_fatal_event_as_error() {
        let line = r#"{"event":"fatal","error":"boom"}"#;
        let err = parse_frequencies_line(line).unwrap_err();
        assert!(err.contains("boom"));
    }

    #[test]
    fn unknown_line_is_ignored() {
        let result = parse_frequencies_line("not json").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn cache_freshness_checks_mtime() {
        let dir = std::env::temp_dir().join(format!("freq_rs_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("a.wav");
        let cache = dir.join("a.freq.json");
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
