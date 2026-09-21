//! Pure-Rust onset detection, BPM estimation, and beat-grid generation.

use super::silent_command;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const SAMPLE_RATE: u32 = 22050;
pub const FRAME_SIZE: usize = 1024;
pub const HOP_SIZE: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopAnalysis {
    pub bpm: f64,
    pub confidence: f64,
    pub transients: Vec<f64>,
    pub beat_grid: Vec<f64>,
    pub bars: u32,
    pub onset_envelope: Vec<f64>,
    pub peak_db: f64,
    pub rms_db: f64,
}

/// Decodes `wav_path` to mono f32 PCM at 22050 Hz via ffmpeg stdout.
pub fn decode_mono_f32(wav_path: &Path) -> Result<Vec<f32>, String> {
    let src_s = wav_path.to_string_lossy().to_string();
    let output = silent_command("ffmpeg")
        .args([
            "-i", &src_s, "-f", "f32le", "-ac", "1", "-ar", "22050", "-",
        ])
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(20).collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg decode-to-f32 failed: {tail}"));
    }

    let bytes = output.stdout;
    let n = bytes.len() / 4;
    let mut samples = Vec::with_capacity(n);
    for i in 0..n {
        let b = [bytes[i * 4], bytes[i * 4 + 1], bytes[i * 4 + 2], bytes[i * 4 + 3]];
        samples.push(f32::from_le_bytes(b));
    }
    Ok(samples)
}

/// Computes the onset envelope: per-hop half-wave-rectified energy
/// difference, log-compressed, then smoothed with a 3-tap moving average.
/// Returns values normalized to 0..1.
pub fn onset_envelope(samples: &[f32]) -> Vec<f64> {
    if samples.len() < FRAME_SIZE {
        return Vec::new();
    }
    let mut energies = Vec::new();
    let mut pos = 0usize;
    while pos + FRAME_SIZE <= samples.len() {
        let mut e = 0.0f64;
        for &s in &samples[pos..pos + FRAME_SIZE] {
            e += (s as f64) * (s as f64);
        }
        // log-compress
        let e_log = (1.0 + e).ln();
        energies.push(e_log);
        pos += HOP_SIZE;
    }

    if energies.is_empty() {
        return Vec::new();
    }

    let mut onset = Vec::with_capacity(energies.len());
    onset.push(0.0);
    for i in 1..energies.len() {
        onset.push((energies[i] - energies[i - 1]).max(0.0));
    }

    // 3-tap smoothing (simple moving average, edge-clamped).
    let mut smoothed = vec![0.0; onset.len()];
    for i in 0..onset.len() {
        let a = if i == 0 { onset[0] } else { onset[i - 1] };
        let b = onset[i];
        let c = if i + 1 < onset.len() { onset[i + 1] } else { onset[i] };
        smoothed[i] = (a + b + c) / 3.0;
    }

    let max = smoothed.iter().cloned().fold(0.0_f64, f64::max);
    if max > 0.0 {
        for v in smoothed.iter_mut() {
            *v /= max;
        }
    }
    smoothed
}

/// Detects local-max transient peaks above `mean + 1.0*std`, enforcing a
/// minimum gap of `min_gap_ms` between consecutive peaks. Returns frame
/// indices into `envelope`.
pub fn detect_transients(envelope: &[f64], hop_size: usize, sample_rate: u32, min_gap_ms: f64) -> Vec<usize> {
    if envelope.is_empty() {
        return Vec::new();
    }
    let mean = envelope.iter().sum::<f64>() / envelope.len() as f64;
    let variance = envelope.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / envelope.len() as f64;
    let std = variance.sqrt();
    let threshold = mean + 1.0 * std;

    let min_gap_frames = ((min_gap_ms / 1000.0) * sample_rate as f64 / hop_size as f64).round() as usize;
    let min_gap_frames = min_gap_frames.max(1);

    let mut peaks = Vec::new();
    let mut last_peak: Option<usize> = None;

    for i in 0..envelope.len() {
        if envelope[i] < threshold {
            continue;
        }
        let is_local_max = (i == 0 || envelope[i] >= envelope[i - 1])
            && (i == envelope.len() - 1 || envelope[i] >= envelope[i + 1]);
        if !is_local_max {
            continue;
        }
        if let Some(lp) = last_peak {
            if i - lp < min_gap_frames {
                // keep the stronger of the two candidates
                if envelope[i] > envelope[lp] {
                    peaks.pop();
                    peaks.push(i);
                    last_peak = Some(i);
                }
                continue;
            }
        }
        peaks.push(i);
        last_peak = Some(i);
    }

    peaks
}

