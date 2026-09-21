//! Song library (contract v3 addendum): per-track `track.json` / `state.json`
//! persistence, listing/opening/keeping/deleting tracks, directory-size
//! accounting, and YouTube URL normalization.

use super::engine::InstrumentStem;
use super::{analysis, dsp_filters, workspace};
use crate::pipeline::{LoopManifest, StemManifest, TrackManifest};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------
// Timestamps (RFC3339, UTC, via std only)
// ---------------------------------------------------------------------

/// Converts days-since-unix-epoch to a proleptic Gregorian (y, m, d) triple.
/// Howard Hinnant's `civil_from_days` algorithm; UTC, no leap seconds.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Formats a `SystemTime` as RFC3339 UTC, e.g. `2026-09-20T12:34:56Z`.
pub fn format_rfc3339(t: SystemTime) -> String {
    let dur = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs();
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}Z")
}

/// The current time as RFC3339 UTC.
pub fn now_rfc3339() -> String {
    format_rfc3339(SystemTime::now())
}

// ---------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateFile {
    #[serde(default)]
    pub kept: bool,
    #[serde(default = "now_rfc3339")]
    pub fetched_at: String,
    #[serde(default = "now_rfc3339")]
    pub last_opened_at: String,
    #[serde(rename = "loop", default, skip_serializing_if = "Option::is_none")]
    pub loop_info: Option<LoopManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis: Option<analysis::LoopAnalysis>,
    /// Cache of ffmpeg astats results for `stems/*.wav`, keyed by filename
    /// (e.g. `"01_drums_sub.wav"`), so `open()` doesn't re-run astats on
    /// every open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub band_stats: Option<HashMap<String, dsp_filters::StemLoudness>>,
    /// `"song"` when the last `separate_instruments` ran over the whole
    /// `source.wav` (contract v6 addendum "Split the whole song once"),
    /// `"loop"` for older loop-scoped splits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruments_scope: Option<String>,
}

impl Default for StateFile {
    fn default() -> Self {
        let now = now_rfc3339();
        StateFile {
            kept: false,
            fetched_at: now.clone(),
            last_opened_at: now,
            loop_info: None,
            analysis: None,
            band_stats: None,
            instruments_scope: None,
        }
    }
}

fn track_json_path(dir: &Path) -> PathBuf {
    dir.join("track.json")
}

fn state_json_path(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

/// Writes `track.json` for `track_id`.
pub fn write_track(track_id: &str, track: &TrackManifest) -> Result<(), String> {
    let dir = workspace::work_dir(track_id)?;
    let json = serde_json::to_string_pretty(track)
        .map_err(|e| format!("failed to serialize track.json: {e}"))?;
    std::fs::write(track_json_path(&dir), json).map_err(|e| format!("failed to write track.json: {e}"))
}

/// Reads `track.json` for `track_id`, if present.
pub fn read_track(track_id: &str) -> Result<Option<TrackManifest>, String> {
    let dir = workspace::work_dir(track_id)?;
    read_track_at(&dir)
}

fn read_track_at(dir: &Path) -> Result<Option<TrackManifest>, String> {
    let path = track_json_path(dir);
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("failed to read track.json: {e}"))?;
    let track: TrackManifest =
        serde_json::from_str(&text).map_err(|e| format!("failed to parse track.json: {e}"))?;
    Ok(Some(track))
}

/// Loads `state.json` for `track_id`, or a fresh default if missing/corrupt.
pub fn load_state(track_id: &str) -> StateFile {
    (|| -> Result<StateFile, String> {
        let dir = workspace::work_dir(track_id)?;
        load_state_at(&dir)
    })()
    .unwrap_or_default()
}

