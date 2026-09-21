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
}
