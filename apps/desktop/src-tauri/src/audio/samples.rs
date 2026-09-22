//! Sample library (contract v4 addendum): saved clips copied out of a
//! track's stem/instrument/loop wavs into
//! `~/.absolutesample/samples/<sanitized song title>/<sanitized name>.wav`,
//! indexed in `~/.absolutesample/samples/samples.json`.

use super::{analysis, cuts, dsp_filters, library, workspace};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub id: String,
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub song_id: String,
    pub song_title: String,
    pub stem_key: String,
    pub stem_label: String,
    pub group: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub duration_sec: f64,
    pub bpm: Option<f64>,
    pub created_at: String,
    #[serde(default)]
    pub peaks: Vec<f32>,
    /// `"stem"` (whole-stem copy), `"region"` (cut via `cut_region`), or
    /// `"hit"` (one-shot slice via `slice_hits`) — contract v6 addendum.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Short key label like `"Gm"`/`"F"`, derived from the source analysis
    /// key (contract v6 addendum "Key detection and naming").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_short: Option<String>,
    /// Bar count, only set when the sample was grid-snapped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bars: Option<u32>,
}

fn default_kind() -> String {
    "stem".to_string()
}

/// Optional region-cut parameters for `save_sample` (contract v6 addendum
/// "Region cut").
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionParams {
    pub start_sec: f64,
    pub end_sec: f64,
    #[serde(default)]
    pub snap: Option<String>,
    #[serde(default)]
    pub fade_ms: Option<f64>,
    #[serde(default)]
    pub trim_leading_silence: Option<bool>,
}

/// `~/.absolutesample/samples/`, created if missing.
pub fn samples_root() -> Result<PathBuf, String> {
    let dir = workspace::home_dir()?.join("samples");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create samples dir: {e}"))?;
    Ok(dir)
}

fn index_path() -> Result<PathBuf, String> {
    Ok(samples_root()?.join("samples.json"))
}

