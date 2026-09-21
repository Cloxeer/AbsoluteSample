//! Waveform peaks (contract v5 addendum): fast max-abs-per-bucket
//! computation for wav playback previews, without decoding through ffmpeg.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// Reads a RIFF/WAVE `fmt ` + `data` chunk pair from `reader`, returning
/// `(format_tag, channels, bits_per_sample, data_bytes)`. `format_tag` is 1
/// for PCM integer, 3 for IEEE float (WAVE_FORMAT_EXTENSIBLE resolves to the
/// sub-format tag when present).
fn read_wav_header(reader: &mut impl Read) -> Result<(u16, u16, u16, Vec<u8>), String> {
    let mut riff = [0u8; 12];
    reader.read_exact(&mut riff).map_err(|e| format!("failed to read RIFF header: {e}"))?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".to_string());
    }

    let mut format_tag: u16 = 0;
    let mut channels: u16 = 0;
    let mut bits_per_sample: u16 = 0;
    let mut data: Option<Vec<u8>> = None;

    loop {
        let mut chunk_hdr = [0u8; 8];
        if reader.read_exact(&mut chunk_hdr).is_err() {
            break;
        }
        let chunk_id = &chunk_hdr[0..4];
        let chunk_size = u32::from_le_bytes([chunk_hdr[4], chunk_hdr[5], chunk_hdr[6], chunk_hdr[7]]) as usize;

        if chunk_id == b"fmt " {
            let mut body = vec![0u8; chunk_size];
            reader.read_exact(&mut body).map_err(|e| format!("failed to read fmt chunk: {e}"))?;
            if body.len() >= 16 {
                format_tag = u16::from_le_bytes([body[0], body[1]]);
                channels = u16::from_le_bytes([body[2], body[3]]);
                bits_per_sample = u16::from_le_bytes([body[14], body[15]]);
                // WAVE_FORMAT_EXTENSIBLE (0xFFFE): sub-format GUID starts at
                // byte 24 of the fmt body; first two bytes are the real tag.
                if format_tag == 0xFFFE && body.len() >= 26 {
                    format_tag = u16::from_le_bytes([body[24], body[25]]);
                }
            }
            if chunk_size % 2 == 1 {
                let mut pad = [0u8; 1];
                let _ = reader.read_exact(&mut pad);
            }
        } else if chunk_id == b"data" {
            let mut body = vec![0u8; chunk_size];
            reader.read_exact(&mut body).map_err(|e| format!("failed to read data chunk: {e}"))?;
            data = Some(body);
            if chunk_size % 2 == 1 {
                let mut pad = [0u8; 1];
                let _ = reader.read_exact(&mut pad);
            }
        } else {
            // Skip unknown chunk (LIST, fact, etc).
            let mut skip = vec![0u8; chunk_size + (chunk_size % 2)];
            if reader.read_exact(&mut skip).is_err() {
                break;
            }
        }

        if data.is_some() && format_tag != 0 {
            // We have both fmt and data; further chunks (if any) are
            // irrelevant to peaks computation, but keep scanning in case
            // `fmt ` came after `data` (rare, but be lenient).
        }
    }

    let data = data.ok_or_else(|| "wav file has no data chunk".to_string())?;
    if format_tag == 0 || channels == 0 || bits_per_sample == 0 {
        return Err("wav file has no (valid) fmt chunk".to_string());
    }
    Ok((format_tag, channels, bits_per_sample, data))
}

/// Converts raw interleaved PCM `data` to per-frame max-abs-across-channels
/// samples in `-1.0..=1.0` (approximately, for int formats).
fn frame_max_abs(format_tag: u16, channels: u16, bits_per_sample: u16, data: &[u8]) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    let bytes_per_sample = (bits_per_sample / 8) as usize;
    if bytes_per_sample == 0 {
        return Vec::new();
    }
    let frame_bytes = bytes_per_sample * channels;
    if frame_bytes == 0 {
        return Vec::new();
    }
    let n_frames = data.len() / frame_bytes;
    let mut out = Vec::with_capacity(n_frames);

    for f in 0..n_frames {
        let frame = &data[f * frame_bytes..(f + 1) * frame_bytes];
        let mut m = 0.0f32;
        for c in 0..channels {
            let s = &frame[c * bytes_per_sample..(c + 1) * bytes_per_sample];
            let v: f32 = match (format_tag, bits_per_sample) {
                (1, 16) => (i16::from_le_bytes([s[0], s[1]]) as f32) / 32768.0,
                (1, 24) => {
                    let raw = ((s[2] as i32) << 24 | (s[1] as i32) << 16 | (s[0] as i32) << 8) >> 8;
                    (raw as f32) / 8_388_608.0
                }
                (1, 32) => (i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f32) / 2_147_483_648.0,
                (3, 32) => f32::from_le_bytes([s[0], s[1], s[2], s[3]]),
                _ => 0.0,
            };
            let a = v.abs();
            if a > m {
                m = a;
            }
        }
        out.push(m);
    }
    out
}

/// Computes `n` max-abs-per-bucket peaks (normalized 0..1 against the
/// file's own global max amplitude, rounded to 3 decimals) for a PCM WAV
/// file (16/24/32-bit int, or 32-bit float; any channel count), read via a
/// buffered reader without any external WAV-parsing crate.
pub fn compute_peaks(wav_path: &Path, n: usize) -> Result<Vec<f32>, String> {
    let file = File::open(wav_path).map_err(|e| format!("failed to open {}: {e}", wav_path.display()))?;
    let mut reader = BufReader::new(file);
    let (format_tag, channels, bits_per_sample, data) = read_wav_header(&mut reader)?;
    let samples = frame_max_abs(format_tag, channels, bits_per_sample, &data);
    Ok(bucketize(&samples, n))
}

