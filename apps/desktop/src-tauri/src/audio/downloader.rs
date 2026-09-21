//! yt-dlp download + ffprobe metadata extraction.

use super::{run_capture, silent_command};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub id: String,
    pub title: String,
    pub ext: String,
    pub source_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub codec: String,
}

/// Locates the yt-dlp executable path via, in order:
/// 1. `YTDLP_PATH` env var
/// 2. `yt-dlp` on PATH
/// 3. `%LOCALAPPDATA%/Microsoft/WinGet/Links/yt-dlp.exe`
/// 4. `%LOCALAPPDATA%/Microsoft/WinGet/Packages/*yt-dlp*/yt-dlp.exe`
pub fn locate_ytdlp() -> Option<String> {
    if let Ok(p) = std::env::var("YTDLP_PATH") {
        if !p.is_empty() && Path::new(&p).exists() {
            return Some(p);
        }
    }

    // Try bare name on PATH.
    if silent_command("yt-dlp")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some("yt-dlp".to_string());
    }

    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        let links = PathBuf::from(&local_appdata)
            .join("Microsoft")
            .join("WinGet")
            .join("Links")
            .join("yt-dlp.exe");
        if links.exists() {
            return Some(links.to_string_lossy().to_string());
        }

        let packages_dir = PathBuf::from(&local_appdata)
            .join("Microsoft")
            .join("WinGet")
            .join("Packages");
        if let Ok(entries) = std::fs::read_dir(&packages_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.contains("yt-dlp") {
                    let candidate = entry.path().join("yt-dlp.exe");
                    if candidate.exists() {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

pub fn version() -> Option<String> {
    let bin = locate_ytdlp()?;
    let out = silent_command(&bin).arg("--version").output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// sha1-ish fallback id derived from the url when yt-dlp doesn't give one.
pub fn hash_id(url: &str) -> String {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Downloads bestaudio for `url` into `workdir/source.<ext>` using yt-dlp,
/// returning the parsed id/title/ext/path.
pub fn download(url: &str, workdir: &Path) -> Result<DownloadResult, String> {
    let bin = locate_ytdlp().ok_or_else(|| {
        "yt-dlp not found (set YTDLP_PATH, add to PATH, or install via winget)".to_string()
    })?;

    let out_template = workdir.join("source.%(ext)s");
    let out_template_str = out_template.to_string_lossy().to_string();

    let output = silent_command(&bin)
        .args([
            "-f",
            "bestaudio",
            "--no-playlist",
            "--print-json",
            "--no-simulate",
            "-o",
            &out_template_str,
            url,
        ])
        .output()
        .map_err(|e| format!("failed to spawn yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(20).collect::<Vec<_>>().join("\n");
        return Err(format!("yt-dlp failed: {tail}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // --print-json emits one JSON object per line; take the last non-empty line.
    let json_line = stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .ok_or_else(|| "yt-dlp produced no JSON output".to_string())?;

    let parsed: serde_json::Value =
        serde_json::from_str(json_line).map_err(|e| format!("failed to parse yt-dlp JSON: {e}"))?;

    let id = parsed
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| hash_id(url));
    let title = parsed
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let ext = parsed
        .get("ext")
        .and_then(|v| v.as_str())
        .unwrap_or("webm")
        .to_string();

    let source_path = workdir.join(format!("source.{ext}"));
    if !source_path.exists() {
        return Err(format!(
            "expected downloaded file at {} but it was not found",
            source_path.display()
        ));
    }

    Ok(DownloadResult {
        id,
        title,
        ext,
        source_path,
    })
}

/// Runs ffprobe on `path` and extracts duration/sample_rate/channels/codec
/// from the best audio stream.
pub fn probe(path: &Path) -> Result<ProbeInfo, String> {
    let path_str = path.to_string_lossy().to_string();
    let stdout = run_capture(
        "ffprobe",
        &[
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path_str,
        ],
    )?;

    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("failed to parse ffprobe JSON: {e}"))?;

    let streams = parsed
        .get("streams")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let audio_stream = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio"))
        .ok_or_else(|| "ffprobe found no audio stream".to_string())?;

    let sample_rate = audio_stream
        .get("sample_rate")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(44100);
    let channels = audio_stream
        .get("channels")
        .and_then(|v| v.as_u64())
        .unwrap_or(2) as u32;
    let codec = audio_stream
        .get("codec_name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let duration_sec = parsed
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| {
            audio_stream
                .get("duration")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
        })
        .unwrap_or(0.0);

    Ok(ProbeInfo {
        duration_sec,
        sample_rate,
        channels,
        codec,
    })
}
