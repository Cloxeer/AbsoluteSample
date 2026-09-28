//! pitchcore: Melodyne-style monophonic vocal editing.
//!
//! analyse once (pitch track, notes, key) -> edit notes (center / drift / vibrato,
//! split, merge) -> render only what changed with TD-PSOLA. Everything stays in
//! memory, so an edit re-renders in about a millisecond. Built natively for tests and
//! as WebAssembly for the app (browser and desktop run the same code).

pub mod crepe;
pub mod notes;
pub mod pitch;
pub mod psola;
pub mod warp;

use notes::{Key, Note};
use serde::Serialize;

pub struct Session {
    x: Vec<f32>,
    /// Optional original channels (e.g. stereo L/R). Analysis always uses the mono mix `x`;
    /// every channel is re-rendered with the same epochs and shift map, so stereo stays intact.
    channels: Vec<Vec<f32>>,
    sr: f32,
    midi: Vec<f32>,
    db: Vec<f32>,
    notes: Vec<Note>,
    runs: Vec<psola::Run>,
    key: Key,
    /// Timing edits: non-overlapping WSOLA segments, sorted by start.
    warps: Vec<warp::Segment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisOut<'a> {
    hop_sec: f32,
    duration_sec: f32,
    /// MIDI pitch per frame; null where there is no sung pitch.
    pitch: Vec<Option<f32>>,
    /// Pitch after the current edits (same shape as `pitch`).
    edited_pitch: Vec<Option<f32>>,
    /// Level per frame in dBFS (for blob thickness).
    db: &'a [f32],
    notes: &'a [Note],
    key: &'a Key,
}

fn opt(v: &[f32]) -> Vec<Option<f32>> {
    v.iter().map(|m| if m.is_nan() { None } else { Some((m * 1000.0).round() / 1000.0) }).collect()
}

impl Session {
    pub fn new(samples: Vec<f32>, sr: f32) -> Session {
        let x16 = pitch::resample_to_asr(&samples, sr);
        let tr = pitch::track(&x16);
        let n = notes::segment(&tr.midi, &tr.db);
        let key = notes::detect_key(&n);
        let runs = psola::find_epochs(&samples, sr, &tr.midi);
        Session { x: samples, channels: Vec::new(), sr, midi: tr.midi, db: tr.db, notes: n, runs, key, warps: Vec::new() }
    }

    pub fn analysis_json(&self) -> String {
        let edited = notes::edited_pitch(&self.midi, &self.notes);
        serde_json::to_string(&AnalysisOut {
            hop_sec: pitch::HOP_SEC,
            duration_sec: self.x.len() as f32 / self.sr,
            pitch: opt(&self.midi),
            edited_pitch: opt(&edited),
            db: &self.db,
            notes: &self.notes,
            key: &self.key,
        })
        .unwrap_or_default()
    }

    pub fn notes(&self) -> &[Note] {
        &self.notes
    }

    /// Set a note's target center (MIDI, fractional allowed), drift and modulation amounts.
    pub fn set_note(&mut self, idx: usize, target: f32, drift: f32, modulation: f32) -> bool {
        match self.notes.get_mut(idx) {
            Some(n) => {
                n.target = target;
                n.drift = drift.clamp(0.0, 2.0);
                n.modulation = modulation.clamp(0.0, 2.0);
                true
            }
            None => false,
        }
    }

    pub fn split_note(&mut self, idx: usize, sec: f32) -> bool {
        if idx >= self.notes.len() {
            return false;
        }
        let frame = (sec / pitch::HOP_SEC).round() as usize;
        notes::split_note(&mut self.notes, idx, frame, &self.midi, &self.db)
    }

    pub fn merge_with_next(&mut self, idx: usize) -> bool {
        notes::merge_with_next(&mut self.notes, idx, &self.midi, &self.db)
    }

    /// Render [start_sec, end_sec) with the current edits. Untouched audio is copied
    /// bit-for-bit; only voiced phrases containing an edited note are resynthesised.
    pub fn render(&self, start_sec: f32, end_sec: f32) -> Vec<f32> {
        self.render_signal(&self.x, start_sec, end_sec)
    }

    /// Attach the original channels (each the same length as the mono analysis signal).
    pub fn set_channels(&mut self, channels: Vec<Vec<f32>>) -> bool {
        if channels.iter().any(|c| c.len() != self.x.len()) {
            return false;
        }
        self.channels = channels;
        true
    }

