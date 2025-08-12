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

# Install pre-commit
echo "📦 Installing pre-commit..."
pip install pre-commit

# Install Node.js dev dependencies
echo "📦 Installing Node.js linting tools..."
npm install --save-dev eslint prettier

# Install Python linting tools
echo "📦 Installing Python linting tools..."
pip install black flake8 isort

# Install pre-commit hooks
echo "🔗 Installing git hooks..."
pre-commit install

# Create secrets baseline
echo "🔐 Creating secrets baseline..."
pip install detect-secrets
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