fn load_state_at(dir: &Path) -> Result<StateFile, String> {
    let path = state_json_path(dir);
    if !path.exists() {
        return Ok(StateFile::default());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("failed to read state.json: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("failed to parse state.json: {e}"))
}

/// Writes `state.json` for `track_id`.
pub fn write_state(track_id: &str, state: &StateFile) -> Result<(), String> {
    let dir = workspace::work_dir(track_id)?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("failed to serialize state.json: {e}"))?;
    std::fs::write(state_json_path(&dir), json).map_err(|e| format!("failed to write state.json: {e}"))
}

/// Sets `kept = true` for `track_id`, leaving the rest of `state.json` intact.
/// Used by the split (`separate_stems`/`separate_instruments`) and save
/// (`save_stem`/`save_all_stems`) paths per the "keep rule" in the contract.
pub fn mark_kept(track_id: &str) -> Result<(), String> {
    let mut state = load_state(track_id);
    if !state.kept {
        state.kept = true;
        write_state(track_id, &state)?;
    }
    Ok(())
}

/// Attempts to recover a track id from an absolute path somewhere under
/// `<home>/work/<id>/...` (e.g. a stem or destination path passed to
/// `save_stem`). Returns `None` if `path` isn't under a work dir.
pub fn track_id_from_path(path: &Path) -> Option<String> {
    let work_root = workspace::work_root().ok()?;
    let rel = path.strip_prefix(&work_root).ok()?;
    rel.components().next().map(|c| c.as_os_str().to_string_lossy().to_string())
}

// ---------------------------------------------------------------------
// LibraryEntry / TrackSession
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    pub duration_sec: f64,
    pub fetched_at: String,
    pub last_opened_at: String,
    pub kept: bool,
    pub has_loop: bool,
    pub loop_start_sec: Option<f64>,
    pub loop_end_sec: Option<f64>,
    pub has_bands: bool,
    pub has_instruments: bool,
    pub instrument_count: u32,
    pub bytes: u64,
    #[serde(default)]
    pub source_kind: crate::pipeline::SourceKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSession {
    pub track: TrackManifest,
    #[serde(rename = "loop")]
    pub loop_info: Option<LoopManifest>,
    pub stems: Option<Vec<StemManifest>>,
    pub instruments: Option<Vec<InstrumentStem>>,
    /// Separate from `instruments` per the v5 addendum's timing/device/
    /// failed-passes metadata (see the note in `docs/CONTRACT.md`).
    pub instruments_meta: Option<super::engine::InstrumentsMeta>,
    pub analysis: Option<analysis::LoopAnalysis>,
}

fn has_band_stem_files(dir: &Path) -> bool {
    let stems_dir = dir.join("stems");
    match std::fs::read_dir(&stems_dir) {
        Ok(entries) => entries.filter_map(|e| e.ok()).any(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.ends_with(".wav") && name.chars().next().is_some_and(|c| c.is_ascii_digit())
        }),
        Err(_) => false,
    }
}

