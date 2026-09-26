#!/usr/bin/env bash
# Install a git pre-push hook that runs the smoke suite and blocks bad pushes.
set -e
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hook="$root/.git/hooks/pre-push"
cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
# gh-pages holds only the built static web demo (no source, nothing that runs on this
# machine), so a push that updates ONLY gh-pages skips the code checks. Any other ref runs them.
only_pages=1
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$remote_ref" = "refs/heads/gh-pages" ] || only_pages=0
done
if [ "$only_pages" = 1 ]; then
  echo "[pre-push] gh-pages only (static web build): no code to test."
  exit 0
fi
main_root="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
echo "[pre-push] running smoke suite (node scripts/smoke.mjs)..."
node "$main_root/scripts/smoke.mjs" || {
  echo "[pre-push] BLOCKED: smoke suite failed. Push aborted to protect your machine."
  exit 1
}
HOOK
chmod +x "$hook"
echo "installed pre-push hook at $hook"
