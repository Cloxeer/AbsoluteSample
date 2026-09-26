//! cargo run --release --example eval -- <mono-or-stereo.wav> [crepe_analysis.json]
//! Prints analysis time, notes, render speed and (optionally) agreement with a CREPE
//! analysis JSON from engine/autotune.py.
use pitchcore::Session;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut r = hound::WavReader::open(&args[1]).expect("wav");
    let spec = r.spec();
    let ch = spec.channels as usize;
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap()).collect(),
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().map(|s| s.unwrap() as f32 / scale).collect()
        }
    };
    let x: Vec<f32> = raw.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect();
    let sr = spec.sample_rate as f32;
    let t = std::time::Instant::now();
    let mut s = Session::new(x.clone(), sr);
    println!("analysed {:.1} s of audio in {:.0} ms", x.len() as f32 / sr, t.elapsed().as_secs_f32() * 1000.0);
    let v: serde_json::Value = serde_json::from_str(&s.analysis_json()).unwrap();
    println!("key {} {}  notes {}", v["key"]["tonic"], v["key"]["mode"], s.notes().len());
    for n in s.notes().iter().take(12) {
        println!("  {:6.2}-{:6.2}  center {:6.2}", n.start_sec, n.end_sec, n.center);
    }
    let pitch: Vec<Option<f64>> = v["pitch"].as_array().unwrap().iter().map(|p| p.as_f64()).collect();
    if std::env::var("LOWDUMP").is_ok() {
        let lim: f64 = std::env::var("LOWDUMP").unwrap().parse().unwrap();
        let db: Vec<f64> = v["db"].as_array().unwrap().iter().map(|d| d.as_f64().unwrap()).collect();
        let mut i = 0;
        while i < pitch.len() {
            if matches!(pitch[i], Some(m) if m < lim) {
                let s = i;
                while i < pitch.len() && matches!(pitch[i], Some(m) if m < lim) {
                    i += 1;
                }
                let ctx: Vec<String> = (s.saturating_sub(3)..(i + 3).min(pitch.len())).map(|k| pitch[k].map_or("-".into(), |m| format!("{m:.0}"))).collect();
                println!("LOW {:.2}-{:.2} db {:.0}: {}", s as f64 / 100.0, i as f64 / 100.0, db[s], ctx.join(" "));
            }
            i += 1;
        }
    }
    if let Some(p) = args.get(2) {
        let c: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        let f0 = c["f0"].as_array().unwrap();
        let mut diffs: Vec<f64> = Vec::new();
        let (mut both, mut agree, mut only_c, mut only_us, mut octave) = (0, 0, 0, 0, 0);
        for (i, fr) in f0.iter().enumerate() {
            let cm = fr["midi"].as_f64();
            let um = pitch.get(i).cloned().flatten();
            match (cm, um) {
                (Some(a), Some(b)) => {
                    both += 1;
                    if (a - b).abs() < 0.5 {
                        agree += 1;
                        diffs.push(((a - b) * 100.0).abs());
                    } else if ((a - b).abs() - 12.0).abs() < 1.0 {
                        octave += 1;
                    }
                }
                (Some(_), None) => only_c += 1,
                (None, Some(_)) => only_us += 1,
                _ => {}
            }
        }
        let db: Vec<f64> = v["db"].as_array().unwrap().iter().map(|d| d.as_f64().unwrap()).collect();
        let mut i = 0;
        let mut shown = 0;
        while i < f0.len() && shown < 25 {
            let miss = |i: usize| f0[i]["midi"].as_f64().is_some() && pitch.get(i).cloned().flatten().is_none();
            if miss(i) {
                let s = i;
                while i < f0.len() && miss(i) {
                    i += 1;
                }
                if i - s >= 5 {
                    let lv = db[s..i].iter().cloned().fold(f64::MIN, f64::max);
                    println!("  CREPE-only {:.2}-{:.2} ({} ms) peak {:.0} dB, CREPE midi {:.1}", s as f64 / 100.0, i as f64 / 100.0, (i - s) * 10, lv, f0[s]["midi"].as_f64().unwrap());
                    shown += 1;
                }
            }
            i += 1;
        }
        let mut i = 0;
        let mut shown = 0;
        while i < f0.len() && shown < 30 {
            let extra = |i: usize| f0[i]["midi"].as_f64().is_none() && pitch.get(i).cloned().flatten().is_some();
            if extra(i) {
                let s = i;
                while i < f0.len() && extra(i) {
                    i += 1;
                }
                if i - s >= 5 {
                    let lv = db[s..i].iter().cloned().fold(f64::MIN, f64::max);
                    let prev = if s > 0 { f0[s - 1]["midi"].as_f64().is_some() } else { false };
                    println!("  OURS-only {:.2}-{:.2} ({} ms) peak {:.0} dB, follows CREPE-voiced: {prev}", s as f64 / 100.0, i as f64 / 100.0, (i - s) * 10, lv);
                    shown += 1;
                }
            }
            i += 1;
        }
        let mut i = 0;
        while i < f0.len() {
            let oct =|i: usize| match (f0[i]["midi"].as_f64(), pitch.get(i).cloned().flatten()) {
                (Some(a), Some(b)) => (a - b).abs() > 6.0,
                _ => false,
            };
            if oct(i) {
                let s = i;
                while i < f0.len() && oct(i) {
                    i += 1;
                }
                println!("  OCTAVE {:.2}-{:.2}: CREPE {:.1} ours {:.1}", s as f64 / 100.0, i as f64 / 100.0, f0[s]["midi"].as_f64().unwrap(), pitch[s].unwrap());
            }
            i += 1;
        }
        diffs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if !diffs.is_empty() { println!("cents vs CREPE on agreeing frames: median {:.1}, 90th pct {:.1}", diffs[diffs.len() / 2], diffs[diffs.len() * 9 / 10]); }
        println!(
            "vs CREPE: both voiced {both}, agree within 50c {agree} ({:.1}%), octave diff {octave}, CREPE-only {only_c}, ours-only {only_us}",
            100.0 * agree as f64 / both.max(1) as f64
        );
    }
    let idx = s.notes().len() / 2;
    let n = s.notes()[idx].clone();
    s.set_note(idx, n.center.round() + 2.0, 1.0, 1.0);
    let t = std::time::Instant::now();
    let (a, b) = s.phrase_bounds(n.start_sec + 0.05);
    let _ = s.render(a, b);
    println!("edit note {idx}: re-rendered its phrase ({:.2} s) in {:.2} ms", b - a, t.elapsed().as_secs_f32() * 1000.0);
}
