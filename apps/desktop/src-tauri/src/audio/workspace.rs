//! Workspace directory management: `<home>/work/<track_id>/`.
//!
//! Home dir resolution (contract v2 "Home directory" addendum): `ABSOLUTESAMPLE_HOME`
//! env var if set, else `%USERPROFILE%\.absolutesample\`. NOT `%LOCALAPPDATA%`, which
//! is filesystem-virtualized for processes launched from packaged (MSIX) apps.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

/// Root app data directory: `ABSOLUTESAMPLE_HOME` env if set, else
/// `%USERPROFILE%\.absolutesample\`. Shared by `work_root()` here and
/// `engine::engine_dir()`.
pub fn home_dir() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("ABSOLUTESAMPLE_HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home));
        }
    }
    let user_profile = std::env::var("USERPROFILE")
        .map_err(|_| "neither ABSOLUTESAMPLE_HOME nor USERPROFILE is set".to_string())?;
    Ok(PathBuf::from(user_profile).join(".absolutesample"))
}

/// Returns the sanitized id: keep alnum, dash, underscore; replace everything
/// else with `_`. Prevents path traversal via crafted track ids.
pub fn sanitize_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("track");
    }
    out
}

/// Root work directory: `<home>/work`.
pub fn work_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("work"))
}

/// Work directory for a specific (sanitized) track id, created if missing.
pub fn work_dir(track_id: &str) -> Result<PathBuf, String> {
    let id = sanitize_id(track_id);
    let dir = work_root()?.join(id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create work dir: {e}"))?;
    Ok(dir)
}

// ---------------------------------------------------------------------
// Performance log (contract v8 addendum "Performance metrics")
// ---------------------------------------------------------------------

/// One parsed row of `<home>/perf.log`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerfRow {
    pub ts: String,
    pub op: String,
    pub track_id: Option<String>,
    pub seconds: f64,
    pub peak_rss_mb: Option<f64>,
}

/// `<home>/perf.log` path.
pub fn perf_log_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("perf.log"))
}

