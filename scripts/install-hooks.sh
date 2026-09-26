#!/usr/bin/env bash
# Install a git pre-push hook that runs the smoke suite and blocks bad pushes.
set -e
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hook="$root/.git/hooks/pre-push"
cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
echo "[pre-push] running smoke suite (node scripts/smoke.mjs)..."
node "$(git rev-parse --show-toplevel)/scripts/smoke.mjs" || {
  echo "[pre-push] BLOCKED: smoke suite failed. Push aborted to protect your machine."
  exit 1
}
HOOK
chmod +x "$hook"
echo "installed pre-push hook at $hook"
