//! Progress reporting abstraction shared between the Tauri commands and the CLI.

use serde::Serialize;
use std::collections::HashMap;
use std::time::Instant;

/// Payload emitted on the `"pipeline://progress"` / `"engine://progress"`
/// Tauri events (contract v5 addendum "Honest timing"). Defined here (not in
/// `commands.rs`) so it can be unit-tested without the `tauri-app` feature.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub stage: String,
    pub percent: f32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pass: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<bool>,
    /// Which track this progress belongs to (v5 "Per-song jobs"), so
    /// switching songs mid-job doesn't lose track of it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pass_seconds: Option<HashMap<String, f64>>,
}

/// Implementors receive stage/percent/message updates during long-running
/// pipeline operations (download, decode, trim, stems, analyze, slice).
pub trait Progress: Send + Sync {
    fn report(&self, stage: &str, percent: f32, msg: &str);
}

/// Honest wall-clock timing helper (contract v5 addendum: "Honest timing").
/// Records `startedAt` (RFC3339, via `library::now_rfc3339`) at construction
/// and reports independently-measured elapsed seconds, regardless of what
/// any subprocess claims about its own timing.
#[derive(Debug, Clone)]
pub struct Timer {
    start: Instant,
    started_at: String,
}

impl Timer {
    /// Starts a new timer, capturing "now" as both the monotonic instant and
    /// the RFC3339 wall-clock timestamp.
    pub fn start() -> Self {
        Timer {
            start: Instant::now(),
            started_at: super::library::now_rfc3339(),
        }
    }

    /// The RFC3339 UTC timestamp this timer was started at.
    pub fn started_at(&self) -> &str {
        &self.started_at
    }

    /// Wall-clock seconds elapsed since `start()`, as measured by this
    /// process (not trusted from any subprocess output).
    pub fn elapsed_sec(&self) -> f64 {
        self.start.elapsed().as_secs_f64()
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timer_reports_nonzero_elapsed_and_rfc3339_started_at() {
        let timer = Timer::start();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let elapsed = timer.elapsed_sec();
        assert!(elapsed >= 0.015, "expected >= 15ms elapsed, got {elapsed}");
        // RFC3339 UTC shape: YYYY-MM-DDTHH:MM:SSZ
        let started = timer.started_at();
        assert_eq!(started.len(), 20);
        assert!(started.ends_with('Z'));
        assert_eq!(started.as_bytes()[4], b'-');
        assert_eq!(started.as_bytes()[10], b'T');
    }

    #[test]
    fn progress_payload_serializes_camel_case_and_omits_none_optionals() {
        let payload = ProgressPayload {
            stage: "separate".to_string(),
            percent: 42.0,
            message: "working".to_string(),
            pass: None,
            failed: None,
            track_id: Some("abc123".to_string()),
            started_at: Some("2026-09-21T00:00:00Z".to_string()),
            elapsed_sec: Some(1.5),
            pass_seconds: None,
        };
        let json = serde_json::to_value(&payload).unwrap();
        let obj = json.as_object().unwrap();

        assert_eq!(obj.get("trackId").unwrap(), "abc123");
        assert_eq!(obj.get("startedAt").unwrap(), "2026-09-21T00:00:00Z");
        assert_eq!(obj.get("elapsedSec").unwrap(), 1.5);
        // None optionals (pass, failed, passSeconds) must be omitted entirely.
        assert!(!obj.contains_key("pass"));
        assert!(!obj.contains_key("failed"));
        assert!(!obj.contains_key("passSeconds"));
    }

    #[test]
    fn progress_payload_includes_pass_and_failed_when_present() {
        let mut pass_seconds = HashMap::new();
        pass_seconds.insert("drums".to_string(), 12.5);
        let payload = ProgressPayload {
            stage: "separate".to_string(),
            percent: -1.0,
            message: "failed".to_string(),
            pass: Some("lead".to_string()),
            failed: Some(true),
            track_id: None,
            started_at: None,
            elapsed_sec: None,
            pass_seconds: Some(pass_seconds),
        };
        let json = serde_json::to_value(&payload).unwrap();
        let obj = json.as_object().unwrap();

        assert_eq!(obj.get("pass").unwrap(), "lead");
        assert_eq!(obj.get("failed").unwrap(), true);
        assert_eq!(obj["passSeconds"]["drums"], 12.5);
        assert!(!obj.contains_key("trackId"));
        assert!(!obj.contains_key("startedAt"));
        assert!(!obj.contains_key("elapsedSec"));
    }
}
