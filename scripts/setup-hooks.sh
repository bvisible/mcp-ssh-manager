#!/bin/bash

echo "🔧 Setting up Git hooks for code quality..."
echo "=========================================="
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not installed."
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    exit 1
fi

# Versions AND hashes are pinned. An unpinned install in a setup script hands
# every contributor whatever version is current that day, and these tools gate
# commits (detect-secrets even writes the baseline the hooks then trust). The
# lock covers every transitive dependency; --require-hashes refuses any file
# whose hash is not in it. Regenerate it from requirements-dev.in (see there).
echo "📦 Installing pre-commit, black, flake8, isort and detect-secrets..."
pip install --require-hashes -r "$(dirname "$0")/requirements-dev.txt"

# eslint and prettier are already devDependencies, at versions the CI gates
# depend on. `npm install --save-dev eslint prettier` would re-resolve both to
# their latest majors (ESLint 10 over the pinned ^8.56.0) and rewrite
# package.json in the contributor's working tree. npm ci installs exactly what
# package-lock.json pins.
echo "📦 Installing Node.js dev dependencies from the lockfile..."
npm ci

# Install pre-commit hooks
echo "🔗 Installing git hooks..."
pre-commit install

# Create secrets baseline
echo "🔐 Creating secrets baseline..."
detect-secrets scan > .secrets.baseline

# Run hooks on all files (optional first run)
echo ""
echo "🧪 Testing hooks on existing files..."
pre-commit run --all-files || true

echo ""
echo "✅ Git hooks setup complete!"
echo ""
echo "The following checks will run before each commit:"
echo "  ✓ JavaScript syntax checking"
echo "  ✓ Python syntax checking"
echo "  ✓ ESLint (JavaScript linting)"
echo "  ✓ Black (Python formatting)"
echo "  ✓ Flake8 (Python linting)"
echo "  ✓ Prettier (code formatting)"
echo "  ✓ Secret detection"
echo "  ✓ Trailing whitespace removal"
echo "  ✓ Large file prevention"
echo ""
echo "To skip hooks temporarily: git commit --no-verify"
echo "To run hooks manually: pre-commit run --all-files"