    pub fn channel_count(&self) -> usize {
        self.channels.len()
    }

    /// Like `render`, for channel `ch` of the attached channels (the mono mix if none).
    pub fn render_channel(&self, ch: usize, start_sec: f32, end_sec: f32) -> Vec<f32> {
        match self.channels.get(ch) {
            Some(x) => self.render_signal(x, start_sec, end_sec),
            None => self.render(start_sec, end_sec),
        }
    }

    fn render_signal(&self, x: &[f32], start_sec: f32, end_sec: f32) -> Vec<f32> {
        let a = ((start_sec.max(0.0)) * self.sr) as usize;
        let b = ((end_sec * self.sr) as usize).min(x.len());
        if b <= a {
            return Vec::new();
        }
        let segs: Vec<&warp::Segment> = self.warps.iter().filter(|s| s.end > a && s.start < b).collect();
        if segs.is_empty() {
            return self.pitch_render(x, a, b);
        }
        // Warped phrases are rebuilt whole (so any sub-range renders exactly the same samples), from
        // the pitch-edited signal plus the context their grains read.
        let pad = warp::margin(self.sr);
        let ea = a.min(segs[0].start).saturating_sub(pad);
        let eb = (b.max(segs[segs.len() - 1].end) + pad).min(x.len());
        let base = self.pitch_render(x, ea, eb);
        let mono_base;
        let mono: &[f32] = if std::ptr::eq(x.as_ptr(), self.x.as_ptr()) {
            &base
        } else {
            mono_base = self.pitch_render(&self.x, ea, eb);
            &mono_base
        };
        let mut out = base.clone();
        for seg in segs {
            let grains = warp::plan(mono, ea, seg, self.sr);
            warp::apply(&base, ea, seg, &grains, self.sr, &mut out, ea);
        }
        out[a - ea..b - ea].to_vec()
    }

    /// Pitch edits only, samples [a, b).
    fn pitch_render(&self, x: &[f32], a: usize, b: usize) -> Vec<f32> {
        let mut out = x[a..b].to_vec();
        let shift = notes::shift_curve(&self.midi, &self.notes);
        for run in &self.runs {
            if run.end + (self.sr / 50.0) as usize <= a || run.start >= b + (self.sr / 50.0) as usize {
                continue;
            }
            psola::render_run(x, self.sr, run, &shift, &mut out, a);
        }
        out
    }

    /// Replaces the timing edits. Each segment is a list of (output sec, input sec) anchors that is
    /// the identity at both ends. Returns false (and changes nothing) if any segment is invalid or
    /// two overlap.
    pub fn set_warps(&mut self, segments: &[Vec<(f32, f32)>]) -> bool {
        let mut built = Vec::with_capacity(segments.len());
        for s in segments {
            match warp::Segment::new(s, self.sr, self.x.len()) {
                Some(seg) if !seg.is_identity() => built.push(seg),
                Some(_) => {}
                None => return false,
            }
        }
        built.sort_by_key(|s| s.start);
        if built.windows(2).any(|w| w[1].start < w[0].end) {
            return false;
        }
        self.warps = built;
        true
    }

    pub fn warp_count(&self) -> usize {
        self.warps.len()
    }

    pub fn render_all(&self) -> Vec<f32> {
        self.render(0.0, self.x.len() as f32 / self.sr)
    }

    /// Diagnostics for artifact hunting: the phrase, nearby epoch spacing and shift at a sample.
    pub fn debug_at(&self, sample: usize) -> String {
        let shift = notes::shift_curve(&self.midi, &self.notes);
        let f = (sample as f32 / self.sr / pitch::HOP_SEC) as usize;
        let sh: Vec<String> = (f.saturating_sub(3)..(f + 4).min(shift.len())).map(|i| format!("{:.2}", shift[i])).collect();
        let pm: Vec<String> = (f.saturating_sub(3)..(f + 4).min(self.midi.len())).map(|i| format!("{:.1}", self.midi[i])).collect();
        for r in &self.runs {
            if sample + 2000 >= r.start && sample <= r.end + 2000 {
                let k = r.epochs.partition_point(|&e| e < sample);
                let lo = k.saturating_sub(3);
                let hi = (k + 3).min(r.epochs.len());
                let gaps: Vec<String> = (lo.max(1)..hi).map(|i| (r.epochs[i] - r.epochs[i - 1]).to_string()).collect();
                return format!(
                    "run {:.3}-{:.3}s ({} epochs) dist-from-start {} dist-to-end {} | epoch gaps {:?} | shift {:?} | midi {:?}",
                    r.start as f32 / self.sr, r.end as f32 / self.sr, r.epochs.len(),
                    sample as isize - r.start as isize, r.end as isize - sample as isize, gaps, sh, pm
                );
            }
        }
        format!("not in a phrase | shift {sh:?} | midi {pm:?}")
    }

