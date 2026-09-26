//! cargo run --release --example artifacts -- <vocal.wav> [out.wav]
//! Applies "Tune all to key" (every note's center to the nearest note of the detected key,
//! drift straightened 50%) and measures clicks/crackle: 5 ms frames where the tuned audio has
//! much more high-frequency (>5 kHz) energy than the original. A clean retune adds none.
use pitchcore::Session;

fn read(path: &str) -> (Vec<f32>, f32) {
    let mut r = hound::WavReader::open(path).expect("wav");
    let sp = r.spec();
    let ch = sp.channels as usize;
    let raw: Vec<f32> = match sp.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap()).collect(),
        _ => r.samples::<i32>().map(|s| s.unwrap() as f32 / (1i64 << (sp.bits_per_sample - 1)) as f32).collect(),
    };
    (raw.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect(), sp.sample_rate as f32)
}

/// Per-frame energy (dB) of a crude high-pass: first difference twice (~+12 dB/oct).
fn hf_db(x: &[f32], frame: usize) -> Vec<f32> {
    let mut out = Vec::new();
    for f in (2..x.len()).step_by(frame) {
        let end = (f + frame).min(x.len());
        let mut e = 0.0f64;
        for i in f..end {
            let d2 = x[i] - 2.0 * x[i - 1] + x[i - 2];
            e += (d2 * d2) as f64;
        }
        out.push(10.0 * ((e / frame as f64) + 1e-14).log10() as f32);
    }
    out
}

fn scale_pcs(tonic: &str, mode: &str) -> Vec<i32> {
    const N: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    let t = N.iter().position(|n| *n == tonic).unwrap_or(0) as i32;
    let steps: &[i32] = if mode == "minor" { &[0, 2, 3, 5, 7, 8, 10] } else { &[0, 2, 4, 5, 7, 9, 11] };
    steps.iter().map(|s| (t + s) % 12).collect()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (x, sr) = read(&a[1]);
    let mut s = Session::new(x.clone(), sr);
    let v: serde_json::Value = serde_json::from_str(&s.analysis_json()).unwrap();
    let pcs = scale_pcs(v["key"]["tonic"].as_str().unwrap(), v["key"]["mode"].as_str().unwrap());
    let n = s.notes().len();
    for i in 0..n {
        let c = s.notes()[i].center;
        let mut best = c.round();
        let mut bd = f32::MAX;
        for m in (c.floor() as i32 - 2)..=(c.ceil() as i32 + 2) {
            if pcs.contains(&m.rem_euclid(12)) && (m as f32 - c).abs() < bd {
                bd = (m as f32 - c).abs();
                best = m as f32;
            }
        }
        let off: f32 = std::env::var("OFFSET").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0);
        s.set_note(i, best + off, 0.5, 1.0);
    }
    let t = std::time::Instant::now();
    let y = s.render_all();
    println!("tuned {n} notes, full render {:.1} ms", t.elapsed().as_secs_f32() * 1000.0);
    let fr = (sr * 0.005) as usize;
    let ho = hf_db(&x, fr);
    let hy = hf_db(&y, fr);
    let mut clicks = Vec::new();
    for i in 0..ho.len().min(hy.len()) {
        let near = ho[i.saturating_sub(4)..(i + 5).min(ho.len())].iter().cloned().fold(f32::MIN, f32::max);
        if hy[i] > near + 10.0 && hy[i] > -70.0 {
            clicks.push(i);
        }
    }
    // Also raw sample jumps: |y[i]-y[i-1]| far above anything in the original nearby.
    let mut jumps = 0;
    let mut shown = 0;
    for i in 1..y.len() {
        let dy = (y[i] - y[i - 1]).abs();
        if dy > 0.05 {
            let lo = i.saturating_sub((sr * 0.015) as usize);
            let hi = (i + (sr * 0.015) as usize).min(x.len());
            let dx = (lo + 1..hi).map(|k| (x[k] - x[k - 1]).abs()).fold(0.0f32, f32::max);
            if dy > 2.5 * dx + 0.01 {
                jumps += 1;
                if shown < 10 && std::env::var("DIAG").is_ok() {
                    shown += 1;
                    println!("JUMP {:.4}s dy {dy:.3} (orig max {dx:.3}): {}", i as f32 / sr, s.debug_at(i));
                    if shown == 1 {
                        let ys: Vec<String> = (i - 6..i + 6).map(|k| format!("{:.3}", y[k])).collect();
                        let xs: Vec<String> = (i - 6..i + 6).map(|k| format!("{:.3}", x[k])).collect();
                        println!("   y: {}\n   x: {}", ys.join(" "), xs.join(" "));
                    }
                }
            }
        }
    }
    println!("HF-burst frames (>10 dB over original): {}  ({:.2}% of frames)", clicks.len(), 100.0 * clicks.len() as f32 / ho.len() as f32);
    println!("sample jumps far above original: {jumps}");
    for c in clicks.iter().take(12) {
        let t = *c as f32 * 0.005;
        println!("  burst at {t:.3}s  +{:.1} dB", hy[*c] - ho[*c]);
    }
    if let Some(p) = a.get(2) {
        let spec = hound::WavSpec { channels: 1, sample_rate: sr as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(p, spec).unwrap();
        for v in &y {
            w.write_sample((v.clamp(-1.0, 1.0) * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    }
}