/// Computes peaks for a non-WAV source (e.g. `source.webm`/`source.m4a`) by
/// piping `ffmpeg -i <src> -f s16le -ac 1 -ar 8000 -` and reading stdout
/// directly, without writing a temp file. Fast: 8kHz mono keeps decode cheap.
pub fn compute_peaks_ffmpeg(src_path: &Path, n: usize) -> Result<Vec<f32>, String> {
    let src_s = src_path.to_string_lossy().to_string();
    let output = super::silent_command("ffmpeg")
        .args(["-i", &src_s, "-f", "s16le", "-ac", "1", "-ar", "8000", "-"])
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(20).collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg peaks decode failed: {tail}"));
    }
    let bytes = output.stdout;
    let n_samples = bytes.len() / 2;
    let mut samples = Vec::with_capacity(n_samples);
    for i in 0..n_samples {
        let v = i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]);
        samples.push((v as f32 / 32768.0).abs());
    }
    Ok(bucketize(&samples, n))
}

/// Number of peak points computed for every wav per the contract (v5
/// addendum: "Peaks (performance)").
pub const DEFAULT_N: usize = 1000;

/// Computes peaks for `path`, dispatching to the fast WAV reader for `.wav`
/// files and to the ffmpeg-stdout path for anything else (e.g.
/// `source.webm`/`source.m4a`).
pub fn compute_peaks_for_path(path: &Path) -> Result<Vec<f32>, String> {
    let is_wav = path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("wav")).unwrap_or(false);
    if is_wav {
        compute_peaks(path, DEFAULT_N)
    } else {
        compute_peaks_ffmpeg(path, DEFAULT_N)
    }
}

/// Splits `samples` (per-frame abs amplitude) into `n` buckets, taking the
/// max of each bucket, normalized against the global max, rounded to 3
/// decimals.
fn bucketize(samples: &[f32], n: usize) -> Vec<f32> {
    if samples.is_empty() || n == 0 {
        return vec![0.0; n];
    }
    let global_max = samples.iter().cloned().fold(0.0f32, f32::max);
    let scale = if global_max > 0.0 { 1.0 / global_max } else { 0.0 };

    let mut out = Vec::with_capacity(n);
    let len = samples.len();
    for i in 0..n {
        let start = (i * len) / n;
        let end = (((i + 1) * len) / n).max(start + 1).min(len);
        let mut m = 0.0f32;
        for &s in &samples[start..end] {
            if s > m {
                m = s;
            }
        }
        let normalized = (m * scale).clamp(0.0, 1.0);
        out.push((normalized * 1000.0).round() / 1000.0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Writes a minimal 16-bit mono PCM WAV containing a sine wave.
    fn write_sine_wav(path: &Path, sample_rate: u32, seconds: f64, freq: f64) {
        let n = (sample_rate as f64 * seconds) as u32;
        let data_bytes = n * 2;
        let mut file = File::create(path).unwrap();

        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data_bytes).to_le_bytes()).unwrap();
        file.write_all(b"WAVE").unwrap();

        file.write_all(b"fmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
        file.write_all(&1u16.to_le_bytes()).unwrap(); // mono
        file.write_all(&sample_rate.to_le_bytes()).unwrap();
        let byte_rate = sample_rate * 2;
        file.write_all(&byte_rate.to_le_bytes()).unwrap();
        file.write_all(&2u16.to_le_bytes()).unwrap(); // block align
        file.write_all(&16u16.to_le_bytes()).unwrap(); // bits per sample

        file.write_all(b"data").unwrap();
        file.write_all(&data_bytes.to_le_bytes()).unwrap();
        for i in 0..n {
            let t = i as f64 / sample_rate as f64;
            let sample = (t * freq * std::f64::consts::TAU).sin() * 0.8;
            let v = (sample * i16::MAX as f64) as i16;
            file.write_all(&v.to_le_bytes()).unwrap();
        }
    }

    #[test]
    fn compute_peaks_on_sine_wav() {
        let mut dir = std::env::temp_dir();
        dir.push(format!("absolutesample_peaks_test_{:?}", std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sine.wav");
        write_sine_wav(&path, 44100, 1.0, 440.0);

        let peaks = compute_peaks(&path, 1000).unwrap();
        assert_eq!(peaks.len(), 1000);
        // A full-amplitude-ish sine wave should have buckets near 1.0.
        let max = peaks.iter().cloned().fold(0.0f32, f32::max);
        assert!(max > 0.9, "expected near-1.0 peak, got {max}");
        assert!(peaks.iter().all(|&p| (0.0..=1.0).contains(&p)));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compute_peaks_small_n() {
        let mut dir = std::env::temp_dir();
        dir.push(format!("absolutesample_peaks_test_small_{:?}", std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sine.wav");
        write_sine_wav(&path, 8000, 0.1, 220.0);

        let peaks = compute_peaks(&path, 10).unwrap();
        assert_eq!(peaks.len(), 10);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bucketize_empty_returns_zeros() {
        let out = bucketize(&[], 5);
        assert_eq!(out, vec![0.0; 5]);
    }
}