fn frame_to_sec(frame: usize, hop_size: usize, sample_rate: u32) -> f64 {
    (frame * hop_size) as f64 / sample_rate as f64
}

pub struct TempoEstimate {
    pub bpm: f64,
    pub confidence: f64,
}

/// Autocorrelation-based tempo estimation over `envelope` (frames at
/// `sample_rate/hop_size` fps), searching lags corresponding to 60..200 BPM,
/// refined via parabolic interpolation, with half/double disambiguation
/// preferring the 80..160 BPM range.
pub fn estimate_tempo(envelope: &[f64], hop_size: usize, sample_rate: u32) -> TempoEstimate {
    if envelope.len() < 4 {
        return TempoEstimate { bpm: 120.0, confidence: 0.0 };
    }
    let fps = sample_rate as f64 / hop_size as f64;

    let min_bpm = 60.0f64;
    let max_bpm = 200.0f64;
    let min_lag = (60.0 / max_bpm * fps).floor().max(1.0) as usize;
    let max_lag = (60.0 / min_bpm * fps).ceil() as usize;
    let max_lag = max_lag.min(envelope.len() - 1);

    if min_lag >= max_lag {
        return TempoEstimate { bpm: 120.0, confidence: 0.0 };
    }

    let mean = envelope.iter().sum::<f64>() / envelope.len() as f64;
    let centered: Vec<f64> = envelope.iter().map(|v| v - mean).collect();

    let mut acf = vec![0.0; max_lag + 1];
    for lag in min_lag..=max_lag {
        let mut sum = 0.0;
        for i in 0..(centered.len() - lag) {
            sum += centered[i] * centered[i + lag];
        }
        acf[lag] = sum;
    }

    // pick the max within range
    let mut best_lag = min_lag;
    let mut best_val = f64::MIN;
    for lag in min_lag..=max_lag {
        if acf[lag] > best_val {
            best_val = acf[lag];
            best_lag = lag;
        }
    }

    // parabolic interpolation around best_lag
    let refined_lag = if best_lag > min_lag && best_lag < max_lag {
        let y0 = acf[best_lag - 1];
        let y1 = acf[best_lag];
        let y2 = acf[best_lag + 1];
        let denom = y0 - 2.0 * y1 + y2;
        if denom.abs() > 1e-12 {
            let delta = 0.5 * (y0 - y2) / denom;
            best_lag as f64 + delta.clamp(-1.0, 1.0)
        } else {
            best_lag as f64
        }
    } else {
        best_lag as f64
    };

    let mut bpm = 60.0 * fps / refined_lag;

    // half/double ambiguity: prefer 80..160 range
    while bpm < 80.0 && bpm * 2.0 <= 200.0 {
        bpm *= 2.0;
    }
    while bpm > 160.0 && bpm / 2.0 >= 60.0 {
        bpm /= 2.0;
    }

    let sum_acf: f64 = acf[min_lag..=max_lag].iter().filter(|v| **v > 0.0).sum();
    let confidence = if sum_acf > 0.0 {
        (best_val.max(0.0) / sum_acf).clamp(0.0, 1.0)
    } else {
        0.0
    };

    TempoEstimate {
        bpm: (bpm * 10.0).round() / 10.0,
        confidence,
    }
}

/// Generates a beat grid anchored at the strongest transient, stepping by
/// 60/bpm seconds and extending both directions across `[0, duration_sec]`.
pub fn beat_grid(transient_times: &[f64], strongest_idx: Option<usize>, bpm: f64, duration_sec: f64) -> Vec<f64> {
    if bpm <= 0.0 {
        return Vec::new();
    }
    let step = 60.0 / bpm;
    let anchor = strongest_idx
        .and_then(|i| transient_times.get(i).copied())
        .or_else(|| transient_times.first().copied())
        .unwrap_or(0.0);

    let mut grid = Vec::new();

    // extend backward from anchor
    let mut t = anchor;
    let mut backward = Vec::new();
    while t >= 0.0 {
        backward.push(t);
        t -= step;
    }
    backward.reverse();
    grid.extend(backward);

    // extend forward from anchor + step
    let mut t = anchor + step;
    while t <= duration_sec {
        grid.push(t);
        t += step;
    }

    grid.sort_by(|a, b| a.partial_cmp(b).unwrap());
    grid.retain(|&t| t >= 0.0 && t <= duration_sec);
    grid
}

