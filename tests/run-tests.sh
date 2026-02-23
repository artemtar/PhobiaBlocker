#!/bin/bash

# Quick test runner script for PhobiaBlocker Extension Tests
# This script checks if dependencies are installed and runs the tests

set -e

echo "PhobiaBlocker Extension Test Runner"
echo "===================================="
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js v18 or higher."
    exit 1
fi

# Check if we're in the tests directory
if [ ! -f "package.json" ]; then
    echo "Error: Please run this script from the tests directory."
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Dependencies not found. Installing..."
    npm install
    echo ""
fi

echo "Running PhobiaBlocker Extension Tests..."
echo ""

# Parse command line arguments
case "$1" in
    basic)
        echo "Running basic functionality tests..."
        node basic-functionality.test.js
        ;;
    nlp)
        echo "Running NLP analysis tests..."
        node nlp-analysis.test.js
        ;;
    visual)
        echo "Running visual content tests..."
        node visual-content.test.js
        ;;
    *)
        echo "Running all tests..."
        npm test
        ;;
esac

echo ""
echo "Tests completed!"
