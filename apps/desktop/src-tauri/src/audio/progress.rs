//! Progress reporting abstraction shared between the Tauri commands and the CLI.

/// Implementors receive stage/percent/message updates during long-running
/// pipeline operations (download, decode, trim, stems, analyze, slice).
pub trait Progress: Send + Sync {
    fn report(&self, stage: &str, percent: f32, msg: &str);
}

/// A no-op implementation used where progress reporting is not needed.
pub struct Noop;

impl Progress for Noop {
    fn report(&self, _stage: &str, _percent: f32, _msg: &str) {}
}

/// Prints progress to stdout as a single-line JSON object; used by the CLI.
pub struct Stdout;

impl Progress for Stdout {
    fn report(&self, stage: &str, percent: f32, msg: &str) {
        let payload = serde_json::json!({
            "stage": stage,
            "percent": percent,
            "message": msg,
        });
        eprintln!("{}", payload);
    }
}
