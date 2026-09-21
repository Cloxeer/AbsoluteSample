//! Trash (contract v6 addendum "Trash"): `delete_track`/`delete_sample` move
//! their target into `~/.absolutesample/trash/<yyyymmdd-hhmmss>-<id>/`
//! instead of permanently deleting it, with a `meta.json` describing what
//! was moved. `restore_trash` moves it back (and, for a sample,
//! re-registers it in `samples.json`). `prune_trash` purges entries older
//! than a few days on app start.

use super::{library, samples, workspace};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Default retention window for `prune_trash`, per the contract.
pub const DEFAULT_RETENTION_DAYS: u64 = 7;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashMeta {
    kind: String, // "track" | "sample"
    id: String,
    name: String,
    original_path: String,
    deleted_at: String,
    bytes: u64,
    /// Full sample record, kept so `restore_trash` can re-register it in
    /// `samples.json` without guessing at fields. Only set for `kind: "sample"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sample: Option<samples::Sample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub original_path: String,
    pub deleted_at: String,
    pub bytes: u64,
}

/// `~/.absolutesample/trash/`, created if missing.
fn trash_root() -> Result<PathBuf, String> {
    let dir = workspace::home_dir()?.join("trash");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create trash dir: {e}"))?;
    Ok(dir)
}

/// Total size (bytes) of everything under the trash dir.
pub fn trash_bytes() -> Result<u64, String> {
    let root = trash_root()?;
    library::dir_size(&root)
}

fn timestamp_dirname() -> String {
    // `now_rfc3339()` -> "2026-09-21T12:34:56Z"; collapse to "20260921-123456".
    let rfc = library::now_rfc3339();
    let date: String = rfc.chars().take(10).filter(|c| *c != '-').collect();
    let time: String = rfc.chars().skip(11).take(8).filter(|c| *c != ':').collect();
    format!("{date}-{time}")
}

fn new_trash_entry_dir(id: &str) -> Result<PathBuf, String> {
    let root = trash_root()?;
    let base = format!("{}-{}", timestamp_dirname(), workspace::sanitize_id(id));
    let mut candidate = root.join(&base);
    let mut n = 2;
    while candidate.exists() {
        candidate = root.join(format!("{base}-{n}"));
        n += 1;
    }
    std::fs::create_dir_all(&candidate).map_err(|e| format!("failed to create trash entry dir: {e}"))?;
    Ok(candidate)
}

fn write_meta(entry_dir: &Path, meta: &TrashMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| format!("failed to serialize trash meta: {e}"))?;
    std::fs::write(entry_dir.join("meta.json"), json).map_err(|e| format!("failed to write trash meta: {e}"))
}

fn read_meta(entry_dir: &Path) -> Result<TrashMeta, String> {
    let text = std::fs::read_to_string(entry_dir.join("meta.json"))
        .map_err(|e| format!("failed to read trash meta: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("failed to parse trash meta: {e}"))
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("failed to create dir: {e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("failed to read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read dir entry: {e}"))?;
        let path = entry.path();
        let target = dest.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else {
            std::fs::copy(&path, &target).map_err(|e| format!("failed to copy file: {e}"))?;
        }
    }
    Ok(())
}

/// Moves a directory, falling back to recursive copy+remove across volumes
/// (where `rename` fails).
fn move_dir(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create dest parent: {e}"))?;
    }
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    copy_dir_recursive(src, dest)?;
    std::fs::remove_dir_all(src).map_err(|e| format!("failed to remove source dir after copy: {e}"))
}

/// Moves a file, falling back to copy+remove across volumes.
fn move_file(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create dest parent: {e}"))?;
    }
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dest).map_err(|e| format!("failed to copy file: {e}"))?;
    std::fs::remove_file(src).map_err(|e| format!("failed to remove source file after copy: {e}"))
}

/// Moves a track's entire work dir into trash. No-op (Ok) if the track dir
/// doesn't exist.
pub fn delete_track(track_id: &str) -> Result<(), String> {
    let dir = workspace::work_dir(track_id)?;
    if !dir.exists() {
        return Ok(());
    }
    let name = library::read_track(track_id)
        .ok()
        .flatten()
        .map(|t| t.title)
        .unwrap_or_else(|| track_id.to_string());
    let bytes = library::dir_size(&dir)?;
    let original_path = dir.to_string_lossy().to_string();

    let entry_dir = new_trash_entry_dir(track_id)?;
    move_dir(&dir, &entry_dir.join("track"))?;

    write_meta(
        &entry_dir,
        &TrashMeta {
            kind: "track".to_string(),
            id: track_id.to_string(),
            name,
            original_path,
            deleted_at: library::now_rfc3339(),
            bytes,
            sample: None,
        },
    )
}

