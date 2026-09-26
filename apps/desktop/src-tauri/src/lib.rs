pub mod audio;
pub mod pipeline;

#[cfg(feature = "tauri-app")]
pub mod commands;

#[cfg(feature = "tauri-app")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    audio::trash::prune_trash(audio::trash::DEFAULT_RETENTION_DAYS);
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(feature = "drag")]
    let builder = builder.plugin(tauri_plugin_drag::init());
    builder
        .invoke_handler(tauri::generate_handler![
            commands::check_dependencies,
            commands::fetch_audio,
            commands::import_local,
            commands::trim_loop,
            commands::separate_stems,
            commands::analyze_loop,
            commands::save_stem,
            commands::save_all_stems,
            commands::open_work_dir,
            commands::slice_beats,
            commands::engine_status,
            commands::engine_install,
            commands::separate_instruments,
            commands::list_library,
            commands::open_track,
            commands::set_kept,
            commands::delete_track,
            commands::library_size,
            commands::save_sample,
            commands::list_samples,
            commands::rename_sample,
            commands::delete_sample,
            commands::export_samples,
            commands::reveal_sample,
            commands::analyze_file,
            commands::cut_region,
            commands::cut_sample,
            commands::save_sample_part,
            commands::slice_hits,
            commands::clear_scans,
            commands::list_trash,
            commands::restore_trash,
            commands::empty_trash,
            commands::extract_notes,
            commands::export_midi,
            commands::separate_karaoke,
            commands::analyze_frequencies,
            commands::analyze_pitch,
            commands::apply_autotune,
            commands::perf_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
