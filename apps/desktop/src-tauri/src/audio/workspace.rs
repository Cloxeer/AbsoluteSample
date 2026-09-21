//! Workspace directory management: `<home>/work/<track_id>/`.
//!
//! Home dir resolution (contract v2 "Home directory" addendum): `ABSOLUTESAMPLE_HOME`
//! env var if set, else `%USERPROFILE%\.absolutesample\`. NOT `%LOCALAPPDATA%`, which
//! is filesystem-virtualized for processes launched from packaged (MSIX) apps.

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
}
