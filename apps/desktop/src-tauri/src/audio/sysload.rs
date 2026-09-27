//! System load checks (contract v11 addendum "Resource rule"): free RAM via
//! Win32, GPU memory/utilization via nvidia-smi, a pure `assess()` verdict
//! for "can I split now?", and the resident-model watcher that offloads
//! kept models when a game needs the machine.

use super::silent_command;
use serde::Serialize;
use std::time::Duration;

/// A split needs this much free RAM...
pub const SPLIT_MIN_RAM_GB: f64 = 5.0;
/// ...and, on CUDA, this much free VRAM.
pub const SPLIT_MIN_VRAM_GB: f64 = 3.0;
/// GPU utilization (%) that, while our engine is idle, means something else
/// (a game) is using the GPU.
pub const BUSY_GPU_UTIL: f64 = 50.0;
/// Watcher: offload kept models below/above these.
pub const WATCH_MIN_RAM_GB: f64 = 2.0;
pub const WATCH_MIN_VRAM_GB: f64 = 1.0;
pub const WATCH_GPU_UTIL: f64 = 70.0;
pub const WATCH_PERIOD: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpuSample {
    pub used_mb: f64,
    pub total_mb: f64,
    /// Utilization in percent.
    pub util: f64,
}

impl GpuSample {
    pub fn free_gb(&self) -> f64 {
        ((self.total_mb - self.used_mb) / 1024.0).max(0.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LoadSample {
    pub ram_total_gb: Option<f64>,
    pub ram_free_gb: Option<f64>,
    /// None without an NVIDIA GPU / nvidia-smi (CPU engine).
    pub gpu: Option<GpuSample>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Ok,
    Busy,
    Insufficient,
}

/// `system_load()` result.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemLoad {
    pub ram_total_gb: Option<f64>,
    pub ram_free_gb: Option<f64>,
    pub vram_total_gb: Option<f64>,
    pub vram_free_gb: Option<f64>,
    pub gpu_util: Option<f64>,
    pub verdict: Verdict,
    pub reasons: Vec<String>,
}

/// Parses `nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu
/// --format=csv,noheader,nounits` (first GPU only).
pub fn parse_nvidia_smi(text: &str) -> Option<GpuSample> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut parts = line.split(',').map(|p| p.trim().parse::<f64>().ok());
    let used_mb = parts.next()??;
    let total_mb = parts.next()??;
    let util = parts.next()??;
    (total_mb > 0.0).then_some(GpuSample { used_mb, total_mb, util })
}

/// One nvidia-smi sample, or None when there is no NVIDIA GPU.
pub fn query_gpu() -> Option<GpuSample> {
    let out = silent_command("nvidia-smi")
        .args([
            "--query-gpu=memory.used,memory.total,utilization.gpu",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_nvidia_smi(&String::from_utf8_lossy(&out.stdout))
}

/// (total, free) physical RAM in GiB.
#[cfg(windows)]
pub fn ram_gb() -> Option<(f64, f64)> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: MEMORYSTATUSEX is plain data; dwLength must be set before the call.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return None;
    }
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    Some((status.ullTotalPhys as f64 / GIB, status.ullAvailPhys as f64 / GIB))
}

#[cfg(not(windows))]
pub fn ram_gb() -> Option<(f64, f64)> {
    None
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    Some(v[v.len() / 2])
}

/// Samples RAM once and the GPU `gpu_samples` times 300 ms apart, using the
/// median utilization (a single sample is noisy).
pub fn sample(gpu_samples: usize) -> LoadSample {
    let ram = ram_gb();
    let mut gpus = Vec::new();
    for i in 0..gpu_samples.max(1) {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(300));
        }
        match query_gpu() {
            Some(g) => gpus.push(g),
            None => break,
        }
    }
    let gpu = gpus.last().copied().map(|g| GpuSample {
        util: median(gpus.iter().map(|g| g.util).collect()).unwrap_or(g.util),
        ..g
    });
    LoadSample { ram_total_gb: ram.map(|r| r.0), ram_free_gb: ram.map(|r| r.1), gpu }
}

