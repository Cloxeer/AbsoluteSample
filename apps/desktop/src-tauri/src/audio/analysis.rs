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
    /// Key detection (contract v6 addendum: "Key detection and naming"),
    /// `None` when the signal was too short/quiet to get a confident chroma.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<KeyEstimate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyEstimate {
    pub tonic: String,
    pub mode: String, // "major" | "minor"
    pub confidence: f64,
    pub camelot: String,
}

const PITCH_CLASSES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Camelot wheel: major/minor keys mapped to their wheel position + letter.
// Index = semitone offset from C (0=C .. 11=B).
const CAMELOT_MAJOR: [&str; 12] = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR: [&str; 12] = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

// Krumhansl-Schmuckler key profiles.
const MAJOR_PROFILE: [f64; 12] =
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE: [f64; 12] =
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const FFT_SIZE: usize = 1024;
const FFT_HOP: usize = 512;

/// In-place radix-2 Cooley-Tukey FFT (`n` must be a power of two). Pure Rust,
/// no external dependency.
fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    if n <= 1 {
        return;
    }
    // bit-reversal permutation
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j &= !bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        let wr = ang.cos();
        let wi = ang.sin();
        let mut i = 0;
        while i < n {
            let mut cur_wr = 1.0;
            let mut cur_wi = 0.0;
            for k in 0..len / 2 {
                let ur = re[i + k];
                let ui = im[i + k];
                let vr = re[i + k + len / 2] * cur_wr - im[i + k + len / 2] * cur_wi;
                let vi = re[i + k + len / 2] * cur_wi + im[i + k + len / 2] * cur_wr;
                re[i + k] = ur + vr;
                im[i + k] = ui + vi;
                re[i + k + len / 2] = ur - vr;
                im[i + k + len / 2] = ui - vi;
                let next_wr = cur_wr * wr - cur_wi * wi;
                let next_wi = cur_wr * wi + cur_wi * wr;
                cur_wr = next_wr;
                cur_wi = next_wi;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// Computes a 12-bin chroma vector (pitch class energy, summed over all
/// frames and normalized to sum 1) from a mono signal at `sample_rate`, via a
/// 1024-window/512-hop Hann-windowed STFT, mapping FFT bins to pitch classes
/// using A4=440Hz equal temperament (contract v6 addendum: "Key detection").
pub fn compute_chroma(samples: &[f32], sample_rate: u32) -> [f64; 12] {
    let mut chroma = [0.0f64; 12];
    if samples.len() < FFT_SIZE {
        return chroma;
    }

    // Hann window, precomputed once.
    let window: Vec<f64> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (FFT_SIZE - 1) as f64).cos())
        .collect();

    // Precompute FFT bin -> pitch class (skip bin 0 / DC, and anything below
    // ~C2 / above ~C7 which is mostly noise/harmonics for key detection).
    let sr = sample_rate as f64;
    let mut bin_pitch_class = vec![None; FFT_SIZE / 2];
    for (bin, entry) in bin_pitch_class.iter_mut().enumerate().skip(1) {
        let freq = bin as f64 * sr / FFT_SIZE as f64;
        if freq < 65.0 || freq > 2100.0 {
            continue;
        }
        // MIDI note number relative to A4=440Hz, then mod 12 -> pitch class
        // where 0 = C (A4 is midi 69, pitch class 9).
        let midi = 69.0 + 12.0 * (freq / 440.0).log2();
        let pc = ((midi.round() as i64).rem_euclid(12)) as usize;
        *entry = Some(pc);
    }

    let mut pos = 0usize;
    while pos + FFT_SIZE <= samples.len() {
        let mut re: Vec<f64> = (0..FFT_SIZE).map(|i| samples[pos + i] as f64 * window[i]).collect();
        let mut im = vec![0.0f64; FFT_SIZE];
        fft(&mut re, &mut im);
        for bin in 1..FFT_SIZE / 2 {
            if let Some(pc) = bin_pitch_class[bin] {
                let mag = (re[bin] * re[bin] + im[bin] * im[bin]).sqrt();
                chroma[pc] += mag;
            }
        }
        pos += FFT_HOP;
    }

    let sum: f64 = chroma.iter().sum();
    if sum > 0.0 {
        for v in chroma.iter_mut() {
            *v /= sum;
        }
    }
    chroma
}

/// Pearson correlation between `chroma` (rotated so tonic `shift` is index 0)
/// and `profile`.
fn correlate(chroma: &[f64; 12], profile: &[f64; 12], shift: usize) -> f64 {
    let rotated: Vec<f64> = (0..12).map(|i| chroma[(i + shift) % 12]).collect();
    let mean_a = rotated.iter().sum::<f64>() / 12.0;
    let mean_b = profile.iter().sum::<f64>() / 12.0;
    let mut num = 0.0;
    let mut den_a = 0.0;
    let mut den_b = 0.0;
    for i in 0..12 {
        let da = rotated[i] - mean_a;
        let db = profile[i] - mean_b;
        num += da * db;
        den_a += da * da;
        den_b += db * db;
    }
    if den_a <= 0.0 || den_b <= 0.0 {
        0.0
    } else {
        num / (den_a.sqrt() * den_b.sqrt())
    }
}

