//! Frame-level pitch tracking: YIN difference function (FFT-accelerated), several
//! candidates per frame, and a Viterbi pass that picks the most continuous path so
//! octave jumps are rejected. Then loudness gating removes silence, reverb tails and
//! onset glitches, which a pure periodicity detector would happily track.

use rustfft::{num_complex::Complex32, FftPlanner};

/// Analysis rate. Vocals carry their pitch well below 8 kHz.
pub const ASR: f32 = 16000.0;
/// 10 ms hop.
pub const HOP: usize = 160;
pub const HOP_SEC: f32 = HOP as f32 / ASR;
const WIN: usize = 1024;
const FMIN: f32 = 78.0; // lowest sung notes (bass voices reach ~E2 = 82 Hz)
const HPF_HZ: f32 = 70.0;
const FMAX: f32 = 1100.0;
const TAU_MIN: usize = (ASR / FMAX) as usize;
const TAU_MAX: usize = (ASR / FMIN) as usize;
const INTEG: usize = WIN - TAU_MAX;
const PERIODIC_MAX: f32 = 0.30; // CMNDF minimum above this is treated as unpitched
const CAND_MAX: f32 = 0.55;

pub struct Track {
    /// MIDI pitch per frame, NaN where unvoiced. Frame i is centered at i * HOP_SEC.
    pub midi: Vec<f32>,
    /// RMS level in dBFS per frame (25 ms window).
    pub db: Vec<f32>,
}

pub fn hz_to_midi(hz: f32) -> f32 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

pub fn midi_to_hz(m: f32) -> f32 {
    440.0 * 2f32.powf((m - 69.0) / 12.0)
}

/// Windowed-sinc low-pass + linear interpolation down to ASR.
pub fn resample_to_asr(x: &[f32], sr: f32) -> Vec<f32> {
    if (sr - ASR).abs() < 1.0 {
        return x.to_vec();
    }
    let ratio = sr / ASR;
    let cutoff = 0.45 / ratio; // normalized to input rate
    let taps = 63usize;
    let half = (taps / 2) as isize;
    let kernel: Vec<f32> = (0..taps)
        .map(|i| {
            let n = i as isize - half;
            let s = if n == 0 { 2.0 * cutoff } else { (2.0 * std::f32::consts::PI * cutoff * n as f32).sin() / (std::f32::consts::PI * n as f32) };
            let w = 0.54 - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / (taps - 1) as f32).cos();
            s * w
        })
        .collect();
    let n_out = (x.len() as f32 / ratio) as usize;
    let mut out = Vec::with_capacity(n_out);
    let filt = |center: isize| -> f32 {
        let mut acc = 0.0;
        for (k, kv) in kernel.iter().enumerate() {
            let idx = center + k as isize - half;
            if idx >= 0 && (idx as usize) < x.len() {
                acc += x[idx as usize] * kv;
            }
        }
        acc
    };
    for i in 0..n_out {
        let pos = i as f32 * ratio;
        let i0 = pos.floor() as isize;
        let frac = pos - i0 as f32;
        let a = filt(i0);
        let b = filt(i0 + 1);
        out.push(a + (b - a) * frac);
    }
    out
}

/// (threshold, weight) pairs of a Beta(2, 18)-like prior (mean 0.1), weights sum to 1.
static THRESHOLDS: std::sync::LazyLock<Vec<(f32, f32)>> = std::sync::LazyLock::new(|| {
    let raw: Vec<(f32, f32)> = (1..=60)
        .map(|k| {
            let t = k as f32 * 0.01;
            (t, t * (1.0 - t).powi(17))
        })
        .collect();
    let s: f32 = raw.iter().map(|r| r.1).sum();
    raw.into_iter().map(|(t, w)| (t, w / s)).collect()
});

struct Cand {
    midi: f32,
    cost: f32,
}

