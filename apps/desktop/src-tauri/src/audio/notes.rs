//! Note/key/chord extraction via the embedded `engine/notes.py` (Basic
//! Pitch, free, local). Contract v6 "Notes" section.
//!
//! Mirrors `engine.rs`'s pattern: the repo's `engine/notes.py` is embedded
//! via `include_str!` and rewritten to `<engine>/notes.py` before every run,
//! then driven with the engine's venv python.

use super::engine::{engine_dir, venv_python_path};
use super::silent_command;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

/// The `engine/notes.py` script embedded at compile time. Path is relative
/// to this file: `src/audio/notes.rs` -> repo root is 5 levels up (audio,
/// src, src-tauri, desktop, apps).
const NOTES_PY: &str = include_str!("../../../../../engine/notes.py");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub start_sec: f64,
    pub end_sec: f64,
    pub midi: i64,
    pub name: String,
    pub velocity: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub tonic: String,
    pub mode: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chord {
    pub start_sec: f64,
    pub end_sec: f64,
    pub name: String,
    pub notes: Vec<String>,
}

/// The `<stem>.notes.json` shape written by `notes.py`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
struct NotesJson {
    #[serde(default)]
    notes: Vec<Note>,
    #[serde(default)]
    key: Option<Key>,
    #[serde(default)]
    chords: Vec<Chord>,
    #[serde(default)]
    scale: Vec<String>,
    #[serde(default)]
    bpm: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotesResult {
    pub notes: Vec<Note>,
    pub key: Option<Key>,
    pub chords: Vec<Chord>,
    pub scale: Vec<String>,
    pub bpm: Option<f64>,
    pub mid_path: String,
    pub elapsed_sec: f64,
}

/// One parsed line of `notes.py`'s final-JSON-line protocol.
#[derive(Debug, Clone, PartialEq)]
enum NotesEvent {
    Done { json: String, mid: String },
    Fatal { error: String },
    Unknown,
}

/// Parses one JSON line from `notes.py`'s stdout.
fn parse_notes_line(line: &str) -> NotesEvent {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return NotesEvent::Unknown,
    };
    match value.get("event").and_then(|v| v.as_str()).unwrap_or("") {
        "done" => NotesEvent::Done {
            json: value.get("json").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            mid: value.get("mid").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        },
        "fatal" => NotesEvent::Fatal {
            error: value.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        },
        _ => NotesEvent::Unknown,
    }
}

/// The `<wav dir>/notes/` output directory for a given wav path.
fn notes_dir_for(wav: &Path) -> PathBuf {
    wav.parent().unwrap_or_else(|| Path::new(".")).join("notes")
}

/// `<dir>/<stem>.notes.json` cache path for a given wav path.
fn cache_path_for(wav: &Path) -> PathBuf {
    let stem = wav.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    notes_dir_for(wav).join(format!("{stem}.notes.json"))
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

fn load_notes_result(json_path: &Path, mid_path: &Path, elapsed_sec: f64) -> Result<NotesResult, String> {
    let text = std::fs::read_to_string(json_path)
        .map_err(|e| format!("failed to read {}: {e}", json_path.display()))?;
    let parsed: NotesJson =
        serde_json::from_str(&text).map_err(|e| format!("failed to parse {}: {e}", json_path.display()))?;
    Ok(NotesResult {
        notes: parsed.notes,
        key: parsed.key,
        chords: parsed.chords,
        scale: parsed.scale,
        bpm: parsed.bpm,
        mid_path: mid_path.to_string_lossy().to_string(),
        elapsed_sec,
    })
}

/// Extracts notes/key/chords/scale from `path` (any wav) via `notes.py`.
/// Cached next to the wav as `<wav dir>/notes/<stem>.notes.json`; a fresh
/// cache (mtime >= wav's mtime) is returned without re-running the script.
pub fn extract_notes(path: &Path, bpm: Option<f64>) -> Result<NotesResult, String> {
    let dir = notes_dir_for(path);
    let cache = cache_path_for(path);
    let mid_path = dir.join(format!(
        "{}.mid",
        path.file_stem().and_then(|s| s.to_str()).unwrap_or("output")
    ));

    if cache_is_fresh(&cache, path) {
        return load_notes_result(&cache, &mid_path, 0.0);
    }

    let start = Instant::now();
    let engine = engine_dir()?;
    std::fs::create_dir_all(&engine).map_err(|e| format!("failed to create engine dir: {e}"))?;
    let script_path = engine.join("notes.py");
    std::fs::write(&script_path, NOTES_PY).map_err(|e| format!("failed to write notes.py: {e}"))?;

    let venv_python = venv_python_path(&engine);
    if !venv_python.exists() {
        return Err(format!("engine not installed: {} not found", venv_python.display()));
    }

    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create notes dir: {e}"))?;

    let mut cmd = silent_command(&venv_python.to_string_lossy());
    cmd.arg(&script_path)
        .arg("--input")
        .arg(path)
        .arg("--out")
        .arg(&dir)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(bpm) = bpm {
        cmd.arg("--bpm").arg(bpm.to_string());
    }

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn notes.py: {e}"))?;
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

    let mut done: Option<(String, String)> = None;
    let mut fatal: Option<String> = None;
    if let Some(stdout) = stdout {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            match parse_notes_line(&line) {
                NotesEvent::Done { json, mid } => done = Some((json, mid)),
                NotesEvent::Fatal { error } => fatal = Some(error),
                NotesEvent::Unknown => {}
            }
        }
    }

    let status = child.wait().map_err(|e| format!("failed to wait on notes.py: {e}"))?;
    let stderr_tail: Vec<String> = stderr_lines.join().unwrap_or_default().into_iter().rev().take(20).rev().collect();

    if !status.success() || fatal.is_some() {
        let mut msg = String::new();
        if let Some(err) = &fatal {
            msg.push_str(&format!("notes.py fatal error: {err}\n"));
        } else {
            msg.push_str(&format!("notes.py exited with {:?}\n", status.code()));
        }
        if !stderr_tail.is_empty() {
            msg.push_str("--- stderr tail ---\n");
            msg.push_str(&stderr_tail.join("\n"));
        }
        return Err(msg);
    }

    let (json_str, mid_str) = done.ok_or_else(|| "notes.py did not emit a done event".to_string())?;
    let json_path = PathBuf::from(json_str);
    let mid_path = PathBuf::from(mid_str);
    let elapsed_sec = start.elapsed().as_secs_f64();
    load_notes_result(&json_path, &mid_path, elapsed_sec)
}

