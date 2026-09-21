//! Workspace directory management: `%LOCALAPPDATA%/AbsoluteSample/work/<track_id>/`.

use std::path::PathBuf;

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

/// Root work directory: `%LOCALAPPDATA%/AbsoluteSample/work`.
pub fn work_root() -> Result<PathBuf, String> {
    let local_appdata = std::env::var("LOCALAPPDATA")
        .map_err(|_| "LOCALAPPDATA environment variable not set".to_string())?;
    Ok(PathBuf::from(local_appdata)
        .join("AbsoluteSample")
        .join("work"))
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
