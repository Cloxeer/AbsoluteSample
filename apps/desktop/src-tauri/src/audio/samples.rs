//! Sample library (contract v4 addendum): saved clips copied out of a
//! track's stem/instrument/loop wavs into
//! `~/.absolutesample/samples/<sanitized song title>/<sanitized name>.wav`,
//! indexed in `~/.absolutesample/samples/samples.json`.

use super::{dsp_filters, library, workspace};
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
fn sanitize_component(name: &str, fallback: &str) -> String {
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
/// live at `stems/0N_<key>.wav`, `"loop"` is `loop.wav`, and anything else
/// is assumed to be an instrument key at `instruments/<key>.wav`.
fn resolve_stem_path(track_id: &str, stem_key: &str) -> Result<(PathBuf, String, String), String> {
    let dir = workspace::work_dir(track_id)?;

    if stem_key == "loop" {
        let path = dir.join("loop.wav");
        return Ok((path, "Loop".to_string(), "loop".to_string()));
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
fn unique_filename(dir: &Path, base: &str, ext: &str) -> String {
    let mut candidate = format!("{base}.{ext}");
    let mut n = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{base} ({n}).{ext}");
        n += 1;
    }
    candidate
}

/// Saves a copy of `(track_id, stem_key)`'s wav as a named sample, using the
/// track's loop range (if any) and cached analysis bpm from `state.json`.
/// `name` defaults to `"<song title> - <stem label> <m:ss>-<m:ss>"`.
pub fn save_sample(track_id: &str, stem_key: &str, name: Option<&str>) -> Result<Sample, String> {
    let track = library::read_track(track_id)?
        .ok_or_else(|| format!("track '{track_id}' not found; call fetch_audio first"))?;
    let state = library::load_state(track_id);

    let (source_path, stem_label, group) = resolve_stem_path(track_id, stem_key)?;
    if !source_path.exists() {
        return Err(format!("sample source not found: {}", source_path.display()));
    }

    let (start_sec, end_sec) = match &state.loop_info {
        Some(l) => (l.start_sec, l.end_sec),
        // Never trimmed: the stem covers the whole song.
        None => (0.0, track.duration_sec),
    };
    let duration_sec = (end_sec - start_sec).max(0.0);
    let bpm = state.analysis.as_ref().map(|a| a.bpm);

    let default_name = format!(
        "{} - {} {}-{}",
        track.title,
        stem_label,
        format_mmss(start_sec),
        format_mmss(end_sec)
    );
    let sample_name = name.filter(|n| !n.trim().is_empty()).unwrap_or(&default_name).trim().to_string();

    let song_dir_name = sanitize_component(&track.title, "song");
    let song_dir = samples_root()?.join(&song_dir_name);
    std::fs::create_dir_all(&song_dir).map_err(|e| format!("failed to create song samples dir: {e}"))?;

    let file_base = sanitize_component(&sample_name, "sample");
    let filename = unique_filename(&song_dir, &file_base, "wav");
    let dest_path = song_dir.join(&filename);

    std::fs::copy(&source_path, &dest_path).map_err(|e| format!("failed to copy sample wav: {e}"))?;
    let bytes = std::fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);
    let sample_peaks = super::peaks::compute_peaks_for_path(&dest_path).unwrap_or_default();

    let sample = Sample {
        id: generate_id(&dest_path),
        name: sample_name,
        path: dest_path.to_string_lossy().to_string(),
        bytes,
        song_id: track_id.to_string(),
        song_title: track.title,
        stem_key: stem_key.to_string(),
        stem_label,
        group,
        start_sec,
        end_sec,
        duration_sec,
        bpm,
        created_at: library::now_rfc3339(),
        peaks: sample_peaks,
    };

    let mut index = load_index()?;
    index.push(sample.clone());
    save_index(&index)?;

    Ok(sample)
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
}
