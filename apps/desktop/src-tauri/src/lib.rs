pub mod audio;
pub mod pipeline;

#[cfg(feature = "tauri-app")]
pub mod commands;

#[cfg(feature = "tauri-app")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::check_dependencies,
            commands::fetch_audio,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
