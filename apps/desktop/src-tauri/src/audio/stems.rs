//! Stem sets on disk (contract v11 addendum "compact stems"): the
//! `instruments.json` / `karaoke/karaoke.json` manifests, stem file
//! resolution, and derived stems (recipes such as
//! `other = mixGain*mix - (vocals+drums+...)`) materialized with ffmpeg into
//! `<set dir>/_derived/<key>.wav` on demand.
//!
//! Derived-stem lanes: at split time a derived stem is materialized once to
//! measure loudness/peaks/duration (so its lane is drawable); every manifest
//! write then deletes the `_derived` cache, so derived stems cost no disk
//! until something asks `stem_file` for them again.

use super::engine::{Derived, InstrumentStem, InstrumentsManifest};
use super::{dsp_filters, silent_command, workspace};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const DERIVED_DIR: &str = "_derived";
/// Level stored for a digitally silent stem.
pub const SILENT_DB: f64 = -120.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StemSetKind {
    Instruments,
    Karaoke,
}

impl StemSetKind {
    /// Directory holding the set's stem files (the engine's `out`).
    pub fn out_dir(self, work_dir: &Path) -> PathBuf {
        match self {
            StemSetKind::Instruments => work_dir.join("instruments"),
            StemSetKind::Karaoke => work_dir.join("karaoke"),
        }
    }

    pub fn manifest_path(self, work_dir: &Path) -> PathBuf {
        match self {
            StemSetKind::Instruments => work_dir.join("instruments.json"),
            StemSetKind::Karaoke => work_dir.join("karaoke").join("karaoke.json"),
        }
    }
}

