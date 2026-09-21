//! Region cut (contract v6 addendum "Region cut"): cuts a time range out of a
//! stem/instrument/loop/source wav, with optional beat/bar snapping (from the
//! cached whole-song analysis) and fades/leading-silence trim.

use super::{analysis, peaks, samples, silent_command, workspace};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutResult {
    pub path: String,
    pub start_sec: f64,
    pub end_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bars: Option<u32>,
    pub peaks: Vec<f32>,
    pub duration_sec: f64,
}

/// Snaps `t` to the nearest entry of `beat_grid`, or leaves it unchanged if
/// the grid is empty.
fn snap_to_nearest_beat(t: f64, beat_grid: &[f64]) -> f64 {
    beat_grid
        .iter()
        .copied()
        .min_by(|a, b| (a - t).abs().partial_cmp(&(b - t).abs()).unwrap())
        .unwrap_or(t)
}

/// Snaps `t` to the nearest bar boundary: `anchor + 4k*(60/bpm)` for integer
/// `k`.
fn snap_to_nearest_bar(t: f64, anchor: f64, bpm: f64) -> f64 {
    if bpm <= 0.0 {
        return t;
    }
    let bar_sec = 4.0 * 60.0 / bpm;
    let k = ((t - anchor) / bar_sec).round();
    anchor + k * bar_sec
}

/// Applies `snap` ("none"/"beat"/"bar") to `(start, end)` using `analysis`'s
/// beat grid/bpm, returning `(snapped_start, snapped_end, bars)`. For "bar",
/// nudges `end` forward by whole bars until it's strictly after `start` if
/// snapping collapsed the range.
pub fn apply_snap(start: f64, end: f64, snap: &str, analysis: &analysis::LoopAnalysis) -> (f64, f64, Option<u32>) {
    let bpm = analysis.bpm;
    match snap {
        "beat" => {
            let s = snap_to_nearest_beat(start, &analysis.beat_grid);
            let e = snap_to_nearest_beat(end, &analysis.beat_grid);
            let bars = if bpm > 0.0 {
                Some(((e - s) / (4.0 * 60.0 / bpm)).round().max(0.0) as u32)
            } else {
                None
            };
            (s, e, bars)
        }
        "bar" => {
            let anchor = analysis.beat_grid.first().copied().unwrap_or(0.0);
            let s = snap_to_nearest_bar(start, anchor, bpm);
            let mut e = snap_to_nearest_bar(end, anchor, bpm);
            if bpm > 0.0 {
                let bar_sec = 4.0 * 60.0 / bpm;
                while e <= s {
                    e += bar_sec;
                }
            }
            let bars = if bpm > 0.0 {
                Some(((e - s) / (4.0 * 60.0 / bpm)).round().max(0.0) as u32)
            } else {
                None
            };
            (s, e, bars)
        }
        _ => (start, end, None),
    }
}

/// Resolves/creates the cached whole-song analysis (`analysis/source.json`)
/// for `track_id`, analyzing `source.wav` if it isn't cached yet.
pub fn source_analysis(track_id: &str) -> Result<analysis::LoopAnalysis, String> {
    let dir = workspace::work_dir(track_id)?;
    let source_wav = dir.join("source.wav");
    if !source_wav.exists() {
        return Err(format!("source.wav not found: {}", source_wav.display()));
    }
    analysis::analyze_file(&source_wav)
}

/// The `<workdir>/cuts/` directory, created if missing.
fn cuts_dir(track_id: &str) -> Result<PathBuf, String> {
    let dir = workspace::work_dir(track_id)?.join("cuts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create cuts dir: {e}"))?;
    Ok(dir)
}

/// Cuts `[start, end]` (already snapped, if any) out of `src` via ffmpeg,
/// with `fade_ms` in/out fades and optional leading-silence trim, writing
/// `dest`.
pub fn ffmpeg_cut(src: &Path, dest: &Path, start: f64, end: f64, fade_ms: f64, trim_leading_silence: bool) -> Result<(), String> {
    let fade_sec = (fade_ms / 1000.0).max(0.0);
    let dur = (end - start).max(0.0);
    let fade_out_start = (dur - fade_sec).max(0.0);

    let mut filter = format!("afade=t=in:d={fade_sec},afade=t=out:st={fade_out_start}:d={fade_sec}");
    if trim_leading_silence {
        filter.push_str(",silenceremove=start_periods=1:start_threshold=-50dB");
    }

    let src_s = src.to_string_lossy().to_string();
    let dest_s = dest.to_string_lossy().to_string();
    let start_s = format!("{start}");
    let end_s = format!("{end}");

    let output = silent_command("ffmpeg")
        .args([
            "-ss", &start_s, "-to", &end_s, "-i", &src_s, "-af", &filter, "-c:a", "pcm_s24le", "-y", &dest_s,
        ])
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(20).collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg cut failed: {tail}"));
    }
    Ok(())
}

