# PhobiaBlocker Extension Tests

This directory contains end-to-end (E2E) tests for the PhobiaBlocker Chrome extension. These tests run separately from the extension itself and use Puppeteer to automate Chrome with the extension loaded.

## Prerequisites

- Node.js (v18 or higher recommended)
- Chrome browser installed
- The PhobiaBlocker extension code (parent directory)

## Installation

Navigate to the tests directory and install dependencies:

```bash
cd tests
npm install
```

This will install Puppeteer and all required dependencies.

## Test Structure

The test suite is organized into three main test files:

### 1. `basic-functionality.test.js`
Tests core extension functionality:
- Extension loading and initialization
- Storing and retrieving phobia words
- Blur/unblur functionality
- Enable/disable toggle
- "Always blur" mode
- Manual blur/unblur commands
- Blur amount settings

### 2. `nlp-analysis.test.js`
Tests Natural Language Processing and text analysis:
- Singular/plural detection (spider/spiders)
- Irregular plurals (mouse/mice)
- Verb form detection (crawl/crawling)
- Case insensitivity
- Possessive forms (spider's)
- Stop word filtering
- Partial word match prevention
- Title tag analysis
- Multiple phobia words
- Special character handling

### 3. `visual-content.test.js`
Tests different types of visual content:
- Regular img elements
- Background images
- Video elements
- Iframe elements
- GIF images
- SVG images
- Dynamically added content (MutationObserver)
- Multiple images on same page
- Edge cases (empty src, no alt text, nested elements)
- Performance with many images

## Running Tests

### Run All Tests

```bash
npm test
```

This runs all test files using Node.js built-in test runner.

### Run Individual Test Files

```bash
# Basic functionality tests
npm run test:basic

# NLP analysis tests
npm run test:nlp

# Visual content tests
npm run test:visual
```

Or run individual files directly:

```bash
node basic-functionality.test.js
node nlp-analysis.test.js
node visual-content.test.js
```

### Watch Mode

To run tests in watch mode (re-runs on file changes):

```bash
npm run test:watch
```

## Test Pages

The `test-pages/` directory contains HTML files used for testing:

- `simple-image.html` - Basic test page with images and background images
- `video-iframe.html` - Test page with video and iframe elements
- `dynamic-content.html` - Test page for testing dynamically added content

These pages are loaded using `file://` URLs during tests.

## How Tests Work

1. **Browser Launch**: Puppeteer launches Chrome with the extension loaded from the parent directory
2. **Extension Access**: Tests interact with the extension via Chrome APIs (`chrome.storage`, `chrome.runtime`)
3. **Page Navigation**: Tests load test HTML pages and verify blur behavior
4. **Assertions**: Tests check computed CSS styles, element states, and extension storage

## Test Utilities

The `test-utils.js` file provides helper functions:

- `launchBrowserWithExtension()` - Launch Chrome with extension
- `setPhobiaWords(page, words)` - Configure phobia words
- `getPhobiaWords(page)` - Retrieve current phobia words
- `setExtensionEnabled(page, enabled)` - Enable/disable extension
- `isElementBlurred(page, selector)` - Check if element is blurred
- `waitForBlurState(page, selector, shouldBeBlurred, timeout)` - Wait for blur state
- `countBlurredImages(page)` - Count all blurred images on page
- `getAllVisualElements(page)` - Get info about all visual elements
- And more...

## Important Notes

### Headless Mode
- Tests run in **non-headless mode** because Chrome extensions don't work in headless mode
- You'll see Chrome windows open during test execution
- This is expected behavior

### Timing
- Tests use `waitForTimeout()` to allow for:
  - Content script initialization (~500ms)
  - Text analysis processing (~1-2s)
  - Unveil timers (2s for safe content)
- If tests are flaky, you may need to increase timeout values

### Extension Storage
- Tests use `chrome.storage.sync` to configure the extension
- Storage is cleared before each test suite to ensure clean state
- Settings persist across page navigations within a test

### Test Isolation
- Each test file has its own `before`/`after` hooks
- Browser is launched once per test file and reused across tests
- Pages are navigated/recreated for each test

## Debugging Tests

### Viewing Test Execution
Since tests run in non-headless mode, you can watch the browser as tests execute. This is helpful for debugging.

### Adding Console Logs
Add `console.log()` statements in test files or use Puppeteer's console event:

```javascript
page.on('console', msg => console.log('PAGE LOG:', msg.text()))
```

### Taking Screenshots
Add screenshots to debug visual issues:

```javascript
await page.screenshot({ path: 'debug-screenshot.png' })
```

### Slowdown Execution
Add longer waits to observe behavior:

```javascript
await page.waitForTimeout(5000) // Wait 5 seconds
```

## Troubleshooting

### "Extension service worker not found"
- Make sure the extension path in `test-utils.js` (`EXTENSION_PATH`) points to the correct location
- Verify `manifest.json` exists in the parent directory
- Check that the extension has a valid background service worker defined

### Tests Timing Out
- Increase timeout values in tests
- Check if the extension is loading properly
- Verify test page URLs are correct

### "Element not found" Errors
- Check that selectors match the test HTML pages
- Ensure pages are fully loaded before querying elements
- Increase wait times if content loads slowly

### Blur Not Detected
- Check that the extension is enabled (`phobiaBlockerEnabled: true`)
- Verify phobia words are set correctly
- Ensure text analysis has completed (wait longer)
- Check CSS filter value in browser DevTools

## CI/CD Integration

To run tests in CI/CD pipelines:

1. Install Node.js and Chrome in your CI environment
2. Install test dependencies: `npm install`
3. Run tests: `npm test`

Note: You may need to configure Chrome to run in a CI environment with appropriate flags (e.g., `--no-sandbox`, `--disable-setuid-sandbox`).

## Writing New Tests

To add new tests:

1. Create a new test file or add to existing ones
2. Import test utilities from `test-utils.js`
3. Use `describe()` and `it()` from Node.js test runner
4. Use `before()`/`after()` hooks for setup/teardown
5. Use `assert` module for assertions

Example test structure:

```javascript
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const { launchBrowserWithExtension, /* ... */ } = require('./test-utils')

describe('My Test Suite', () => {
    let browser, page

    before(async () => {
        browser = await launchBrowserWithExtension()
        page = await browser.newPage()
    })

    after(async () => {
        if (browser) await browser.close()
    })

    it('should do something', async () => {
        // Test code here
        assert.ok(true, 'Test passed')
    })
})
```

## Contributing

When adding new features to the extension:

1. Add corresponding tests to verify the feature works
2. Update test pages if needed
3. Add new test utilities if helpful for multiple tests
4. Run all tests to ensure nothing broke

## License

Same as the main PhobiaBlocker project.
