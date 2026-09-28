//! Timing tightening: WSOLA time-warping, one phrase (segment) at a time.
//!
//! A segment is a piecewise-linear map from OUTPUT time to INPUT time whose two ends are the
//! identity, so the audio before and after it is untouched and the file keeps its exact length.
//! Inside, the audio is rebuilt from 20 ms Hann grains laid every 10 ms; each grain is read from
//! where the map says, nudged (by up to 8 ms) to the offset whose waveform best continues the
//! previous grain. That keeps periods in phase, so stretched vowels stay smooth and the pitch
//! does not change. Grain offsets are chosen once on the mono mix and reused for every channel.

/// Largest search nudge around the mapped position.
pub const SEARCH_SEC: f32 = 0.008;
/// Allowed local speed change (input seconds per output second).
pub const MIN_SLOPE: f64 = 0.5;
pub const MAX_SLOPE: f64 = 2.0;

pub struct Segment {
    pub start: usize,
    pub end: usize,
    /// (output sample, input sample), strictly increasing, identity at both ends.
    anchors: Vec<(f64, f64)>,
}

impl Segment {
    /// Builds a segment from (output sec, input sec) anchors. Refuses maps that are not identity at
    /// the ends, not strictly increasing, too fast/slow, or outside the audio.
    pub fn new(anchors_sec: &[(f32, f32)], sr: f32, len: usize) -> Option<Segment> {
        if anchors_sec.len() < 2 {
            return None;
        }
        let a: Vec<(f64, f64)> = anchors_sec.iter().map(|&(o, i)| (o as f64 * sr as f64, i as f64 * sr as f64)).collect();
        let (first, last) = (a[0], a[a.len() - 1]);
        // Seconds -> samples in f32 can land a hair past either end: allow one sample of slack.
        if (first.0 - first.1).abs() > 1.0 || (last.0 - last.1).abs() > 1.0 || first.0 < -1.0 || last.0 > len as f64 + 1.0 {
            return None;
        }
        for w in a.windows(2) {
            let (d_out, d_in) = (w[1].0 - w[0].0, w[1].1 - w[0].1);
            if d_out <= 0.0 || d_in <= 0.0 {
                return None;
            }
            let slope = d_in / d_out;
            if !(MIN_SLOPE..=MAX_SLOPE).contains(&slope) {
                return None;
            }
        }
        let mut anchors = a;
        anchors[0].0 = anchors[0].0.max(0.0);
        anchors[0].1 = anchors[0].0;
        let n = anchors.len() - 1;
        anchors[n].0 = anchors[n].0.min(len as f64);
        anchors[n].1 = anchors[n].0;
        let (start, end) = (anchors[0].0.round() as usize, (anchors[n].0.round() as usize).min(len));
        Some(Segment { start, end, anchors })
    }

    /// Input position for an output position (identity outside the segment).
    pub fn map(&self, out: f64) -> f64 {
        let a = &self.anchors;
        if out <= a[0].0 || out >= a[a.len() - 1].0 {
            return out;
        }
        let k = a.partition_point(|p| p.0 <= out).max(1);
        let (p, q) = (a[k - 1], a[k]);
        p.1 + (out - p.0) * (q.1 - p.1) / (q.0 - p.0)
    }

    /// True when the map moves nothing (then the render path is skipped entirely).
    pub fn is_identity(&self) -> bool {
        self.anchors.iter().all(|p| (p.0 - p.1).abs() < 0.5)
    }
}

pub fn hop(sr: f32) -> usize {
    ((sr * 0.01).round() as usize).max(16)
}

/// Samples of context a warped segment reads beyond its own bounds.
pub fn margin(sr: f32) -> usize {
    2 * hop(sr) + (SEARCH_SEC * sr).ceil() as usize + 8
}

