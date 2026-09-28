//! cargo run --release --example warpcheck -- <vocal.wav> [shift_ms=40] [out.wav]
//! Stress test for "Tighten timing" on a real vocal: every note onset is moved alternately
//! earlier/later by `shift_ms` inside identity-ended phrase segments, then the render is checked
//! for clicks (high-frequency bursts and sample jumps far above anything in the original nearby)
//! and for exact length and untouched audio outside the segments.
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

fn hf_db(x: &[f32], frame: usize) -> Vec<f32> {
    (2..x.len())
        .step_by(frame)
        .map(|f| {
            let end = (f + frame).min(x.len());
            let e: f64 = (f..end).map(|i| ((x[i] - 2.0 * x[i - 1] + x[i - 2]) as f64).powi(2)).sum();
            10.0 * ((e / frame as f64) + 1e-14).log10() as f32
        })
        .collect()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (x, sr) = read(&a[1]);
    let shift = a.get(2).and_then(|v| v.parse::<f32>().ok()).unwrap_or(40.0) / 1000.0;
    let mut s = Session::new(x.clone(), sr);
    let dur = x.len() as f32 / sr;
    let notes: Vec<(f32, f32)> = s.notes().iter().map(|n| (n.start_sec, n.end_sec)).collect();
    // Phrases: notes closer than 120 ms.
    let mut phrases: Vec<(f32, f32, Vec<f32>)> = Vec::new();
    for (st, en) in notes {
        match phrases.last_mut() {
            Some(p) if st - p.1 < 0.12 => {
                p.1 = p.1.max(en);
                p.2.push(st);
            }
            _ => phrases.push((st, en, vec![st])),
        }
    }
    let mut segs: Vec<Vec<(f32, f32)>> = Vec::new();
    let mut moved = 0;
    for i in 0..phrases.len() {
        let (st, en, ref onsets) = phrases[i];
        let prev = if i > 0 { phrases[i - 1].1 } else { 0.0 };
        let next = if i + 1 < phrases.len() { phrases[i + 1].0 } else { dur };
        let a0 = (st - (0.25f32).min((st - prev) / 2.0)).max(0.0);
        let b0 = (en + (0.25f32).min((next - en) / 2.0)).min(dur);
        let mut anchors = vec![(a0, a0)];
        for (k, &o) in onsets.iter().enumerate() {
            let out = o + if k % 2 == 0 { -shift } else { shift };
            let last = *anchors.last().unwrap();
            let (d_out, d_in) = (out - last.0, o - last.1);
            if d_out > 0.03 && d_in > 0.03 && (0.56..=1.78).contains(&(d_in / d_out)) && out < b0 - 0.03 && o < b0 - 0.03 {
                anchors.push((out, o));
            }
        }
        while anchors.len() > 1 {
            let last = *anchors.last().unwrap();
            let (d_out, d_in) = (b0 - last.0, b0 - last.1);
            if d_out > 0.03 && d_in > 0.03 && (0.56..=1.78).contains(&(d_in / d_out)) {
                break;
            }
            anchors.pop();
        }
        if anchors.len() >= 2 {
            moved += anchors.len() - 1;
            anchors.push((b0, b0));
            segs.push(anchors);
        }
    }
    let before = s.render_all();
    assert!(s.set_warps(&segs), "engine refused the segments");
    let t = std::time::Instant::now();
    let y = s.render_all();
    println!("{} segments, {moved} onsets moved by ±{:.0} ms; full render {:.1} ms", s.warp_count(), shift * 1000.0, t.elapsed().as_secs_f32() * 1000.0);
    assert_eq!(y.len(), before.len());
    let mut outside_changed = 0;
    let bounds: Vec<(usize, usize)> = segs.iter().map(|g| ((g[0].0 * sr) as usize, (g[g.len() - 1].0 * sr) as usize + 1)).collect();
    for i in 0..y.len() {
        if !bounds.iter().any(|&(p, q)| i + 1 >= p && i <= q + 1) && y[i] != before[i] {
            outside_changed += 1;
        }
    }
    println!("samples changed outside the segments: {outside_changed}");
    let fr = (sr * 0.005) as usize;
    let (ho, hy) = (hf_db(&x, fr), hf_db(&y, fr));
    let reach = ((shift + 0.02) / 0.005) as usize + 2;
    let bursts = (0..ho.len().min(hy.len()))
        .filter(|&i| {
            let near = ho[i.saturating_sub(reach)..(i + reach + 1).min(ho.len())].iter().cloned().fold(f32::MIN, f32::max);
            hy[i] > near + 10.0 && hy[i] > -70.0
        })
        .count();
    let win = ((shift + 0.015) * sr) as usize;
    let jumps = (1..y.len())
        .filter(|&i| {
            let dy = (y[i] - y[i - 1]).abs();
            if dy <= 0.05 {
                return false;
            }
            let (lo, hi) = (i.saturating_sub(win), (i + win).min(x.len()));
            let dx = (lo + 1..hi).map(|k| (x[k] - x[k - 1]).abs()).fold(0.0f32, f32::max);
            dy > 2.5 * dx + 0.01
        })
        .count();
    println!("HF-burst frames: {bursts} ({:.2}% of frames)", 100.0 * bursts as f32 / ho.len() as f32);
    println!("sample jumps far above original: {jumps}");
    if let Some(p) = a.get(3) {
        let spec = hound::WavSpec { channels: 1, sample_rate: sr as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(p, spec).unwrap();
        for v in &y {
            w.write_sample((v.clamp(-1.0, 1.0) * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    }
}
