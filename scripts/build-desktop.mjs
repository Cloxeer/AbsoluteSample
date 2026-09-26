// Build the standalone desktop app: frontend -> dist, then the Rust exe with the frontend
// EMBEDDED (tauri/custom-protocol). Without that feature a plain `cargo build` produces an exe
// that loads http://localhost:1420 and shows a blank window when no dev server is running.
// Run: node scripts/build-desktop.mjs   -> apps/desktop/src-tauri/target/release/absolutesample.exe
import { spawnSync } from "node:child_process";
import { existsSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps", "desktop");
const tauriDir = join(app, "src-tauri");
const mingw = join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages", "BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe", "mingw64", "bin");
const env = { ...process.env, PATH: existsSync(mingw) ? `${mingw};${process.env.PATH}` : process.env.PATH };
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, cwd, env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("npm", ["run", "build"], app);
// The frontend is embedded at compile time; touch the build script so cargo re-embeds new dist.
const now = new Date();
utimesSync(join(tauriDir, "build.rs"), now, now);
const toolchain = process.platform === "win32" && existsSync(mingw) ? ["+stable-x86_64-pc-windows-gnu"] : [];
run("cargo", [...toolchain, "build", "--release", "--features", "tauri/custom-protocol"], tauriDir);
console.log("[build-desktop] standalone exe: apps/desktop/src-tauri/target/release/absolutesample.exe");