/// `cut_region` (contract v6 addendum "Region cut"): resolves `stem_key`'s
/// wav, snaps `[start, end]` per `snap`, cuts it (fades + optional leading
/// silence trim) into `<workdir>/cuts/<stemKey>_<startMs>-<endMs>.wav`.
pub fn cut_region(
    track_id: &str,
    stem_key: &str,
    start: f64,
    end: f64,
    snap: &str,
    fade_ms: f64,
    trim_leading_silence: bool,
) -> Result<CutResult, String> {
    let (stem_path, _label, _group) = samples::resolve_stem_path(track_id, stem_key)?;
    if !stem_path.exists() {
        return Err(format!("cut source not found: {}", stem_path.display()));
    }

    let (start, end, bars) = if snap != "none" {
        let analysis = source_analysis(track_id)?;
        apply_snap(start, end, snap, &analysis)
    } else {
        (start, end, None)
    };
    if end <= start {
        return Err("cut region end must be after start".to_string());
    }

    let start_ms = (start * 1000.0).round() as i64;
    let end_ms = (end * 1000.0).round() as i64;
    let out_dir = cuts_dir(track_id)?;
    let out_path = out_dir.join(format!("{stem_key}_{start_ms}-{end_ms}.wav"));

    ffmpeg_cut(&stem_path, &out_path, start, end, fade_ms, trim_leading_silence)?;

    let cut_peaks = peaks::compute_peaks_for_path(&out_path).unwrap_or_default();
    let duration_sec = super::downloader::probe(&out_path).map(|p| p.duration_sec).unwrap_or(end - start);

    Ok(CutResult {
        path: out_path.to_string_lossy().to_string(),
        start_sec: start,
        end_sec: end,
        bars,
        peaks: cut_peaks,
        duration_sec,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_analysis(bpm: f64, beat_grid: Vec<f64>) -> analysis::LoopAnalysis {
        analysis::LoopAnalysis {
            bpm,
            confidence: 1.0,
            transients: Vec::new(),
            beat_grid,
            bars: 0,
            onset_envelope: Vec::new(),
            peak_db: 0.0,
            rms_db: 0.0,
            key: None,
        }
    }

    #[test]
    fn beat_snap_picks_nearest_grid_points() {
        let a = mk_analysis(120.0, vec![0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]);
        let (s, e, bars) = apply_snap(0.4, 2.6, "beat", &a);
        assert_eq!(s, 0.5);
        assert_eq!(e, 2.5);
        assert_eq!(bars, Some(1)); // (2.5-0.5)/(4*0.5) = 1
    }

    #[test]
    fn bar_snap_lands_on_4_beat_multiples() {
        // 120 bpm -> beat = 0.5s, bar = 2.0s, anchor = 1.0
        let a = mk_analysis(120.0, vec![1.0]);
        let (s, e, bars) = apply_snap(1.9, 5.9, "bar", &a);
        // nearest multiples of 2.0 from anchor 1.0: 1.9 -> 1.0 (k=0, dist .9) vs 3.0 (k=1, dist 1.1) -> 1.0
        assert_eq!(s, 1.0);
        // 5.9 -> nearest bar: 5.0 (k=2) dist .9 vs 7.0 dist 1.1 -> 5.0
        assert_eq!(e, 5.0);
        assert_eq!(bars, Some(2));
    }

    #[test]
    fn bar_snap_nudges_end_forward_past_start() {
        // start and end both collapse to the same bar boundary; end must be
        // nudged forward so end > start after snapping.
        let a = mk_analysis(120.0, vec![0.0]);
        let (s, e, bars) = apply_snap(0.1, 0.3, "bar", &a);
        assert_eq!(s, 0.0);
        assert!(e > s);
        assert_eq!(e, 2.0); // next bar boundary after 0.0
        assert_eq!(bars, Some(1));
    }

    #[test]
    fn none_snap_leaves_times_unchanged() {
        let a = mk_analysis(120.0, vec![0.0, 0.5]);
        let (s, e, bars) = apply_snap(0.37, 1.91, "none", &a);
        assert_eq!(s, 0.37);
        assert_eq!(e, 1.91);
        assert_eq!(bars, None);
    }

    #[test]
    fn cut_filename_encodes_start_end_ms() {
        let stem_key = "kick";
        let start: f64 = 30.0;
        let end: f64 = 45.5;
        let start_ms = (start * 1000.0).round() as i64;
        let end_ms = (end * 1000.0).round() as i64;
        let filename = format!("{stem_key}_{start_ms}-{end_ms}.wav");
        assert_eq!(filename, "kick_30000-45500.wav");
    }
}