pub fn load_manifest(work_dir: &Path, kind: StemSetKind) -> Option<InstrumentsManifest> {
    let text = std::fs::read_to_string(kind.manifest_path(work_dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Writes the manifest atomically (temp file + rename) and drops the derived
/// cache, since the stems it was computed from may have changed.
pub fn save_manifest(work_dir: &Path, kind: StemSetKind, manifest: &InstrumentsManifest) -> Result<(), String> {
    let path = kind.manifest_path(work_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(manifest).map_err(|e| format!("failed to serialize stem manifest: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("failed to replace {}: {e}", path.display()))?;
    invalidate_derived(work_dir, kind, manifest);
    Ok(())
}

/// Deletes `<set>/_derived/` and the per-file analysis caches of derived
/// stems (keyed by file stem, so they would otherwise outlive a change).
pub fn invalidate_derived(work_dir: &Path, kind: StemSetKind, manifest: &InstrumentsManifest) {
    let _ = std::fs::remove_dir_all(kind.out_dir(work_dir).join(DERIVED_DIR));
    for stem in manifest.stems.iter().filter(|s| s.derived.is_some()) {
        let _ = std::fs::remove_file(work_dir.join("analysis").join(format!("{}.json", stem.key)));
    }
}

/// Finds the set holding `key`. `"karaoke:<key>"` forces the karaoke set;
/// otherwise instruments win over karaoke (both can have `vocals`).
pub fn locate(work_dir: &Path, key: &str) -> Option<(StemSetKind, InstrumentsManifest, InstrumentStem)> {
    let (kinds, bare): (&[StemSetKind], &str) = match key.strip_prefix("karaoke:") {
        Some(k) => (&[StemSetKind::Karaoke], k),
        None => (&[StemSetKind::Instruments, StemSetKind::Karaoke], key),
    };
    kinds.iter().find_map(|&kind| {
        let m = load_manifest(work_dir, kind)?;
        let stem = m.stems.iter().find(|s| s.key == bare)?.clone();
        Some((kind, m, stem))
    })
}

/// `stem_file(trackId, key)`: the stem's real file (derived stems are
/// materialized into the `_derived` cache).
pub fn stem_file(track_id: &str, key: &str) -> Result<PathBuf, String> {
    let dir = workspace::work_dir(track_id)?;
    let (kind, manifest, stem) =
        locate(&dir, key).ok_or_else(|| format!("stem '{key}' not found for track '{track_id}'"))?;
    let path = StemSet::new(&dir, kind, &manifest).file_for(&stem.key)?;
    if !path.exists() {
        return Err(format!("stem file missing: {}", path.display()));
    }
    Ok(path)
}

/// One stem set with enough context to resolve any key to a file.
pub struct StemSet<'a> {
    pub stems: &'a [InstrumentStem],
    pub mix_path: PathBuf,
    pub mix_gain: f32,
    pub derived_dir: PathBuf,
}

impl<'a> StemSet<'a> {
    pub fn new(work_dir: &Path, kind: StemSetKind, manifest: &'a InstrumentsManifest) -> Self {
        let mix_path = manifest
            .mix_path
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| work_dir.join("source.wav"));
        StemSet {
            stems: &manifest.stems,
            mix_path,
            mix_gain: manifest.mix_gain.unwrap_or(1.0),
            derived_dir: kind.out_dir(work_dir).join(DERIVED_DIR),
        }
    }

    /// The file for `key` (`"mix"` is the mix itself).
    pub fn file_for(&self, key: &str) -> Result<PathBuf, String> {
        self.file_for_depth(key, 0)
    }

    fn file_for_depth(&self, key: &str, depth: u32) -> Result<PathBuf, String> {
        if key == "mix" {
            return Ok(self.mix_path.clone());
        }
        let stem = self
            .stems
            .iter()
            .find(|s| s.key == key)
            .ok_or_else(|| format!("unknown stem '{key}'"))?;
        let derived = match &stem.derived {
            Some(d) if stem.path.is_empty() => d,
            _ => return Ok(PathBuf::from(&stem.path)),
        };
        if depth > 4 {
            return Err(format!("derived stem '{key}' nests too deeply"));
        }
        let dest = self.derived_dir.join(format!("{key}.wav"));
        if dest.exists() {
            return Ok(dest);
        }
        let mix_gain = derived.mix_gain.unwrap_or(self.mix_gain) as f64;
        let mut inputs = Vec::new();
        for k in &derived.plus {
            inputs.push((self.file_for_depth(k, depth + 1)?, if k == "mix" { mix_gain } else { 1.0 }));
        }
        for k in &derived.minus {
            inputs.push((self.file_for_depth(k, depth + 1)?, if k == "mix" { -mix_gain } else { -1.0 }));
        }
        materialize(&inputs, &dest)?;
        Ok(dest)
    }
}

/// Builds the exact weighted sum `sum(weight_i * input_i)` filtergraph:
/// every input is converted to double precision and scaled by `volume`
/// (amix's own `weights` ignore the sign), then summed by `amix` with
/// `normalize=0` (no scaling, no dropout ramps).
pub fn mix_filtergraph(weights: &[f64]) -> String {
    let mut graph = String::new();
    for (i, w) in weights.iter().enumerate() {
        graph.push_str(&format!("[{i}:a]aformat=sample_fmts=dbl,volume={w}:precision=double[a{i}];"));
    }
    for i in 0..weights.len() {
        graph.push_str(&format!("[a{i}]"));
    }
    graph.push_str(&format!("amix=inputs={}:normalize=0:duration=longest", weights.len()));
    graph
}

/// Writes `sum(weight * file)` to `dest` as 24-bit wav (via a temp file, so
/// a concurrent reader never sees a partial file).
pub fn materialize(inputs: &[(PathBuf, f64)], dest: &Path) -> Result<(), String> {
    if inputs.is_empty() {
        return Err("derived stem has no inputs".to_string());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    let tmp = dest.with_extension(format!("{}.part", std::process::id()));
    let mut cmd = silent_command("ffmpeg");
    cmd.args(["-v", "error", "-y"]);
    for (path, _) in inputs {
        cmd.arg("-i").arg(path);
    }
    let weights: Vec<f64> = inputs.iter().map(|(_, w)| *w).collect();
    cmd.args(["-filter_complex", &mix_filtergraph(&weights), "-c:a", "pcm_s24le", "-f", "wav"]).arg(&tmp);
    let out = cmd.output().map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(10).collect();
        return Err(format!("ffmpeg derived-stem mix failed: {}", tail.join("\n")));
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("failed to finalize {}: {e}", dest.display()))
}

/// Measures one stem from `file`: loudness, peaks, duration; `bytes` only
/// for stored files (a derived stem occupies no disk).
fn measure(stem: &mut InstrumentStem, file: &Path) {
    let derived = stem.derived.is_some() && stem.path.is_empty();
    stem.bytes = if derived { 0 } else { std::fs::metadata(file).map(|m| m.len()).unwrap_or(0) };
    // A silent stem measures -inf, which JSON can't hold (it would be written
    // as null and the manifest would no longer load): floor it.
    let floor = |db: f64| if db.is_finite() { db } else { SILENT_DB };
    if let Ok(l) = dsp_filters::measure_loudness(file) {
        stem.peak_db = floor(l.peak_db);
        stem.rms_db = floor(l.rms_db);
    }
    stem.peaks = super::peaks::compute_peaks_for_path(file).unwrap_or_default();
    stem.duration_sec = super::downloader::probe(file).map(|p| p.duration_sec).unwrap_or(0.0);
}

fn same_source(a: &InstrumentStem, b: &InstrumentStem) -> bool {
    a.key == b.key && a.path == b.path && a.derived == b.derived
}

/// Fills measurements for every stem of `manifest`, reusing them from
/// `known` when the stem's source is unchanged (same key, path, recipe).
/// Derived stems are materialized under `kind`'s `_derived` dir as needed.
pub fn measure_all(work_dir: &Path, kind: StemSetKind, manifest: &mut InstrumentsManifest, known: &[InstrumentStem]) {
    let known: HashMap<&str, &InstrumentStem> = known.iter().map(|s| (s.key.as_str(), s)).collect();
    let snapshot = manifest.clone();
    let set = StemSet::new(work_dir, kind, &snapshot);
    for stem in manifest.stems.iter_mut() {
        // Reuse an early (stem_ready) measurement only if it actually produced peaks.
        if let Some(k) = known.get(stem.key.as_str()).filter(|k| same_source(k, stem) && !k.peaks.is_empty()) {
            stem.bytes = k.bytes;
            stem.peak_db = k.peak_db;
            stem.rms_db = k.rms_db;
            stem.peaks = k.peaks.clone();
            stem.duration_sec = k.duration_sec;
            continue;
        }
        if let Ok(file) = set.file_for(&stem.key) {
            measure(stem, &file);
        }
    }
}

/// Measures one freshly reported stem (`stem_ready`) against the stems seen
/// so far in the same job.
pub fn measure_one(work_dir: &Path, kind: StemSetKind, seen: &[InstrumentStem], mix_path: &Path, stem: &mut InstrumentStem) {
    // A stem can be re-announced with a new file (e.g. vocals rewritten at the final gain): the
    // latest entry per key wins, so derived stems are never measured against a deleted file.
    let mut stems: Vec<InstrumentStem> = Vec::new();
    for s in seen.iter().chain(std::iter::once(&*stem)) {
        stems.retain(|x| x.key != s.key);
        stems.push(s.clone());
    }
    let set = StemSet {
        stems: &stems,
        mix_path: mix_path.to_path_buf(),
        mix_gain: 1.0,
        derived_dir: kind.out_dir(work_dir).join(DERIVED_DIR),
    };
    if let Ok(file) = set.file_for(&stem.key) {
        measure(stem, &file);
    }
}

/// True for a stem whose recipe is `derived`.
pub fn is_derived(stem: &InstrumentStem) -> bool {
    stem.path.is_empty() && stem.derived.is_some()
}

/// Recipe helper for tests and callers building recipes by hand.
pub fn recipe(plus: &[&str], minus: &[&str], mix_gain: Option<f32>) -> Derived {
    Derived {
        plus: plus.iter().map(|s| s.to_string()).collect(),
        minus: minus.iter().map(|s| s.to_string()).collect(),
        mix_gain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::engine::RawStem;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("as_stems_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn stem(key: &str, path: &str, derived: Option<Derived>) -> InstrumentStem {
        InstrumentStem::from(RawStem {
            key: key.into(),
            label: key.into(),
            group: "other".into(),
            path: path.into(),
            model: "m".into(),
            order: 1,
            derived,
            ..Default::default()
        })
    }

    #[test]
    fn old_manifest_without_v11_fields_parses() {
        let old = r#"{
            "stems": [{"key":"vocals","label":"Vocals","group":"vocals","parent":null,
                       "path":"C:/w/instruments/vocals.wav","bytes":10,"peakDb":-1.0,"rmsDb":-12.0,
                       "model":"m","order":10}],
            "device": "cuda", "failedPasses": [], "elapsedSec": 12.5, "passSeconds": {"vocals": 3.0}
        }"#;
        let m: InstrumentsManifest = serde_json::from_str(old).unwrap();
        assert_eq!(m.quality, None);
        assert_eq!(m.mix_path, None);
        assert_eq!(m.mix_gain, None);
        assert!(m.enhanced.is_empty());
        assert_eq!(m.stems[0].derived, None);
        // A silent stem's -inf used to be written as null.
        let silent = old.replace(r#""peakDb":-1.0,"rmsDb":-12.0"#, r#""peakDb":null,"rmsDb":null"#);
        let m2: InstrumentsManifest = serde_json::from_str(&silent).unwrap();
        assert_eq!(m2.stems[0].peak_db, SILENT_DB);
        // Stored stems don't gain a `derived` key on re-save.
        let v = serde_json::to_value(&m).unwrap();
        assert!(v["stems"][0].get("derived").is_none());
    }

    #[test]
    fn derived_recipe_round_trips() {
        let json = r#"{"key":"other","label":"Other","group":"other","parent":null,"path":"",
            "model":"sum","order":60,"derived":{"plus":["mix"],"minus":["vocals","drums"],"mixGain":0.9}}"#;
        let raw: RawStem = serde_json::from_str(json).unwrap();
        let d = raw.derived.clone().unwrap();
        assert_eq!(d, recipe(&["mix"], &["vocals", "drums"], Some(0.9)));
        let s = InstrumentStem::from(raw);
        assert!(is_derived(&s));
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["derived"]["plus"][0], "mix");
        assert_eq!(v["derived"]["mixGain"].as_f64().unwrap() as f32, 0.9);
        let back: InstrumentStem = serde_json::from_value(v).unwrap();
        assert_eq!(back.derived, Some(d));
        // Engine sends explicit nulls for stored files and null mixGain.
        let raw: RawStem = serde_json::from_str(
            r#"{"key":"v","label":"V","group":"vocals","parent":null,"path":"a.flac","model":"m","order":1,"derived":null}"#,
        )
        .unwrap();
        assert_eq!(raw.derived, None);
        let d: Derived = serde_json::from_str(r#"{"plus":["vocals"],"minus":["lead_vocals"],"mixGain":null}"#).unwrap();
        assert_eq!(d.mix_gain, None);
        assert!(serde_json::to_value(&d).unwrap().get("mixGain").is_none());
    }

    #[test]
    fn v11_manifest_round_trips() {
        let m = InstrumentsManifest {
            stems: vec![stem("vocals", "v.flac", None), stem("other", "", Some(recipe(&["mix"], &["vocals"], None)))],
            device: "cuda".into(),
            quality: Some("quick".into()),
            mix_path: Some("C:/w/source.wav".into()),
            mix_gain: Some(0.8),
            enhanced: vec![super::super::engine::Region { start: 1.0, end: 2.5 }],
            ..Default::default()
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["mixPath"], "C:/w/source.wav");
        assert_eq!(v["enhanced"][0]["end"], 2.5);
        let back: InstrumentsManifest = serde_json::from_value(v).unwrap();
        assert_eq!(back.mix_gain, Some(0.8));
        assert_eq!(back.stems[1].derived, m.stems[1].derived);
    }

    #[test]
    fn filtergraph_shape() {
        let g = mix_filtergraph(&[0.9, -1.0, -1.0]);
        assert!(g.starts_with("[0:a]aformat=sample_fmts=dbl,volume=0.9:precision=double[a0];"));
        assert!(g.contains("[2:a]aformat=sample_fmts=dbl,volume=-1:precision=double[a2];"));
        assert!(g.ends_with("[a0][a1][a2]amix=inputs=3:normalize=0:duration=longest"));
    }

    #[test]
    fn locate_prefers_instruments_and_honors_karaoke_prefix() {
        let dir = temp_dir("locate");
        let inst = InstrumentsManifest { stems: vec![stem("vocals", "i.flac", None)], ..Default::default() };
        let kar = InstrumentsManifest {
            stems: vec![stem("vocals", "k.flac", None), stem("instrumental", "", Some(recipe(&["mix"], &["vocals"], None)))],
            ..Default::default()
        };
        save_manifest(&dir, StemSetKind::Instruments, &inst).unwrap();
        save_manifest(&dir, StemSetKind::Karaoke, &kar).unwrap();
        assert_eq!(locate(&dir, "vocals").unwrap().2.path, "i.flac");
        assert_eq!(locate(&dir, "karaoke:vocals").unwrap().2.path, "k.flac");
        assert_eq!(locate(&dir, "instrumental").unwrap().0, StemSetKind::Karaoke);
        assert!(locate(&dir, "nope").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- ffmpeg exactness -------------------------------------------------

    const SR: u32 = 44100;

    fn write_wav24(path: &Path, frames: &[[f64; 2]]) {
        let data_len = frames.len() as u32 * 6;
        let mut b = Vec::with_capacity(44 + data_len as usize);
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&SR.to_le_bytes());
        b.extend_from_slice(&(SR * 6).to_le_bytes());
        b.extend_from_slice(&6u16.to_le_bytes());
        b.extend_from_slice(&24u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        for f in frames {
            for &x in f {
                let v = (x * 8_388_608.0).round().clamp(-8_388_608.0, 8_388_607.0) as i32;
                b.extend_from_slice(&v.to_le_bytes()[..3]);
            }
        }
        std::fs::write(path, b).unwrap();
    }

    /// Decodes any file to interleaved stereo f64 via ffmpeg (s32 PCM, so no
    /// float rounding on the way out).
    fn read_pcm(path: &Path) -> Vec<f64> {
        let out = silent_command("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(path)
            .args(["-f", "s32le", "-ac", "2", "-"])
            .output()
            .unwrap();
        assert!(out.status.success());
        out.stdout.chunks_exact(4).map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64 / 2147483648.0).collect()
    }

    fn tone(freq: f64, amp: f64, n: usize) -> Vec<[f64; 2]> {
        (0..n)
            .map(|i| {
                let t = i as f64 / SR as f64;
                let x = amp * (2.0 * std::f64::consts::PI * freq * t).sin();
                [x, -0.5 * x]
            })
            .collect()
    }

    #[test]
    fn materialized_derived_stems_are_exact() {
        if crate::audio::find_on_path("ffmpeg").is_none() {
            eprintln!("skipping: ffmpeg not found");
            return;
        }
        let dir = temp_dir("exact");
        let n = SR as usize; // 1 s
        let a = tone(220.0, 0.3, n);
        let b = tone(331.0, 0.25, n);
        let c = tone(1234.5, 0.15, n);
        let gain = 0.8;
        // mix is the unscaled song: stems sum to gain * mix.
        let mix: Vec<[f64; 2]> = (0..n)
            .map(|i| [0, 1].map(|ch| (a[i][ch] + b[i][ch] + c[i][ch]) / gain))
            .collect();
        write_wav24(&dir.join("a.wav"), &a);
        write_wav24(&dir.join("b.wav"), &b);
        write_wav24(&dir.join("mix.wav"), &mix);
        // Stored stems are FLAC in v11: exercise the FLAC path too.
        let b_flac = dir.join("b.flac");
        let st = silent_command("ffmpeg")
            .args(["-v", "error", "-y", "-i"])
            .arg(dir.join("b.wav"))
            .args(["-c:a", "flac", "-sample_fmt", "s32"])
            .arg(&b_flac)
            .status()
            .unwrap();
        assert!(st.success());

        let manifest = InstrumentsManifest {
            stems: vec![
                stem("a", &dir.join("a.wav").to_string_lossy(), None),
                stem("b", &b_flac.to_string_lossy(), None),
                // c = gain*mix - a - b (manifest-level mixGain)
                stem("c", "", Some(recipe(&["mix"], &["a", "b"], None))),
                // ab = c-free part via nested derivation: gain*mix - c
                stem("ab", "", Some(recipe(&["mix"], &["c"], Some(gain as f32)))),
                stem("apb", "", Some(recipe(&["a", "b"], &[], None))),
            ],
            mix_path: Some(dir.join("mix.wav").to_string_lossy().to_string()),
            mix_gain: Some(gain as f32),
            ..Default::default()
        };
        let set = StemSet {
            stems: &manifest.stems,
            mix_path: dir.join("mix.wav"),
            mix_gain: gain as f32,
            derived_dir: dir.join(DERIVED_DIR),
        };
        // f32 mixGain in the manifest vs f64 in the reference: allow for
        // that plus 24-bit quantization of every operand.
        let tol = 4.0 / 8_388_608.0 + 1e-7;
        let check = |key: &str, want: &dyn Fn(usize, usize) -> f64| {
            let file = set.file_for(key).unwrap();
            assert!(file.starts_with(dir.join(DERIVED_DIR)));
            let got = read_pcm(&file);
            assert_eq!(got.len(), n * 2, "{key}: length");
            let max_err = (0..n)
                .flat_map(|i| [0, 1].map(|ch| (got[i * 2 + ch] - want(i, ch)).abs()))
                .fold(0.0, f64::max);
            assert!(max_err <= tol, "{key}: max error {max_err} > {tol}");
        };
        check("c", &|i, ch| c[i][ch]);
        check("ab", &|i, ch| a[i][ch] + b[i][ch]);
        check("apb", &|i, ch| a[i][ch] + b[i][ch]);

        // Cached: a second call returns the same file without re-running.
        let p = set.file_for("c").unwrap();
        let mtime = std::fs::metadata(&p).unwrap().modified().unwrap();
        assert_eq!(std::fs::metadata(set.file_for("c").unwrap()).unwrap().modified().unwrap(), mtime);

        // Measurements: derived stems are drawable but take no bytes.
        let mut m = manifest.clone();
        let work = dir.clone();
        std::fs::create_dir_all(work.join("instruments")).unwrap();
        measure_all(&work, StemSetKind::Instruments, &mut m, &[]);
        let c_stem = m.stems.iter().find(|s| s.key == "c").unwrap();
        assert_eq!(c_stem.bytes, 0);
        assert!(!c_stem.peaks.is_empty());
        assert!((c_stem.duration_sec - 1.0).abs() < 0.01);
        assert!(m.stems[0].bytes > 0);

        // Saving the manifest drops the derived cache.
        save_manifest(&work, StemSetKind::Instruments, &m).unwrap();
        assert!(!work.join("instruments").join(DERIVED_DIR).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
