//! TD-PSOLA: the voice is cut into one-period grains centred on its pitch epochs and
//! the grains are re-spaced to the new period. The grain contents (and so the
//! formants, breath and timbre) are untouched, which is why it sounds natural.

use crate::pitch::{midi_to_hz, runs, HOP_SEC};

/// Unvoiced gaps up to this many frames (50 ms) inside a phrase are bridged.
pub const BRIDGE_FRAMES: usize = 5;

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
    // A dropout of a few frames inside a sung line is a detector gap, not a real break: bridge
    // it so the line is resynthesised as one continuous phrase (no seams).
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in runs(&voiced) {
        match merged.last_mut() {
            Some(last) if s - last.1 <= BRIDGE_FRAMES => last.1 = e,
            _ => merged.push((s, e)),
        }
    }
    let mut out = Vec::new();
    for (fs, fe) in merged {
        let start = ((fs as f32 * HOP_SEC - HOP_SEC * 0.5).max(0.0) * sr) as usize;
        let end = (((fe as f32 * HOP_SEC + HOP_SEC * 0.5) * sr) as usize).min(x.len());
        if end <= start + 16 {
            continue;
        }
        // Inside a bridged gap there is no pitch: keep the last known period.
        let last_period = std::cell::Cell::new(sr / 150.0);
        let period = |pos: usize| -> f32 {
            let p = pitch_at(midi, pos as f32 / sr);
            if !p.is_nan() {
                last_period.set(sr / midi_to_hz(p));
            }
            last_period.get()
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
            // Pitch-synchronous marks must sit at the SAME point of every cycle, or neighbouring
            // grains are out of phase and the overlap-add sounds rough/crackly. Pick the offset
            // whose surrounding period best matches the previous cycle (normalised correlation),
            // with a small pull toward the predicted position.
            let half = (t * 0.5) as isize;
            let lo = (pred - 0.25 * t).max(m as f32 + 0.5 * t) as isize;
            let hi = ((pred + 0.25 * t) as isize).min(end as isize - 1);
            if hi <= lo {
                break;
            }
            let mut best = (f32::MIN, lo);
            for c in lo..=hi {
                let (mut xy, mut xx, mut yy) = (0.0f32, 0.0f32, 0.0f32);
                for j in -half..=half {
                    let a = m as isize + j;
                    let b = c + j;
                    if a < 0 || b < 0 || b as usize >= x.len() {
                        continue;
                    }
                    let (p, q) = (lp[a as usize], lp[b as usize]);
                    xy += p * q;
                    xx += p * p;
                    yy += q * q;
                }
                let r = xy / (xx * yy).sqrt().max(1e-12);
                let pull = 0.05 * ((c as f32 - pred) / t).abs();
                if r - pull > best.0 {
                    best = (r - pull, c);
                }
            }
            let next = best.1 as usize;
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
        let ratio = 2f32.powf(shift_at(ts) / 12.0);
        let step = t_a / ratio;
        // Grain half-width covers the output spacing too: when pitching DOWN the grains are
        // spread further apart than one period, and a one-period window would leave gaps.
        let half_w = t_a.max(step);
        let l = half_w.ceil() as isize;
        let a = ep[k] as isize;
        let c = ts.round() as isize;
        for j in -l..=l {
            let src = a + j;
            let dsti = c + j - s0 as isize;
            if src < 0 || src as usize >= x.len() || dsti < 0 || dsti as usize >= len {
                continue;
            }
            let w = 0.5 * (1.0 + (std::f32::consts::PI * (j as f32 / half_w).clamp(-1.0, 1.0)).cos());
            y[dsti as usize] += x[src as usize] * w;
            wsum[dsti as usize] += w;
        }
        ts += step;
    }
    for i in 0..len {
        let pos = s0 + i;
        let orig = x[pos];
        // Inside the phrase the output is fully the resynthesis (no flicker between two
        // non-phase-aligned signals). Only where grain coverage fades out, at the phrase
        // edges, does it crossfade continuously back to the original.
        let g = (wsum[i] / 0.5).clamp(0.0, 1.0);
        let synth = if wsum[i] > 1e-6 { y[i] / wsum[i] } else { orig };
        // Add the change rather than overwrite: neighbouring phrases' margins may overlap,
        // and overwriting would cut one phrase's tail off with a click.
        let di = pos as isize - dst_offset as isize;
        if di >= 0 && (di as usize) < dst.len() {
            dst[di as usize] += (synth - orig) * g;
        }
    }
}
