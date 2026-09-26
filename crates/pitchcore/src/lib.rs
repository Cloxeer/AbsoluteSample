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

use notes::{Key, Note};
use serde::Serialize;

pub struct Session {
    x: Vec<f32>,
    sr: f32,
    midi: Vec<f32>,
    db: Vec<f32>,
    notes: Vec<Note>,
    runs: Vec<psola::Run>,
    key: Key,
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
        Session { x: samples, sr, midi: tr.midi, db: tr.db, notes: n, runs, key }
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
        let a = ((start_sec.max(0.0)) * self.sr) as usize;
        let b = ((end_sec * self.sr) as usize).min(self.x.len());
        if b <= a {
            return Vec::new();
        }
        let mut out = self.x[a..b].to_vec();
        let shift = notes::shift_curve(&self.midi, &self.notes);
        for run in &self.runs {
            if run.end + (self.sr / 50.0) as usize <= a || run.start >= b + (self.sr / 50.0) as usize {
                continue;
            }
            psola::render_run(&self.x, self.sr, run, &shift, &mut out, a);
        }
        out
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
