// Automatic smoke test: frontend tests, Rust tests, and a memory-guarded engine run.
// Run: node scripts/smoke.mjs   (also invoked by the git pre-push hook)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const step = (name, cmd, args, opts = {}) => {
  process.stdout.write(`\n=== ${name} ===\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, cwd: root, ...opts });
  if (r.status !== 0) {
    console.error(`\n[smoke] FAILED at: ${name}`);
    process.exit(1);
  }
};

// 1. Frontend unit tests.
step("frontend tests", "pnpm", ["-C", "apps/desktop", "test"]);

// 2. Rust tests (GNU toolchain). Skip if cargo is unavailable.
const cargo = join(process.env.USERPROFILE || process.env.HOME || "", ".cargo", "bin", "cargo.exe");
if (existsSync(cargo)) {
  const mingw = join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages", "BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe", "mingw64", "bin");
  const env = { ...process.env, PATH: `${mingw};${process.env.PATH}` };
  step("rust tests", cargo, ["+stable-x86_64-pc-windows-gnu", "test", "--release", "--no-default-features", "--lib"], { cwd: join(root, "apps/desktop/src-tauri"), env });
} else {
  console.log("\n=== rust tests ===\n[smoke] cargo not found; skipping.");
}

// 3. Memory-guarded engine smoke (skips itself if the engine venv is absent).
// Prefer the engine venv python (it has psutil + the audio deps).
const venvPy = join(process.env.USERPROFILE || process.env.HOME || "", ".absolutesample", "engine", "venv", "Scripts", "python.exe");
const py = existsSync(venvPy) ? venvPy : (process.platform === "win32" ? "python" : "python3");
step("engine memory guard", py, [join(root, "scripts", "engine_smoke.py")]);

console.log("\n[smoke] ALL CHECKS PASSED");
