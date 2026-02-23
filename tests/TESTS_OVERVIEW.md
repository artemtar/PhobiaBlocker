# PhobiaBlocker Test Suite Overview

This document provides a high-level overview of the test infrastructure created for the PhobiaBlocker extension.

## Quick Start

```bash
# Install dependencies
cd tests
npm install

# Run all tests
npm test

# Or use the script
./run-tests.sh
```

## Test Suite Structure

```
tests/
├── package.json                    # Test dependencies (Puppeteer)
├── README.md                       # Detailed testing documentation
├── TESTS_OVERVIEW.md              # This file
├── run-tests.sh                   # Quick test runner script
│
├── test-utils.js                  # Shared utilities for all tests
│
├── test-pages/                    # HTML test pages
│   ├── simple-image.html          # Basic images & background images
│   ├── video-iframe.html          # Video and iframe elements
│   └── dynamic-content.html       # Dynamic content loading
│
└── Test Files:
    ├── basic-functionality.test.js     # Core functionality tests (9 tests)
    ├── nlp-analysis.test.js           # NLP & text analysis tests (12 tests)
    └── visual-content.test.js         # Visual content types tests (14 tests)
```

## Test Coverage Summary

### Basic Functionality Tests (9 tests)
✓ Extension loads successfully
✓ Store and retrieve phobia words
✓ Blur images when phobia words detected
✓ Don't blur images without phobia words
✓ "Always blur" mode
✓ Enable/disable extension
✓ Manual blur all command
✓ Manual unblur all command
✓ Blur amount adjustment

### NLP Analysis Tests (12 tests)
✓ Detect singular when plural configured
✓ Detect plural when singular configured
✓ Detect verb forms (crawl → crawling)
✓ Handle irregular plurals (mouse → mice)
✓ Case insensitive matching
✓ No partial word matches
✓ Detect words in page title
✓ Handle multiple phobia words
✓ Handle possessive forms (spider's)
✓ Filter out stop words
✓ Handle empty word list
✓ Handle special characters

### Visual Content Tests (14 tests)
✓ Blur regular img elements
✓ Blur background images
✓ Blur video elements
✓ Blur iframe elements
✓ Handle GIF images
✓ Handle multiple images on page
✓ Detect dynamically added images (with phobia words)
✓ Don't blur dynamically added safe images
✓ Handle images without alt text
✓ Handle images with empty src
✓ Handle nested elements with background images
✓ Handle SVG images
✓ Count all visual element types
✓ Handle pages with many images efficiently

## Key Features

### 1. Real Chrome Environment
- Tests run in actual Chrome with extension loaded
- Not mocked - tests real extension behavior
- Runs in non-headless mode (extensions don't work headless)

### 2. Test Utilities
The `test-utils.js` file provides reusable helper functions:
- Browser launch with extension
- Extension storage management
- Phobia word configuration
- Blur state detection
- Element querying
- Timing utilities

### 3. Isolated Test Pages
Custom HTML pages in `test-pages/` provide controlled test environments:
- Known content for predictable testing
- Different content types (images, videos, iframes)
- Dynamic content simulation
- No external dependencies

### 4. Comprehensive Coverage
Tests verify:
- All extension features
- All visual element types
- NLP text processing
- Edge cases and error conditions
- Performance with many images
- Dynamic content handling

## Running Specific Tests

```bash
# All tests
npm test

# Individual test suites
npm run test:basic
npm run test:nlp
npm run test:visual

# Or directly
node basic-functionality.test.js
node nlp-analysis.test.js
node visual-content.test.js
```

## Test Output Example

```
▶ PhobiaBlocker - Basic Functionality
  ✔ should load extension successfully (245ms)
  ✔ should store and retrieve phobia words (123ms)
  ✔ should blur images when phobia words are detected (3456ms)
  ✔ should not blur images when no phobia words are detected (3234ms)
  ...
▶ PhobiaBlocker - Basic Functionality (12.3s)

▶ PhobiaBlocker - NLP Text Analysis
  ✔ should detect singular form when plural is configured (2145ms)
  ✔ should detect plural form when singular is configured (2089ms)
  ...
```

## Technology Stack

- **Node.js**: Test runner (built-in test module)
- **Puppeteer**: Browser automation
- **Chrome**: Target browser with extension
- **Assert**: Node.js assertion library

## Important Notes

### Timing Considerations
- Content script initialization: ~500ms
- Text analysis processing: ~1-2s
- Unveil timers: 2s for safe content
- Tests include appropriate waits for these delays

### Extension Storage
- Tests use `chrome.storage.sync` API
- Storage cleared before each test suite
- Settings persist across page navigations

### Non-Headless Mode
- Chrome extensions require visible browser
- You'll see Chrome windows during tests
- This is expected and required

## Debugging Tips

1. **Watch execution**: Tests run in visible Chrome - watch what happens
2. **Add screenshots**: `await page.screenshot({ path: 'debug.png' })`
3. **Console logs**: `page.on('console', msg => console.log(msg.text()))`
4. **Slow down**: Increase `waitForTimeout()` values
5. **Run individually**: Test single files to isolate issues

## Integration with Extension Submission

These tests are **separate from the extension** that gets submitted to the Chrome Web Store:

✅ Extension files (for submission):
- manifest.json
- js/
- images/
- popup.html
- etc.

❌ NOT included in submission:
- tests/ directory
- All test files
- Test dependencies

The tests verify the extension works correctly before submission, but they don't get packaged with the extension.

## Adding New Tests

To add new tests:

1. Choose appropriate test file or create new one
2. Import utilities from `test-utils.js`
3. Use Node.js test structure (`describe`, `it`, `before`, `after`)
4. Use `assert` for assertions
5. Include appropriate waits for async operations

Example:

```javascript
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const { launchBrowserWithExtension, setPhobiaWords } = require('./test-utils')

describe('My New Test Suite', () => {
    let browser, page

    before(async () => {
        browser = await launchBrowserWithExtension()
        page = await browser.newPage()
    })

    after(async () => {
        if (browser) await browser.close()
    })

    it('should test new feature', async () => {
        await setPhobiaWords(page, ['test'])
        // ... test code ...
        assert.ok(true, 'Test passed')
    })
})
```

## Contributing

When modifying the extension:
1. Update tests to cover new functionality
2. Run all tests to ensure nothing broke
3. Add new test pages if needed
4. Update test utilities if helpful

## Support

For questions or issues with tests:
- Check [tests/README.md](README.md) for detailed documentation
- Review test files for examples
- Ensure dependencies are installed correctly
- Verify extension path is correct

## Total Test Count

**35 tests** across 3 test suites:
- 9 basic functionality tests
- 12 NLP analysis tests
- 14 visual content tests

These tests provide comprehensive coverage of all PhobiaBlocker features and edge cases.
