fn main() {
    // Only run tauri's build script (icon/resource embedding, etc.) when the
    // actual Tauri app is being built. The CLI-only build
    // (`--no-default-features --bin absolutesample-cli`) skips this so it
    // has no dependency on WebView2/MSVC-specific tooling.
    if std::env::var("CARGO_FEATURE_TAURI_APP").is_ok() {
        tauri_build::build()
    }
}