fn load_index() -> Result<Vec<Sample>, String> {
    let path = index_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("failed to read samples.json: {e}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|e| format!("failed to parse samples.json: {e}"))
}

fn save_index(samples: &[Sample]) -> Result<(), String> {
    let path = index_path()?;
    let json = serde_json::to_string_pretty(samples)
        .map_err(|e| format!("failed to serialize samples.json: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("failed to write samples.json: {e}"))
}

/// Total size (bytes) of everything under the samples dir.
pub fn samples_dir_size() -> Result<u64, String> {
    let root = samples_root()?;
    library::dir_size(&root)
}

/// Sanitizes a name/title for use as a path component: keeps alnum, space,
/// dash, underscore, parens; replaces everything else with `_`; collapses
/// surrounding whitespace; falls back to `sample`/`song` if empty.
pub(crate) fn sanitize_component(name: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.trim().chars() {
        if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '(' || c == ')' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim().to_string();
    if trimmed.is_empty() || !trimmed.chars().any(|c| c.is_alphanumeric()) {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn format_mmss(sec: f64) -> String {
    let sec = sec.max(0.0);
    let total = sec.round() as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// Resolves the source wav path for `(track_id, stem_key)`: band stem keys
/// live at `stems/0N_<key>.wav`, `"loop"` is `loop.wav`, `"source"` is
/// `source.wav`, and anything else is assumed to be an instrument key at
/// `instruments/<key>.wav`.
pub fn resolve_stem_path(track_id: &str, stem_key: &str) -> Result<(PathBuf, String, String), String> {
    let dir = workspace::work_dir(track_id)?;

    if stem_key == "loop" {
        let path = dir.join("loop.wav");
        return Ok((path, "Loop".to_string(), "loop".to_string()));
    }

    if stem_key == "source" {
        let path = dir.join("source.wav");
        return Ok((path, "Source".to_string(), "source".to_string()));
    }

    if let Some(pos) = dsp_filters::STEM_KEYS.iter().position(|k| *k == stem_key) {
        let index = pos + 1;
        let path = dir.join("stems").join(format!("{index:02}_{stem_key}.wav"));
        return Ok((path, dsp_filters::STEM_LABELS[pos].to_string(), "band".to_string()));
    }

    let path = dir.join("instruments").join(format!("{stem_key}.wav"));
    let instruments = dir.join("instruments.json");
    let (label, group) = std::fs::read_to_string(&instruments)
        .ok()
        .and_then(|text| serde_json::from_str::<super::engine::InstrumentsManifest>(&text).ok())
        .and_then(|m| m.stems.into_iter().find(|s| s.key == stem_key))
        .map(|s| (s.label, s.group))
        .unwrap_or_else(|| (stem_key.to_string(), "instrument".to_string()));
    Ok((path, label, group))
}

/// Short random hex id, derived from the path + current time (std only, no
/// external RNG crate).
fn generate_id(seed_path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    seed_path.to_string_lossy().hash(&mut hasher);
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos().hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    format!("{:016x}", hasher.finish())[..12].to_string()
}

/// Picks a filename (without directory) that doesn't collide with existing
/// files in `dir`, appending ` (2)`, ` (3)`, ... before the extension.
pub(crate) fn unique_filename(dir: &Path, base: &str, ext: &str) -> String {
    let mut candidate = format!("{base}.{ext}");
    let mut n = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{base} ({n}).{ext}");
        n += 1;
    }
    candidate
}

/// The short key label like `"Gm"` (minor) or `"F"` (major) — contract v6
/// addendum "Key detection and naming".
fn key_short(key: &analysis::KeyEstimate) -> String {
    if key.mode == "minor" {
        format!("{}m", key.tonic)
    } else {
        key.tonic.clone()
    }
}

/// Best-effort song-level analysis for naming purposes: prefers the cached
/// whole-song analysis (`analysis/source.json`), falling back to the loop
/// analysis in `state.json` for tracks that predate the whole-song split.
fn analysis_for_naming(track_id: &str) -> Option<analysis::LoopAnalysis> {
    cuts::source_analysis(track_id).ok().or_else(|| library::load_state(track_id).analysis)
}

/// Assembles the default sample name: `"<song> - <stem label> - <bpm>bpm -
/// <keyShort> - <n>bars"`, omitting any part that's unknown/unavailable
/// (contract v6 addendum "Key detection and naming").
fn build_default_name(song: &str, stem_label: &str, bpm: Option<f64>, key_short: Option<&str>, bars: Option<u32>) -> String {
    let mut parts = vec![song.to_string(), stem_label.to_string()];
    if let Some(b) = bpm.filter(|b| *b > 0.0) {
        parts.push(format!("{}bpm", (b.round() as i64)));
    }
    if let Some(k) = key_short.filter(|k| !k.is_empty()) {
        parts.push(k.to_string());
    }
    if let Some(n) = bars {
        parts.push(format!("{n}bars"));
    }
    parts.join(" - ")
}

/// Copies `src` into the song's samples dir as a uniquely-named `sample_name`
/// wav, returning `(dest_path, bytes, peaks)`.
pub(crate) fn copy_into_samples_dir(track_title: &str, sample_name: &str, src: &Path) -> Result<(PathBuf, u64, Vec<f32>), String> {
    let song_dir_name = sanitize_component(track_title, "song");
    let song_dir = samples_root()?.join(&song_dir_name);
    std::fs::create_dir_all(&song_dir).map_err(|e| format!("failed to create song samples dir: {e}"))?;

    let file_base = sanitize_component(sample_name, "sample");
    let filename = unique_filename(&song_dir, &file_base, "wav");
    let dest_path = song_dir.join(&filename);

    std::fs::copy(src, &dest_path).map_err(|e| format!("failed to copy sample wav: {e}"))?;
    let bytes = std::fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);
    let sample_peaks = super::peaks::compute_peaks_for_path(&dest_path).unwrap_or_default();
    Ok((dest_path, bytes, sample_peaks))
}

/// One resolved save: everything that differs between the whole-stem and
/// region-cut paths of `save_sample`.
struct ResolvedSave {
    kind: String,
    start_sec: f64,
    end_sec: f64,
    bars: Option<u32>,
    dest_path: PathBuf,
    bytes: u64,
    peaks: Vec<f32>,
    stem_label: String,
    group: String,
    name: String,
}

/// Saves a copy of `(track_id, stem_key)`'s wav as a named sample. With
/// `region`, cuts that range via `cut_region` (`kind: "region"`); otherwise
/// copies the whole stem using the track's loop range, if any (`kind:
/// "stem"`). `name` defaults per the contract's naming rule, omitting any
/// part (bpm/key/bars) that isn't known.
pub fn save_sample(track_id: &str, stem_key: &str, name: Option<&str>, region: Option<RegionParams>) -> Result<Sample, String> {
    let track = library::read_track(track_id)?
        .ok_or_else(|| format!("track '{track_id}' not found; call fetch_audio first"))?;
    let state = library::load_state(track_id);

    let naming_analysis = analysis_for_naming(track_id);
    let bpm = naming_analysis.as_ref().map(|a| a.bpm);
    let key_short_str = naming_analysis.as_ref().and_then(|a| a.key.as_ref()).map(key_short);

    let resolved = if let Some(region) = region {
        let snap = region.snap.as_deref().unwrap_or("none");
        let fade_ms = region.fade_ms.unwrap_or(5.0);
        let trim = region.trim_leading_silence.unwrap_or(false);
        let cut = cuts::cut_region(track_id, stem_key, region.start_sec, region.end_sec, snap, fade_ms, trim)?;
        let (_, stem_label, group) = resolve_stem_path(track_id, stem_key)?;

        let sample_name = name
            .filter(|n| !n.trim().is_empty())
            .map(|n| n.to_string())
            .unwrap_or_else(|| build_default_name(&track.title, &stem_label, bpm, key_short_str.as_deref(), cut.bars));

        let (dest_path, bytes, peaks) = copy_into_samples_dir(&track.title, &sample_name, Path::new(&cut.path))?;
        // Remove the intermediate cuts/ file now that it's copied into the samples dir.
        let _ = std::fs::remove_file(&cut.path);

        ResolvedSave {
            kind: "region".to_string(),
            start_sec: cut.start_sec,
            end_sec: cut.end_sec,
            bars: cut.bars,
            dest_path,
            bytes,
            peaks,
            stem_label,
            group,
            name: sample_name,
        }
    } else {
        let (source_path, stem_label, group) = resolve_stem_path(track_id, stem_key)?;
        if !source_path.exists() {
            return Err(format!("sample source not found: {}", source_path.display()));
        }

        let (start_sec, end_sec) = match &state.loop_info {
            Some(l) => (l.start_sec, l.end_sec),
            // Never trimmed: the stem covers the whole song.
            None => (0.0, track.duration_sec),
        };

        let sample_name = name
            .filter(|n| !n.trim().is_empty())
            .map(|n| n.to_string())
            .unwrap_or_else(|| {
                format!(
                    "{} - {} {}-{}",
                    track.title,
                    stem_label,
                    format_mmss(start_sec),
                    format_mmss(end_sec)
                )
            });

        let (dest_path, bytes, peaks) = copy_into_samples_dir(&track.title, &sample_name, &source_path)?;
        ResolvedSave {
            kind: "stem".to_string(),
            start_sec,
            end_sec,
            bars: None,
            dest_path,
            bytes,
            peaks,
            stem_label,
            group,
            name: sample_name,
        }
    };

    let duration_sec = (resolved.end_sec - resolved.start_sec).max(0.0);
    let sample = Sample {
        id: generate_id(&resolved.dest_path),
        name: resolved.name,
        path: resolved.dest_path.to_string_lossy().to_string(),
        bytes: resolved.bytes,
        song_id: track_id.to_string(),
        song_title: track.title,
        stem_key: stem_key.to_string(),
        stem_label: resolved.stem_label,
        group: resolved.group,
        start_sec: resolved.start_sec,
        end_sec: resolved.end_sec,
        duration_sec,
        bpm,
        created_at: library::now_rfc3339(),
        peaks: resolved.peaks,
        kind: resolved.kind,
        key_short: key_short_str,
        bars: resolved.bars,
    };

    let mut index = load_index()?;
    index.push(sample.clone());
    save_index(&index)?;

    Ok(sample)
}

/// `slice_hits` (contract v6 addendum "One-shots"): writes one wav per onset
/// of `(track_id, stem_key)`'s analysis (from onset to `min(next onset, onset
/// + 1.0s)`, respecting `min_gap_ms` to merge/skip transients too close
/// together, capped at `max_hits`), with 5ms fades and leading-silence trim,
/// into `~/.absolutesample/samples/<song>/<stem label> hits/NN.wav`,
/// registering each as a `kind: "hit"` Sample.
pub fn slice_hits(track_id: &str, stem_key: &str, min_gap_ms: Option<f64>, max_hits: Option<u32>) -> Result<Vec<Sample>, String> {
    let track = library::read_track(track_id)?
        .ok_or_else(|| format!("track '{track_id}' not found; call fetch_audio first"))?;
    let (stem_path, stem_label, group) = resolve_stem_path(track_id, stem_key)?;
    if !stem_path.exists() {
        return Err(format!("sample source not found: {}", stem_path.display()));
    }

    let stem_analysis = analysis::analyze_file(&stem_path)?;
    let probe = super::downloader::probe(&stem_path)?;
    let duration_sec = probe.duration_sec;

    let min_gap_sec = min_gap_ms.unwrap_or(60.0) / 1000.0;
    let max_hits = max_hits.unwrap_or(64).max(0) as usize;

    // Merge/skip transients closer together than `min_gap_sec`.
    let mut onsets: Vec<f64> = Vec::new();
    for &t in &stem_analysis.transients {
        if let Some(&last) = onsets.last() {
            if t - last < min_gap_sec {
                continue;
            }
        }
        onsets.push(t);
    }
    onsets.truncate(max_hits);

    if onsets.is_empty() {
        return Ok(Vec::new());
    }

    let song_dir_name = sanitize_component(&track.title, "song");
    let hits_dir_name = sanitize_component(&format!("{stem_label} hits"), "hits");
    let hits_dir = samples_root()?.join(&song_dir_name).join(&hits_dir_name);
    std::fs::create_dir_all(&hits_dir).map_err(|e| format!("failed to create hits dir: {e}"))?;

    let naming_analysis = analysis_for_naming(track_id);
    let bpm = naming_analysis.as_ref().map(|a| a.bpm);
    let key_short_str = naming_analysis.as_ref().and_then(|a| a.key.as_ref()).map(key_short);

    let mut out = Vec::with_capacity(onsets.len());
    let mut index = load_index()?;

    for (i, &onset) in onsets.iter().enumerate() {
        let next = onsets.get(i + 1).copied().unwrap_or(duration_sec);
        let end = next.min(onset + 1.0).min(duration_sec);
        if end <= onset {
            continue;
        }

        let out_path = hits_dir.join(format!("{:02}.wav", i + 1));
        cuts::ffmpeg_cut(&stem_path, &out_path, onset, end, 5.0, true)?;
        let bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        let peaks = super::peaks::compute_peaks_for_path(&out_path).unwrap_or_default();

        let sample = Sample {
            id: generate_id(&out_path),
            name: format!("{} - {} hit {:02}", track.title, stem_label, i + 1),
            path: out_path.to_string_lossy().to_string(),
            bytes,
            song_id: track_id.to_string(),
            song_title: track.title.clone(),
            stem_key: stem_key.to_string(),
            stem_label: stem_label.clone(),
            group: group.clone(),
            start_sec: onset,
            end_sec: end,
            duration_sec: end - onset,
            bpm,
            created_at: library::now_rfc3339(),
            peaks,
            kind: "hit".to_string(),
            key_short: key_short_str.clone(),
            bars: None,
        };

        index.push(sample.clone());
        out.push(sample);
    }

    save_index(&index)?;
    Ok(out)
}

/// Lists every saved sample, most recently created first. Lazily backfills
/// `peaks` for samples saved before that field existed, re-saving the index
/// if anything changed.
pub fn list() -> Result<Vec<Sample>, String> {
    let mut index = load_index()?;
    let mut dirty = false;
    for sample in index.iter_mut() {
        if sample.peaks.is_empty() {
            let path = PathBuf::from(&sample.path);
            if path.exists() {
                if let Ok(p) = super::peaks::compute_peaks_for_path(&path) {
                    sample.peaks = p;
                    dirty = true;
                }
            }
        }
    }
    if dirty {
        save_index(&index)?;
    }
    index.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(index)
}

/// Renames a sample (both its display name and its file on disk).
pub fn rename(id: &str, new_name: &str) -> Result<Sample, String> {
    let mut index = load_index()?;
    let pos = index.iter().position(|s| s.id == id).ok_or_else(|| format!("sample '{id}' not found"))?;

    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("sample name cannot be empty".to_string());
    }

    let old_path = PathBuf::from(&index[pos].path);
    let dir = old_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    let file_base = sanitize_component(new_name, "sample");
    let filename = if old_path.file_stem().and_then(|s| s.to_str()) == Some(file_base.as_str()) {
        old_path.file_name().and_then(|n| n.to_str()).unwrap_or("sample.wav").to_string()
    } else {
        unique_filename(&dir, &file_base, "wav")
    };
    let new_path = dir.join(&filename);

    if new_path != old_path {
        std::fs::rename(&old_path, &new_path).map_err(|e| format!("failed to rename sample file: {e}"))?;
    }

    index[pos].name = new_name.to_string();
    index[pos].path = new_path.to_string_lossy().to_string();
    let updated = index[pos].clone();
    save_index(&index)?;
    Ok(updated)
}

/// Deletes a sample: removes its wav file and its index entry.
pub fn delete(id: &str) -> Result<(), String> {
    let mut index = load_index()?;
    let pos = index.iter().position(|s| s.id == id).ok_or_else(|| format!("sample '{id}' not found"))?;
    let path = PathBuf::from(&index[pos].path);
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    index.remove(pos);
    save_index(&index)?;
    Ok(())
}

/// Removes a sample's index entry without touching its wav file, returning
/// the removed record. Used by `trash::delete_sample`, which handles moving
/// the file itself.
pub fn remove_index_entry(id: &str) -> Result<Sample, String> {
    let mut index = load_index()?;
    let pos = index.iter().position(|s| s.id == id).ok_or_else(|| format!("sample '{id}' not found"))?;
    let sample = index.remove(pos);
    save_index(&index)?;
    Ok(sample)
}

/// Re-adds a sample record to the index (e.g. restoring from trash), without
/// touching its wav file.
pub fn reinsert(sample: Sample) -> Result<(), String> {
    let mut index = load_index()?;
    index.push(sample);
    save_index(&index)
}

/// Copies the given sample ids' wav files into `dest_dir`, returning the
/// resulting destination paths.
pub fn export(ids: &[String], dest_dir: &Path) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| format!("failed to create export dir: {e}"))?;
    let index = load_index()?;
    let mut out = Vec::new();
    for id in ids {
        let sample = index.iter().find(|s| &s.id == id).ok_or_else(|| format!("sample '{id}' not found"))?;
        let src = PathBuf::from(&sample.path);
        let filename = src.file_name().ok_or_else(|| format!("sample '{id}' has no filename"))?;
        let dest = dest_dir.join(filename);
        let dest = if dest.exists() {
            let base = src.file_stem().and_then(|s| s.to_str()).unwrap_or("sample");
            dest_dir.join(unique_filename(dest_dir, base, "wav"))
        } else {
            dest
        };
        std::fs::copy(&src, &dest).map_err(|e| format!("failed to export sample '{id}': {e}"))?;
        out.push(dest.to_string_lossy().to_string());
    }
    Ok(out)
}

/// Returns the sample's file path, for the caller to reveal in a file
/// explorer.
pub fn path_for_reveal(id: &str) -> Result<PathBuf, String> {
    let index = load_index()?;
    let sample = index.iter().find(|s| s.id == id).ok_or_else(|| format!("sample '{id}' not found"))?;
    Ok(PathBuf::from(&sample.path))
}

/// Looks up a saved sample by id.
pub fn find(id: &str) -> Result<Sample, String> {
    let index = load_index()?;
    index.into_iter().find(|s| s.id == id).ok_or_else(|| format!("sample '{id}' not found"))
}

/// `save_sample_part` (highlight-a-saved-sample addendum): cuts `[start_sec,
/// end_sec]` out of an already-saved sample's wav (via `cuts::cut_sample`)
/// and registers the result as a new `kind: "region"` sample, inheriting the
/// source sample's song/stem/bpm/key (`bars` is always `None`, since this
/// isn't grid-snapped).
pub fn save_sample_part(id: &str, start_sec: f64, end_sec: f64, name: Option<&str>) -> Result<Sample, String> {
    let source = find(id)?;
    let cut = cuts::cut_sample(id, start_sec, end_sec, 5.0)?;

    let sample_name = name
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.to_string())
        .unwrap_or_else(|| format!("{} {}-{}", source.name, format_mmss(cut.start_sec), format_mmss(cut.end_sec)));

    let (dest_path, bytes, peaks) = copy_into_samples_dir(&source.song_title, &sample_name, Path::new(&cut.path))?;
    // Remove the intermediate _cuts/ file now that it's copied into the samples dir.
    let _ = std::fs::remove_file(&cut.path);

    let duration_sec = (cut.end_sec - cut.start_sec).max(0.0);
    let sample = Sample {
        id: generate_id(&dest_path),
        name: sample_name,
        path: dest_path.to_string_lossy().to_string(),
        bytes,
        song_id: source.song_id,
        song_title: source.song_title,
        stem_key: source.stem_key,
        stem_label: source.stem_label,
        group: source.group,
        start_sec: cut.start_sec,
        end_sec: cut.end_sec,
        duration_sec,
        bpm: source.bpm,
        created_at: library::now_rfc3339(),
        peaks,
        kind: "region".to_string(),
        key_short: source.key_short,
        bars: None,
    };

    let mut index = load_index()?;
    index.push(sample.clone());
    save_index(&index)?;
    Ok(sample)
}

#[cfg(test)]
mod tests {
    use super::*;

        fn temp_dir(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("absolutesample_samples_test_{name}_{:?}", std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitize_component_replaces_unsafe_chars() {
        assert_eq!(sanitize_component("Kick / Snare: 1:23-1:45", "sample"), "Kick _ Snare_ 1_23-1_45");
    }

    #[test]
    fn sanitize_component_falls_back_when_empty() {
        assert_eq!(sanitize_component("   ", "sample"), "sample");
        assert_eq!(sanitize_component("///", "sample"), "sample");
    }

    #[test]
    fn format_mmss_pads_seconds() {
        assert_eq!(format_mmss(65.4), "1:05");
        assert_eq!(format_mmss(0.0), "0:00");
    }

    #[test]
    fn unique_filename_appends_suffix_on_collision() {
        let dir = temp_dir("unique_filename");
        std::fs::write(dir.join("kick.wav"), b"a").unwrap();
        std::fs::write(dir.join("kick (2).wav"), b"b").unwrap();
        assert_eq!(unique_filename(&dir, "kick", "wav"), "kick (3).wav");
        assert_eq!(unique_filename(&dir, "snare", "wav"), "snare.wav");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn samples_json_round_trips() {
        let _guard = workspace::ENV_TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_dir("index_roundtrip");
        std::env::set_var("ABSOLUTESAMPLE_HOME", &root);

        let sample = Sample {
            id: "abc123".to_string(),
            name: "Kick 0:00-0:02".to_string(),
            path: root.join("samples/Song/Kick.wav").to_string_lossy().to_string(),
            bytes: 1234,
            song_id: "song1".to_string(),
            song_title: "Song".to_string(),
            stem_key: "kick".to_string(),
            stem_label: "Kick".to_string(),
            group: "drums".to_string(),
            start_sec: 0.0,
            end_sec: 2.0,
            duration_sec: 2.0,
            bpm: Some(120.0),
            created_at: library::now_rfc3339(),
            peaks: vec![0.5, 1.0],
            kind: "stem".to_string(),
            key_short: Some("Gm".to_string()),
            bars: Some(4),
        };
        save_index(&[sample.clone()]).unwrap();
        let loaded = load_index().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "abc123");
        assert_eq!(loaded[0].bpm, Some(120.0));

        std::env::remove_var("ABSOLUTESAMPLE_HOME");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn generate_id_produces_hex_string() {
        let id = generate_id(Path::new("/tmp/foo.wav"));
        assert_eq!(id.len(), 12);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn key_short_appends_m_for_minor_not_major() {
        let minor = analysis::KeyEstimate { tonic: "G".to_string(), mode: "minor".to_string(), confidence: 1.0, camelot: "6A".to_string() };
        let major = analysis::KeyEstimate { tonic: "F".to_string(), mode: "major".to_string(), confidence: 1.0, camelot: "7B".to_string() };
        assert_eq!(key_short(&minor), "Gm");
        assert_eq!(key_short(&major), "F");
    }

    #[test]
    fn default_name_includes_all_known_parts() {
        let name = build_default_name("Song", "Kick", Some(128.0), Some("Gm"), Some(8));
        assert_eq!(name, "Song - Kick - 128bpm - Gm - 8bars");
    }

    #[test]
    fn default_name_omits_bpm_when_unknown() {
        let name = build_default_name("Song", "Kick", None, Some("Gm"), Some(8));
        assert_eq!(name, "Song - Kick - Gm - 8bars");
    }

    #[test]
    fn default_name_omits_key_when_unknown() {
        let name = build_default_name("Song", "Kick", Some(128.0), None, Some(8));
        assert_eq!(name, "Song - Kick - 128bpm - 8bars");
    }

    #[test]
    fn default_name_omits_bars_when_not_grid_snapped() {
        let name = build_default_name("Song", "Kick", Some(128.0), Some("Gm"), None);
        assert_eq!(name, "Song - Kick - 128bpm - Gm");
    }

    #[test]
    fn default_name_with_nothing_known_is_just_song_and_stem() {
        let name = build_default_name("Song", "Kick", None, None, None);
        assert_eq!(name, "Song - Kick");
    }
}
