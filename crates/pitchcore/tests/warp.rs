//! Timing tightening (WSOLA segments): exact length, untouched audio outside the segment, moved
//! onsets land where asked, pitch is unchanged, no clicks, and sub-range renders match.

use pitchcore::Session;

const SR: f32 = 44100.0;

fn secs(s: f32) -> usize {
    (s * SR) as usize
}

/// Voice-like tone (harmonics, gentle vibrato) from `a` to `b` seconds at `hz`, with 20 ms ramps.
fn add_tone(x: &mut [f32], a: f32, b: f32, hz: f32) {
    let (s, e) = (secs(a), secs(b));
    let mut ph = 0.0f32;
    for i in s..e {
        let t = (i - s) as f32 / SR;
        let f = hz * (1.0 + 0.004 * (2.0 * std::f32::consts::PI * 5.5 * t).sin());
        ph += 2.0 * std::f32::consts::PI * f / SR;
        let env = (t / 0.02).min(1.0) * (((e - i) as f32 / SR) / 0.02).min(1.0);
        x[i] += env * (0.3 * ph.sin() + 0.15 * (2.0 * ph).sin() + 0.08 * (3.0 * ph).sin() + 0.04 * (5.0 * ph).sin());
    }
}

fn signal() -> Vec<f32> {
    let mut x = vec![0.0f32; secs(2.2)];
    add_tone(&mut x, 0.3, 0.8, 220.0);
    add_tone(&mut x, 1.1, 1.6, 247.0);
    x
}

fn onset(x: &[f32], from: f32, to: f32) -> f32 {
    let w = secs(0.002);
    let mut i = secs(from);
    while i + w < secs(to) {
        let e: f32 = x[i..i + w].iter().map(|v| v * v).sum::<f32>() / w as f32;
        if e > 0.3 * 0.3 * 0.25 * 0.1 {
            return i as f32 / SR;
        }
        i += w / 2;
    }
    f32::NAN
}

/// Period (seconds) by autocorrelation over [a, b).
fn period(x: &[f32], a: f32, b: f32) -> f32 {
    let seg = &x[secs(a)..secs(b)];
    let (lo, hi) = ((SR / 400.0) as usize, (SR / 100.0) as usize);
    let mut best = (f32::MIN, lo);
    for lag in lo..hi {
        let r: f32 = (0..seg.len() - lag).map(|i| seg[i] * seg[i + lag]).sum();
        if r > best.0 {
            best = (r, lag);
        }
    }
    best.1 as f32 / SR
}

/// Pull the second tone's onset 60 ms earlier (its note stretches to fill), inside the gap.
fn tighten() -> Vec<(f32, f32)> {
    vec![(0.95, 0.95), (1.04, 1.10), (1.60, 1.60), (1.75, 1.75)]
}

#[test]
fn warp_moves_the_onset_keeps_length_pitch_and_untouched_audio() {
    let x = signal();
    let mut s = Session::new(x.clone(), SR);
    let before = s.render_all();
    assert!(s.set_warps(&[tighten()]));
    let y = s.render_all();
    assert_eq!(y.len(), before.len(), "exact length");
    // Outside the segment: bit-identical.
    for i in (0..secs(0.95)).chain(secs(1.75)..y.len()) {
        assert_eq!(y[i], before[i], "sample {i} outside the segment changed");
    }
    let o0 = onset(&before, 0.9, 1.5);
    let o1 = onset(&y, 0.9, 1.5);
    assert!((o0 - 1.10).abs() < 0.01, "original onset {o0}");
    assert!((o1 - 1.04).abs() < 0.008, "tightened onset {o1} (wanted 1.04)");
    let (p0, p1) = (period(&before, 1.25, 1.45), period(&y, 1.25, 1.45));
    assert!((p0 - p1).abs() / p0 < 0.01, "pitch changed: {p0} vs {p1}");
    // No clicks: the biggest sample-to-sample jump stays in line with the original's.
    let jump = |v: &[f32]| v.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
    assert!(jump(&y) < jump(&before) * 1.35, "click: {} vs {}", jump(&y), jump(&before));
    // No level loss/gain in the stretched vowel.
    let rms = |v: &[f32]| (v.iter().map(|a| a * a).sum::<f32>() / v.len() as f32).sqrt();
    let (r0, r1) = (rms(&before[secs(1.2)..secs(1.5)]), rms(&y[secs(1.2)..secs(1.5)]));
    assert!((r1 / r0 - 1.0).abs() < 0.08, "level {r0} -> {r1}");
}

#[test]
fn identity_warp_changes_nothing_and_bad_maps_are_refused() {
    let x = signal();
    let mut s = Session::new(x, SR);
    let before = s.render_all();
    assert!(s.set_warps(&[vec![(0.9, 0.9), (1.2, 1.2), (1.7, 1.7)]]));
    assert_eq!(s.warp_count(), 0, "identity segments are dropped");
    assert_eq!(s.render_all(), before);
    // Ends must be the identity; maps must increase; speed within 0.5x..2x; no overlaps.
    assert!(!s.set_warps(&[vec![(0.9, 0.95), (1.7, 1.7)]]));
    assert!(!s.set_warps(&[vec![(0.9, 0.9), (1.2, 1.1), (1.1, 1.3), (1.7, 1.7)]]));
    assert!(!s.set_warps(&[vec![(0.9, 0.9), (0.95, 1.3), (1.7, 1.7)]]));
    assert!(!s.set_warps(&[tighten(), vec![(1.5, 1.5), (1.6, 1.62), (1.9, 1.9)]]));
    assert_eq!(s.warp_count(), 0, "a refused call changes nothing");
    // A segment ending exactly at the end of the audio (f32 seconds can overshoot by a hair) is fine.
    let end = s.render_all().len() as f32 / SR;
    assert!(s.set_warps(&[vec![(1.9, 1.9), (1.95, 1.99), (end, end)]]));
    assert_eq!(s.render_all().len(), before.len());
}

#[test]
fn partial_renders_match_the_full_render() {
    let x = signal();
    let mut s = Session::new(x, SR);
    assert!(s.set_warps(&[tighten()]));
    let full = s.render_all();
    for (a, b) in [(1.0f32, 1.3f32), (1.2, 2.0), (0.5, 1.05)] {
        let part = s.render(a, b);
        let off = secs(a);
        for (k, v) in part.iter().enumerate() {
            assert!((v - full[off + k]).abs() < 1e-6, "[{a},{b}) sample {k}");
        }
    }
}

#[test]
fn warps_and_pitch_edits_compose_and_stereo_stays_consistent() {
    let x = signal();
    let l: Vec<f32> = x.iter().map(|v| v * 1.2).collect();
    let r: Vec<f32> = x.iter().map(|v| v * 0.8).collect();
    let mut s = Session::new(x, SR);
    assert!(s.set_channels(vec![l, r]));
    let n = s.notes().len();
    assert!(n >= 2);
    let t = s.notes()[n - 1].center + 1.0;
    assert!(s.set_note(n - 1, t, 1.0, 1.0));
    assert!(s.set_warps(&[tighten()]));
    let mono = s.render_all();
    let end = mono.len() as f32 / SR + 1.0;
    let (cl, cr) = (s.render_channel(0, 0.0, end), s.render_channel(1, 0.0, end));
    assert_eq!(cl.len(), mono.len());
    for i in 0..mono.len() {
        assert!(((cl[i] + cr[i]) * 0.5 - mono[i]).abs() < 1e-4, "sample {i}");
    }
    assert!((onset(&mono, 0.9, 1.5) - 1.04).abs() < 0.008);
}
