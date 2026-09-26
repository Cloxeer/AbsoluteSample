//! Notes ("blobs"): segmentation of the pitch track, Melodyne-style decomposition
//! of each note's pitch into center + drift (slow wander) + modulation (vibrato),
//! the per-frame retune curve produced by the user's edits, and key detection.

use crate::pitch::{runs, HOP_SEC};
use serde::Serialize;

const SPLIT_SEMI: f32 = 0.6; // leaving the note's center by this much...
const SPLIT_FRAMES: usize = 4; // ...for 40 ms starts a new note
const MIN_NOTE_FRAMES: usize = 6; // shorter pieces are glides, merged into a neighbour
const REONSET_DB: f32 = 6.0; // a dip this deep between two louder parts = new syllable
const DRIFT_WINDOW: usize = 15; // 150 ms: slower than vibrato, faster than a note

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub start_frame: usize,
    pub end_frame: usize, // exclusive
    pub start_sec: f32,
    pub end_sec: f32,
    /// Perceived pitch of the note as sung (fractional MIDI).
    pub center: f32,
    /// Where the user wants the center (fractional MIDI). Equal to `center` when untouched.
    pub target: f32,
    /// 1 = keep the slow pitch wander, 0 = straighten it out.
    pub drift: f32,
    /// 1 = keep the vibrato, 0 = flatten it, >1 = exaggerate.
    pub modulation: f32,
    /// Peak level of the note in dBFS, for drawing the blob.
    pub peak_db: f32,
}

impl Note {
    pub fn is_edited(&self) -> bool {
        (self.target - self.center).abs() > 1e-4 || (self.drift - 1.0).abs() > 1e-4 || (self.modulation - 1.0).abs() > 1e-4
    }
}

fn voiced_mean(midi: &[f32]) -> Option<f32> {
    let v: Vec<f32> = midi.iter().cloned().filter(|m| !m.is_nan()).collect();
    if v.is_empty() {
        None
    } else {
        Some(v.iter().sum::<f32>() / v.len() as f32)
    }
}

/// Amplitude-weighted mean pitch over the stable middle of the note (transitions excluded).
pub fn note_center(midi: &[f32], db: &[f32], s: usize, e: usize) -> f32 {
    let n = e - s;
    let trim = if n >= 15 { n / 5 } else { 0 };
    let (a, b) = (s + trim, e - trim);
    let mut num = 0.0;
    let mut den = 0.0;
    for i in a..b {
        if !midi[i].is_nan() {
            let w = 10f32.powf(db[i] / 20.0);
            num += midi[i] * w;
            den += w;
        }
    }
    if den > 0.0 {
        num / den
    } else {
        voiced_mean(&midi[s..e]).unwrap_or(60.0)
    }
}

fn make_note(midi: &[f32], db: &[f32], s: usize, e: usize) -> Note {
    let c = note_center(midi, db, s, e);
    Note {
        start_frame: s,
        end_frame: e,
        start_sec: s as f32 * HOP_SEC,
        end_sec: e as f32 * HOP_SEC,
        center: c,
        target: c,
        drift: 1.0,
        modulation: 1.0,
        peak_db: db[s..e].iter().cloned().fold(f32::MIN, f32::max),
    }
}

pub fn segment(midi: &[f32], db: &[f32]) -> Vec<Note> {
    let voiced: Vec<bool> = midi.iter().map(|m| !m.is_nan()).collect();
    let mut bounds: Vec<(usize, usize)> = Vec::new();
    for (s, e) in runs(&voiced) {
        // 1) pitch splits
        let mut cuts = vec![s];
        let mut note_start = s;
        let mut i = s;
        while i < e {
            let hist_from = note_start.max(i.saturating_sub(25));
            if i - note_start >= 3 {
                let mut h: Vec<f32> = midi[hist_from..i].to_vec();
                h.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let center = h[h.len() / 2];
                if (midi[i] - center).abs() > SPLIT_SEMI {
                    let mut k = i;
                    while k < e && k < i + SPLIT_FRAMES && (midi[k] - center).abs() > SPLIT_SEMI {
                        k += 1;
                    }
                    if k - i >= SPLIT_FRAMES {
                        cuts.push(i);
                        note_start = i;
                        i += 1;
                        continue;
                    }
                }
            }
            i += 1;
        }
        // 2) re-onset splits (same pitch, new syllable)
        let mut extra = Vec::new();
        for i in s + 5..e.saturating_sub(5) {
            let win = &db[i - 5..=i + 5];
            if db[i] > win.iter().cloned().fold(f32::MAX, f32::min) {
                continue;
            }
            let before = db[s..i].iter().cloned().fold(f32::MIN, f32::max);
            let after = db[i..(i + 15).min(e)].iter().cloned().fold(f32::MIN, f32::max);
            if before - db[i] >= REONSET_DB && after - db[i] >= REONSET_DB {
                extra.push(i);
            }
        }
        cuts.extend(extra);
        cuts.sort_unstable();
        cuts.dedup();
        cuts.push(e);
        // 3) merge too-short pieces into the previous (or next) piece
        let mut pieces: Vec<(usize, usize)> = cuts.windows(2).map(|w| (w[0], w[1])).filter(|p| p.1 > p.0).collect();
        let mut k = 0;
        while k < pieces.len() {
            if pieces[k].1 - pieces[k].0 < MIN_NOTE_FRAMES && pieces.len() > 1 {
                if k > 0 {
                    pieces[k - 1].1 = pieces[k].1;
                } else {
                    pieces[1].0 = pieces[0].0;
                }
                pieces.remove(k);
            } else {
                k += 1;
            }
        }
        bounds.extend(pieces.into_iter().filter(|p| p.1 - p.0 >= MIN_NOTE_FRAMES.min(5)));
    }
    bounds.into_iter().map(|(s, e)| make_note(midi, db, s, e)).collect()
}

