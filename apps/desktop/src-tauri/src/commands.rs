//! Thin #[tauri::command] wrappers around the audio/pipeline modules.
//! All blocking work runs via `tauri::async_runtime::spawn_blocking`;
//! progress is emitted on the `"pipeline://progress"` event.

use crate::audio::cuts;
use crate::audio::engine::{self, EngineStatus, InstrumentStem};
use crate::audio::progress::{Progress, ProgressPayload, Timer};
use crate::audio::{analysis, downloader, library, samples, slicer, trash, workspace};
use crate::pipeline;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

struct TauriProgress {
    app: AppHandle,
    track_id: String,
    timer: Timer,
}

impl TauriProgress {
    fn new(app: AppHandle, track_id: impl Into<String>) -> Self {
        TauriProgress { app, track_id: track_id.into(), timer: Timer::start() }
    }
}

impl Progress for TauriProgress {
    fn report(&self, stage: &str, percent: f32, msg: &str) {
        let _ = self.app.emit(
            "pipeline://progress",
            ProgressPayload {
                stage: stage.to_string(),
                percent,
                message: msg.to_string(),
                pass: None,
                failed: None,
                track_id: Some(self.track_id.clone()),
                started_at: Some(self.timer.started_at().to_string()),
                elapsed_sec: Some(self.timer.elapsed_sec()),
                pass_seconds: None,
            },
        );
    }
}

impl TauriProgress {
    /// Emits a progress event carrying the separation `pass` name and
    /// whether that pass failed, for `separate_instruments`.
    fn report_pass(&self, stage: &str, pass: &str, percent: f32, msg: &str, failed: bool, pass_seconds: &HashMap<String, f64>) {
        let _ = self.app.emit(
            "pipeline://progress",
            ProgressPayload {
                stage: stage.to_string(),
                percent,
                message: msg.to_string(),
                pass: Some(pass.to_string()),
                failed: if failed { Some(true) } else { None },
                track_id: Some(self.track_id.clone()),
                started_at: Some(self.timer.started_at().to_string()),
                elapsed_sec: Some(self.timer.elapsed_sec()),
                pass_seconds: if pass_seconds.is_empty() { None } else { Some(pass_seconds.clone()) },
            },
        );
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReport {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
    pub ytdlp: Option<String>,
    pub ok: bool,
}

#[tauri::command]
pub async fn check_dependencies() -> Result<DependencyReport, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let ffmpeg = crate::audio::version_string("ffmpeg", "-version");
        let ffprobe = crate::audio::version_string("ffprobe", "-version");
        let ytdlp = downloader::version();
        let ok = ffmpeg.is_some() && ffprobe.is_some() && ytdlp.is_some();
        Ok(DependencyReport { ffmpeg, ffprobe, ytdlp, ok })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(rename = "sourcePath")]
    pub source_path: String,
    #[serde(rename = "wavPath")]
    pub wav_path: String,
    #[serde(rename = "durationSec")]
    pub duration_sec: f64,
    #[serde(rename = "sampleRate")]
    pub sample_rate: u32,
    pub channels: u32,
    pub codec: String,
    #[serde(rename = "workDir")]
    pub work_dir: String,
    pub peaks: Vec<f32>,
    #[serde(rename = "sourceKind")]
    pub source_kind: pipeline::SourceKind,
}

impl From<pipeline::TrackManifest> for TrackInfo {
    fn from(t: pipeline::TrackManifest) -> Self {
        TrackInfo {
            id: t.id,
            title: t.title,
            url: t.url,
            source_path: t.source_path,
            wav_path: t.wav_path,
            duration_sec: t.duration_sec,
            sample_rate: t.sample_rate,
            channels: t.channels,
            codec: t.codec,
            work_dir: t.work_dir,
            peaks: t.peaks,
            source_kind: t.source_kind,
        }
    }
}