/// Reads `instruments.json`, lazily backfilling `peaks`/`durationSec` for
/// any stem saved before those fields existed (and re-saving the manifest
/// if anything changed).
fn instruments_manifest_at(dir: &Path) -> Option<super::engine::InstrumentsManifest> {
    let path = dir.join("instruments.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let mut manifest: super::engine::InstrumentsManifest = serde_json::from_str(&text).ok()?;

    let mut dirty = false;
    for stem in manifest.stems.iter_mut() {
        if stem.peaks.is_empty() {
            let stem_path = PathBuf::from(&stem.path);
            if stem_path.exists() {
                if let Ok(p) = super::peaks::compute_peaks_for_path(&stem_path) {
                    stem.peaks = p;
                    dirty = true;
                }
                if stem.duration_sec <= 0.0 {
                    stem.duration_sec = super::downloader::probe(&stem_path).map(|p| p.duration_sec).unwrap_or(0.0);
                    dirty = true;
                }
            }
        }
    }
    if dirty {
        if let Ok(json) = serde_json::to_string_pretty(&manifest) {
            let _ = std::fs::write(&path, json);
        }
    }

    Some(manifest)
}

fn dir_entry_to_library_entry(id: &str, dir: &Path) -> Result<Option<LibraryEntry>, String> {
    let track = match read_track_at(dir)? {
        Some(t) => t,
        None => return Ok(None),
    };
    let state = load_state_at(dir)?;
    let bytes = dir_size(dir)?;
    let has_bands = has_band_stem_files(dir);
    let instruments = instruments_manifest_at(dir);
    let has_instruments = instruments.as_ref().is_some_and(|m| !m.stems.is_empty());
    let instrument_count = instruments.map(|m| m.stems.len() as u32).unwrap_or(0);

    Ok(Some(LibraryEntry {
        id: id.to_string(),
        title: track.title,
        url: track.url,
        duration_sec: track.duration_sec,
        fetched_at: state.fetched_at,
        last_opened_at: state.last_opened_at,
        // `kept` is purely the stored flag (v4): nothing implicitly keeps a
        // song anymore. See `prune_unkept` for the actual retention rule.
        kept: state.kept,
        has_loop: state.loop_info.is_some(),
        loop_start_sec: state.loop_info.as_ref().map(|l| l.start_sec),
        loop_end_sec: state.loop_info.as_ref().map(|l| l.end_sec),
        has_bands,
        has_instruments,
        instrument_count,
        bytes,
        source_kind: track.source_kind,
    }))
}

/// Lists every fetched track, sorted by `lastOpenedAt` descending.
pub fn list() -> Result<Vec<LibraryEntry>, String> {
    let root = workspace::work_root()?;
    let mut entries = Vec::new();
    if !root.exists() {
        return Ok(entries);
    }
    for entry in std::fs::read_dir(&root).map_err(|e| format!("failed to read work root: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read work root entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if let Some(lib_entry) = dir_entry_to_library_entry(&id, &path)? {
            entries.push(lib_entry);
        }
    }
    entries.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    Ok(entries)
}

/// Parses a band-stem filename like `01_drums_sub.wav` into
/// `(index, key)`, or `None` if it doesn't match the expected shape.
fn parse_band_stem_filename(name: &str) -> Option<(u32, String)> {
    let stem = name.strip_suffix(".wav")?;
    let (idx_str, key) = stem.split_once('_')?;
    let index: u32 = idx_str.parse().ok()?;
    Some((index, key.to_string()))
}

/// Rebuilds `StemManifest`s from `stems/0*.wav` files, using (and updating)
/// `state.band_stats` as an astats cache so repeat opens don't re-run ffmpeg.
fn rebuild_band_stems(track_id: &str, dir: &Path, state: &mut StateFile) -> Result<Option<Vec<StemManifest>>, String> {
    let stems_dir = dir.join("stems");
    if !stems_dir.exists() {
        return Ok(None);
    }
    let mut files: Vec<(String, PathBuf)> = std::fs::read_dir(&stems_dir)
        .map_err(|e| format!("failed to read stems dir: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("wav"))
        .filter_map(|p| p.file_name().map(|n| (n.to_string_lossy().to_string(), p.clone())))
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));

    if files.is_empty() {
        return Ok(None);
    }

    let mut cache = state.band_stats.clone().unwrap_or_default();
    let mut dirty = false;
    let mut result = Vec::new();

    for (name, path) in files {
        let Some((index, key)) = parse_band_stem_filename(&name) else { continue };
        let cached = cache.get(&name).cloned();
        let needs_recompute = cached.is_none() || cached.as_ref().is_some_and(|l| l.peaks.is_empty());
        let loudness = if needs_recompute {
            let mut l = cached.unwrap_or_else(|| {
                dsp_filters::measure_loudness(&path).unwrap_or(dsp_filters::StemLoudness {
                    peak_db: 0.0,
                    rms_db: 0.0,
                    duration_sec: 0.0,
                    peaks: Vec::new(),
                })
            });
            l.peaks = super::peaks::compute_peaks_for_path(&path).unwrap_or_default();
            if l.duration_sec <= 0.0 {
                l.duration_sec = super::downloader::probe(&path).map(|p| p.duration_sec).unwrap_or(0.0);
            }
            cache.insert(name.clone(), l.clone());
            dirty = true;
            l
        } else {
            cached.unwrap()
        };
        let pos = dsp_filters::STEM_KEYS.iter().position(|k| *k == key.as_str());
        let (label, band) = match pos {
            Some(i) => (dsp_filters::STEM_LABELS[i].to_string(), dsp_filters::STEM_BANDS[i].to_string()),
            None => (key.clone(), String::new()),
        };
        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        result.push(StemManifest {
            index,
            key,
            label,
            band,
            path: path.to_string_lossy().to_string(),
            bytes,
            peak_db: loudness.peak_db,
            rms_db: loudness.rms_db,
            duration_sec: loudness.duration_sec,
            peaks: loudness.peaks,
        });
    }

    result.sort_by_key(|s| s.index);

    if dirty {
        state.band_stats = Some(cache);
        write_state(track_id, state)?;
    }

    Ok(Some(result))
}

/// Opens a track: touches `lastOpenedAt`, rebuilds band `StemInfo[]` (with
/// an astats cache in `state.json`), and reads `instruments.json` if present.
pub fn open(track_id: &str) -> Result<TrackSession, String> {
    let dir = workspace::work_dir(track_id)?;
    let mut track = read_track_at(&dir)?
        .ok_or_else(|| format!("track '{track_id}' not found; call fetch_audio first"))?;

    // Lazily backfill peaks for track.json files that predate them.
    if track.peaks.is_empty() {
        let source = std::fs::read_dir(&dir)
            .ok()
            .and_then(|entries| {
                entries.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| {
                    p.file_stem().and_then(|s| s.to_str()) == Some("source")
                })
            });
        if let Some(src) = source {
            if let Ok(p) = super::peaks::compute_peaks_for_path(&src) {
                track.peaks = p;
                let _ = write_track(track_id, &track);
            }
        }
    }

    let mut state = load_state_at(&dir)?;
    state.last_opened_at = now_rfc3339();

    // Lazily backfill loop.wav peaks for state.json files that predate them.
    if let Some(loop_info) = state.loop_info.as_mut() {
        if loop_info.peaks.is_empty() {
            let wav = std::path::PathBuf::from(&loop_info.wav_path);
            if wav.exists() {
                if let Ok(p) = super::peaks::compute_peaks_for_path(&wav) {
                    loop_info.peaks = p;
                }
            }
        }
    }

    let stems = rebuild_band_stems(track_id, &dir, &mut state)?;
    // rebuild_band_stems already persisted state if it updated band_stats;
    // persist again unconditionally to record the touched lastOpenedAt.
    write_state(track_id, &state)?;

    let manifest = instruments_manifest_at(&dir);
    let instruments = manifest.as_ref().map(|m| m.stems.clone());
    let instruments_meta = manifest.as_ref().map(super::engine::InstrumentsMeta::from);

    Ok(TrackSession {
        track,
        loop_info: state.loop_info.clone(),
        stems,
        instruments,
        instruments_meta,
        analysis: state.analysis.clone(),
    })
}

