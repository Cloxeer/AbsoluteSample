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

/// Shared across `library`'s and `samples`' test modules: `ABSOLUTESAMPLE_HOME`
/// is process-global state, so tests that set it must not run concurrently
/// with each other, regardless of which module they live in.
#[cfg(test)]
pub static ENV_TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

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
