//! cargo run --release --example mkharmony -- <lead.wav> <out.wav> <scale_steps> [max_err_cents=40] [late_ms=40] [seed=1]
//! Makes a realistic SLOPPY harmony take from a lead, for testing "Fix harmonies": every note moves
//! `scale_steps` along the detected key (e.g. 2 = a 3rd above, -2 = a 3rd below), then gets a random
//! pitch error up to ±max_err_cents and its syllable starts up to `late_ms` late/early.
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

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (x, sr) = read(&a[1]);
    let steps: i32 = a[3].parse().unwrap();
    let err: f32 = a.get(4).and_then(|v| v.parse().ok()).unwrap_or(40.0) / 100.0;
    let late: f32 = a.get(5).and_then(|v| v.parse().ok()).unwrap_or(40.0) / 1000.0;
    let mut seed: u64 = a.get(6).and_then(|v| v.parse().ok()).unwrap_or(1);
    let mut rnd = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((seed >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
    };
    let mut s = Session::new(x.clone(), sr);
    let v: serde_json::Value = serde_json::from_str(&s.analysis_json()).unwrap();
    const N: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    let tonic = N.iter().position(|n| Some(*n) == v["key"]["tonic"].as_str()).unwrap_or(0) as i32;
    let minor = v["key"]["mode"].as_str() == Some("minor");
    let degrees: [i32; 7] = if minor { [0, 2, 3, 5, 7, 8, 10] } else { [0, 2, 4, 5, 7, 9, 11] };
    let scale: Vec<i32> = (0..128).filter(|m| degrees.contains(&((m - tonic).rem_euclid(12)))).collect();
    let n = s.notes().len();
    let dur = x.len() as f32 / sr;
    let mut onsets = Vec::new();
    for i in 0..n {
        let c = s.notes()[i].center;
        onsets.push((s.notes()[i].start_sec, s.notes()[i].end_sec));
        let k = scale.iter().enumerate().min_by(|p, q| (*p.1 as f32 - c).abs().partial_cmp(&(*q.1 as f32 - c).abs()).unwrap()).unwrap().0 as i32;
        let target = scale[(k + steps).clamp(0, scale.len() as i32 - 1) as usize] as f32 + err * rnd();
        s.set_note(i, target, 1.0, 1.0);
    }
    // Sloppy timing: each phrase's syllables start a bit off (inside identity-ended segments).
    let mut segs: Vec<Vec<(f32, f32)>> = Vec::new();
    let mut i = 0;
    while i < onsets.len() {
        let mut j = i;
        while j + 1 < onsets.len() && onsets[j + 1].0 - onsets[j].1 < 0.12 {
            j += 1;
        }
        let prev = if i > 0 { onsets[i - 1].1 } else { 0.0 };
        let next = if j + 1 < onsets.len() { onsets[j + 1].0 } else { dur };
        let a0 = (onsets[i].0 - 0.25f32.min((onsets[i].0 - prev) / 2.0)).max(0.0);
        let b0 = (onsets[j].1 + 0.25f32.min((next - onsets[j].1) / 2.0)).min(dur);
        let mut anchors = vec![(a0, a0)];
        for k in i..=j {
            let inp = onsets[k].0;
            let out = inp + late * (0.5 + 0.5 * rnd().abs()) * if rnd() > -0.3 { 1.0 } else { -1.0 };
            let last = *anchors.last().unwrap();
            let (d_out, d_in) = (out - last.0, inp - last.1);
            if d_out > 0.03 && d_in > 0.03 && (0.56..=1.78).contains(&(d_in / d_out)) && out < b0 - 0.03 {
                anchors.push((out, inp));
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
            anchors.push((b0, b0));
            segs.push(anchors);
        }
        i = j + 1;
    }
    assert!(s.set_warps(&segs));
    let y = s.render_all();
    let spec = hound::WavSpec { channels: 1, sample_rate: sr as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(&a[2], spec).unwrap();
    for v in &y {
        w.write_sample((v.clamp(-1.0, 1.0) * 32767.0) as i16).unwrap();
    }
    w.finalize().unwrap();
    println!("{n} notes moved {steps} scale steps (±{:.0} cents error), {} phrases with sloppy timing -> {}", err * 100.0, s.warp_count(), a[2]);
}