/// 4th-order Butterworth high-pass (two biquads). Separated vocal stems often carry
/// bass bleed whose low period would otherwise out-vote the voice.
pub fn highpass(x: &[f32], fc: f32, sr: f32) -> Vec<f32> {
    let mut y = x.to_vec();
    for q in [0.541_196_1f32, 1.306_563] {
        let w0 = 2.0 * std::f32::consts::PI * fc / sr;
        let (s, c) = w0.sin_cos();
        let alpha = s / (2.0 * q);
        let a0 = 1.0 + alpha;
        let b0 = (1.0 + c) / 2.0 / a0;
        let b1 = -(1.0 + c) / a0;
        let b2 = b0;
        let a1 = -2.0 * c / a0;
        let a2 = (1.0 - alpha) / a0;
        let (mut x1, mut x2, mut y1, mut y2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for v in y.iter_mut() {
            let x0 = *v;
            let out = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = out;
            *v = out;
        }
    }
    y
}

pub fn track(x16_raw: &[f32]) -> Track {
    let x16 = &highpass(x16_raw, HPF_HZ, ASR)[..];
    let n_frames = x16.len() / HOP + 1;
    // Pad so frame i is centered on sample i*HOP.
    let mut pad = vec![0.0f32; WIN / 2];
    pad.extend_from_slice(x16);
    pad.extend(std::iter::repeat(0.0).take(WIN));

    let mut planner = FftPlanner::<f32>::new();
    let nfft = 2048;
    let fft = planner.plan_fft_forward(nfft);
    let ifft = planner.plan_fft_inverse(nfft);
    let mut a = vec![Complex32::new(0.0, 0.0); nfft];
    let mut b = vec![Complex32::new(0.0, 0.0); nfft];

    let mut cands: Vec<Vec<Cand>> = Vec::with_capacity(n_frames);
    let mut db = Vec::with_capacity(n_frames);
    let mut d = vec![0.0f32; TAU_MAX + 2];
    let mut cm = vec![0.0f32; TAU_MAX + 2];
    let mut cum = vec![0.0f32; WIN + 1];

    for f in 0..n_frames {
        let fr = &pad[f * HOP..f * HOP + WIN];
        // level over the central 25 ms
        let c0 = WIN / 2 - 200;
        let e: f32 = fr[c0..c0 + 400].iter().map(|v| v * v).sum::<f32>() / 400.0;
        db.push(if e > 1e-12 { 10.0 * e.log10() } else { -120.0 });

        for i in 0..nfft {
            a[i] = Complex32::new(if i < INTEG { fr[i] } else { 0.0 }, 0.0);
            b[i] = Complex32::new(if i < WIN { fr[i] } else { 0.0 }, 0.0);
        }
        fft.process(&mut a);
        fft.process(&mut b);
        for i in 0..nfft {
            a[i] = a[i].conj() * b[i];
        }
        ifft.process(&mut a);
        cum[0] = 0.0;
        for i in 0..WIN {
            cum[i + 1] = cum[i] + fr[i] * fr[i];
        }
        let e0 = cum[INTEG];
        for tau in 0..=TAU_MAX {
            let et = cum[tau + INTEG] - cum[tau];
            let c = a[tau].re / nfft as f32;
            d[tau] = (e0 + et - 2.0 * c).max(0.0);
        }
        cm[0] = 1.0;
        let mut run = 0.0;
        for tau in 1..=TAU_MAX {
            run += d[tau];
            cm[tau] = if run > 0.0 { d[tau] * tau as f32 / run } else { 1.0 };
        }

        // Dips (local minima) in tau order: (tau, value)
        let mut dips: Vec<(f32, f32)> = Vec::new();
        for tau in TAU_MIN.max(2)..TAU_MAX {
            if cm[tau] < cm[tau - 1] && cm[tau] <= cm[tau + 1] && cm[tau] < CAND_MAX {
                let (y0, y1, y2) = (cm[tau - 1], cm[tau], cm[tau + 1]);
                let den = y0 - 2.0 * y1 + y2;
                let off = if den.abs() > 1e-9 { 0.5 * (y0 - y2) / den } else { 0.0 };
                let t = tau as f32 + off.clamp(-0.5, 0.5);
                let v = (y1 - 0.25 * (y0 - y2) * off).max(0.0);
                dips.push((t, v));
            }
        }
        // pYIN: for each threshold (weighted by a prior peaked near 0.1) the chosen
        // period is the FIRST dip under it. Summing over thresholds gives each dip a
        // probability that strongly favours the true period over its multiples.
        let mut prob = vec![0.0f32; dips.len()];
        let best = dips.iter().map(|d| d.1).fold(1.0, f32::min);
        if best < PERIODIC_MAX {
            for (th, w) in THRESHOLDS.iter() {
                if let Some(k) = dips.iter().position(|d| d.1 < *th) {
                    prob[k] += w;
                }
            }
        }
        let fc: Vec<Cand> = dips
            .iter()
            .zip(&prob)
            .filter(|(_, p)| **p > 0.002)
            .map(|(d, p)| Cand { midi: hz_to_midi(ASR / d.0), cost: -p.ln() * 0.25 })
            .collect();
        cands.push(fc);
    }

    referee(x16_raw, &db, &mut cands); // the network was trained on unfiltered audio
    let mut midi = viterbi(&cands);
    median3(&mut midi);
    clean_voicing(&mut midi, &db);
    Track { midi, db }
}

const REFEREE_EVERY: usize = 10; // run the neural net on every 10th pitched frame (100 ms)
const REFEREE_REACH: isize = 6; // an anchor governs frames within +-60 ms
const REFEREE_MIN_CONF: f32 = 0.4;
const FILL_MIN_CONF: f32 = 0.6;
const OCTAVE_MISMATCH_COST: f32 = 1.5;

/// The neural octave referee: CREPE-tiny decides which octave each region is in;
/// YIN candidates in the wrong octave are penalised, and CREPE's own estimate is added
/// as a candidate when YIN offered nothing near it.
fn referee(x16: &[f32], db: &[f32], cands: &mut [Vec<Cand>]) {
    let net = crate::crepe::Crepe::load();
    let half = crate::crepe::FRAME / 2;
    let mut pad = vec![0.0f32; half];
    pad.extend_from_slice(x16);
    pad.extend(std::iter::repeat(0.0).take(crate::crepe::FRAME));
    let n = cands.len();
    // Loud frames where YIN found no clear period (breathy voice, bleed): ask the
    // network directly every third frame and trust it when it is confident.
    let mut loud: Vec<f32> = db.to_vec();
    loud.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let loud95 = loud.get(((loud.len().max(1) - 1) as f32 * 0.95) as usize).cloned().unwrap_or(-20.0);
    let fill_gate = (loud95 - 25.0).max(-50.0);
    let mut filled: Vec<Option<f32>> = vec![None; n];
    let mut f = 0;
    while f < n {
        if cands[f].is_empty() && db[f] > fill_gate {
            let (m, conf) = net.pitch(&pad[f * HOP..f * HOP + crate::crepe::FRAME]);
            if conf >= FILL_MIN_CONF && in_voice_range(m) {
                filled[f] = Some(m);
            }
            f += 3;
        } else {
            f += 1;
        }
    }
    for f in 0..n {
        if !cands[f].is_empty() || db[f] <= fill_gate {
            continue;
        }
        let a = filled[f].or(if f > 0 { filled[f - 1] } else { None }).or(filled.get(f + 1).cloned().flatten());
        if let Some(m) = a {
            cands[f].push(Cand { midi: m, cost: 0.5 });
        }
    }

    let mut anchors: Vec<Option<f32>> = vec![None; n];
    let mut count = 0usize;
    for f in 0..n {
        if cands[f].is_empty() {
            continue;
        }
        if count % REFEREE_EVERY == 0 {
            let (m, conf) = net.pitch(&pad[f * HOP..f * HOP + crate::crepe::FRAME]);
            if conf >= REFEREE_MIN_CONF && in_voice_range(m) {
                anchors[f] = Some(m);
            }
        }
        count += 1;
    }
    for f in 0..n {
        if cands[f].is_empty() {
            continue;
        }
        let mut near: Option<(isize, f32)> = None;
        for d in -REFEREE_REACH..=REFEREE_REACH {
            let g = f as isize + d;
            if g < 0 || g >= n as isize {
                continue;
            }
            if let Some(a) = anchors[g as usize] {
                if near.map_or(true, |(bd, _)| d.abs() < bd.abs()) {
                    near = Some((d, a));
                }
            }
        }
        let Some((_, a)) = near else { continue };
        let mut has_close = false;
        for c in cands[f].iter_mut() {
            let dist = (c.midi - a).abs();
            if dist > 5.0 {
                c.cost += OCTAVE_MISMATCH_COST;
            }
            if dist < 1.0 {
                has_close = true;
            }
        }
        if !has_close {
            cands[f].push(Cand { midi: a, cost: 0.6 });
        }
    }
}

/// The network covers 32 Hz-2 kHz; mains hum and rumble live below any singing voice.
fn in_voice_range(m: f32) -> bool {
    m >= hz_to_midi(FMIN) && m <= hz_to_midi(FMAX)
}

/// Continuity-seeking path through each run of pitched frames.
fn viterbi(cands: &[Vec<Cand>]) -> Vec<f32> {
    const JUMP_COST_PER_SEMI: f32 = 0.05;
    let n = cands.len();
    let mut out = vec![f32::NAN; n];
    let mut i = 0;
    while i < n {
        if cands[i].is_empty() {
            i += 1;
            continue;
        }
        let s = i;
        while i < n && !cands[i].is_empty() {
            i += 1;
        }
        let e = i;
        let mut cost: Vec<f32> = cands[s].iter().map(|c| c.cost).collect();
        let mut back: Vec<Vec<usize>> = vec![vec![0; cands[s].len()]];
        for f in s + 1..e {
            let mut nc = Vec::with_capacity(cands[f].len());
            let mut nb = Vec::with_capacity(cands[f].len());
            for c in &cands[f] {
                let mut bi = 0;
                let mut bv = f32::INFINITY;
                for (k, p) in cands[f - 1].iter().enumerate() {
                    let v = cost[k] + (c.midi - p.midi).abs() * JUMP_COST_PER_SEMI;
                    if v < bv {
                        bv = v;
                        bi = k;
                    }
                }
                nc.push(bv + c.cost);
                nb.push(bi);
            }
            cost = nc;
            back.push(nb);
        }
        let mut k = cost.iter().enumerate().min_by(|a, b| a.1.partial_cmp(b.1).unwrap()).map(|p| p.0).unwrap_or(0);
        for f in (s..e).rev() {
            out[f] = cands[f][k].midi;
            k = back[f - s][k];
        }
    }
    out
}

fn median3(m: &mut [f32]) {
    let src = m.to_vec();
    for i in 1..m.len().saturating_sub(1) {
        let (a, b, c) = (src[i - 1], src[i], src[i + 1]);
        if a.is_nan() || b.is_nan() || c.is_nan() {
            continue;
        }
        let mut v = [a, b, c];
        v.sort_by(|x, y| x.partial_cmp(y).unwrap());
        m[i] = v[1];
    }
}

pub fn runs(voiced: &[bool]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, &v) in voiced.iter().enumerate() {
        match (v, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                out.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push((s, voiced.len()));
    }
    out
}

const GATE_FLOOR_DB: f32 = -55.0;
const GATE_BELOW_PEAK_DB: f32 = 32.0; // Melodyne-like: voice lives within ~30-35 dB of the loud parts
const TAIL_DB: f32 = 15.0;
const EDGE_OUTLIER_SEMI: f32 = 1.5;
const EDGE_MAX_FRAMES: usize = 6;
const STOP_DROP_DB: f32 = 6.0;
const STOP_WITHIN: usize = 8;
const STOP_RECOVER_DB: f32 = 4.0;

fn slope_db_per_sec(seg: &[f32]) -> f32 {
    let n = seg.len() as f32;
    if n < 3.0 {
        return 0.0;
    }
    let mx = (n - 1.0) / 2.0;
    let my = seg.iter().sum::<f32>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for (i, &y) in seg.iter().enumerate() {
        let dx = i as f32 - mx;
        num += dx * (y - my);
        den += dx * dx;
    }
    (num / den) / HOP_SEC
}

fn sudden_stop(db: &[f32], s: usize, e: usize) -> Option<usize> {
    if e < s + 5 + STOP_WITHIN + 1 {
        return None;
    }
    for i in s + 5..e - STOP_WITHIN {
        let before = db[i.saturating_sub(3).max(s)..=i].iter().cloned().fold(f32::MIN, f32::max);
        let after = db[i + STOP_WITHIN];
        if before - after < STOP_DROP_DB {
            continue;
        }
        let rest = &db[i + STOP_WITHIN..e];
        if rest.iter().cloned().fold(f32::MIN, f32::max) >= before - STOP_RECOVER_DB {
            continue;
        }
        if rest.len() >= 3 && slope_db_per_sec(rest) > -10.0 {
            continue;
        }
        let mut j = i + 1;
        while j < i + STOP_WITHIN && db[j] >= before - 3.0 {
            j += 1;
        }
        return Some(j);
    }
    None
}

/// Unvoice silence, reverb tails, onset/offset glitches and isolated blips.
pub fn clean_voicing(midi: &mut [f32], db: &[f32]) {
    let mut vdb: Vec<f32> = midi.iter().zip(db).filter(|(m, _)| !m.is_nan()).map(|(_, d)| *d).collect();
    if vdb.is_empty() {
        return;
    }
    vdb.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let loud = vdb[((vdb.len() - 1) as f32 * 0.95) as usize];
    let gate = GATE_FLOOR_DB.max(loud - GATE_BELOW_PEAK_DB);
    for (m, d) in midi.iter_mut().zip(db) {
        if *d < gate {
            *m = f32::NAN;
        }
    }

    let voiced: Vec<bool> = midi.iter().map(|m| !m.is_nan()).collect();
    for (s, mut e) in runs(&voiced) {
        let peak = db[s..e].iter().cloned().fold(f32::MIN, f32::max);
        while e - s > 1 && db[e - 1] < peak - TAIL_DB {
            e -= 1;
            midi[e] = f32::NAN;
        }
        if let Some(cut) = sudden_stop(db, s, e) {
            for m in &mut midi[cut..e] {
                *m = f32::NAN;
            }
            e = cut;
        }
        let n = e - s;
        if n < 4 {
            continue;
        }
        let med = |a: usize, b: usize, m: &[f32]| -> f32 {
            let mut v: Vec<f32> = m[a..b].iter().cloned().filter(|x| !x.is_nan()).collect();
            if v.is_empty() {
                return f32::NAN;
            }
            v.sort_by(|x, y| x.partial_cmp(y).unwrap());
            v[v.len() / 2]
        };
        let head_ref = med(s + (n - 1).min(EDGE_MAX_FRAMES), s + n.min(EDGE_MAX_FRAMES + 8), midi);
        for i in s..e.min(s + EDGE_MAX_FRAMES) {
            if (midi[i] - head_ref).abs() > EDGE_OUTLIER_SEMI {
                midi[i] = f32::NAN;
            } else {
                break;
            }
        }
        let tail_ref = med(e.saturating_sub(EDGE_MAX_FRAMES + 8).max(s), e.saturating_sub(EDGE_MAX_FRAMES).max(s + 1), midi);
        for i in (e.saturating_sub(EDGE_MAX_FRAMES).max(s)..e).rev() {
            if (midi[i] - tail_ref).abs() > EDGE_OUTLIER_SEMI {
                midi[i] = f32::NAN;
            } else {
                break;
            }
        }
    }

    let voiced: Vec<bool> = midi.iter().map(|m| !m.is_nan()).collect();
    let mut prev_peak: Option<f32> = None;
    let mut prev_end: usize = 0;
    for (s, e) in runs(&voiced) {
        let seg = &db[s..e];
        let peak = seg.iter().cloned().fold(f32::MIN, f32::max);
        if e - s < 5 {
            for m in &mut midi[s..e] {
                *m = f32::NAN;
            }
            continue;
        }
        let mut is_tail = false;
        if let Some(pp) = prev_peak {
            if (s - prev_end) as f32 * HOP_SEC < 0.5 && peak < pp - 8.0 {
                let argmax = seg.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).map(|p| p.0).unwrap_or(0);
                is_tail = argmax <= 2 && slope_db_per_sec(seg) < -10.0;
            }
        }
        if is_tail {
            for m in &mut midi[s..e] {
                *m = f32::NAN;
            }
            prev_end = e;
        } else {
            prev_peak = Some(peak);
            prev_end = e;
        }
    }
}