/// Resource rule for starting a split. `engine_busy`: our own engine job is
/// running (then GPU load is ours, not a game's). `resident_vram_mb`: VRAM
/// held by our kept models, which a split reuses, so it counts as free.
pub fn assess(load: &LoadSample, engine_busy: bool, resident_vram_mb: f64) -> (Verdict, Vec<String>) {
    let mut insufficient = Vec::new();
    let mut busy = Vec::new();
    if let Some(free) = load.ram_free_gb {
        if free < SPLIT_MIN_RAM_GB {
            insufficient.push(format!(
                "Only {free:.1} GB of RAM is free; splitting needs {SPLIT_MIN_RAM_GB:.0} GB. Close some apps."
            ));
        }
    }
    if let Some(gpu) = load.gpu {
        let free = gpu.free_gb() + resident_vram_mb.max(0.0) / 1024.0;
        if free < SPLIT_MIN_VRAM_GB {
            insufficient.push(format!(
                "Only {free:.1} GB of GPU memory is free; splitting needs {SPLIT_MIN_VRAM_GB:.0} GB. Close games or GPU-heavy apps."
            ));
        }
        if !engine_busy && gpu.util >= BUSY_GPU_UTIL {
            busy.push(format!("Your GPU is {:.0}% busy (a game?). Splitting now will be slow and may stutter it.", gpu.util));
        }
    }
    if !insufficient.is_empty() {
        insufficient.extend(busy);
        (Verdict::Insufficient, insufficient)
    } else if !busy.is_empty() {
        (Verdict::Busy, busy)
    } else {
        (Verdict::Ok, Vec::new())
    }
}

/// Samples the machine (3 GPU samples) and assesses it.
pub fn measure(engine_busy: bool, resident_vram_mb: f64) -> SystemLoad {
    let load = sample(3);
    let (verdict, reasons) = assess(&load, engine_busy, resident_vram_mb);
    let round1 = |x: f64| (x * 10.0).round() / 10.0;
    SystemLoad {
        ram_total_gb: load.ram_total_gb.map(round1),
        ram_free_gb: load.ram_free_gb.map(round1),
        vram_total_gb: load.gpu.map(|g| round1(g.total_mb / 1024.0)),
        vram_free_gb: load.gpu.map(|g| round1(g.free_gb())),
        gpu_util: load.gpu.map(|g| g.util),
        verdict,
        reasons,
    }
}

/// The watcher's offload condition for one sample, as a human reason.
pub fn pressure_reason(load: &LoadSample) -> Option<String> {
    if let Some(gpu) = load.gpu {
        if gpu.free_gb() < WATCH_MIN_VRAM_GB {
            return Some("AI models offloaded: your GPU is busy (a game?) and needs the memory.".to_string());
        }
    }
    if load.ram_free_gb.is_some_and(|f| f < WATCH_MIN_RAM_GB) {
        return Some("AI models offloaded: your computer is running low on memory.".to_string());
    }
    if load.gpu.is_some_and(|g| g.util >= WATCH_GPU_UTIL) {
        return Some("AI models offloaded: your GPU is busy (a game?).".to_string());
    }
    None
}

/// Watcher state: offloads only when the pressure condition holds on two
/// consecutive checks (one spike never offloads).
#[derive(Debug, Default)]
pub struct Watcher {
    strikes: u32,
}

impl Watcher {
    /// `load` is None while models aren't kept or the engine is busy (the
    /// watcher does nothing then and forgets earlier strikes).
    pub fn step(&mut self, load: Option<&LoadSample>) -> Option<String> {
        match load.and_then(pressure_reason) {
            Some(reason) => {
                self.strikes += 1;
                if self.strikes >= 2 {
                    self.strikes = 0;
                    Some(reason)
                } else {
                    None
                }
            }
            None => {
                self.strikes = 0;
                None
            }
        }
    }
}