/// Raw bytes of a user-chosen audio file, for the in-browser pitch editor (which decodes and
/// analyses it itself). Returned as a binary IPC response, not JSON.
#[tauri::command]
pub async fn read_audio_file(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::audio::workspace::read_audio_bytes(std::path::Path::new(&path)).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn import_local(app: AppHandle, path: String) -> Result<TrackInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress::new(app, String::new());
        let track = pipeline::run_import_local(std::path::Path::new(&path), &progress)?;
        Ok(track.into())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn fetch_audio(
    app: AppHandle,
    url: String,
    force: Option<bool>,
    current_track_id: Option<String>,
) -> Result<TrackInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress::new(app, current_track_id.clone().unwrap_or_default());
        let track = pipeline::run_fetch(&url, force.unwrap_or(false), current_track_id.as_deref(), &progress)?;
        Ok(track.into())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopInfo {
    #[serde(rename = "trackId")]
    pub track_id: String,
    #[serde(rename = "startSec")]
    pub start_sec: f64,
    #[serde(rename = "endSec")]
    pub end_sec: f64,
    #[serde(rename = "durationSec")]
    pub duration_sec: f64,
    #[serde(rename = "loopPath")]
    pub loop_path: String,
    #[serde(rename = "wavPath")]
    pub wav_path: String,
    pub peaks: Vec<f32>,
}

impl From<pipeline::LoopManifest> for LoopInfo {
    fn from(l: pipeline::LoopManifest) -> Self {
        LoopInfo {
            track_id: l.track_id,
            start_sec: l.start_sec,
            end_sec: l.end_sec,
            duration_sec: l.duration_sec,
            loop_path: l.loop_path,
            wav_path: l.wav_path,
            peaks: l.peaks,
        }
    }
}

#[tauri::command]
pub async fn trim_loop(
    app: AppHandle,
    track_id: String,
    start_sec: f64,
    end_sec: f64,
) -> Result<LoopInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress::new(app, track_id.clone());
        let dir = workspace::work_dir(&track_id)?;
        // Find source.<ext> in the work dir; prefer the non-wav source
        // (v5), falling back to source.wav for old work dirs that predate
        // this change and never got a non-wav source.
        let non_wav = std::fs::read_dir(&dir)
            .map_err(|e| format!("failed to read work dir: {e}"))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| {
                p.file_stem().and_then(|s| s.to_str()) == Some("source")
                    && p.extension().and_then(|e| e.to_str()) != Some("wav")
            });
        let source_path = non_wav
            .or_else(|| {
                let wav = dir.join("source.wav");
                if wav.exists() { Some(wav) } else { None }
            })
            .ok_or_else(|| "source file not found; call fetch_audio first".to_string())?;

        let result = pipeline::run_trim(&track_id, &source_path, start_sec, end_sec, &progress)?;
        Ok(result.into())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemInfo {
    pub index: u32,
    pub key: String,
    pub label: String,
    pub band: String,
    pub path: String,
    pub bytes: u64,
    #[serde(rename = "peakDb")]
    pub peak_db: f64,
    #[serde(rename = "rmsDb")]
    pub rms_db: f64,
    #[serde(rename = "durationSec")]
    pub duration_sec: f64,
    pub peaks: Vec<f32>,
}

impl From<pipeline::StemManifest> for StemInfo {
    fn from(s: pipeline::StemManifest) -> Self {
        StemInfo {
            index: s.index,
            key: s.key,
            label: s.label,
            band: s.band,
            path: s.path,
            bytes: s.bytes,
            peak_db: s.peak_db,
            rms_db: s.rms_db,
            duration_sec: s.duration_sec,
            peaks: s.peaks,
        }
    }
}

