use absolutesample_lib::audio::engine::{self, EngineProgress};
use absolutesample_lib::audio::progress::Stdout;
use absolutesample_lib::audio::{downloader, library, samples, workspace};
use absolutesample_lib::pipeline::{self, Engine};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

fn eprint_engine_progress(p: &EngineProgress) {
    let payload = serde_json::json!({
        "stage": p.stage,
        "percent": p.percent,
        "message": p.message,
        "pass": p.pass,
        "failed": p.failed,
    });
    eprintln!("{payload}");
}

#[derive(Parser)]
#[command(name = "absolutesample-cli", about = "AbsoluteSample backend CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Check ffmpeg/ffprobe/yt-dlp availability.
    Deps,
    /// Download bestaudio for a URL (any youtu.be/watch/shorts/embed form).
    Fetch {
        #[arg(long)]
        url: String,
        /// Re-download even if a cached source.<ext>+source.wav pair exists.
        #[arg(long)]
        force: bool,
        /// The currently open track's id, if any; never pruned by this fetch.
        #[arg(long)]
        current: Option<String>,
    },
    /// Trim a previously fetched track.
    Trim {
        #[arg(long)]
        track_id: String,
        #[arg(long)]
        start: f64,
        #[arg(long)]
        end: f64,
    },
    /// Split a trimmed loop into 4 stems.
    Stems {
        #[arg(long)]
        track_id: String,
    },
    /// Analyze a trimmed loop (BPM/onsets/beat grid).
    Analyze {
        #[arg(long)]
        track_id: String,
    },
    /// Analyze any wav file (BPM/onsets/beat grid), caching the result under
    /// `<workdir>/analysis/<stem>.json` when `path` is inside a work dir.
    AnalyzeFile {
        path: PathBuf,
    },
    /// Full pipeline: fetch -> trim -> stems -> analyze (-> instruments with --engine ai).
    Run {
        #[arg(long)]
        url: String,
        #[arg(long)]
        start: f64,
        #[arg(long)]
        end: f64,
        #[arg(long)]
        out: PathBuf,
        /// Which separation engine to use: "bands" (default) or "ai".
        #[arg(long, default_value = "bands")]
        engine: String,
    },
    /// AI instrument separation engine management.
    Engine {
        #[command(subcommand)]
        action: EngineAction,
    },
    /// Run AI instrument separation on a previously trimmed track.
    Instruments {
        #[arg(long)]
        track: String,
        /// Comma-separated pass list (default: instruments,vocals,lead,drums,tag).
        #[arg(long)]
        passes: Option<String>,
    },
    /// Song library management.
    Library {
        #[command(subcommand)]
        action: LibraryAction,
    },
    /// Sample library management.
    Samples {
        #[command(subcommand)]
        action: SamplesAction,
    },
}

#[derive(Subcommand)]
enum SamplesAction {
    /// List every saved sample.
    List,
    /// Save a clip from a track's stem/instrument/loop wav as a named sample.
    Save {
        track_id: String,
        stem_key: String,
        #[arg(long)]
        name: Option<String>,
    },
    /// Delete a saved sample.
    Delete { id: String },
    /// Export samples to a destination directory.
    Export { dest_dir: String, ids: Vec<String> },
}

#[derive(Subcommand)]
enum LibraryAction {
    /// List every fetched track.
    List,
    /// Open a track (rebuilds stem/instrument info, touches lastOpenedAt).
    Open {
        track_id: String,
    },
    /// Toggle (or set) a track's `kept` flag.
    Keep {
        track_id: String,
        /// Turn `kept` off instead of on.
        #[arg(long)]
        off: bool,
    },
    /// Delete a track's entire work dir.
    Delete {
        track_id: String,
    },
    /// Total library size (bytes + track count).
    Size,
}

#[derive(Subcommand)]
enum EngineAction {
    /// Report engine install status (never fails; prints JSON).
    Status,
    /// Install the AI separation engine (Python venv, torch, audio-separator).
    Install,
}

fn print_json<T: serde::Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(s) => println!("{s}"),
        Err(e) => eprintln!("failed to serialize output: {e}"),
    }
}

