pub mod analysis;
pub mod dsp_filters;
pub mod downloader;
pub mod engine;
pub mod library;
pub mod progress;
pub mod samples;
pub mod slicer;
pub mod workspace;

use std::process::Command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Builds a `Command` that, on Windows, is configured not to flash a console
/// window when spawned from a GUI (Tauri) process.
pub fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs a command, returning stdout as a String on success or a formatted
/// error (including the stderr tail) on failure/non-zero exit.
pub fn run_capture(program: &str, args: &[&str]) -> Result<String, String> {
    let output = silent_command(program)
        .args(args)
        .output()
        .map_err(|e| format!("failed to spawn `{program}`: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(20).collect::<Vec<_>>().join("\n");
        return Err(format!(
            "`{program}` exited with {:?}\n{}",
            output.status.code(),
            tail
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Locates a binary by name, returning its resolved path (or the bare name
/// if it's expected to be found on PATH) if it appears runnable, else None.
pub fn find_on_path(name: &str) -> Option<String> {
    let probe = silent_command(name).arg("-version").output();
    if let Ok(out) = probe {
        if out.status.success() || !out.stdout.is_empty() || !out.stderr.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

/// Returns a version-ish string for `ffmpeg`/`ffprobe`-style binaries invoked
/// with `-version`, or None if the binary can't be run.
pub fn version_string(program: &str, version_flag: &str) -> Option<String> {
    let output = silent_command(program).arg(version_flag).output().ok()?;
    let text = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).to_string()
    };
    text.lines().next().map(|s| s.to_string())
}