/// Moves a saved sample's wav file into trash and removes it from
/// `samples.json` (keeping the full record in `meta.json` for restore).
pub fn delete_sample(id: &str) -> Result<(), String> {
    let sample = samples::remove_index_entry(id)?;
    let src = PathBuf::from(&sample.path);
    let bytes = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(sample.bytes);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("wav").to_string();

    let entry_dir = new_trash_entry_dir(id)?;
    if src.exists() {
        move_file(&src, &entry_dir.join(format!("sample.{ext}")))?;
    }

    write_meta(
        &entry_dir,
        &TrashMeta {
            kind: "sample".to_string(),
            id: id.to_string(),
            name: sample.name.clone(),
            original_path: sample.path.clone(),
            deleted_at: library::now_rfc3339(),
            bytes,
            sample: Some(sample),
        },
    )
}

/// Lists every trash entry, most recently deleted first.
pub fn list_trash() -> Result<Vec<TrashEntry>, String> {
    let root = trash_root()?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| format!("failed to read trash root: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read trash entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Ok(meta) = read_meta(&path) {
            out.push(TrashEntry {
                id: entry.file_name().to_string_lossy().to_string(),
                kind: meta.kind,
                name: meta.name,
                original_path: meta.original_path,
                deleted_at: meta.deleted_at,
                bytes: meta.bytes,
            });
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

/// Restores a trash entry (by its trash dir id, from `list_trash`) to its
/// original location, re-registering a sample in `samples.json`.
pub fn restore_trash(id: &str) -> Result<(), String> {
    let root = trash_root()?;
    let entry_dir = root.join(workspace::sanitize_id(id));
    if !entry_dir.exists() {
        return Err(format!("trash entry '{id}' not found"));
    }
    let meta = read_meta(&entry_dir)?;

    match meta.kind.as_str() {
        "track" => {
            let payload = entry_dir.join("track");
            let dest = PathBuf::from(&meta.original_path);
            // `workspace::work_dir` may have recreated an empty dir at the
            // original path since deletion; clear it out of the way first.
            if dest.is_dir() {
                let _ = std::fs::remove_dir(&dest);
            }
            move_dir(&payload, &dest)?;
        }
        "sample" => {
            let dest = PathBuf::from(&meta.original_path);
            let ext = dest.extension().and_then(|e| e.to_str()).unwrap_or("wav").to_string();
            let payload = entry_dir.join(format!("sample.{ext}"));
            if payload.exists() {
                move_file(&payload, &dest)?;
            }
            if let Some(sample) = meta.sample.clone() {
                samples::reinsert(sample)?;
            }
        }
        other => return Err(format!("unknown trash entry kind: {other}")),
    }

    std::fs::remove_dir_all(&entry_dir).map_err(|e| format!("failed to clean up trash entry: {e}"))
}

/// Permanently deletes everything in trash.
pub fn empty_trash() -> Result<(), String> {
    let root = trash_root()?;
    for entry in std::fs::read_dir(&root).map_err(|e| format!("failed to read trash root: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read trash entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Permanently deletes trash entries older than `days`. Never fails the
/// caller (best-effort); called on every app/CLI start.
pub fn prune_trash(days: u64) {
    let _ = (|| -> Result<(), String> {
        let root = trash_root()?;
        let cutoff_time = SystemTime::now()
            .checked_sub(Duration::from_secs(days.saturating_mul(86400)))
            .unwrap_or(UNIX_EPOCH);
        let cutoff = library::format_rfc3339(cutoff_time);
        for entry in std::fs::read_dir(&root).map_err(|e| format!("failed to read trash root: {e}"))? {
            let entry = entry.map_err(|e| format!("failed to read trash entry: {e}"))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Ok(meta) = read_meta(&path) {
                if meta.deleted_at < cutoff {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
        Ok(())
    })();
}

/// Moves every unkept ("scan") track into trash, except `except` (if given).
/// Returns the number of tracks moved.
pub fn clear_scans(except: Option<&str>) -> Result<usize, String> {
    let root = workspace::work_root()?;
    if !root.exists() {
        return Ok(0);
    }
    let except_id = except.map(workspace::sanitize_id);
    let mut count = 0;
    for entry in std::fs::read_dir(&root).map_err(|e| format!("failed to read work root: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read work root entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if except_id.as_deref() == Some(id.as_str()) {
            continue;
        }
        let state = library::load_state(&id);
        if state.kept {
            continue;
        }
        delete_track(&id)?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("absolutesample_trash_test_{name}_{:?}", std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_sample(id: &str, path: &Path) -> samples::Sample {
        samples::Sample {
            id: id.to_string(),
            name: "Kick".to_string(),
            path: path.to_string_lossy().to_string(),
            bytes: 4,
            song_id: "song1".to_string(),
            song_title: "Song".to_string(),
            stem_key: "kick".to_string(),
            stem_label: "Kick".to_string(),
            group: "drums".to_string(),
            start_sec: 0.0,
            end_sec: 1.0,
            duration_sec: 1.0,
            bpm: None,
            created_at: library::now_rfc3339(),
            peaks: Vec::new(),
            kind: "stem".to_string(),
            key_short: None,
            bars: None,
        }
    }

    #[test]
    fn sample_delete_list_restore_round_trip() {
        let _guard = workspace::ENV_TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_dir("sample_round_trip");
        std::env::set_var("ABSOLUTESAMPLE_HOME", &root);

        let song_dir = samples::samples_root().unwrap().join("Song");
        std::fs::create_dir_all(&song_dir).unwrap();
        let sample_path = song_dir.join("Kick.wav");
        std::fs::write(&sample_path, b"fake").unwrap();
        samples::reinsert(make_sample("sampleid1", &sample_path)).unwrap();

        delete_sample("sampleid1").unwrap();
        assert!(!sample_path.exists(), "sample wav should be moved out of the song dir");
        assert!(samples::list().unwrap().is_empty(), "sample index entry should be gone");

        let entries = list_trash().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "sample");
        assert_eq!(entries[0].name, "Kick");

        restore_trash(&entries[0].id).unwrap();
        assert!(sample_path.exists(), "sample wav should be restored");
        let restored = samples::list().unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, "sampleid1");
        assert!(list_trash().unwrap().is_empty(), "trash entry should be cleaned up after restore");

        std::env::remove_var("ABSOLUTESAMPLE_HOME");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn track_delete_and_restore_round_trip() {
        let _guard = workspace::ENV_TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_dir("track_round_trip");
        std::env::set_var("ABSOLUTESAMPLE_HOME", &root);

        let dir = workspace::work_dir("trackid1").unwrap();
        std::fs::write(dir.join("source.wav"), b"fake").unwrap();

        delete_track("trackid1").unwrap();
        assert!(!dir.exists(), "track work dir should be moved out");

        let entries = list_trash().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "track");

        restore_trash(&entries[0].id).unwrap();
        assert!(dir.join("source.wav").exists(), "track file should be restored");
        assert!(list_trash().unwrap().is_empty());

        std::env::remove_var("ABSOLUTESAMPLE_HOME");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_trash_removes_only_old_entries() {
        let _guard = workspace::ENV_TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_dir("prune");
        std::env::set_var("ABSOLUTESAMPLE_HOME", &root);

        let old_dir = new_trash_entry_dir("old_entry").unwrap();
        write_meta(
            &old_dir,
            &TrashMeta {
                kind: "track".to_string(),
                id: "old_entry".to_string(),
                name: "Old".to_string(),
                original_path: "".to_string(),
                deleted_at: "2000-01-01T00:00:00Z".to_string(),
                bytes: 0,
                sample: None,
            },
        )
        .unwrap();

        let new_dir = new_trash_entry_dir("new_entry").unwrap();
        write_meta(
            &new_dir,
            &TrashMeta {
                kind: "track".to_string(),
                id: "new_entry".to_string(),
                name: "New".to_string(),
                original_path: "".to_string(),
                deleted_at: library::now_rfc3339(),
                bytes: 0,
                sample: None,
            },
        )
        .unwrap();

        prune_trash(DEFAULT_RETENTION_DAYS);

        assert!(!old_dir.exists());
        assert!(new_dir.exists());

        std::env::remove_var("ABSOLUTESAMPLE_HOME");
        let _ = std::fs::remove_dir_all(&root);
    }
}
