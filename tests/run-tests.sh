#!/bin/bash

# PhobiaBlocker Test Runner
# Runs all test suites individually to avoid service worker conflicts

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}  PhobiaBlocker Test Suite Runner${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed. Please install Node.js v18 or higher.${NC}"
    exit 1
fi

# Check if we're in the tests directory
if [ ! -f "test-utils.js" ]; then
    echo -e "${RED}Error: Please run this script from the tests directory.${NC}"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Dependencies not found. Installing...${NC}"
    npm install
    echo ""
fi

# Track results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
FAILED_SUITES=()

# Test files to run (order matters - basic tests first)
TEST_FILES=(
    "basic-functionality.test.js"
    "framework-compatibility.test.js"
    "storage-persistence.test.js"
    "no-jquery.test.js"
    "visual-content.test.js"
    "flash-prevention.test.js"
    "nlp-analysis.test.js"
)

# Parse command line arguments
if [ "$1" != "" ]; then
    case "$1" in
        basic)
            TEST_FILES=("basic-functionality.test.js")
            ;;
        framework)
            TEST_FILES=("framework-compatibility.test.js")
            ;;
        storage)
            TEST_FILES=("storage-persistence.test.js")
            ;;
        jquery)
            TEST_FILES=("no-jquery.test.js")
            ;;
        visual)
            TEST_FILES=("visual-content.test.js")
            ;;
        flash)
            TEST_FILES=("flash-prevention.test.js")
            ;;
        nlp)
            TEST_FILES=("nlp-analysis.test.js")
            ;;
        *)
            echo -e "${YELLOW}Unknown test suite: $1${NC}"
            echo "Available suites: basic, framework, storage, jquery, visual, flash, nlp"
            echo "Run without arguments to run all suites"
            exit 1
            ;;
    esac
fi

# Run each test suite individually
for test_file in "${TEST_FILES[@]}"; do
    echo -e "${YELLOW}Running: ${test_file}${NC}"
    echo "----------------------------------------"

    # Run test and capture exit code (don't exit on failure)
    if node --test "$test_file" 2>&1; then
        echo -e "${GREEN}✓ PASSED: ${test_file}${NC}"
        ((PASSED_TESTS++))
    else
        echo -e "${RED}✗ FAILED: ${test_file}${NC}"
        ((FAILED_TESTS++))
        FAILED_SUITES+=("$test_file")
    fi

    echo ""
    ((TOTAL_TESTS++))

    # Longer delay between tests to allow full browser/service worker cleanup
    # Chrome needs significant time to properly unload extensions between test runs
    # After heavy service worker usage (20-30s tests), Chrome requires substantial cleanup time
    # Tests fail with 10s delay, need at least 20s for reliable service worker availability
    sleep 20
done

# Print summary
echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}  Test Summary${NC}"
echo -e "${BLUE}======================================${NC}"
echo -e "Total test suites: ${TOTAL_TESTS}"
echo -e "${GREEN}Passed: ${PASSED_TESTS}${NC}"
echo -e "${RED}Failed: ${FAILED_TESTS}${NC}"

if [ ${FAILED_TESTS} -gt 0 ]; then
    echo ""
    echo -e "${RED}Failed test suites:${NC}"
    for suite in "${FAILED_SUITES[@]}"; do
        echo -e "${RED}  - ${suite}${NC}"
    done
    exit 1
else
    echo ""
    echo -e "${GREEN}All tests passed! ✓${NC}"
    exit 0
fi
