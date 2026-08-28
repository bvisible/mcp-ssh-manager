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

# Versions are pinned on purpose. An unpinned install in a setup script hands
# every contributor whatever version is current that day, and the tools below
# gate commits — a silent major bump changes what passes.
echo "📦 Installing pre-commit..."
pip install 'pre-commit==4.0.1'

# eslint and prettier are already devDependencies, at versions the CI gates
# depend on. `npm install --save-dev eslint prettier` would re-resolve both to
# their latest majors (ESLint 10 over the pinned ^8.56.0) and rewrite
# package.json in the contributor's working tree. npm ci installs exactly what
# package-lock.json pins.
echo "📦 Installing Node.js dev dependencies from the lockfile..."
npm ci

# Install Python linting tools
echo "📦 Installing Python linting tools..."
pip install 'black==24.10.0' 'flake8==7.1.1' 'isort==5.13.2'

# Install pre-commit hooks
echo "🔗 Installing git hooks..."
pre-commit install

# Create secrets baseline
echo "🔐 Creating secrets baseline..."
# Pinned: an unpinned install in a setup script gives every developer whatever
# version is current that day, and this one writes the secrets baseline the
# pre-commit hooks then trust.
pip install 'detect-secrets==1.5.0'
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