/// Full analysis pipeline over a decoded loop wav.
pub fn analyze(wav_path: &Path, duration_sec: f64) -> Result<LoopAnalysis, String> {
    let samples = decode_mono_f32(wav_path)?;
    let envelope = onset_envelope(&samples);
    let transient_frames = detect_transients(&envelope, HOP_SIZE, SAMPLE_RATE, 50.0);
    let transient_times: Vec<f64> = transient_frames
        .iter()
        .map(|&f| frame_to_sec(f, HOP_SIZE, SAMPLE_RATE))
        .collect();

    let tempo = estimate_tempo(&envelope, HOP_SIZE, SAMPLE_RATE);

    let strongest_idx = transient_frames
        .iter()
        .enumerate()
        .max_by(|a, b| envelope[*a.1].partial_cmp(&envelope[*b.1]).unwrap())
        .map(|(idx, _)| idx);

    let grid = beat_grid(&transient_times, strongest_idx, tempo.bpm, duration_sec);

    let bars = if tempo.bpm > 0.0 {
        (duration_sec / (4.0 * 60.0 / tempo.bpm)).floor() as u32
    } else {
        0
    };

    let loudness = super::dsp_filters::measure_loudness(wav_path)?;

    Ok(LoopAnalysis {
        bpm: tempo.bpm,
        confidence: tempo.confidence,
        transients: transient_times,
        beat_grid: grid,
        bars,
        onset_envelope: envelope,
        peak_db: loudness.peak_db,
        rms_db: loudness.rms_db,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generates a synthetic click train at `bpm` BPM, `duration_sec` long,
    /// at `sample_rate`, as short decaying impulses.
    fn synthetic_click_train(bpm: f64, duration_sec: f64, sample_rate: u32) -> Vec<f32> {
        let n = (duration_sec * sample_rate as f64) as usize;
        let mut samples = vec![0.0f32; n];
        let period = 60.0 / bpm;
        let click_len = (0.01 * sample_rate as f64) as usize; // 10ms decaying click
        let mut t = 0.0;
        while t < duration_sec {
            let start = (t * sample_rate as f64) as usize;
            for i in 0..click_len {
                if start + i >= n {
                    break;
                }
                let decay = (-(i as f64) / (click_len as f64 / 4.0)).exp();
                samples[start + i] += decay as f32;
            }
            t += period;
        }
        samples
    }

    #[test]
    fn bpm_estimation_on_120bpm_click_train() {
        let samples = synthetic_click_train(120.0, 8.0, SAMPLE_RATE);
        let envelope = onset_envelope(&samples);
        let tempo = estimate_tempo(&envelope, HOP_SIZE, SAMPLE_RATE);
        assert!(
            (tempo.bpm - 120.0).abs() < 3.0,
            "expected ~120 bpm, got {}",
            tempo.bpm
        );
    }

    #[test]
    fn bpm_estimation_on_90bpm_click_train() {
        let samples = synthetic_click_train(90.0, 8.0, SAMPLE_RATE);
        let envelope = onset_envelope(&samples);
        let tempo = estimate_tempo(&envelope, HOP_SIZE, SAMPLE_RATE);
        assert!(
            (tempo.bpm - 90.0).abs() < 3.0,
            "expected ~90 bpm, got {}",
            tempo.bpm
        );
    }

    #[test]
    fn transient_detection_respects_min_gap() {
        let samples = synthetic_click_train(180.0, 4.0, SAMPLE_RATE);
        let envelope = onset_envelope(&samples);
        let peaks = detect_transients(&envelope, HOP_SIZE, SAMPLE_RATE, 50.0);
        let min_gap_frames = ((50.0 / 1000.0) * SAMPLE_RATE as f64 / HOP_SIZE as f64).round() as usize;
        for w in peaks.windows(2) {
            assert!(
                w[1] - w[0] >= min_gap_frames,
                "peaks too close: {} {}",
                w[0],
                w[1]
            );
        }
    }

    #[test]
    fn beat_grid_generation_spans_duration_and_is_evenly_spaced() {
        let bpm = 120.0;
        let duration = 8.0;
        let grid = beat_grid(&[1.0], Some(0), bpm, duration);
        assert!(!grid.is_empty());
        assert!(grid.iter().all(|&t| t >= 0.0 && t <= duration));
        let step = 60.0 / bpm;
        for w in grid.windows(2) {
            assert!((w[1] - w[0] - step).abs() < 1e-6);
        }
    }
}