    /// The phrase (voiced run) bounds in seconds that contain `sec`, so the UI can
    /// re-render just that phrase after editing a note in it.
    pub fn phrase_bounds(&self, sec: f32) -> (f32, f32) {
        let s = (sec * self.sr) as usize;
        let pad = (self.sr / 50.0) as usize;
        for r in &self.runs {
            if s + pad >= r.start && s <= r.end + pad {
                return (r.start.saturating_sub(pad) as f32 / self.sr, ((r.end + pad).min(self.x.len())) as f32 / self.sr);
            }
        }
        (sec, sec)
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub struct PitchSession(super::Session);

    #[wasm_bindgen]
    impl PitchSession {
        /// Analyse mono samples. Takes a few hundred ms per minute of audio.
        #[wasm_bindgen(constructor)]
        pub fn new(samples: Vec<f32>, sample_rate: f32) -> PitchSession {
            PitchSession(super::Session::new(samples, sample_rate))
        }
        #[wasm_bindgen(js_name = analysisJson)]
        pub fn analysis_json(&self) -> String {
            self.0.analysis_json()
        }
        #[wasm_bindgen(js_name = setNote)]
        pub fn set_note(&mut self, idx: usize, target: f32, drift: f32, modulation: f32) -> bool {
            self.0.set_note(idx, target, drift, modulation)
        }
        #[wasm_bindgen(js_name = splitNote)]
        pub fn split_note(&mut self, idx: usize, sec: f32) -> bool {
            self.0.split_note(idx, sec)
        }
        #[wasm_bindgen(js_name = mergeWithNext)]
        pub fn merge_with_next(&mut self, idx: usize) -> bool {
            self.0.merge_with_next(idx)
        }
        pub fn render(&self, start_sec: f32, end_sec: f32) -> Vec<f32> {
            self.0.render(start_sec, end_sec)
        }
        /// Attach original channels (e.g. stereo); returns false if a length differs.
        #[wasm_bindgen(js_name = setChannels)]
        pub fn set_channels(&mut self, left: Vec<f32>, right: Option<Vec<f32>>) -> bool {
            let mut chs = vec![left];
            if let Some(r) = right {
                chs.push(r);
            }
            self.0.set_channels(chs)
        }
        #[wasm_bindgen(js_name = channelCount)]
        pub fn channel_count(&self) -> usize {
            self.0.channel_count()
        }
        #[wasm_bindgen(js_name = renderChannel)]
        pub fn render_channel(&self, ch: usize, start_sec: f32, end_sec: f32) -> Vec<f32> {
            self.0.render_channel(ch, start_sec, end_sec)
        }
        /// Timing edits, flattened: [n, out0, in0, out1, in1, ..., n2, ...] (seconds).
        #[wasm_bindgen(js_name = setWarps)]
        pub fn set_warps(&mut self, flat: Vec<f32>) -> bool {
            let mut segs = Vec::new();
            let mut i = 0;
            while i < flat.len() {
                let n = flat[i] as usize;
                if n < 2 || i + 1 + 2 * n > flat.len() {
                    return false;
                }
                segs.push((0..n).map(|k| (flat[i + 1 + 2 * k], flat[i + 2 + 2 * k])).collect());
                i += 1 + 2 * n;
            }
            self.0.set_warps(&segs)
        }
        #[wasm_bindgen(js_name = renderAll)]
        pub fn render_all(&self) -> Vec<f32> {
            self.0.render_all()
        }
        /// [start, end] seconds of the phrase containing `sec`.
        #[wasm_bindgen(js_name = phraseBounds)]
        pub fn phrase_bounds(&self, sec: f32) -> Vec<f32> {
            let (a, b) = self.0.phrase_bounds(sec);
            vec![a, b]
        }
    }
}