/// Sets the `kept` flag for `track_id` and returns its updated `LibraryEntry`.
pub fn set_kept(track_id: &str, kept: bool) -> Result<LibraryEntry, String> {
    let mut state = load_state(track_id);
    state.kept = kept;
    write_state(track_id, &state)?;
    let dir = workspace::work_dir(track_id)?;
    dir_entry_to_library_entry(track_id, &dir)?
        .ok_or_else(|| format!("track '{track_id}' not found; call fetch_audio first"))
}

/// Deletes a track's entire work dir.
pub fn delete(track_id: &str) -> Result<(), String> {
    let dir = workspace::work_dir(track_id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("failed to delete track dir: {e}"))?;
    }
    Ok(())
}

/// Recursively sums file sizes under `path` (walkdir-free, std only).
pub fn dir_size(path: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    let entries = match std::fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return Ok(0),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("failed to read dir entry: {e}"))?;
        let meta = entry.metadata().map_err(|e| format!("failed to stat entry: {e}"))?;
        if meta.is_dir() {
            total += dir_size(&entry.path())?;
        } else {
            total += meta.len();
        }
    }
    Ok(total)
}

/// Total size (bytes), track count, and unkept ("scan") track count across
/// the whole library.
pub fn size() -> Result<(u64, usize, usize), String> {
    let root = workspace::work_root()?;
    if !root.exists() {
        return Ok((0, 0, 0));
    }
    let mut bytes = 0u64;
    let mut tracks = 0usize;
    let mut scans = 0usize;
    for entry in std::fs::read_dir(&root).map_err(|e| format!("failed to read work root: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read work root entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            tracks += 1;
            bytes += dir_size(&path)?;
            let state = load_state_at(&path).unwrap_or_default();
            if !state.kept {
                scans += 1;
            }
        }
    }
    Ok((bytes, tracks, scans))
}

