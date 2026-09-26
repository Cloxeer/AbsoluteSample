//! TD-PSOLA: the voice is cut into one-period grains centred on its pitch epochs and
//! the grains are re-spaced to the new period. The grain contents (and so the
//! formants, breath and timbre) are untouched, which is why it sounds natural.

use crate::pitch::{midi_to_hz, runs, HOP_SEC};

pub struct Run {
    pub start: usize, // samples
    pub end: usize,
    pub epochs: Vec<usize>,
}

/// Pitch (MIDI) at an arbitrary time, interpolating voiced frames.
fn pitch_at(midi: &[f32], sec: f32) -> f32 {
    let f = sec / HOP_SEC;
    let i = (f.floor() as isize).clamp(0, midi.len() as isize - 1) as usize;
    let j = (i + 1).min(midi.len() - 1);
    let (a, b) = (midi[i], midi[j]);
    match (a.is_nan(), b.is_nan()) {
        (false, false) => a + (b - a) * (f - i as f32).clamp(0.0, 1.0),
        (false, true) => a,
        (true, false) => b,
        _ => f32::NAN,
    }
}

/// Glottal-epoch marks for every voiced run: one per period, aligned to the peaks of
/// a low-passed copy of the signal so neighbouring grains are phase-consistent.
pub fn find_epochs(x: &[f32], sr: f32, midi: &[f32]) -> Vec<Run> {
    // one-pole low-pass around 1 kHz emphasises the fundamental's peaks
    let a = (-2.0 * std::f32::consts::PI * 1000.0 / sr).exp();
    let mut lp = vec![0.0f32; x.len()];
    let mut z = 0.0;
    for (i, &v) in x.iter().enumerate() {
        z = (1.0 - a) * v + a * z;
        lp[i] = z;
    }
    let voiced: Vec<bool> = midi.iter().map(|m| !m.is_nan()).collect();
    let mut out = Vec::new();
    for (fs, fe) in runs(&voiced) {
        let start = ((fs as f32 * HOP_SEC - HOP_SEC * 0.5).max(0.0) * sr) as usize;
        let end = (((fe as f32 * HOP_SEC + HOP_SEC * 0.5) * sr) as usize).min(x.len());
        if end <= start + 16 {
            continue;
        }
        let period = |pos: usize| -> f32 {
            let p = pitch_at(midi, pos as f32 / sr);
            if p.is_nan() {
                sr / 150.0
            } else {
                sr / midi_to_hz(p)
            }
        };
        let argmax = |a: usize, b: usize| -> usize {
            let b = b.min(lp.len());
            (a..b).max_by(|&i, &j| lp[i].partial_cmp(&lp[j]).unwrap()).unwrap_or(a)
        };
        let t0 = period(start);
        let mut m = argmax(start, start + t0 as usize + 1);
        let mut epochs = vec![m];
        loop {
            let t = period(m);
            let pred = m as f32 + t;
            if pred >= end as f32 {
                break;
            }
            let lo = (pred - 0.2 * t).max(m as f32 + 0.5 * t) as usize;
            let hi = (pred + 0.2 * t) as usize + 1;
            let next = argmax(lo, hi.min(end));
            if next <= m {
                break;
            }
            m = next;
            epochs.push(m);
        }
        out.push(Run { start, end, epochs });
    }
    out
}

/// Re-synthesise one run with a per-sample shift (semitones) and blend it into `dst`
/// (which starts as the original audio) only where the shift is non-zero.
pub fn render_run(x: &[f32], sr: f32, run: &Run, shift_frames: &[f32], dst: &mut [f32], dst_offset: usize) {
    let shift_at = |pos: f32| -> f32 {
        let f = pos / sr / HOP_SEC;
        let i = (f.floor() as isize).clamp(0, shift_frames.len() as isize - 1) as usize;
        let j = (i + 1).min(shift_frames.len() - 1);
        shift_frames[i] + (shift_frames[j] - shift_frames[i]) * (f - i as f32).clamp(0.0, 1.0)
    };
    // Skip untouched runs entirely: the output stays bit-identical to the input.
    let f0 = (run.start as f32 / sr / HOP_SEC) as usize;
    let f1 = ((run.end as f32 / sr / HOP_SEC) as usize + 1).min(shift_frames.len());
    if f0 >= f1 || shift_frames[f0..f1].iter().all(|s| s.abs() < 1e-4) {
        return;
    }
    let ep = &run.epochs;
    if ep.len() < 3 {
        return;
    }
    let pad = (sr / 50.0) as usize;
    let s0 = run.start.saturating_sub(pad);
    let s1 = (run.end + pad).min(x.len());
    let len = s1 - s0;
    let mut y = vec![0.0f32; len];
    let mut wsum = vec![0.0f32; len];
    let local_period = |k: usize| -> f32 {
        let a = ep[k.saturating_sub(1)];
        let b = ep[(k + 1).min(ep.len() - 1)];
        let span = (k + 1).min(ep.len() - 1) - k.saturating_sub(1);
        (b - a) as f32 / span.max(1) as f32
    };
    let mut ts = ep[0] as f32;
    let mut k = 0usize;
    while ts < *ep.last().unwrap() as f32 {
        while k + 1 < ep.len() && ((ep[k + 1] as f32 - ts).abs() < (ep[k] as f32 - ts).abs()) {
            k += 1;
        }
        let t_a = local_period(k).max(8.0);
        let l = t_a as isize;
        let a = ep[k] as isize;
        let c = ts.round() as isize;
        for j in -l..=l {
            let src = a + j;
            let dsti = c + j - s0 as isize;
            if src < 0 || src as usize >= x.len() || dsti < 0 || dsti as usize >= len {
                continue;
            }
            let w = 0.5 * (1.0 + (std::f32::consts::PI * j as f32 / t_a).cos());
            y[dsti as usize] += x[src as usize] * w;
            wsum[dsti as usize] += w;
        }
        let ratio = 2f32.powf(shift_at(ts) / 12.0);
        ts += t_a / ratio;
    }
    for i in 0..len {
        let pos = s0 + i;
        let orig = x[pos];
        let synth = if wsum[i] > 0.3 { y[i] / wsum[i] } else { orig };
        // blend gain: 1 where retuned, fading to 0 where the shift is ~0
        let g = (shift_at(pos as f32).abs() / 0.02).clamp(0.0, 1.0);
        let di = pos as isize - dst_offset as isize;
        if di >= 0 && (di as usize) < dst.len() {
            dst[di as usize] = orig * (1.0 - g) + synth * g;
        }
    }
}
