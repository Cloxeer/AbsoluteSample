// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "tauri-app")]
fn main() {
    absolutesample_lib::run();
}

#[cfg(not(feature = "tauri-app"))]
fn main() {
    eprintln!("absolutesample was built without the `tauri-app` feature; use absolutesample-cli instead.");
    std::process::exit(1);
}
