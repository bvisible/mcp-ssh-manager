#!/bin/bash

# Quick validation script to check code quality
# Can be run manually or in CI/CD

echo "🔍 MCP SSH Manager - Code Validation"
echo "====================================="
echo ""

ERRORS=0

# Check JavaScript syntax
echo "📋 Checking JavaScript syntax..."
if node --check src/index.js 2>/dev/null; then
    echo "  ✅ JavaScript syntax is valid"
else
    echo "  ❌ JavaScript syntax error!"
    ERRORS=$((ERRORS + 1))
fi

# Check Python syntax
echo "📋 Checking Python syntax..."
PYTHON_FILES=$(find tools -name "*.py" 2>/dev/null)
PYTHON_OK=true
for file in $PYTHON_FILES; do
    if ! python3 -m py_compile "$file" 2>/dev/null; then
        echo "  ❌ Python syntax error in $file"
        PYTHON_OK=false
        ERRORS=$((ERRORS + 1))
    fi
done
if [ "$PYTHON_OK" = true ]; then
    echo "  ✅ Python syntax is valid"
fi

# Check for .env in git
echo "📋 Checking for sensitive files..."
if git ls-files | grep -q "^\.env$"; then
    echo "  ❌ WARNING: .env file is tracked in git!"
    ERRORS=$((ERRORS + 1))
else
    echo "  ✅ No .env file in git"
fi

# Check if dependencies are installed
echo "📋 Checking dependencies..."
if [ -d "node_modules" ]; then
    echo "  ✅ Node modules installed"
else
    echo "  ⚠️  Node modules not installed (run: npm install)"
fi

# Test server startup (quick test)
echo "📋 Testing MCP server startup..."
# The server needs stdin, so we provide empty input and check if it starts
# Use a timeout alternative for macOS compatibility
( echo "" | node src/index.js 2>/dev/null 1>/dev/null ) &
PID=$!
sleep 2
if kill -0 $PID 2>/dev/null; then
    kill $PID 2>/dev/null
    echo "  ✅ MCP server starts correctly"
else
    wait $PID
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 0 ] || [ $EXIT_CODE -eq 143 ]; then
        echo "  ✅ MCP server syntax is valid"
    else
        echo "  ❌ MCP server failed to start (exit code: $EXIT_CODE)"
        ERRORS=$((ERRORS + 1))
    fi
fi

echo ""
echo "====================================="
if [ $ERRORS -eq 0 ]; then
    echo "✅ All checks passed!"
    exit 0
else
    echo "❌ Found $ERRORS error(s)"
    exit 1
fi