/// Maximum number of unkept ("scan") songs retained by `prune_unkept`,
/// beyond the most recently opened.
pub const MAX_SCANS: usize = 3;

/// Deletes unkept ("scan") songs beyond the `MAX_SCANS` most recently opened
/// (sorted by `lastOpenedAt`, falling back to `fetchedAt`), regardless of
/// whether they have split output. Kept songs always survive. Never deletes
/// any id in `except` (e.g. the id currently being fetched, and the
/// currently open track), even if it would otherwise qualify.
pub fn prune_unkept(except: &[&str]) -> Result<(), String> {
    let root = workspace::work_root()?;
    if !root.exists() {
        return Ok(());
    }
    let except_sanitized: Vec<String> =
        except.iter().filter(|s| !s.is_empty()).map(|s| workspace::sanitize_id(s)).collect();

    // Collect all unkept, non-excepted candidates with their sort key.
    let mut candidates: Vec<(String, PathBuf, String)> = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| format!("failed to read work root: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read work root entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if except_sanitized.iter().any(|e| *e == id) {
            continue;
        }

        let state = load_state_at(&path).unwrap_or_default();
        if state.kept {
            continue;
        }

        // Sort key: lastOpenedAt, falling back to fetchedAt (RFC3339 strings
        // sort lexicographically in chronological order).
        let key = if state.last_opened_at.is_empty() { state.fetched_at.clone() } else { state.last_opened_at.clone() };
        candidates.push((id, path, key));
    }

    // Most-recently-opened first; keep the first MAX_SCANS, delete the rest.
    candidates.sort_by(|a, b| b.2.cmp(&a.2));
    for (_, path, _) in candidates.into_iter().skip(MAX_SCANS) {
        let _ = std::fs::remove_dir_all(&path);
    }
    Ok(())
}

// ---------------------------------------------------------------------
// YouTube URL normalization
// ---------------------------------------------------------------------

fn is_valid_video_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        if k == key {
            return Some(v);
        }
    }
    None
}

