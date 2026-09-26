use pitchcore::Session;
use std::f32::consts::PI;

const SR: f32 = 44100.0;

/// Harmonic "voice" following a MIDI curve (one value per sample).
fn voice(curve: &[f32]) -> Vec<f32> {
    let mut ph = 0.0f32;
    curve
        .iter()
        .map(|&m| {
            let f = 440.0 * 2f32.powf((m - 69.0) / 12.0);
            ph += 2.0 * PI * f / SR;
            if ph > 2.0 * PI * 1000.0 {
                ph -= 2.0 * PI * 1000.0;
            }
            (1..12).map(|k| (0.5 / k as f32) * (k as f32 * ph).sin()).sum::<f32>() * 0.25
        })
        .collect()
}

fn secs(s: f32) -> usize {
    (s * SR) as usize
}

fn lcg(seed: &mut u64) -> f32 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    ((*seed >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
}

/// Dry vocal: 0.25 s at 59.5, then 57.34 with 5.5 Hz vibrato until 1.2 s; plus
/// optional reverb (noise IR, RT60 1.8 s) so a tail rings on after 1.2 s.
fn test_signal(reverb: bool) -> Vec<f32> {
    let n = secs(3.0);
    let curve: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f32 / SR;
            if t < 0.25 { 59.5 } else { 57.34 + 0.15 * (2.0 * PI * 5.5 * t).sin() }
        })
        .collect();
    let mut dry = voice(&curve);
    for (i, v) in dry.iter_mut().enumerate() {
        let t = i as f32 / SR;
        *v *= (t / 0.02).min(1.0);
        if t > 1.2 {
            *v = 0.0;
        }
    }
    if !reverb {
        return dry;
    }
    // Sparse-tap reverb (cheap convolution): 400 random taps with exponential decay.
    let mut seed = 7u64;
    let mut wet = dry.clone();
    for _ in 0..400 {
        let d = (lcg(&mut seed).abs() * 1.8 * SR) as usize + 200;
        let g = lcg(&mut seed) * (-6.9 * d as f32 / SR / 1.8).exp() * 0.12;
        for i in 0..n.saturating_sub(d) {
            wet[i + d] += dry[i] * g;
        }
    }
    wet
}

#[test]
fn detects_notes_and_stops_at_the_singer_not_the_reverb() {
    for reverb in [false, true] {
        let s = Session::new(test_signal(reverb), SR);
        let notes = s.notes();
        let long = notes.iter().max_by(|a, b| (a.end_sec - a.start_sec).partial_cmp(&(b.end_sec - b.start_sec)).unwrap()).unwrap();
        assert!((long.center - 57.34).abs() < 0.06, "reverb={reverb} center {} (want 57.34)", long.center);
        let last_end = notes.iter().map(|n| n.end_sec).fold(0.0, f32::max);
        assert!(last_end < 1.3 && last_end > 1.05, "reverb={reverb}: last note ends {last_end}, singer stops at 1.2");
        let scoop = notes.iter().find(|n| n.start_sec < 0.1).expect("first note");
        assert!((scoop.center - 59.5).abs() < 0.1, "first note center {}", scoop.center);
        assert!(notes.len() == 2, "reverb={reverb}: want 2 notes, got {}", notes.len());
    }
}