/// Krumhansl-Schmuckler key detection over a chroma vector: tries all 24
/// (tonic, mode) candidates and returns the best match, with `confidence`
/// derived from the correlation margin between the best and second-best.
pub fn detect_key_from_chroma(chroma: &[f64; 12]) -> Option<KeyEstimate> {
    if chroma.iter().sum::<f64>() <= 0.0 {
        return None;
    }
    let mut scores: Vec<(usize, bool, f64)> = Vec::with_capacity(24);
    for tonic in 0..12 {
        scores.push((tonic, true, correlate(chroma, &MAJOR_PROFILE, tonic)));
        scores.push((tonic, false, correlate(chroma, &MINOR_PROFILE, tonic)));
    }
    scores.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap());
    let (tonic, is_major, best) = scores[0];
    let second = scores.get(1).map(|s| s.2).unwrap_or(best);
    // Margin between best and second-best correlation, normalized to 0..1.
    let margin = (best - second).max(0.0);
    let confidence = (margin / 0.3).clamp(0.0, 1.0);

    let camelot = if is_major { CAMELOT_MAJOR[tonic] } else { CAMELOT_MINOR[tonic] };
    Some(KeyEstimate {
        tonic: PITCH_CLASSES[tonic].to_string(),
        mode: if is_major { "major".to_string() } else { "minor".to_string() },
        confidence,
        camelot: camelot.to_string(),
    })
}

/// Detects the key of a decoded wav file by decoding it mono at
/// [`SAMPLE_RATE`] and running chroma + Krumhansl-Schmuckler correlation.
pub fn detect_key(wav_path: &Path) -> Result<Option<KeyEstimate>, String> {
    let samples = decode_mono_f32(wav_path)?;
    let chroma = compute_chroma(&samples, SAMPLE_RATE);
    Ok(detect_key_from_chroma(&chroma))
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
    let chroma = compute_chroma(&samples, SAMPLE_RATE);
    let key = detect_key_from_chroma(&chroma);

    Ok(LoopAnalysis {
        bpm: tempo.bpm,
        confidence: tempo.confidence,
        transients: transient_times,
        beat_grid: grid,
        bars,
        onset_envelope: envelope,
        peak_db: loudness.peak_db,
        rms_db: loudness.rms_db,
        key,
    })
}

/// Resolves the `<workdir>/analysis/<file stem>.json` cache path for `path`,
/// if `path` is inside a work dir (contract v5 addendum: `analyze_file`).
fn cache_path_for(path: &Path) -> Option<std::path::PathBuf> {
    let track_id = super::library::track_id_from_path(path)?;
    let dir = super::workspace::work_dir(&track_id).ok()?;
    let stem = path.file_stem()?.to_str()?;
    Some(dir.join("analysis").join(format!("{stem}.json")))
}

/// `analyze_file({ path }) -> LoopAnalysis` (contract v5 addendum): analyzes
/// any wav (used for per-stem onsets in the Beat Matrix). When `path` is
/// inside a work dir, caches the result at `<workdir>/analysis/<stem>.json`
/// and reuses that cache on subsequent calls.
pub fn analyze_file(path: &Path) -> Result<LoopAnalysis, String> {
    let cache_path = cache_path_for(path);

    if let Some(cp) = &cache_path {
        if let Ok(text) = std::fs::read_to_string(cp) {
            if let Ok(cached) = serde_json::from_str::<LoopAnalysis>(&text) {
                return Ok(cached);
            }
        }
    }

    let probe = super::downloader::probe(path)?;
    let result = analyze(path, probe.duration_sec)?;

    if let Some(cp) = &cache_path {
        if let Some(parent) = cp.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&result) {
            let _ = std::fs::write(cp, json);
        }
    }

    Ok(result)
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

    /// Synthesizes a chord as the sum of sine waves at the given
    /// frequencies, `duration_sec` long at `sample_rate`.
    fn synth_chord(freqs: &[f64], duration_sec: f64, sample_rate: u32) -> Vec<f32> {
        let n = (duration_sec * sample_rate as f64) as usize;
        let mut samples = vec![0.0f32; n];
        for i in 0..n {
            let t = i as f64 / sample_rate as f64;
            let mut s = 0.0;
            for &f in freqs {
                s += (t * f * std::f64::consts::TAU).sin();
            }
            samples[i] = (s / freqs.len() as f64 * 0.8) as f32;
        }
        samples
    }

    #[test]
    fn detects_c_major_triad() {
        // C4=261.63, E4=329.63, G4=392.00
        let samples = synth_chord(&[261.63, 329.63, 392.00], 3.0, SAMPLE_RATE);
        let chroma = compute_chroma(&samples, SAMPLE_RATE);
        let key = detect_key_from_chroma(&chroma).expect("expected a key estimate");
        assert_eq!(key.tonic, "C");
        assert_eq!(key.mode, "major");
    }

    #[test]
    fn detects_a_minor_triad() {
        // A3=220.00, C4=261.63, E4=329.63
        let samples = synth_chord(&[220.00, 261.63, 329.63], 3.0, SAMPLE_RATE);
        let chroma = compute_chroma(&samples, SAMPLE_RATE);
        let key = detect_key_from_chroma(&chroma).expect("expected a key estimate");
        assert_eq!(key.tonic, "A");
        assert_eq!(key.mode, "minor");
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
