//! Thin #[tauri::command] wrappers around the audio/pipeline modules.
//! All blocking work runs via `tauri::async_runtime::spawn_blocking`;
//! progress is emitted on the `"pipeline://progress"` event.

use crate::audio::engine::{self, EngineStatus, InstrumentStem};
use crate::audio::progress::Progress;
use crate::audio::{analysis, downloader, library, samples, slicer, workspace};
use crate::pipeline;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

struct TauriProgress {
    app: AppHandle,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    stage: String,
    percent: f32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pass: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failed: Option<bool>,
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
            },
        );
    }
}

impl TauriProgress {
    /// Emits a progress event carrying the separation `pass` name and
    /// whether that pass failed, for `separate_instruments`.
    fn report_pass(&self, stage: &str, pass: &str, percent: f32, msg: &str, failed: bool) {
        let _ = self.app.emit(
            "pipeline://progress",
            ProgressPayload {
                stage: stage.to_string(),
                percent,
                message: msg.to_string(),
                pass: Some(pass.to_string()),
                failed: if failed { Some(true) } else { None },
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
        }
    }
}

#[tauri::command]
pub async fn fetch_audio(
    app: AppHandle,
    url: String,
    force: Option<bool>,
    current_track_id: Option<String>,
) -> Result<TrackInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress { app };
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
        let progress = TauriProgress { app };
        let dir = workspace::work_dir(&track_id)?;
        // Find source.<ext> in the work dir.
        let source_path = std::fs::read_dir(&dir)
            .map_err(|e| format!("failed to read work dir: {e}"))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| {
                p.file_stem().and_then(|s| s.to_str()) == Some("source")
                    && p.extension().and_then(|e| e.to_str()) != Some("wav")
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
        }
    }
}

#[tauri::command]
pub async fn separate_stems(app: AppHandle, track_id: String) -> Result<Vec<StemInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress { app };
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
        }
    }
}

#[tauri::command]
pub async fn analyze_loop(app: AppHandle, track_id: String) -> Result<LoopAnalysisOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress { app };
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
        let progress = TauriProgress { app };
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
        })
}

#[tauri::command]
pub async fn engine_install(app: AppHandle) -> Result<EngineStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        engine::install(|p| {
            let _ = app.emit(
                "engine://progress",
                ProgressPayload {
                    stage: p.stage,
                    percent: p.percent,
                    message: p.message,
                    pass: None,
                    failed: None,
                },
            );
        })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn separate_instruments(
    app: AppHandle,
    track_id: String,
    passes: Option<Vec<String>>,
) -> Result<Vec<InstrumentStem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = TauriProgress { app };
        let dir = workspace::work_dir(&track_id)?;
        let loop_wav = dir.join("loop.wav");
        if !loop_wav.exists() {
            return Err("loop.wav not found; call trim_loop first".to_string());
        }
        let passes = passes.unwrap_or_else(|| {
            engine::DEFAULT_PASSES.iter().map(|s| s.to_string()).collect()
        });
        let (stems, _device, _failed_passes) =
            engine::separate(&loop_wav, &dir, &passes, |p| {
                progress.report_pass(
                    &p.stage,
                    p.pass.as_deref().unwrap_or(""),
                    p.percent,
                    &p.message,
                    p.failed,
                );
            })?;
        Ok(stems)
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
    tauri::async_runtime::spawn_blocking(move || library::delete(&track_id))
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
}

#[tauri::command]
pub async fn library_size() -> Result<LibrarySize, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (bytes, tracks, scans) = library::size()?;
        let samples_bytes = samples::samples_dir_size()?;
        Ok(LibrarySize { bytes, tracks, scans, samples_bytes })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

// ---------------------------------------------------------------------
// v4: Sample library
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn save_sample(track_id: String, stem_key: String, name: Option<String>) -> Result<samples::Sample, String> {
    tauri::async_runtime::spawn_blocking(move || samples::save_sample(&track_id, &stem_key, name.as_deref()))
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
    tauri::async_runtime::spawn_blocking(move || samples::delete(&id))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn export_samples(ids: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || samples::export(&ids, std::path::Path::new(&dest_dir)))
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
