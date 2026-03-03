#!/usr/bin/env bash
# setup.sh — Install git hooks and verify prerequisites for Sentinel

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Sentinel Setup ==="
echo "Repo: $REPO_DIR"
echo ""

# --- Check prerequisites ---
echo "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install with: brew install node"
  exit 1
fi
echo "  Node.js $(node --version)"

if ! command -v java &>/dev/null; then
  echo "⚠️  Java not found (needed for IBKR Gateway). Install with: brew install openjdk@21"
else
  echo "  Java $(java -version 2>&1 | head -1)"
fi

# --- Install pre-push hook ---
echo ""
echo "Installing pre-push hook..."

HOOK_DIR="$REPO_DIR/.git/hooks"
mkdir -p "$HOOK_DIR"

cat > "$HOOK_DIR/pre-push" << 'HOOK'
#!/usr/bin/env bash
# pre-push hook: run dashboard QA against baseline CSV before allowing push

REPO_DIR="$(git rev-parse --show-toplevel)"
BASELINE="$REPO_DIR/ibkr-api-integration/real_ibkr_baseline.csv"
QA_SCRIPT="$REPO_DIR/dashboard-qa.js"

if [ ! -f "$BASELINE" ]; then
  echo "⚠️  WARNING: No baseline CSV found — skipping QA check"
  exit 0
fi

if [ ! -f "$QA_SCRIPT" ]; then
  echo "❌ dashboard-qa.js not found at $QA_SCRIPT"
  exit 1
fi

echo "Running dashboard QA against baseline CSV..."
OUTPUT=$(node "$QA_SCRIPT" "$BASELINE" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "❌ dashboard-qa.js exited with error code $EXIT_CODE"
  echo "$OUTPUT"
  exit 1
fi

# Check if any BUG lines appear after "BUGS FOUND"
BUG_LINES=$(echo "$OUTPUT" | sed -n '/--- BUGS FOUND ---/,/====/p' | grep '^BUG ')

if [ -n "$BUG_LINES" ]; then
  echo "❌ PUSH BLOCKED — dashboard QA found bugs:"
  echo ""
  echo "$BUG_LINES"
  echo ""
  echo "Fix the bugs above before pushing."
  exit 1
fi

echo "✅ Dashboard QA passed — no bugs detected"
exit 0
HOOK

chmod +x "$HOOK_DIR/pre-push"
echo "  Installed: $HOOK_DIR/pre-push"

# --- Install npm deps for ibkr-api-integration ---
if [ -f "$REPO_DIR/ibkr-api-integration/package.json" ]; then
  echo ""
  echo "Installing ibkr-api-integration dependencies..."
  (cd "$REPO_DIR/ibkr-api-integration" && npm install --silent)
  echo "  Done."
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Start IBKR Gateway:  cd ~/Downloads/clientportal.gw && bin/run.sh root/conf.yaml"
echo "  2. Authenticate at:     https://localhost:5001"
echo "  3. Run spike test:      cd ibkr-api-integration && node run.js --spike"
echo "  4. Generate live CSV:   cd ibkr-api-integration && node run.js"