pub fn split_note(notes: &mut Vec<Note>, idx: usize, frame: usize, midi: &[f32], db: &[f32]) -> bool {
    let n = &notes[idx];
    if frame <= n.start_frame + 2 || frame + 2 >= n.end_frame {
        return false;
    }
    let (s, e) = (n.start_frame, n.end_frame);
    let offset = n.target - n.center;
    let (dr, md) = (n.drift, n.modulation);
    let mut a = make_note(midi, db, s, frame);
    let mut b = make_note(midi, db, frame, e);
    for x in [&mut a, &mut b] {
        x.target = x.center + offset;
        x.drift = dr;
        x.modulation = md;
    }
    notes.splice(idx..=idx, [a, b]);
    true
}

pub fn merge_with_next(notes: &mut Vec<Note>, idx: usize, midi: &[f32], db: &[f32]) -> bool {
    if idx + 1 >= notes.len() {
        return false;
    }
    let (s, e) = (notes[idx].start_frame, notes[idx + 1].end_frame);
    let offset = notes[idx].target - notes[idx].center;
    let mut m = make_note(midi, db, s, e);
    m.target = m.center + offset;
    m.drift = notes[idx].drift;
    m.modulation = notes[idx].modulation;
    notes.splice(idx..=idx + 1, [m]);
    true
}

fn moving_average(x: &[f32], w: usize) -> Vec<f32> {
    if w <= 1 {
        return x.to_vec();
    }
    let half = w / 2;
    (0..x.len())
        .map(|i| {
            let a = i.saturating_sub(half);
            let b = (i + half + 1).min(x.len());
            x[a..b].iter().sum::<f32>() / (b - a) as f32
        })
        .collect()
}

/// Pitch (MIDI) of every frame after the edits: center moved to target, drift and
/// vibrato scaled. NaN where unvoiced. Untouched notes return the original pitch.
pub fn edited_pitch(midi: &[f32], notes: &[Note]) -> Vec<f32> {
    let mut out = midi.to_vec();
    for n in notes {
        if !n.is_edited() {
            continue;
        }
        let (s, e) = (n.start_frame, n.end_frame);
        // fill gaps for smoothing, then decompose
        let seg: Vec<f32> = {
            let mut v = midi[s..e].to_vec();
            let mut last = n.center;
            for x in v.iter_mut() {
                if x.is_nan() {
                    *x = last;
                } else {
                    last = *x;
                }
            }
            v
        };
        let slow = moving_average(&seg, DRIFT_WINDOW);
        for (k, i) in (s..e).enumerate() {
            if midi[i].is_nan() {
                continue;
            }
            let drift = slow[k] - n.center;
            let modu = seg[k] - slow[k];
            out[i] = n.target + drift * n.drift + modu * n.modulation;
        }
    }
    out
}

/// Per-frame shift in semitones (0 where untouched or unvoiced), with 50 ms transitions.
pub fn shift_curve(midi: &[f32], notes: &[Note]) -> Vec<f32> {
    let edited = edited_pitch(midi, notes);
    let n = midi.len();
    let mut shift: Vec<f32> = (0..n)
        .map(|i| if midi[i].is_nan() { f32::NAN } else { edited[i] - midi[i] })
        .collect();
    // unvoiced frames borrow the next voiced frame's shift so ramps happen in gaps
    let mut next = 0.0;
    for i in (0..n).rev() {
        if shift[i].is_nan() {
            shift[i] = next;
        } else {
            next = shift[i];
        }
    }
    let mut sm = moving_average(&shift, 5);
    for i in 0..n {
        if midi[i].is_nan() {
            sm[i] = 0.0;
        }
    }
    sm
}

const NOTE_NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const KS_MAJOR: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

#[derive(Serialize)]
pub struct Key {
    pub tonic: String,
    pub mode: String,
    pub confidence: f32,
}

fn corr(a: &[f32; 12], b: &[f32; 12]) -> f32 {
    let ma = a.iter().sum::<f32>() / 12.0;
    let mb = b.iter().sum::<f32>() / 12.0;
    let (mut n, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        n += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma).powi(2);
        db += (b[i] - mb).powi(2);
    }
    if da <= 0.0 || db <= 0.0 {
        0.0
    } else {
        n / (da * db).sqrt()
    }
}

/// Krumhansl-Schmuckler over the note centers, weighted by duration.
pub fn detect_key(notes: &[Note]) -> Key {
    let mut hist = [0f32; 12];
    for n in notes {
        let pc = ((n.center.round() as i32 % 12) + 12) % 12;
        hist[pc as usize] += n.end_sec - n.start_sec;
    }
    let mut best = (-2.0, 0usize, "major");
    for (mode, prof) in [("major", KS_MAJOR), ("minor", KS_MINOR)] {
        for t in 0..12 {
            let mut rot = [0f32; 12];
            for i in 0..12 {
                rot[(i + t) % 12] = prof[i];
            }
            let c = corr(&hist, &rot);
            if c > best.0 {
                best = (c, t, mode);
            }
        }
    }
    Key { tonic: NOTE_NAMES[best.1].to_string(), mode: best.2.to_string(), confidence: ((best.0 + 1.0) / 2.0).clamp(0.0, 1.0) }
}
