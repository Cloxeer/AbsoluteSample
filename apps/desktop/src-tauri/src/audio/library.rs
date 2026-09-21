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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSession {
    pub track: TrackManifest,
    #[serde(rename = "loop")]
    pub loop_info: Option<LoopManifest>,
    pub stems: Option<Vec<StemManifest>>,
    pub instruments: Option<Vec<InstrumentStem>>,
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

fn instruments_manifest_at(dir: &Path) -> Option<super::engine::InstrumentsManifest> {
    let path = dir.join("instruments.json");
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
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
        // A song with split output is effectively kept: prune never removes it.
        kept: state.kept || has_bands || has_instruments,
        has_loop: state.loop_info.is_some(),
        loop_start_sec: state.loop_info.as_ref().map(|l| l.start_sec),
        loop_end_sec: state.loop_info.as_ref().map(|l| l.end_sec),
        has_bands,
        has_instruments,
        instrument_count,
        bytes,
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
        let loudness = match cache.get(&name) {
            Some(l) => l.clone(),
            None => {
                let l = dsp_filters::measure_loudness(&path)?;
                cache.insert(name.clone(), l.clone());
                dirty = true;
                l
            }
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
    let track = read_track_at(&dir)?
        .ok_or_else(|| format!("track '{track_id}' not found; call fetch_audio first"))?;

    let mut state = load_state_at(&dir)?;
    state.last_opened_at = now_rfc3339();

    let stems = rebuild_band_stems(track_id, &dir, &mut state)?;
    // rebuild_band_stems already persisted state if it updated band_stats;
    // persist again unconditionally to record the touched lastOpenedAt.
    write_state(track_id, &state)?;

    let instruments = instruments_manifest_at(&dir).map(|m| m.stems);

    Ok(TrackSession {
        track,
        loop_info: state.loop_info.clone(),
        stems,
        instruments,
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

/// Total size (bytes) and track count across the whole library.
pub fn size() -> Result<(u64, usize), String> {
    let root = workspace::work_root()?;
    if !root.exists() {
        return Ok((0, 0));
    }
    let mut bytes = 0u64;
    let mut tracks = 0usize;
    for entry in std::fs::read_dir(&root).map_err(|e| format!("failed to read work root: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read work root entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            tracks += 1;
            bytes += dir_size(&path)?;
        }
    }
    Ok((bytes, tracks))
}

/// Deletes work dirs that are not kept AND have no split output (no band
/// stems, no instrument stems). Never deletes `except` (the track currently
/// being fetched), even if it would otherwise qualify.
pub fn prune_unkept(except: &str) -> Result<(), String> {
    let root = workspace::work_root()?;
    if !root.exists() {
        return Ok(());
    }
    let except_sanitized = workspace::sanitize_id(except);
    for entry in std::fs::read_dir(&root).map_err(|e| format!("failed to read work root: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read work root entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !except_sanitized.is_empty() && id == except_sanitized {
            continue;
        }

        let state = load_state_at(&path).unwrap_or_default();
        if state.kept {
            continue;
        }

        let has_split = has_band_stem_files(&path)
            || instruments_manifest_at(&path).is_some_and(|m| !m.stems.is_empty());
        if has_split {
            continue;
        }

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
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        });
        let json = serde_json::to_string(&state).unwrap();
        let parsed: StateFile = serde_json::from_str(&json).unwrap();
        assert!(parsed.kept);
        assert_eq!(parsed.loop_info.unwrap().start_sec, 1.0);
    }

    #[test]
    fn prune_removes_unkept_dirs_without_split_output() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_dir("prune");
        std::env::set_var("ABSOLUTESAMPLE_HOME", &root);

        // kept: survives.
        let kept_dir = workspace::work_dir("kept_track").unwrap();
        write_track(
            "kept_track",
            &TrackManifest {
                id: "kept_track".to_string(),
                title: "Kept".to_string(),
                url: "https://example.com".to_string(),
                source_path: "".to_string(),
                wav_path: "".to_string(),
                duration_sec: 1.0,
                sample_rate: 44100,
                channels: 2,
                codec: "opus".to_string(),
                work_dir: kept_dir.to_string_lossy().to_string(),
            },
        )
        .unwrap();
        mark_kept("kept_track").unwrap();

        // unkept, no split output: pruned.
        let unkept_dir = workspace::work_dir("unkept_track").unwrap();
        write_track(
            "unkept_track",
            &TrackManifest {
                id: "unkept_track".to_string(),
                title: "Unkept".to_string(),
                url: "https://example.com".to_string(),
                source_path: "".to_string(),
                wav_path: "".to_string(),
                duration_sec: 1.0,
                sample_rate: 44100,
                channels: 2,
                codec: "opus".to_string(),
                work_dir: unkept_dir.to_string_lossy().to_string(),
            },
        )
        .unwrap();

        // unkept, but has split output (band stems present): survives.
        let split_dir = workspace::work_dir("split_track").unwrap();
        write_track(
            "split_track",
            &TrackManifest {
                id: "split_track".to_string(),
                title: "Split".to_string(),
                url: "https://example.com".to_string(),
                source_path: "".to_string(),
                wav_path: "".to_string(),
                duration_sec: 1.0,
                sample_rate: 44100,
                channels: 2,
                codec: "opus".to_string(),
                work_dir: split_dir.to_string_lossy().to_string(),
            },
        )
        .unwrap();
        let stems_dir = split_dir.join("stems");
        std::fs::create_dir_all(&stems_dir).unwrap();
        std::fs::write(stems_dir.join("01_drums_sub.wav"), b"fake").unwrap();

        prune_unkept("").unwrap();

        assert!(kept_dir.exists());
        assert!(!unkept_dir.exists());
        assert!(split_dir.exists());

        std::env::remove_var("ABSOLUTESAMPLE_HOME");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_never_deletes_the_excepted_id() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_dir("prune_except");
        std::env::set_var("ABSOLUTESAMPLE_HOME", &root);

        let dir = workspace::work_dir("in_progress").unwrap();
        write_track(
            "in_progress",
            &TrackManifest {
                id: "in_progress".to_string(),
                title: "In progress".to_string(),
                url: "https://example.com".to_string(),
                source_path: "".to_string(),
                wav_path: "".to_string(),
                duration_sec: 1.0,
                sample_rate: 44100,
                channels: 2,
                codec: "opus".to_string(),
                work_dir: dir.to_string_lossy().to_string(),
            },
        )
        .unwrap();

        prune_unkept("in_progress").unwrap();
        assert!(dir.exists());

        std::env::remove_var("ABSOLUTESAMPLE_HOME");
        let _ = std::fs::remove_dir_all(&root);
    }
}
