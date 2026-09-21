//! Linkwitz-Riley 4th-order stem-splitting filter graph + astats loudness.

use super::silent_command;
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const STEM_KEYS: [&str; 4] = ["drums_sub", "bass_lowmid", "mid_vocals", "highs_air"];
pub const STEM_LABELS: [&str; 4] = ["Drums / Sub", "Bass / Low-Mid", "Mid / Vocals", "Highs / Air"];
pub const STEM_BANDS: [&str; 4] = [
    "LP 130 Hz (LR4)",
    "HP 130 Hz - LP 800 Hz (LR4)",
    "HP 800 Hz - LP 4500 Hz (LR4)",
    "HP 4500 Hz (LR4)",
];

fn lr4_lp(f: u32) -> String {
    format!("lowpass=f={f}:p=2:t=q:w=0.7071,lowpass=f={f}:p=2:t=q:w=0.7071")
}

fn lr4_hp(f: u32) -> String {
    format!("highpass=f={f}:p=2:t=q:w=0.7071,highpass=f={f}:p=2:t=q:w=0.7071")
}

/// Builds the single-pass ffmpeg filter_complex graph string per the
/// contract's DSP spec, producing 4 labeled outputs `[s1]..[s4]`.
pub fn build_filter_graph() -> String {
    let s1 = lr4_lp(130);
    let s2 = format!("{},{}", lr4_hp(130), lr4_lp(800));
    let s3 = format!(
        "{},{},pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1",
        lr4_hp(800),
        lr4_lp(4500)
    );
    let s4 = format!("{},stereotools=mlev=0.6:slev=1.6", lr4_hp(4500));

    format!(
        "[0:a]asplit=4[a][b][c][d]; [a]{s1}[s1]; [b]{s2}[s2]; [c]{s3}[s3]; [d]{s4}[s4]"
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemLoudness {
    pub peak_db: f64,
    pub rms_db: f64,
}

/// Runs the single ffmpeg pass, decoding `loop_wav` and writing 4 stem wavs
/// (44.1k, 24-bit PCM, stereo) into `out_dir` named `01_drums_sub.wav` etc.
pub fn split_stems(loop_wav: &Path, out_dir: &Path) -> Result<Vec<PathBuf>, String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("failed to create stems dir: {e}"))?;

    let graph = build_filter_graph();
    let src_s = loop_wav.to_string_lossy().to_string();

    let out_paths: Vec<PathBuf> = (1..=4)
        .map(|i| out_dir.join(format!("{i:02}_{}.wav", STEM_KEYS[i - 1])))
        .collect();
    let out_strs: Vec<String> = out_paths.iter().map(|p| p.to_string_lossy().to_string()).collect();

    let mut cmd = silent_command("ffmpeg");
    cmd.args(["-i", &src_s, "-filter_complex", &graph]);
    for (i, out_s) in out_strs.iter().enumerate() {
        let label = format!("[s{}]", i + 1);
        cmd.args(["-map", &label, "-c:a", "pcm_s24le", "-ar", "44100", "-y", out_s]);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(30).collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg stem split failed: {tail}"));
    }

    Ok(out_paths)
}

/// Runs ffmpeg astats on `wav_path`, parsing `Peak level dB` / `RMS level dB`
/// from stderr (via `-af astats=... -f null -`).
pub fn measure_loudness(wav_path: &Path) -> Result<StemLoudness, String> {
    let src_s = wav_path.to_string_lossy().to_string();
    let output = silent_command("ffmpeg")
        .args([
            "-i",
            &src_s,
            "-af",
            "astats=measure_overall=Peak_level+RMS_level:measure_perchannel=none",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let peak = parse_astats_value(&stderr, "Peak level dB");
    let rms = parse_astats_value(&stderr, "RMS level dB");

    match (peak, rms) {
        (Some(peak_db), Some(rms_db)) => Ok(StemLoudness { peak_db, rms_db }),
        _ => Err(format!(
            "failed to parse astats output for {}",
            wav_path.display()
        )),
    }
}

fn parse_astats_value(text: &str, label: &str) -> Option<f64> {
    for line in text.lines() {
        if let Some(pos) = line.find(label) {
            let rest = &line[pos + label.len()..];
            let value_str = rest.trim_start_matches(':').trim();
            if let Ok(v) = value_str.parse::<f64>() {
                return Some(v);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_graph_matches_contract_shape() {
        let g = build_filter_graph();
        assert!(g.starts_with("[0:a]asplit=4[a][b][c][d];"));
        assert!(g.contains("[a]lowpass=f=130:p=2:t=q:w=0.7071,lowpass=f=130:p=2:t=q:w=0.7071[s1]"));
        assert!(g.contains("highpass=f=130:p=2:t=q:w=0.7071,highpass=f=130:p=2:t=q:w=0.7071,lowpass=f=800:p=2:t=q:w=0.7071,lowpass=f=800:p=2:t=q:w=0.7071[s2]"));
        assert!(g.contains("highpass=f=800"));
        assert!(g.contains("lowpass=f=4500"));
        assert!(g.contains("pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1[s3]"));
        assert!(g.contains("highpass=f=4500:p=2:t=q:w=0.7071,highpass=f=4500:p=2:t=q:w=0.7071,stereotools=mlev=0.6:slev=1.6[s4]"));
    }

    #[test]
    fn stem_naming_arrays_are_aligned() {
        assert_eq!(STEM_KEYS.len(), 4);
        assert_eq!(STEM_LABELS.len(), 4);
        assert_eq!(STEM_BANDS.len(), 4);
    }

    #[test]
    fn parse_astats_value_extracts_numbers() {
        let sample = "[Parsed_astats_0 @ 0000] Overall\n[Parsed_astats_0 @ 0000] Peak level dB: -3.010300\n[Parsed_astats_0 @ 0000] RMS level dB: -18.234500\n";
        assert_eq!(parse_astats_value(sample, "Peak level dB"), Some(-3.0103));
        assert_eq!(parse_astats_value(sample, "RMS level dB"), Some(-18.2345));
    }
}