#[tauri::command]
pub async fn separate_stems(app: AppHandle, track_id: String) -> Result<Vec<StemInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress::new(app, track_id.clone());
        let dir = workspace::work_dir(&track_id)?;
        let loop_wav = dir.join("loop.wav");
        if !loop_wav.exists() {
            return Err("loop.wav not found; call trim_loop first".to_string());
        }
        let stems = pipeline::run_stems(&track_id, &loop_wav, &progress)?;
        Ok(stems.into_iter().map(StemInfo::from).collect())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopAnalysisOut {
    pub bpm: f64,
    pub confidence: f64,
    pub transients: Vec<f64>,
    #[serde(rename = "beatGrid")]
    pub beat_grid: Vec<f64>,
    pub bars: u32,
    #[serde(rename = "onsetEnvelope")]
    pub onset_envelope: Vec<f64>,
    #[serde(rename = "peakDb")]
    pub peak_db: f64,
    #[serde(rename = "rmsDb")]
    pub rms_db: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<analysis::KeyEstimate>,
}

impl From<analysis::LoopAnalysis> for LoopAnalysisOut {
    fn from(a: analysis::LoopAnalysis) -> Self {
        LoopAnalysisOut {
            bpm: a.bpm,
            confidence: a.confidence,
            transients: a.transients,
            beat_grid: a.beat_grid,
            bars: a.bars,
            onset_envelope: a.onset_envelope,
            peak_db: a.peak_db,
            rms_db: a.rms_db,
            key: a.key,
        }
    }
}

