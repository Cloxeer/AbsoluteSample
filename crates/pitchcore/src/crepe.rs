//! CREPE "tiny" (Kim et al. 2018, MIT) re-implemented in plain Rust so it runs
//! natively and in WebAssembly with no ML runtime. Used as the octave referee: it was
//! trained on voices, so bass bleed in a separated stem does not fool it.
//! Weights exported from torchcrepe's tiny.pth (see assets/README.md).

static WEIGHTS: &[u8] = include_bytes!("../assets/crepe_tiny.bin");

const IN_CH: [usize; 6] = [1, 128, 16, 16, 16, 32];
const OUT_CH: [usize; 6] = [128, 16, 16, 16, 32, 64];
const BINS: usize = 360;
pub const FRAME: usize = 1024; // at 16 kHz

struct Layer {
    w: Vec<f32>, // [out][in][k]
    b: Vec<f32>,
    scale: Vec<f32>,
    shift: Vec<f32>,
    k: usize,
    cin: usize,
    cout: usize,
}

pub struct Crepe {
    layers: Vec<Layer>,
    cw: Vec<f32>, // [360][256]
    cb: Vec<f32>,
}

impl Crepe {
    pub fn load() -> Crepe {
        let f: Vec<f32> = WEIGHTS.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        let mut p = 0;
        let mut take = |n: usize| {
            let v = f[p..p + n].to_vec();
            p += n;
            v
        };
        let mut layers = Vec::new();
        for i in 0..6 {
            let k = if i == 0 { 512 } else { 64 };
            let (cin, cout) = (IN_CH[i], OUT_CH[i]);
            layers.push(Layer { w: take(cout * cin * k), b: take(cout), scale: take(cout), shift: take(cout), k, cin, cout });
        }
        let cw = take(BINS * 256);
        let cb = take(BINS);
        Crepe { layers, cw, cb }
    }

    /// 360 pitch-bin activations (sigmoid) for one 1024-sample frame at 16 kHz.
    pub fn activations(&self, frame: &[f32]) -> Vec<f32> {
        // normalise: zero mean, unit std (as in CREPE)
        let n = FRAME as f32;
        let mean = frame.iter().sum::<f32>() / n;
        let var = frame.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / (n - 1.0);
        let std = var.sqrt().max(1e-10);
        let x: Vec<f32> = frame.iter().map(|v| (v - mean) / std).collect();

        // layer 1: pad 254/254, kernel 512, stride 4 -> 256, pool -> 128
        let l = &self.layers[0];
        let mut padded = vec![0.0f32; FRAME + 508];
        padded[254..254 + FRAME].copy_from_slice(&x);
        // split into 4 phases so the stride-4 conv becomes contiguous (vectorisable)
        let plen = padded.len() / 4;
        let phases: Vec<Vec<f32>> = (0..4).map(|p| (0..plen).map(|j| padded[4 * j + p]).collect()).collect();
        let len1 = 256;
        let mut act = vec![0.0f32; l.cout * len1];
        for o in 0..l.cout {
            let row = &mut act[o * len1..(o + 1) * len1];
            row.fill(l.b[o]);
            let w = &l.w[o * l.k..(o + 1) * l.k];
            for (k, &wk) in w.iter().enumerate() {
                let src = &phases[k % 4][k / 4..k / 4 + len1];
                for (r, s) in row.iter_mut().zip(src) {
                    *r += wk * s;
                }
            }
        }
        let (mut cur, mut len) = post(act, l, len1);

        for l in &self.layers[1..] {
            // pad 31 / 32, kernel 64, stride 1 -> same length
            let plen = len + 63;
            let mut pad = vec![0.0f32; l.cin * plen];
            for c in 0..l.cin {
                pad[c * plen + 31..c * plen + 31 + len].copy_from_slice(&cur[c * len..(c + 1) * len]);
            }
            let mut act = vec![0.0f32; l.cout * len];
            for o in 0..l.cout {
                let row = &mut act[o * len..(o + 1) * len];
                row.fill(l.b[o]);
                for c in 0..l.cin {
                    let w = &l.w[(o * l.cin + c) * l.k..(o * l.cin + c + 1) * l.k];
                    let chan = &pad[c * plen..(c + 1) * plen];
                    for (k, &wk) in w.iter().enumerate() {
                        for (r, s) in row.iter_mut().zip(&chan[k..k + len]) {
                            *r += wk * s;
                        }
                    }
                }
            }
            let (c2, l2) = post(act, l, len);
            cur = c2;
            len = l2;
        }
        // cur: [64][4] -> features in [time][channel] order
        let ch = 64;
        let mut feat = vec![0.0f32; 256];
        for c in 0..ch {
            for t in 0..len {
                feat[t * ch + c] = cur[c * len + t];
            }
        }
        (0..BINS)
            .map(|b| {
                let w = &self.cw[b * 256..(b + 1) * 256];
                let z: f32 = self.cb[b] + w.iter().zip(&feat).map(|(a, f)| a * f).sum::<f32>();
                1.0 / (1.0 + (-z).exp())
            })
            .collect()
    }

    /// (midi, confidence) for one frame: weighted average of the bins around the peak.
    pub fn pitch(&self, frame: &[f32]) -> (f32, f32) {
        let a = self.activations(frame);
        let (peak, &conf) = a.iter().enumerate().max_by(|x, y| x.1.partial_cmp(y.1).unwrap()).unwrap();
        let lo = peak.saturating_sub(4);
        let hi = (peak + 5).min(BINS);
        let (mut num, mut den) = (0.0, 0.0);
        for i in lo..hi {
            num += a[i] * (20.0 * i as f32 + 1997.379_4);
            den += a[i];
        }
        let cents = num / den.max(1e-9);
        let hz = 10.0 * 2f32.powf(cents / 1200.0);
        (crate::pitch::hz_to_midi(hz), conf)
    }
}

/// relu -> batch-norm affine -> max-pool(2)
fn post(mut act: Vec<f32>, l: &Layer, len: usize) -> (Vec<f32>, usize) {
    for o in 0..l.cout {
        for v in &mut act[o * len..(o + 1) * len] {
            *v = v.max(0.0) * l.scale[o] + l.shift[o];
        }
    }
    let half = len / 2;
    let mut out = vec![0.0f32; l.cout * half];
    for o in 0..l.cout {
        for t in 0..half {
            out[o * half + t] = act[o * len + 2 * t].max(act[o * len + 2 * t + 1]);
        }
    }
    (out, half)
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_pytorch_reference() {
        let bytes = include_bytes!("../assets/crepe_tiny_ref.bin");
        let f: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        let (frame, want) = f.split_at(super::FRAME);
        let m = super::Crepe::load();
        let t = std::time::Instant::now();
        let got = m.activations(frame);
        eprintln!("one frame: {:.2} ms", t.elapsed().as_secs_f32() * 1000.0);
        let max_err = got.iter().zip(want).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        assert!(max_err < 1e-3, "max err {max_err}");
        let (midi, conf) = m.pitch(frame);
        eprintln!("pitch {midi:.2} (220 Hz = 57.00) conf {conf:.2}");
        assert!((midi - 57.0).abs() < 0.3);
    }
}