fn corr(y: &[f32], a: isize, b: isize, n: usize, step: usize) -> f32 {
    let (mut xy, mut xx, mut yy) = (0.0f32, 0.0f32, 0.0f32);
    let mut j = 0;
    while j < n {
        let (p, q) = (a + j as isize, b + j as isize);
        if p >= 0 && q >= 0 && (p as usize) < y.len() && (q as usize) < y.len() {
            let (u, v) = (y[p as usize], y[q as usize]);
            xy += u * v;
            xx += u * u;
            yy += v * v;
        }
        j += step;
    }
    xy / (xx * yy).sqrt().max(1e-12)
}

/// Chooses each grain's input start (absolute samples). `y` is the mono signal whose first sample
/// is absolute index `y_off`.
pub fn plan(y: &[f32], y_off: usize, seg: &Segment, sr: f32) -> Vec<(isize, isize)> {
    let h = hop(sr) as isize;
    let search = (SEARCH_SEC * sr).round() as isize;
    let lo_bound = y_off as isize;
    let hi_bound = (y_off + y.len()) as isize - 2 * h;
    let mut grains = Vec::new();
    let mut o = seg.start as isize - h;
    let mut prev: Option<isize> = None;
    while o < seg.end as isize {
        let c = o + h;
        let nominal = (seg.map(c as f64) - h as f64).round() as isize;
        let edge = c <= seg.start as isize + h || c >= seg.end as isize - h;
        let mut pick = nominal;
        if let (Some(p), false) = (prev, edge) {
            // Where the previous grain would naturally continue (in the local signal).
            let nat = p + h - lo_bound;
            let base = nominal - lo_bound;
            let energy: f32 = (0..h).map(|j| y.get((nat + j) as usize).map_or(0.0, |v| v * v)).sum();
            if energy > 1e-7 * h as f32 {
                // Coarse (every 4th offset, every 2nd sample), then refine around the winner.
                let score = |d: isize, step: usize| corr(y, nat, base + d, h as usize, step) - 0.002 * (d.abs() as f32 / search.max(1) as f32);
                let mut best = (f32::MIN, 0isize);
                let mut d = -search;
                while d <= search {
                    let s = score(d, 2);
                    if s > best.0 {
                        best = (s, d);
                    }
                    d += 4;
                }
                let center = best.1;
                let mut fine = (f32::MIN, center);
                for d in (center - 3).max(-search)..=(center + 3).min(search) {
                    let s = score(d, 1);
                    if s > fine.0 {
                        fine = (s, d);
                    }
                }
                pick = nominal + fine.1;
            }
        }
        pick = pick.clamp(lo_bound, hi_bound.max(lo_bound));
        grains.push((o, pick));
        prev = Some(pick);
        o += h;
    }
    grains
}

/// Overlap-adds the planned grains of `src` (absolute offset `src_off`) into `dst` (absolute offset
/// `dst_off`) over the segment's output range.
pub fn apply(src: &[f32], src_off: usize, seg: &Segment, grains: &[(isize, isize)], sr: f32, dst: &mut [f32], dst_off: usize) {
    let h = hop(sr);
    let n = 2 * h;
    let win: Vec<f32> = (0..n).map(|j| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * j as f32 / n as f32).cos()).collect();
    let (s, e) = (seg.start as isize, seg.end as isize);
    let d0 = (s - dst_off as isize).max(0) as usize;
    let d1 = ((e - dst_off as isize).max(0) as usize).min(dst.len());
    for v in &mut dst[d0..d1] {
        *v = 0.0;
    }
    for &(o, i) in grains {
        for (j, w) in win.iter().enumerate() {
            let out = o + j as isize;
            if out < s || out >= e {
                continue;
            }
            let di = out - dst_off as isize;
            let si = i + j as isize - src_off as isize;
            if di < 0 || di as usize >= dst.len() || si < 0 || si as usize >= src.len() {
                continue;
            }
            dst[di as usize] += w * src[si as usize];
        }
    }
}