/// Extracts the 11-char YouTube video id from `youtu.be/<id>`,
/// `youtube.com/watch?v=<id>`, `/shorts/<id>`, or `/embed/<id>` (ignoring
/// `list`/`si`/`start_radio`/`t` query params), returning
/// `(id, canonical_url)`. Returns `None` for non-YouTube (or unrecognized)
/// URLs.
pub fn normalize_youtube_url(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim();
    let without_scheme = match trimmed.split_once("://") {
        Some((_, rest)) => rest,
        None => trimmed,
    };
    let (authority, rest) = match without_scheme.split_once('/') {
        Some((a, r)) => (a, r),
        None => (without_scheme, ""),
    };
    // Strip userinfo (user@host) and port, if present.
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    let host_lc = host.to_lowercase();

    let is_youtu_be = host_lc == "youtu.be" || host_lc.ends_with(".youtu.be");
    let is_youtube = host_lc == "youtube.com" || host_lc.ends_with(".youtube.com");
    if !is_youtu_be && !is_youtube {
        return None;
    }

    let (path, query) = match rest.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (rest, None),
    };
    let path = path.trim_start_matches('/');

    let id = if is_youtu_be {
        path.split('/').next().unwrap_or("").to_string()
    } else {
        let mut segs = path.split('/').filter(|s| !s.is_empty());
        match segs.next().unwrap_or("") {
            "watch" => query.and_then(|q| query_param(q, "v")).unwrap_or("").to_string(),
            "shorts" | "embed" => segs.next().unwrap_or("").to_string(),
            _ => String::new(),
        }
    };

    if !is_valid_video_id(&id) {
        return None;
    }
    let canonical = format!("https://www.youtube.com/watch?v={id}");
    Some((id, canonical))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // `ABSOLUTESAMPLE_HOME` is process-global state; serialize the tests that
    // mutate it so they don't race with each other under the default
    // parallel test runner.
        fn temp_dir(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("absolutesample_library_test_{name}_{:?}", std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn normalize_youtu_be_short_link() {
        let (id, url) = normalize_youtube_url("https://youtu.be/nRKgT3d6xoE").unwrap();
        assert_eq!(id, "nRKgT3d6xoE");
        assert_eq!(url, "https://www.youtube.com/watch?v=nRKgT3d6xoE");
    }

    #[test]
    fn normalize_watch_url_strips_list_and_start_radio() {
        let (id, url) = normalize_youtube_url(
            "https://www.youtube.com/watch?v=ZAz3rnLGthg&list=RDZAz3rnLGthg&start_radio=1",
        )
        .unwrap();
        assert_eq!(id, "ZAz3rnLGthg");
        assert_eq!(url, "https://www.youtube.com/watch?v=ZAz3rnLGthg");
    }

    #[test]
    fn normalize_youtu_be_with_si_param() {
        let (id, url) = normalize_youtube_url("https://youtu.be/XEolg577-DA?si=FcV8hujYzCBkWSoL").unwrap();
        assert_eq!(id, "XEolg577-DA");
        assert_eq!(url, "https://www.youtube.com/watch?v=XEolg577-DA");
    }

    #[test]
    fn normalize_shorts_url() {
        let (id, url) = normalize_youtube_url("https://youtube.com/shorts/abcdefghijk").unwrap();
        assert_eq!(id, "abcdefghijk");
        assert_eq!(url, "https://www.youtube.com/watch?v=abcdefghijk");
    }

    #[test]
    fn normalize_embed_url() {
        let (id, _url) = normalize_youtube_url("https://www.youtube.com/embed/nRKgT3d6xoE").unwrap();
        assert_eq!(id, "nRKgT3d6xoE");
    }

    #[test]
    fn normalize_rejects_non_youtube_url() {
        assert_eq!(normalize_youtube_url("https://example.com/watch?v=nRKgT3d6xoE"), None);
        assert_eq!(normalize_youtube_url("https://vimeo.com/123456789"), None);
    }

    #[test]
    fn rfc3339_format_matches_shape() {
        let s = format_rfc3339(UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000));
        // 2023-11-14T22:13:20Z
        assert_eq!(s, "2023-11-14T22:13:20Z");
    }

    #[test]
    fn state_file_round_trips() {
        let mut state = StateFile::default();
        state.kept = true;
        state.loop_info = Some(LoopManifest {
            track_id: "abc".to_string(),
            start_sec: 1.0,
            end_sec: 2.0,
            duration_sec: 1.0,
            loop_path: "loop.webm".to_string(),
            wav_path: "loop.wav".to_string(),
            peaks: Vec::new(),
        });
        let json = serde_json::to_string(&state).unwrap();
        let parsed: StateFile = serde_json::from_str(&json).unwrap();
        assert!(parsed.kept);
        assert_eq!(parsed.loop_info.unwrap().start_sec, 1.0);
    }

    /// Writes a minimal `track.json` for `id`, creating its work dir.
    fn make_track(id: &str) -> PathBuf {
        let dir = workspace::work_dir(id).unwrap();
        write_track(
            id,
            &TrackManifest {
                id: id.to_string(),
                title: id.to_string(),
                url: "https://example.com".to_string(),
                source_path: "".to_string(),
                wav_path: "".to_string(),
                duration_sec: 1.0,
                sample_rate: 44100,
                channels: 2,
                codec: "opus".to_string(),
                work_dir: dir.to_string_lossy().to_string(),
                peaks: Vec::new(),
                source_kind: Default::default(),
            },
        )
        .unwrap();
        dir
    }

    /// Sets `lastOpenedAt` (and, for realism, `fetchedAt`) on `id`'s
    /// `state.json` to an explicit RFC3339 timestamp, without touching
    /// `kept`.
    fn set_last_opened(id: &str, when: &str) {
        let mut state = load_state(id);
        state.last_opened_at = when.to_string();
        write_state(id, &state).unwrap();
    }

    #[test]
    fn prune_keeps_kept_songs_and_max_scans_most_recent_unkept() {
        let _guard = workspace::ENV_TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_dir("prune");
        std::env::set_var("ABSOLUTESAMPLE_HOME", &root);

        // kept: always survives, regardless of recency.
        let kept_dir = make_track("kept_track");
        mark_kept("kept_track").unwrap();
        set_last_opened("kept_track", "2020-01-01T00:00:00Z");

        // 5 unkept songs at different lastOpenedAt times, plus one with split
        // output (band stems) that is still old enough to be pruned, since
        // split output no longer protects a scan under the v4 rule.
        let dirs: Vec<(&str, PathBuf, &str)> = vec![
            ("scan_1", PathBuf::new(), "2024-01-05T00:00:00Z"), // most recent: kept
            ("scan_2", PathBuf::new(), "2024-01-04T00:00:00Z"), // 2nd most recent: kept
            ("scan_3", PathBuf::new(), "2024-01-03T00:00:00Z"), // 3rd most recent: kept
            ("scan_4_with_split", PathBuf::new(), "2024-01-02T00:00:00Z"), // pruned despite split output
            ("scan_5_oldest", PathBuf::new(), "2024-01-01T00:00:00Z"), // pruned
        ];
        let mut created = Vec::new();
        for (id, _, when) in &dirs {
            let dir = make_track(id);
            set_last_opened(id, when);
            created.push((*id, dir));
        }
        // Give scan_4 band-stem split output; it should be pruned anyway.
        let split_stems_dir = created[3].1.join("stems");
        std::fs::create_dir_all(&split_stems_dir).unwrap();
        std::fs::write(split_stems_dir.join("01_drums_sub.wav"), b"fake").unwrap();

        prune_unkept(&[]).unwrap();

        assert!(kept_dir.exists());
        assert!(created[0].1.exists(), "scan_1 (most recent) should survive");
        assert!(created[1].1.exists(), "scan_2 should survive");
        assert!(created[2].1.exists(), "scan_3 should survive");
        assert!(!created[3].1.exists(), "scan_4 (has split output but old) should be pruned");
        assert!(!created[4].1.exists(), "scan_5 (oldest) should be pruned");

        std::env::remove_var("ABSOLUTESAMPLE_HOME");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_never_deletes_excepted_ids() {
        let _guard = workspace::ENV_TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_dir("prune_except");
        std::env::set_var("ABSOLUTESAMPLE_HOME", &root);

        let dir = make_track("in_progress");
        let current_dir = make_track("currently_open");
        // Make both old enough that, absent the `except` list, they'd be
        // pruned in favor of nothing (they're the only 2 songs, so recency
        // alone wouldn't prune them) — instead exercise `except` directly by
        // adding 4 more unkept songs newer than both.
        for i in 0..4 {
            let id = format!("newer_{i}");
            make_track(&id);
            set_last_opened(&id, &format!("2030-01-0{}T00:00:00Z", i + 1));
        }
        set_last_opened("in_progress", "2020-01-01T00:00:00Z");
        set_last_opened("currently_open", "2020-01-02T00:00:00Z");

        prune_unkept(&["in_progress", "currently_open"]).unwrap();
        assert!(dir.exists());
        assert!(current_dir.exists());

        std::env::remove_var("ABSOLUTESAMPLE_HOME");
        let _ = std::fs::remove_dir_all(&root);
    }
}