fn print_err(context: &str, err: &str) -> ExitCode {
    let payload = serde_json::json!({ "error": true, "context": context, "message": err });
    eprintln!("{payload}");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let progress = Stdout;

    match cli.command {
        Commands::Deps => {
            let ffmpeg = absolutesample_lib::audio::version_string("ffmpeg", "-version");
            let ffprobe = absolutesample_lib::audio::version_string("ffprobe", "-version");
            let ytdlp = downloader::version();
            let ok = ffmpeg.is_some() && ffprobe.is_some() && ytdlp.is_some();
            print_json(&serde_json::json!({
                "ffmpeg": ffmpeg,
                "ffprobe": ffprobe,
                "ytdlp": ytdlp,
                "ok": ok,
            }));
            if ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Commands::Fetch { url, force, current } => match pipeline::run_fetch(&url, force, current.as_deref(), &progress) {
            Ok(track) => {
                print_json(&track);
                ExitCode::SUCCESS
            }
            Err(e) => print_err("fetch", &e),
        },
        Commands::Trim { track_id, start, end } => {
            let dir = match workspace::work_dir(&track_id) {
                Ok(d) => d,
                Err(e) => return print_err("trim", &e),
            };
            let source_path = std::fs::read_dir(&dir)
                .ok()
                .and_then(|entries| {
                    entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.path())
                        .find(|p| {
                            p.file_stem().and_then(|s| s.to_str()) == Some("source")
                                && p.extension().and_then(|e| e.to_str()) != Some("wav")
                        })
                })
                .or_else(|| {
                    let wav = dir.join("source.wav");
                    if wav.exists() { Some(wav) } else { None }
                });
            let source_path = match source_path {
                Some(p) => p,
                None => return print_err("trim", "source file not found; run `fetch` first"),
            };
            match pipeline::run_trim(&track_id, &source_path, start, end, &progress) {
                Ok(loop_info) => {
                    print_json(&loop_info);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("trim", &e),
            }
        }
        Commands::Stems { track_id } => {
            let dir = match workspace::work_dir(&track_id) {
                Ok(d) => d,
                Err(e) => return print_err("stems", &e),
            };
            let loop_wav = dir.join("loop.wav");
            if !loop_wav.exists() {
                return print_err("stems", "loop.wav not found; run `trim` first");
            }
            match pipeline::run_stems(&track_id, &loop_wav, &progress) {
                Ok(stems) => {
                    print_json(&stems);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("stems", &e),
            }
        }
        Commands::Analyze { track_id } => {
            let dir = match workspace::work_dir(&track_id) {
                Ok(d) => d,
                Err(e) => return print_err("analyze", &e),
            };
            let loop_wav = dir.join("loop.wav");
            if !loop_wav.exists() {
                return print_err("analyze", "loop.wav not found; run `trim` first");
            }
            let probe = match downloader::probe(&loop_wav) {
                Ok(p) => p,
                Err(e) => return print_err("analyze", &e),
            };
            match pipeline::run_analyze(&track_id, &loop_wav, probe.duration_sec, &progress) {
                Ok(analysis) => {
                    print_json(&analysis);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("analyze", &e),
            }
        }
        Commands::AnalyzeFile { path } => match absolutesample_lib::audio::analysis::analyze_file(&path) {
            Ok(result) => {
                print_json(&result);
                ExitCode::SUCCESS
            }
            Err(e) => print_err("analyze-file", &e),
        },
        Commands::Run { url, start, end, out, engine: engine_arg } => {
            let engine_choice = match engine_arg.as_str() {
                "ai" => Engine::Ai,
                "bands" => Engine::Bands,
                other => return print_err("run", &format!("invalid --engine value: {other} (expected \"ai\" or \"bands\")")),
            };
            match pipeline::run_full(&url, start, end, &out, engine_choice, &progress) {
                Ok(manifest) => {
                    print_json(&manifest);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("run", &e),
            }
        }
        Commands::Engine { action } => match action {
            EngineAction::Status => {
                let status = engine::status();
                print_json(&status);
                ExitCode::SUCCESS
            }
            EngineAction::Install => match engine::install(|p| eprint_engine_progress(&p)) {
                Ok(status) => {
                    print_json(&status);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("engine install", &e),
            },
        },
        Commands::Instruments { track, passes } => {
            let dir = match workspace::work_dir(&track) {
                Ok(d) => d,
                Err(e) => return print_err("instruments", &e),
            };
            let loop_wav = dir.join("loop.wav");
            if !loop_wav.exists() {
                return print_err("instruments", "loop.wav not found; run `trim` first");
            }
            let passes: Vec<String> = match passes {
                Some(p) => p.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
                None => engine::DEFAULT_PASSES.iter().map(|s| s.to_string()).collect(),
            };
            match engine::separate(&loop_wav, &dir, &passes, |p| eprint_engine_progress(&p)) {
                Ok(result) => {
                    print_json(&result.stems);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("instruments", &e),
            }
        }
        Commands::Library { action } => match action {
            LibraryAction::List => match library::list() {
                Ok(entries) => {
                    print_json(&entries);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("library list", &e),
            },
            LibraryAction::Open { track_id } => match library::open(&track_id) {
                Ok(session) => {
                    print_json(&session);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("library open", &e),
            },
            LibraryAction::Keep { track_id, off } => match library::set_kept(&track_id, !off) {
                Ok(entry) => {
                    print_json(&entry);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("library keep", &e),
            },
            LibraryAction::Delete { track_id } => match library::delete(&track_id) {
                Ok(()) => {
                    print_json(&serde_json::json!({ "deleted": track_id }));
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("library delete", &e),
            },
            LibraryAction::Size => match library::size() {
                Ok((bytes, tracks, scans)) => {
                    let samples_bytes = samples::samples_dir_size().unwrap_or(0);
                    print_json(&serde_json::json!({
                        "bytes": bytes,
                        "tracks": tracks,
                        "scans": scans,
                        "samplesBytes": samples_bytes,
                    }));
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("library size", &e),
            },
        },
        Commands::Samples { action } => match action {
            SamplesAction::List => match samples::list() {
                Ok(list) => {
                    print_json(&list);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("samples list", &e),
            },
            SamplesAction::Save { track_id, stem_key, name } => {
                match samples::save_sample(&track_id, &stem_key, name.as_deref()) {
                    Ok(sample) => {
                        print_json(&sample);
                        ExitCode::SUCCESS
                    }
                    Err(e) => print_err("samples save", &e),
                }
            }
            SamplesAction::Delete { id } => match samples::delete(&id) {
                Ok(()) => {
                    print_json(&serde_json::json!({ "deleted": id }));
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("samples delete", &e),
            },
            SamplesAction::Export { dest_dir, ids } => match samples::export(&ids, PathBuf::from(&dest_dir).as_path()) {
                Ok(paths) => {
                    print_json(&paths);
                    ExitCode::SUCCESS
                }
                Err(e) => print_err("samples export", &e),
            },
        },
    }
}