/// Copies the cached `.mid` for `path` (produced by a prior `extract_notes`)
/// to `dest`.
pub fn export_midi(path: &Path, dest: &Path) -> Result<(), String> {
    let dir = notes_dir_for(path);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let mid_path = dir.join(format!("{stem}.mid"));
    if !mid_path.exists() {
        return Err(format!("{} not found; run extract_notes first", mid_path.display()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create export dir: {e}"))?;
    }
    std::fs::copy(&mid_path, dest).map_err(|e| format!("failed to export midi: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_notes_json_sample() {
        let sample = r#"{
            "notes": [{"startSec":0.0,"endSec":0.5,"midi":60,"name":"C4","velocity":0.8}],
            "key": {"tonic":"G","mode":"major","confidence":0.72},
            "chords": [{"startSec":0.0,"endSec":1.0,"name":"Gmaj","notes":["G","B","D"]}],
            "scale": ["G","A","B","C","D","E","F#"],
            "bpm": 90.5
        }"#;
        let parsed: NotesJson = serde_json::from_str(sample).expect("parse");
        assert_eq!(parsed.notes.len(), 1);
        assert_eq!(parsed.notes[0].midi, 60);
        assert_eq!(parsed.key.as_ref().unwrap().tonic, "G");
        assert_eq!(parsed.chords[0].name, "Gmaj");
        assert_eq!(parsed.scale.len(), 7);
        assert_eq!(parsed.bpm, Some(90.5));
    }

    #[test]
    fn parses_notes_json_without_bpm() {
        let sample = r#"{"notes":[],"key":{"tonic":"C","mode":"major","confidence":0.0},"chords":[],"scale":["C"]}"#;
        let parsed: NotesJson = serde_json::from_str(sample).expect("parse");
        assert_eq!(parsed.bpm, None);
    }

    #[test]
    fn parses_done_and_fatal_lines() {
        let done = r#"{"event":"done","json":"C:/out/x.notes.json","mid":"C:/out/x.mid"}"#;
        match parse_notes_line(done) {
            NotesEvent::Done { json, mid } => {
                assert_eq!(json, "C:/out/x.notes.json");
                assert_eq!(mid, "C:/out/x.mid");
            }
            other => panic!("unexpected: {other:?}"),
        }
        let fatal = r#"{"event":"fatal","error":"boom"}"#;
        match parse_notes_line(fatal) {
            NotesEvent::Fatal { error } => assert_eq!(error, "boom"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn cache_freshness_checks_mtime() {
        let dir = std::env::temp_dir().join(format!("notes_rs_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("a.wav");
        let cache = dir.join("a.notes.json");
        std::fs::write(&wav, b"wav").unwrap();
        // No cache yet: not fresh.
        assert!(!cache_is_fresh(&cache, &wav));

        std::fs::write(&cache, b"{}").unwrap();
        // Cache written after wav: fresh.
        assert!(cache_is_fresh(&cache, &wav));

        // Re-write the wav later than the cache: stale.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&wav, b"wav2").unwrap();
        assert!(!cache_is_fresh(&cache, &wav));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
