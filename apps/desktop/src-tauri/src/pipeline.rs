//! High-level fetch -> trim -> stems -> analyze pipeline shared by the CLI
//! `run` subcommand and (indirectly) the Tauri commands.

use crate::audio::engine::{EngineStatus, InstrumentStem};
use crate::audio::progress::Progress;
use crate::audio::{analysis, downloader, dsp_filters, engine, library, slicer, workspace};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Which separation engine `run_full` should use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Bands,
    Ai,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackManifest {
    pub id: String,
    pub title: String,
    pub url: String,
    pub source_path: String,
    pub wav_path: String,
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub codec: String,
    pub work_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopManifest {
    pub track_id: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub duration_sec: f64,
    pub loop_path: String,
    pub wav_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemManifest {
    pub index: u32,
    pub key: String,
    pub label: String,
    pub band: String,
    pub path: String,
    pub bytes: u64,
    pub peak_db: f64,
    pub rms_db: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub track: TrackManifest,
    #[serde(rename = "loop")]
    pub loop_info: LoopManifest,
    pub stems: Vec<StemManifest>,
    pub analysis: analysis::LoopAnalysis,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruments: Option<Vec<InstrumentStem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<EngineStatus>,
}

/// Looks for an existing `source.<ext>` (non-wav) + `source.wav` pair in
/// `dir`, returning the non-wav source's path if both are present.
fn existing_source_pair(dir: &Path) -> Option<PathBuf> {
    let wav = dir.join("source.wav");
    if !wav.exists() {
        return None;
    }
    std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| {
        p.file_stem().and_then(|s| s.to_str()) == Some("source")
            && p.extension().and_then(|e| e.to_str()) != Some("wav")
    })
}

/// fetch: normalizes the URL (YouTube forms), prunes unkept/unsplit work
/// dirs, and returns the cached `track.json` if `dir/source.<ext>` +
/// `dir/source.wav` already exist (unless `force`). Otherwise runs yt-dlp
/// download + ffprobe + decode source.wav, then writes `track.json` and
/// `state.json`.
pub fn run_fetch(
    url: &str,
    force: bool,
    current_track_id: Option<&str>,
    progress: &dyn Progress,
) -> Result<TrackManifest, String> {
    let normalized = library::normalize_youtube_url(url);
    let (fetch_url, known_id) = match &normalized {
        Some((id, canonical)) => (canonical.clone(), Some(id.clone())),
        None => (url.to_string(), None),
    };

    // Never deletes `known_id`'s dir (the one being fetched) or the
    // currently open track's dir, even if either would otherwise qualify.
    let except: Vec<&str> = [known_id.as_deref(), current_track_id].into_iter().flatten().collect();
    let _ = library::prune_unkept(&except);

    if !force {
        if let Some(id) = &known_id {
            let dir = workspace::work_dir(id)?;
            if existing_source_pair(&dir).is_some() {
                if let Some(cached) = library::read_track(id)? {
                    progress.report("download", 100.0, "using cached track");
                    progress.report("decode", 100.0, "fetch complete (cached)");
                    return Ok(cached);
                }
            }
        }
    }

    progress.report("download", 0.0, "starting yt-dlp download");

    // Download into a temp-ish workdir keyed by a url hash first; we relocate
    // once we know the real id (yt-dlp gives it back in the JSON).
    let tmp_id = downloader::hash_id(&fetch_url);
    let tmp_dir = workspace::work_dir(&tmp_id)?;

    let dl = downloader::download(&fetch_url, &tmp_dir)?;
    progress.report("download", 60.0, &format!("downloaded: {}", dl.title));

    // Move into the final workdir named by the real id (if different).
    let final_dir = workspace::work_dir(&dl.id)?;
    let final_source = final_dir.join(format!("source.{}", dl.ext));
    if final_dir != tmp_dir {
        std::fs::rename(&dl.source_path, &final_source)
            .or_else(|_| std::fs::copy(&dl.source_path, &final_source).map(|_| ()))
            .map_err(|e| format!("failed to relocate downloaded file: {e}"))?;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    progress.report("decode", 70.0, "probing metadata");
    let probe = downloader::probe(&final_source)?;

    progress.report("decode", 80.0, "decoding source.wav");
    let wav_path = final_dir.join("source.wav");
    slicer::decode_to_wav(&final_source, &wav_path)?;

    progress.report("decode", 100.0, "fetch complete");

    let track = TrackManifest {
        id: dl.id,
        title: dl.title,
        url: fetch_url,
        source_path: final_source.to_string_lossy().to_string(),
        wav_path: wav_path.to_string_lossy().to_string(),
        duration_sec: probe.duration_sec,
        sample_rate: probe.sample_rate,
        channels: probe.channels,
        codec: probe.codec,
        work_dir: final_dir.to_string_lossy().to_string(),
    };

    library::write_track(&track.id, &track)?;
    let mut state = library::load_state(&track.id);
    let now = library::now_rfc3339();
    if !force {
        // Preserve the original fetchedAt on a fresh (non-forced) fetch of a
        // brand-new id; load_state's default already set it to `now`.
    } else {
        state.fetched_at = now.clone();
    }
    state.last_opened_at = now;
    library::write_state(&track.id, &state)?;

    Ok(track)
}

/// trim: copy-trim source.<ext> -> loop.<ext>, then decode loop.wav.
pub fn run_trim(
    track_id: &str,
    source_path: &Path,
    start_sec: f64,
    end_sec: f64,
    progress: &dyn Progress,
) -> Result<LoopManifest, String> {
    progress.report("trim", 0.0, "trimming loop");
    let dir = workspace::work_dir(track_id)?;
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("webm");
    let loop_path = dir.join(format!("loop.{ext}"));
    slicer::trim_copy(source_path, &loop_path, start_sec, end_sec)?;

    progress.report("trim", 60.0, "decoding loop.wav");
    let wav_path = dir.join("loop.wav");
    slicer::decode_to_wav(&loop_path, &wav_path)?;

    progress.report("trim", 100.0, "trim complete");

    let loop_info = LoopManifest {
        track_id: track_id.to_string(),
        start_sec,
        end_sec,
        duration_sec: end_sec - start_sec,
        loop_path: loop_path.to_string_lossy().to_string(),
        wav_path: wav_path.to_string_lossy().to_string(),
    };

    let mut state = library::load_state(track_id);
    state.loop_info = Some(loop_info.clone());
    library::write_state(track_id, &state)?;

    Ok(loop_info)
}

/// stems: single ffmpeg filter_complex pass over loop.wav -> 4 wavs + astats.
pub fn run_stems(
    track_id: &str,
    loop_wav: &Path,
    progress: &dyn Progress,
) -> Result<Vec<StemManifest>, String> {
    progress.report("stems", 0.0, "splitting stems");
    let stems_dir = workspace::stems_dir(track_id)?;
    let paths = dsp_filters::split_stems(loop_wav, &stems_dir)?;

    let mut result = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let pct = 60.0 + (i as f32 / 4.0) * 30.0;
        progress.report("stems", pct, &format!("measuring loudness: {}", dsp_filters::STEM_KEYS[i]));
        let loudness = dsp_filters::measure_loudness(path)?;
        let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        result.push(StemManifest {
            index: (i + 1) as u32,
            key: dsp_filters::STEM_KEYS[i].to_string(),
            label: dsp_filters::STEM_LABELS[i].to_string(),
            band: dsp_filters::STEM_BANDS[i].to_string(),
            path: path.to_string_lossy().to_string(),
            bytes,
            peak_db: loudness.peak_db,
            rms_db: loudness.rms_db,
        });
    }

    progress.report("stems", 100.0, "stems complete");
    Ok(result)
}

/// analyze: pure-Rust onset/BPM analysis over loop.wav. Persists the result
/// into `state.json`'s `analysis` field.
pub fn run_analyze(
    track_id: &str,
    loop_wav: &Path,
    duration_sec: f64,
    progress: &dyn Progress,
) -> Result<analysis::LoopAnalysis, String> {
    progress.report("analyze", 0.0, "analyzing loop");
    let result = analysis::analyze(loop_wav, duration_sec)?;
    progress.report("analyze", 100.0, "analysis complete");

    let mut state = library::load_state(track_id);
    state.analysis = Some(result.clone());
    library::write_state(track_id, &state)?;

    Ok(result)
}

/// Full fetch -> trim -> stems -> analyze pipeline. Writes `manifest.json`
/// into `out_dir` and copies the 4 stem wavs + loop.wav alongside it.
pub fn run_full(
    url: &str,
    start_sec: f64,
    end_sec: f64,
    out_dir: &Path,
    engine_choice: Engine,
    progress: &dyn Progress,
) -> Result<Manifest, String> {
    let track = run_fetch(url, false, None, progress)?;
    let loop_info = run_trim(
        &track.id,
        Path::new(&track.source_path),
        start_sec,
        end_sec,
        progress,
    )?;
    // The band split is cheap, so it always runs regardless of engine choice.
    let stems = run_stems(&track.id, Path::new(&loop_info.wav_path), progress)?;
    let analysis = run_analyze(&track.id, Path::new(&loop_info.wav_path), loop_info.duration_sec, progress)?;

    let (instruments, engine_status) = if engine_choice == Engine::Ai {
        let work_dir = workspace::work_dir(&track.id)?;
        let passes: Vec<String> = engine::DEFAULT_PASSES.iter().map(|s| s.to_string()).collect();
        let (stems, _device, _failed) = engine::separate(
            Path::new(&loop_info.wav_path),
            &work_dir,
            &passes,
            |p| progress.report(&p.stage, p.percent, &p.message),
        )?;
        (Some(stems), Some(engine::status()))
    } else {
        (None, None)
    };

    let manifest = Manifest {
        track,
        loop_info,
        stems,
        analysis,
        instruments,
        engine: engine_status,
    };

    std::fs::create_dir_all(out_dir).map_err(|e| format!("failed to create out dir: {e}"))?;

    // Copy loop.wav + stems into out_dir.
    let loop_wav_src = Path::new(&manifest.loop_info.wav_path);
    let loop_wav_dest = out_dir.join("loop.wav");
    std::fs::copy(loop_wav_src, &loop_wav_dest)
        .map_err(|e| format!("failed to copy loop.wav to out dir: {e}"))?;

    for stem in &manifest.stems {
        let src = Path::new(&stem.path);
        let filename = src
            .file_name()
            .ok_or_else(|| "stem path has no filename".to_string())?;
        let dest = out_dir.join(filename);
        std::fs::copy(src, &dest).map_err(|e| format!("failed to copy stem to out dir: {e}"))?;
    }

    // Copy instruments/*.wav into out_dir/instruments/ (separate from the
    // workspace instruments dir already produced by `engine::separate`).
    if let Some(instruments) = &manifest.instruments {
        let instruments_dest_dir = out_dir.join("instruments");
        std::fs::create_dir_all(&instruments_dest_dir)
            .map_err(|e| format!("failed to create out instruments dir: {e}"))?;
        for stem in instruments {
            let src = Path::new(&stem.path);
            let filename = src
                .file_name()
                .ok_or_else(|| "instrument stem path has no filename".to_string())?;
            let dest = instruments_dest_dir.join(filename);
            std::fs::copy(src, &dest)
                .map_err(|e| format!("failed to copy instrument stem to out dir: {e}"))?;
        }
    }

    let manifest_path = out_dir.join("manifest.json");
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("failed to serialize manifest: {e}"))?;
    std::fs::write(&manifest_path, manifest_json)
        .map_err(|e| format!("failed to write manifest.json: {e}"))?;

    progress.report("analyze", 100.0, "pipeline complete");

    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_enum_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&Engine::Bands).unwrap(), "\"bands\"");
        assert_eq!(serde_json::to_string(&Engine::Ai).unwrap(), "\"ai\"");
        let parsed: Engine = serde_json::from_str("\"ai\"").unwrap();
        assert_eq!(parsed, Engine::Ai);
    }
}
