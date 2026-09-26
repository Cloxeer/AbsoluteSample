//! cargo run --release --example dips -- <wav> <sec> : print CMNDF dips at a time.
use pitchcore::pitch::{hz_to_midi, resample_to_asr, ASR};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mut r = hound::WavReader::open(&a[1]).unwrap();
    let sp = r.spec();
    let ch = sp.channels as usize;
    let raw: Vec<f32> = match sp.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap()).collect(),
        _ => r.samples::<i32>().map(|s| s.unwrap() as f32 / (1i64 << (sp.bits_per_sample - 1)) as f32).collect(),
    };
    let x: Vec<f32> = raw.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect();
    let x16 = resample_to_asr(&x, sp.sample_rate as f32);
    let c = (a[2].parse::<f32>().unwrap() * ASR) as usize;
    let (w, tmax) = (1024usize, 267usize);
    let fr = &x16[c - w / 2..c + w / 2];
    let integ = w - tmax;
    let mut d = vec![0.0f32; tmax + 2];
    for tau in 0..=tmax {
        d[tau] = (0..integ).map(|j| (fr[j] - fr[j + tau]).powi(2)).sum();
    }
    let mut run = 0.0;
    let mut cm = vec![1.0f32; tmax + 2];
    for tau in 1..=tmax {
        run += d[tau];
        cm[tau] = d[tau] * tau as f32 / run;
    }
    for tau in 15..tmax {
        if cm[tau] < cm[tau - 1] && cm[tau] <= cm[tau + 1] && cm[tau] < 0.8 {
            println!("tau {tau:4} midi {:6.2} cmndf {:.3}", hz_to_midi(ASR / tau as f32), cm[tau]);
        }
    }
}