#[test]
fn edits_land_on_target_and_untouched_audio_is_identical() {
    let x = test_signal(true);
    let mut s = Session::new(x.clone(), SR);
    let idx = s.notes().iter().position(|n| n.center < 58.0).unwrap();
    let before_note = s.notes()[idx].clone();
    for target in [57.0f32, 59.0, 60.0, 55.0] {
        s.set_note(idx, target, 1.0, 1.0);
        let t0 = std::time::Instant::now();
        let (a, b) = s.phrase_bounds(before_note.start_sec + 0.1);
        let y = s.render(0.0, 3.0);
        let ms = t0.elapsed().as_secs_f32() * 1000.0;
        eprintln!("target {target}: rendered full 3 s in {ms:.2} ms (phrase {a:.2}-{b:.2})");
        // Latency budget: an edit must be audible within one audio buffer or two.
        if !cfg!(debug_assertions) {
            assert!(ms < 15.0, "render took {ms} ms, budget is 15 ms");
        }
        let re = Session::new(y.clone(), SR);
        let got = re
            .notes()
            .iter()
            .filter(|n| n.start_sec < before_note.end_sec && n.end_sec > before_note.start_sec + 0.2)
            .max_by(|p, q| (p.end_sec - p.start_sec).partial_cmp(&(q.end_sec - q.start_sec)).unwrap())
            .unwrap();
        let cents = (got.center - target) * 100.0;
        eprintln!("  measured {:.3} -> {cents:+.1} cents", got.center);
        assert!(cents.abs() < 8.0, "target {target}: off by {cents} cents");
        // outside the edited phrase, output is bit-identical
        for i in secs(b + 0.05)..y.len() {
            assert_eq!(y[i], x[i], "sample {i} changed outside the edit");
        }
    }
    s.set_note(idx, before_note.center, 1.0, 1.0);
    assert_eq!(s.render_all(), x, "resetting the edit must give back the original exactly");
}

#[test]
fn flattening_vibrato_removes_it() {
    let x = test_signal(false);
    let mut s = Session::new(x, SR);
    let idx = s.notes().iter().position(|n| n.center < 58.0).unwrap();
    let n = s.notes()[idx].clone();
    s.set_note(idx, 57.0, 0.0, 0.0);
    let y = s.render_all();
    let re = Session::new(y, SR);
    let j: String = re.analysis_json();
    let v: serde_json::Value = serde_json::from_str(&j).unwrap();
    let hop = v["hopSec"].as_f64().unwrap() as f32;
    let pts: Vec<f32> = v["pitch"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(i, p)| {
            let t = *i as f32 * hop;
            !p.is_null() && t > n.start_sec + 0.15 && t < n.end_sec - 0.15
        })
        .map(|(_, p)| p.as_f64().unwrap() as f32)
        .collect();
    let max_dev = pts.iter().map(|p| (p - 57.0).abs()).fold(0.0, f32::max);
    eprintln!("vibrato after flattening: max deviation {:.1} cents over {} frames", max_dev * 100.0, pts.len());
    assert!(max_dev < 0.08, "vibrato still {} cents", max_dev * 100.0);
}

/// Crackle guard: two sung phrases separated by a short dropout, retuned by +-3 semitones,
/// must render without any sample discontinuity that is sharper than the voice itself.
#[test]
fn retuning_adds_no_clicks_or_pops() {
    let n = secs(2.0);
    let curve: Vec<f32> = (0..n).map(|i| 57.3 + 0.2 * (2.0 * PI * 5.0 * i as f32 / SR).sin()).collect();
    let mut x = voice(&curve);
    for (i, v) in x.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let env = (t / 0.02).min(1.0) * ((1.9 - t) / 0.05).clamp(0.0, 1.0);
        // 25 ms dropout in the middle, like a consonant the detector can't pitch
        let gap = if (0.9..0.925).contains(&t) { 0.0 } else { 1.0 };
        *v *= env * gap;
    }
    for off in [-3.0f32, 3.0] {
        let mut s = Session::new(x.clone(), SR);
        for i in 0..s.notes().len() {
            let c = s.notes()[i].center;
            s.set_note(i, c.round() + off, 0.5, 1.0);
        }
        let y = s.render_all();
        let w = (SR * 0.015) as usize;
        let mut bad = 0;
        for i in 1..y.len() {
            let dy = (y[i] - y[i - 1]).abs();
            let lo = i.saturating_sub(w);
            let hi = (i + w).min(x.len());
            let dx = (lo + 1..hi).map(|k| (x[k] - x[k - 1]).abs()).fold(0.0f32, f32::max);
            if dy > 2.5 * dx + 0.01 {
                bad += 1;
            }
        }
        assert_eq!(bad, 0, "offset {off}: {bad} click samples");
    }
}