/// Appends one jsonl row to `<home>/perf.log`: `{ts, op, trackId, seconds,
/// peakRssMb}`. Never fatal to the caller's operation on its own merits, but
/// returns `Err` on an actual write failure so callers can decide whether to
/// ignore it.
pub fn log_perf(op: &str, track_id: Option<&str>, seconds: f64, peak_rss_mb: Option<f64>) -> Result<(), String> {
    let path = perf_log_path()?;
    let row = PerfRow {
        ts: super::library::now_rfc3339(),
        op: op.to_string(),
        track_id: track_id.map(|s| s.to_string()),
        seconds,
        peak_rss_mb,
    };
    let line = serde_json::to_string(&row).map_err(|e| format!("failed to serialize perf row: {e}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    writeln!(file, "{line}").map_err(|e| format!("failed to append to {}: {e}", path.display()))?;
    Ok(())
}

/// Returns the last `limit` rows of `<home>/perf.log`, newest last (file
/// order), parsed; unparsable lines are skipped. Missing file returns an
/// empty vec (not an error).
pub fn read_perf_log(limit: usize) -> Result<Vec<PerfRow>, String> {
    let path = perf_log_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    let rows: Vec<PerfRow> = text.lines().filter_map(|line| serde_json::from_str::<PerfRow>(line).ok()).collect();
    let start = rows.len().saturating_sub(limit);
    Ok(rows[start..].to_vec())
}

/// `stems/` subdirectory of the track's work dir, created if missing.
pub fn stems_dir(track_id: &str) -> Result<PathBuf, String> {
    let dir = work_dir(track_id)?.join("stems");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create stems dir: {e}"))?;
    Ok(dir)
}

/// `stems/slices/` subdirectory of the track's work dir, created if missing.
pub fn slices_dir(track_id: &str) -> Result<PathBuf, String> {
    let dir = stems_dir(track_id)?.join("slices");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create slices dir: {e}"))?;
    Ok(dir)
}

/// Minimal pure-Rust SHA-1 (std only) over `data`, returned as lowercase hex.
/// Used for content-addressing local file imports (see `pipeline::run_import_local`);
/// not intended for security-sensitive use.
pub fn sha1_hex(data: &[u8]) -> String {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let ml: u64 = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&ml.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = if i < 20 {
                ((b & c) | ((!b) & d), 0x5A827999u32)
            } else if i < 40 {
                (b ^ c ^ d, 0x6ED9EBA1)
            } else if i < 60 {
                ((b & c) | (b & d) | (c & d), 0x8F1BBCDC)
            } else {
                (b ^ c ^ d, 0xCA62C1D6)
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    format!("{h0:08x}{h1:08x}{h2:08x}{h3:08x}{h4:08x}")
}

/// Audio file types the pitch editor may read from anywhere the user picked them.
const READABLE_AUDIO_EXTS: [&str; 8] = ["wav", "mp3", "flac", "ogg", "m4a", "aac", "aif", "aiff"];
/// Refuse anything larger (a 10-minute 24-bit stereo WAV is ~300 MB).
pub const MAX_AUDIO_READ_BYTES: u64 = 1024 * 1024 * 1024;

/// Reads a user-chosen audio file for the in-app pitch editor. Only audio extensions and
/// regular files under the size cap are allowed, so this cannot be used to read arbitrary files.
pub fn read_audio_bytes(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    if !READABLE_AUDIO_EXTS.contains(&ext.as_str()) {
        return Err(format!("not an audio file: {}", path.display()));
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    if meta.len() > MAX_AUDIO_READ_BYTES {
        return Err(format!("file too large ({} MB)", meta.len() / (1024 * 1024)));
    }
    std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

/// The user's Downloads folder (override with `ABSOLUTESAMPLE_DOWNLOADS`, used by tests).
pub fn downloads_dir() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("ABSOLUTESAMPLE_DOWNLOADS") {
        return Ok(PathBuf::from(p));
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|_| "no home folder".to_string())?;
    Ok(PathBuf::from(home).join("Downloads"))
}

/// Decodes a `encodeURIComponent` string (file names are sent that way in an IPC header).
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Keeps a user-facing file name safe: no folders, no reserved characters, sane length.
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    let t = if trimmed.is_empty() { "audio.wav".to_string() } else { trimmed };
    t.chars().take(150).collect()
}

/// `dir/name`, or `dir/stem (2).ext`, `(3)`, ... so an earlier save is never overwritten.
pub fn unique_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = std::path::Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("audio");
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (2..10_000).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|c| !c.exists()).unwrap_or(first)
}

/// Writes `bytes` into the Downloads folder under a unique, safe name; returns the full path.
pub fn save_to_downloads(name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = downloads_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot open Downloads: {e}"))?;
    let path = unique_path(&dir, &safe_file_name(name));
    std::fs::write(&path, bytes).map_err(|e| format!("cannot save {}: {e}", path.display()))?;
    Ok(path)
}

/// Shared across `library`'s and `samples`' test modules: `ABSOLUTESAMPLE_HOME`
/// is process-global state, so tests that set it must not run concurrently
/// with each other, regardless of which module they live in.
#[cfg(test)]
pub static ENV_TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_handles_unicode_and_junk() {
        assert_eq!(percent_decode("My%20Song%20%E2%80%93%20take-autotuned.wav"), "My Song \u{2013} take-autotuned.wav");
        assert_eq!(percent_decode("plain.wav"), "plain.wav");
        assert_eq!(percent_decode("bad%zzend%"), "bad%zzend%");
    }

    #[test]
    fn save_to_downloads_never_overwrites_and_strips_folders() {
        let _g = ENV_TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("as-dl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("ABSOLUTESAMPLE_DOWNLOADS", &dir);
        let a = save_to_downloads("take-autotuned.wav", b"one").unwrap();
        let b = save_to_downloads("take-autotuned.wav", b"two").unwrap();
        let c = save_to_downloads("..\\..\\evil/take:x.wav", b"three").unwrap();
        std::env::remove_var("ABSOLUTESAMPLE_DOWNLOADS");
        assert_eq!(a.file_name().unwrap(), "take-autotuned.wav");
        assert_eq!(b.file_name().unwrap(), "take-autotuned (2).wav");
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
        assert_eq!(c.parent().unwrap(), dir.as_path());
        assert_eq!(c.file_name().unwrap(), "take_x.wav");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_audio_bytes_only_reads_audio_files() {
        let dir = std::env::temp_dir().join(format!("as-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("take.WAV");
        std::fs::write(&wav, b"RIFFdata").unwrap();
        assert_eq!(read_audio_bytes(&wav).unwrap(), b"RIFFdata");
        let secret = dir.join("secrets.txt");
        std::fs::write(&secret, b"no").unwrap();
        assert!(read_audio_bytes(&secret).is_err());
        assert!(read_audio_bytes(&dir.join("missing.wav")).is_err());
        let folder = dir.join("folder.wav");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(read_audio_bytes(&folder).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_keeps_safe_chars() {
        assert_eq!(sanitize_id("abc-123_XYZ"), "abc-123_XYZ");
    }

    #[test]
    fn sanitize_replaces_traversal() {
        assert_eq!(sanitize_id("../../etc/passwd"), "______etc_passwd");
    }

    #[test]
    fn sanitize_empty_falls_back() {
        assert_eq!(sanitize_id(""), "track");
    }

    #[test]
    fn sha1_matches_known_vector() {
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    }

    #[test]
    fn perf_log_append_and_read_round_trip() {
        let _guard = ENV_TEST_MUTEX.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("perf_log_rs_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let prior = std::env::var("ABSOLUTESAMPLE_HOME").ok();
        std::env::set_var("ABSOLUTESAMPLE_HOME", dir.to_string_lossy().to_string());

        // Fresh home: no perf.log yet -> empty, not an error.
        assert_eq!(read_perf_log(100).unwrap(), Vec::new());

        log_perf("analyze_pitch", Some("track1"), 23.4, Some(1096.7)).unwrap();
        log_perf("apply_autotune", None, 40.1, Some(1620.0)).unwrap();

        let rows = read_perf_log(100).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].op, "analyze_pitch");
        assert_eq!(rows[0].track_id, Some("track1".to_string()));
        assert_eq!(rows[0].seconds, 23.4);
        assert_eq!(rows[0].peak_rss_mb, Some(1096.7));
        assert_eq!(rows[1].op, "apply_autotune");
        assert_eq!(rows[1].track_id, None);
        assert!(!rows[0].ts.is_empty());

        // `limit` trims to the newest rows.
        let last_one = read_perf_log(1).unwrap();
        assert_eq!(last_one.len(), 1);
        assert_eq!(last_one[0].op, "apply_autotune");

        match prior {
            Some(p) => std::env::set_var("ABSOLUTESAMPLE_HOME", p),
            None => std::env::remove_var("ABSOLUTESAMPLE_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
