// Build the pitch engine (crates/pitchcore) to WebAssembly and write the JS bindings
// into apps/desktop/src/wasm/pitchcore. Run: node scripts/build-wasm.mjs
// Needs: rustup target wasm32-unknown-unknown, wasm-bindgen-cli 0.2.100.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "crates", "pitchcore");
const run = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, cwd: crate, env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const toolchain = process.platform === "win32" ? ["+stable-x86_64-pc-windows-gnu"] : [];
run("cargo", [...toolchain, "build", "--release", "--lib", "--target", "wasm32-unknown-unknown"], {
  RUSTFLAGS: "-C target-feature=+simd128",
});
run("wasm-bindgen", [
  "--target", "web",
  "--out-dir", join(root, "apps", "desktop", "src", "wasm", "pitchcore"),
  join(crate, "target", "wasm32-unknown-unknown", "release", "pitchcore.wasm"),
]);
console.log("[build-wasm] done");
