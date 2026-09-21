//! Trim (copy-only) and PCM decode helpers, plus beat-synced slicing.

use super::silent_command;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Zero-re-encode trim of `src` from `start_sec` to `end_sec`, writing
/// `dest` (e.g. `loop.<ext>`) via `-c copy`.
pub fn trim_copy(src: &Path, dest: &Path, start_sec: f64, end_sec: f64) -> Result<(), String> {
    let src_s = src.to_string_lossy().to_string();
    let dest_s = dest.to_string_lossy().to_string();
    let start_s = format!("{start_sec}");
    let end_s = format!("{end_sec}");

    let output = silent_command("ffmpeg")
        .args([
            // Output-side seek: input-side `-ss` with stream copy lands on the nearest
            // WebM cluster (several seconds early). Output-side seeking drops whole packets
            // instead, which is accurate to one Opus frame (20 ms) and still never re-encodes.
            "-i", &src_s, "-ss", &start_s, "-to", &end_s, "-c", "copy", "-avoid_negative_ts", "make_zero", "-y", &dest_s,
        ])
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(20).collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg trim failed: {tail}"));
    }
    Ok(())
}

/// Decodes `src` to 16-bit 44.1kHz stereo PCM `dest.wav`.
pub fn decode_to_wav(src: &Path, dest: &Path) -> Result<(), String> {
    let src_s = src.to_string_lossy().to_string();
    let dest_s = dest.to_string_lossy().to_string();

    let output = silent_command("ffmpeg")
        .args([
            "-i", &src_s, "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-y", &dest_s,
        ])
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(20).collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg decode failed: {tail}"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceInfo {
    pub index: u32,
    pub start_sec: f64,
    pub end_sec: f64,
    pub path: PathBuf,
}

/// Slices `src` (loop.wav or a stem wav) into `divisions` equal parts per bar
/// along the beat grid, writing `out_dir/<key>_slice_NN.wav` for each.
pub fn slice_beats(
    src: &Path,
    out_dir: &Path,
    key: &str,
    beat_grid: &[f64],
    bpm: f64,
    divisions: u32,
    duration_sec: f64,
) -> Result<Vec<SliceInfo>, String> {
    if divisions == 0 {
        return Err("divisions must be > 0".to_string());
    }
    std::fs::create_dir_all(out_dir).map_err(|e| format!("failed to create slices dir: {e}"))?;

    let bar_sec = if bpm > 0.0 { 4.0 * 60.0 / bpm } else { 0.0 };
    let slice_sec = if bar_sec > 0.0 {
        bar_sec / divisions as f64
    } else {
        0.0
    };

    let anchor = beat_grid.first().copied().unwrap_or(0.0);

    let mut slices = Vec::new();
    let mut idx = 0u32;
    let mut t = anchor;
    while t < duration_sec && slice_sec > 0.0 {
        let end = (t + slice_sec).min(duration_sec);
        let filename = format!("{key}_slice_{:02}.wav", idx + 1);
        let out_path = out_dir.join(&filename);

        let src_s = src.to_string_lossy().to_string();
        let out_s = out_path.to_string_lossy().to_string();
        let start_s = format!("{t}");
        let dur_s = format!("{}", end - t);

        let output = silent_command("ffmpeg")
            .args([
                "-ss", &start_s, "-t", &dur_s, "-i", &src_s, "-c:a", "pcm_s16le", "-y", &out_s,
            ])
            .output()
            .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr.lines().rev().take(10).collect::<Vec<_>>().join("\n");
            return Err(format!("ffmpeg slice failed: {tail}"));
        }

        slices.push(SliceInfo {
            index: idx + 1,
            start_sec: t,
            end_sec: end,
            path: out_path,
        });

        idx += 1;
        t += slice_sec;
    }

    Ok(slices)
}