/// Starts the background watcher (idempotent). Every 20 s, while models are
/// kept and the engine is idle, it takes one cheap sample and offloads the
/// models under pressure, emitting `engine://models` with the reason.
pub fn start_watcher() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| {
            let mut watcher = Watcher::default();
            loop {
                std::thread::sleep(WATCH_PERIOD);
                let server = super::engine_server::global();
                let active = server.is_kept() && !super::engine::engine_busy();
                let load = active.then(|| sample(1));
                if let Some(reason) = watcher.step(load.as_ref()) {
                    if let Ok(_gate) = super::engine::acquire_engine("Offloading models") {
                        server.offload(Some(reason));
                    }
                }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(ram_free: f64, gpu: Option<(f64, f64, f64)>) -> LoadSample {
        LoadSample {
            ram_total_gb: Some(32.0),
            ram_free_gb: Some(ram_free),
            gpu: gpu.map(|(used_mb, total_mb, util)| GpuSample { used_mb, total_mb, util }),
        }
    }

    #[test]
    fn parses_nvidia_smi_output() {
        let g = parse_nvidia_smi("5120, 12288, 37\n").unwrap();
        assert_eq!(g, GpuSample { used_mb: 5120.0, total_mb: 12288.0, util: 37.0 });
        assert!((g.free_gb() - 7.0).abs() < 1e-9);
        // Multi-GPU: first line wins.
        assert_eq!(parse_nvidia_smi("\n100, 8192, 5\n200, 4096, 90\n").unwrap().used_mb, 100.0);
        assert!(parse_nvidia_smi("").is_none());
        assert!(parse_nvidia_smi("[N/A], 8192, 5").is_none());
        assert!(parse_nvidia_smi("NVIDIA-SMI has failed").is_none());
    }

    #[test]
    fn idle_machine_is_ok() {
        let (v, r) = assess(&load(16.0, Some((1000.0, 12288.0, 3.0))), false, 0.0);
        assert_eq!(v, Verdict::Ok);
        assert!(r.is_empty());
    }

    #[test]
    fn cpu_only_machine_ignores_gpu_rules() {
        assert_eq!(assess(&load(8.0, None), false, 0.0).0, Verdict::Ok);
        assert_eq!(assess(&load(4.9, None), false, 0.0).0, Verdict::Insufficient);
    }

    #[test]
    fn low_ram_is_insufficient() {
        let (v, r) = assess(&load(4.99, Some((0.0, 12288.0, 0.0))), false, 0.0);
        assert_eq!(v, Verdict::Insufficient);
        assert_eq!(r.len(), 1);
        assert!(r[0].contains("RAM"));
        assert_eq!(assess(&load(5.0, Some((0.0, 12288.0, 0.0))), false, 0.0).0, Verdict::Ok);
    }

    #[test]
    fn low_vram_is_insufficient() {
        // 12 GB card with 9.1 GB used -> 2.9 GB free.
        let (v, r) = assess(&load(16.0, Some((9318.4, 12288.0, 0.0))), false, 0.0);
        assert_eq!(v, Verdict::Insufficient);
        assert!(r[0].contains("GPU memory"));
        // Exactly 3 GB free is enough.
        assert_eq!(assess(&load(16.0, Some((9216.0, 12288.0, 0.0))), false, 0.0).0, Verdict::Ok);
    }

    #[test]
    fn resident_models_count_as_free_vram() {
        // 1.5 GB free, but 2 GB of it is held by our kept models.
        let l = load(16.0, Some((10752.0, 12288.0, 0.0)));
        assert_eq!(assess(&l, false, 0.0).0, Verdict::Insufficient);
        assert_eq!(assess(&l, false, 2048.0).0, Verdict::Ok);
    }

    #[test]
    fn busy_gpu_while_idle_is_busy() {
        let (v, r) = assess(&load(16.0, Some((1000.0, 12288.0, 50.0))), false, 0.0);
        assert_eq!(v, Verdict::Busy);
        assert!(r[0].contains("50%"));
        assert_eq!(assess(&load(16.0, Some((1000.0, 12288.0, 49.9))), false, 0.0).0, Verdict::Ok);
    }

    #[test]
    fn our_own_gpu_load_is_not_busy() {
        assert_eq!(assess(&load(16.0, Some((1000.0, 12288.0, 99.0))), true, 0.0).0, Verdict::Ok);
    }

    #[test]
    fn insufficient_wins_over_busy_and_keeps_all_reasons() {
        let (v, r) = assess(&load(1.0, Some((11264.0, 12288.0, 95.0))), false, 0.0);
        assert_eq!(v, Verdict::Insufficient);
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn verdict_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&Verdict::Insufficient).unwrap(), "\"insufficient\"");
        let s = SystemLoad {
            ram_total_gb: Some(32.0),
            ram_free_gb: Some(20.0),
            vram_total_gb: None,
            vram_free_gb: None,
            gpu_util: None,
            verdict: Verdict::Ok,
            reasons: vec![],
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["ramFreeGb"], 20.0);
        assert!(v["vramFreeGb"].is_null());
        assert_eq!(v["verdict"], "ok");
    }

    #[test]
    fn pressure_reasons() {
        assert!(pressure_reason(&load(16.0, Some((1000.0, 12288.0, 10.0)))).is_none());
        assert!(pressure_reason(&load(16.0, Some((11500.0, 12288.0, 10.0)))).unwrap().contains("needs the memory"));
        assert!(pressure_reason(&load(1.5, None)).unwrap().contains("low on memory"));
        assert!(pressure_reason(&load(16.0, Some((1000.0, 12288.0, 70.0)))).unwrap().contains("GPU is busy"));
        assert!(pressure_reason(&load(16.0, Some((1000.0, 12288.0, 69.0)))).is_none());
    }

    #[test]
    fn watcher_needs_two_strikes_in_a_row() {
        let hot = load(16.0, Some((1000.0, 12288.0, 90.0)));
        let calm = load(16.0, Some((1000.0, 12288.0, 5.0)));
        let mut w = Watcher::default();
        assert!(w.step(Some(&hot)).is_none());
        assert!(w.step(Some(&calm)).is_none(), "a calm sample resets the streak");
        assert!(w.step(Some(&hot)).is_none());
        assert!(w.step(Some(&hot)).is_some());
        assert!(w.step(Some(&hot)).is_none(), "streak restarts after an offload");
        assert!(w.step(None).is_none(), "not kept / busy resets");
        assert!(w.step(Some(&hot)).is_none());
    }
}