#[tauri::command]
pub async fn analyze_loop(app: AppHandle, track_id: String) -> Result<LoopAnalysisOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress::new(app, track_id.clone());
        let dir = workspace::work_dir(&track_id)?;
        let loop_wav = dir.join("loop.wav");
        if !loop_wav.exists() {
            return Err("loop.wav not found; call trim_loop first".to_string());
        }
        let probe = downloader::probe(&loop_wav)?;
        let result = pipeline::run_analyze(&track_id, &loop_wav, probe.duration_sec, &progress)?;
        Ok(result.into())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn save_stem(src_path: String, dest_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::copy(&src_path, &dest_path).map_err(|e| format!("failed to copy: {e}"))?;
        Ok(dest_path)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn save_all_stems(track_id: String, dest_dir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stems_dir = workspace::stems_dir(&track_id)?;
        let dest = std::path::Path::new(&dest_dir);
        std::fs::create_dir_all(dest).map_err(|e| format!("failed to create dest dir: {e}"))?;
        let mut result = Vec::new();
        for entry in std::fs::read_dir(&stems_dir).map_err(|e| format!("failed to read stems dir: {e}"))? {
            let entry = entry.map_err(|e| format!("failed to read entry: {e}"))?;
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("wav") {
                let filename = path.file_name().unwrap();
                let dest_path = dest.join(filename);
                std::fs::copy(&path, &dest_path).map_err(|e| format!("failed to copy stem: {e}"))?;
                result.push(dest_path.to_string_lossy().to_string());
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn open_work_dir(track_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = workspace::work_dir(&track_id)?;
        crate::audio::silent_command("explorer")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| format!("failed to open explorer: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceInfoOut {
    pub index: u32,
    #[serde(rename = "startSec")]
    pub start_sec: f64,
    #[serde(rename = "endSec")]
    pub end_sec: f64,
    pub path: String,
}

#[tauri::command]
pub async fn slice_beats(
    app: AppHandle,
    track_id: String,
    stem_key: Option<String>,
    bpm: f64,
    divisions: u32,
) -> Result<Vec<SliceInfoOut>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress::new(app, track_id.clone());
        progress.report("slice", 0.0, "slicing beats");

        let dir = workspace::work_dir(&track_id)?;
        let (src, key) = match &stem_key {
            Some(k) => {
                let stems_dir = workspace::stems_dir(&track_id)?;
                let entries = std::fs::read_dir(&stems_dir)
                    .map_err(|e| format!("failed to read stems dir: {e}"))?;
                let path = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .find(|p| p.to_string_lossy().contains(k.as_str()))
                    .ok_or_else(|| format!("stem '{k}' not found; call separate_stems first"))?;
                (path, k.clone())
            }
            None => (dir.join("loop.wav"), "loop".to_string()),
        };

        if !src.exists() {
            return Err(format!("source wav not found: {}", src.display()));
        }

        let probe = downloader::probe(&src)?;
        let loop_wav = dir.join("loop.wav");
        let loop_probe = if loop_wav.exists() { downloader::probe(&loop_wav)? } else { probe.clone() };
        let analysis_result = analysis::analyze(&loop_wav, loop_probe.duration_sec)?;

        let out_dir = workspace::slices_dir(&track_id)?;
        let slices = slicer::slice_beats(
            &src,
            &out_dir,
            &key,
            &analysis_result.beat_grid,
            bpm,
            divisions,
            probe.duration_sec,
        )?;

        progress.report("slice", 100.0, "slicing complete");

        Ok(slices
            .into_iter()
            .map(|s| SliceInfoOut {
                index: s.index,
                start_sec: s.start_sec,
                end_sec: s.end_sec,
                path: s.path.to_string_lossy().to_string(),
            })
            .collect())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn engine_status() -> EngineStatus {
    tauri::async_runtime::spawn_blocking(engine::status)
        .await
        .unwrap_or_else(|_| EngineStatus {
            installed: false,
            python_found: false,
            python_path: None,
            venv_path: None,
            torch_version: None,
            cuda: false,
            gpu_name: None,
            models_present: Vec::new(),
            engine_path: String::new(),
            busy: false,
            busy_track_id: None,
        })
}

#[tauri::command]
pub async fn engine_install(app: AppHandle) -> Result<EngineStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let timer = Timer::start();
        engine::install(|p| {
            let _ = app.emit(
                "engine://progress",
                ProgressPayload {
                    stage: p.stage,
                    percent: p.percent,
                    message: p.message,
                    pass: None,
                    failed: None,
                    track_id: None,
                    started_at: Some(timer.started_at().to_string()),
                    elapsed_sec: Some(timer.elapsed_sec()),
                    pass_seconds: None,
                },
            );
        })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// Result of `separate_instruments` (contract v5 addendum "Honest timing"):
/// wraps the stems with honest total timing + per-pass timing, alongside the
/// device used and any passes that failed (chain continues past failures).
/// This is also what gets written to `instruments.json`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparateInstrumentsOut {
    pub stems: Vec<InstrumentStem>,
    pub elapsed_sec: f64,
    pub pass_seconds: HashMap<String, f64>,
    pub device: String,
    pub failed_passes: Vec<engine::FailedPass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_rss_mb: Option<f64>,
}

#[tauri::command]
pub async fn separate_instruments(
    app: AppHandle,
    track_id: String,
    passes: Option<Vec<String>>,
    low_priority: Option<bool>,
) -> Result<SeparateInstrumentsOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress::new(app, track_id.clone());
        let passes = passes.unwrap_or_else(|| {
            engine::DEFAULT_PASSES.iter().map(|s| s.to_string()).collect()
        });
        let result = pipeline::run_instruments(&track_id, &passes, low_priority.unwrap_or(false), |p| {
            progress.report_pass(
                &p.stage,
                p.pass.as_deref().unwrap_or(""),
                p.percent,
                &p.message,
                p.failed,
                &HashMap::new(),
            );
        })?;
        Ok(SeparateInstrumentsOut {
            stems: result.stems,
            elapsed_sec: result.elapsed_sec,
            pass_seconds: result.pass_seconds,
            device: result.device,
            failed_passes: result
                .failed_passes
                .into_iter()
                .map(|(pass, error)| engine::FailedPass { pass, error })
                .collect(),
            seconds: result.seconds,
            peak_rss_mb: result.peak_rss_mb,
        })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// Result of `separate_karaoke` (contract v7 addendum "Karaoke").
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparateKaraokeOut {
    pub stems: Vec<InstrumentStem>,
    pub elapsed_sec: f64,
    pub device: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_rss_mb: Option<f64>,
}

#[tauri::command]
pub async fn separate_karaoke(
    app: AppHandle,
    track_id: String,
    split_lead_backing: Option<bool>,
    low_priority: Option<bool>,
) -> Result<SeparateKaraokeOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress::new(app, track_id.clone());
        let result = pipeline::run_karaoke(&track_id, split_lead_backing.unwrap_or(false), low_priority.unwrap_or(false), |p| {
            progress.report_pass(&p.stage, p.pass.as_deref().unwrap_or(""), p.percent, &p.message, p.failed, &HashMap::new());
        })?;
        Ok(SeparateKaraokeOut {
            stems: result.stems,
            elapsed_sec: result.elapsed_sec,
            device: result.device,
            seconds: result.seconds,
            peak_rss_mb: result.peak_rss_mb,
        })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

// ---------------------------------------------------------------------
// v3: Song library
// ---------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSessionOut {
    pub track: TrackInfo,
    #[serde(rename = "loop")]
    pub loop_info: Option<LoopInfo>,
    pub stems: Option<Vec<StemInfo>>,
    pub instruments: Option<Vec<InstrumentStem>>,
    pub instruments_meta: Option<engine::InstrumentsMeta>,
    pub analysis: Option<LoopAnalysisOut>,
}

#[tauri::command]
pub async fn list_library() -> Result<Vec<library::LibraryEntry>, String> {
    tauri::async_runtime::spawn_blocking(library::list)
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn open_track(track_id: String) -> Result<TrackSessionOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = library::open(&track_id)?;
        Ok(TrackSessionOut {
            track: session.track.into(),
            loop_info: session.loop_info.map(LoopInfo::from),
            stems: session
                .stems
                .map(|stems| stems.into_iter().map(StemInfo::from).collect()),
            instruments: session.instruments,
            instruments_meta: session.instruments_meta,
            analysis: session.analysis.map(LoopAnalysisOut::from),
        })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn set_kept(track_id: String, kept: bool) -> Result<library::LibraryEntry, String> {
    tauri::async_runtime::spawn_blocking(move || library::set_kept(&track_id, kept))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn delete_track(track_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trash::delete_track(&track_id))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySize {
    pub bytes: u64,
    pub tracks: usize,
    pub scans: usize,
    pub samples_bytes: u64,
    pub trash_bytes: u64,
}

#[tauri::command]
pub async fn library_size() -> Result<LibrarySize, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (bytes, tracks, scans) = library::size()?;
        let samples_bytes = samples::samples_dir_size()?;
        let trash_bytes = trash::trash_bytes()?;
        Ok(LibrarySize { bytes, tracks, scans, samples_bytes, trash_bytes })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// Moves every unkept ("scan") track into trash, except `except` (if given).
/// Returns the number of tracks moved.
#[tauri::command]
pub async fn clear_scans(except: Option<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || trash::clear_scans(except.as_deref()))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

// ---------------------------------------------------------------------
// v6: Trash
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn list_trash() -> Result<Vec<trash::TrashEntry>, String> {
    tauri::async_runtime::spawn_blocking(trash::list_trash)
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn restore_trash(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trash::restore_trash(&id))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn empty_trash() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(trash::empty_trash)
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

// ---------------------------------------------------------------------
// v4: Sample library
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn save_sample(
    track_id: String,
    stem_key: String,
    name: Option<String>,
    region: Option<samples::RegionParams>,
) -> Result<samples::Sample, String> {
    tauri::async_runtime::spawn_blocking(move || samples::save_sample(&track_id, &stem_key, name.as_deref(), region))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn cut_region(
    track_id: String,
    stem_key: String,
    start_sec: f64,
    end_sec: f64,
    snap: Option<String>,
    fade_ms: Option<f64>,
    trim_leading_silence: Option<bool>,
) -> Result<cuts::CutResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cuts::cut_region(
            &track_id,
            &stem_key,
            start_sec,
            end_sec,
            snap.as_deref().unwrap_or("none"),
            fade_ms.unwrap_or(5.0),
            trim_leading_silence.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn cut_sample(
    sample_id: String,
    start_sec: f64,
    end_sec: f64,
    fade_ms: Option<f64>,
) -> Result<cuts::CutResult, String> {
    tauri::async_runtime::spawn_blocking(move || cuts::cut_sample(&sample_id, start_sec, end_sec, fade_ms.unwrap_or(5.0)))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn save_sample_part(
    sample_id: String,
    start_sec: f64,
    end_sec: f64,
    name: Option<String>,
) -> Result<samples::Sample, String> {
    tauri::async_runtime::spawn_blocking(move || samples::save_sample_part(&sample_id, start_sec, end_sec, name.as_deref()))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn slice_hits(
    track_id: String,
    stem_key: String,
    min_gap_ms: Option<f64>,
    max_hits: Option<u32>,
) -> Result<Vec<samples::Sample>, String> {
    tauri::async_runtime::spawn_blocking(move || samples::slice_hits(&track_id, &stem_key, min_gap_ms, max_hits))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn list_samples() -> Result<Vec<samples::Sample>, String> {
    tauri::async_runtime::spawn_blocking(samples::list)
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn rename_sample(id: String, name: String) -> Result<samples::Sample, String> {
    tauri::async_runtime::spawn_blocking(move || samples::rename(&id, &name))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn delete_sample(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trash::delete_sample(&id))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn export_samples(ids: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || samples::export(&ids, std::path::Path::new(&dest_dir)))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

// ---------------------------------------------------------------------
// v5: analyze_file, peaks
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn analyze_file(path: String) -> Result<LoopAnalysisOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = analysis::analyze_file(std::path::Path::new(&path))?;
        Ok(result.into())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn reveal_sample(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = samples::path_for_reveal(&id)?;
        crate::audio::silent_command("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| format!("failed to open explorer: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

// ---------------------------------------------------------------------
// v6: Notes
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn extract_notes(
    path: String,
    bpm: Option<f64>,
    kind: Option<String>,
) -> Result<crate::audio::notes::NotesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::audio::notes::extract_notes(std::path::Path::new(&path), bpm, kind.as_deref())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn export_midi(path: String, dest_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::audio::notes::export_midi(std::path::Path::new(&path), std::path::Path::new(&dest_path))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

// ---------------------------------------------------------------------
// v7: Frequencies
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn analyze_frequencies(path: String, bpm: Option<f64>) -> Result<crate::audio::frequencies::FrequencyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::audio::frequencies::analyze_frequencies(std::path::Path::new(&path), bpm)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

// ---------------------------------------------------------------------
// v7: Autotune
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn analyze_pitch(path: String) -> Result<crate::audio::autotune::PitchResult, String> {
    tauri::async_runtime::spawn_blocking(move || crate::audio::autotune::analyze_pitch(std::path::Path::new(&path)))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn apply_autotune(
    path: String,
    edits: serde_json::Value,
    region_start_sec: Option<f64>,
    region_end_sec: Option<f64>,
    pitch_cache_path: Option<String>,
) -> Result<crate::audio::autotune::AutotuneResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::audio::autotune::apply_autotune(
            std::path::Path::new(&path),
            &edits,
            region_start_sec,
            region_end_sec,
            pitch_cache_path.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

// ---------------------------------------------------------------------
// v8: Performance log
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn perf_log() -> Result<Vec<crate::audio::workspace::PerfRow>, String> {
    tauri::async_runtime::spawn_blocking(|| crate::audio::workspace::read_perf_log(100))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}
