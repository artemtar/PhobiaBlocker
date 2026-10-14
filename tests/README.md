# PhobiaBlur Tests

## Unit suite (release gate)

Run `npm run test:unit` from the repository root. It executes `node --test tests/unit/*.test.js`: the real extension scripts run inside `node:vm` with only the Chrome and DOM boundaries faked (`tests/unit/helpers/content-harness.js` models a small DOM tree; the popup and settings suites fake `chrome.storage` callback ordering). No browser is launched.

The suites cover settings races, fail-closed startup, media protection and blur strength, text-index mutations, matching and URL policy, navigation relay and frame-aggregate invalidation, frame clearance and its retention, shadow-root discovery and styles, popup initialization, the help tooltips, the pack scripts and the store release and upload scripts. They do not verify browser layout or painting; validate those with the loaded extension on real sites.

Run a single suite with `node --test tests/unit/<name>.test.js`.

## Live check: native popup sizing

`tests/live/popup-sizing.js` exercises Chrome's native action popup, which cannot be tested by opening `popup.html` in a tab. Run it through the extension-enabled Playwright server's `browser_run_code_unsafe` tool with the script's absolute path as `filename`, and keep a real website active in that browser. It opens the popup three times, measures its size during help and disclosure interactions, checks that pointer and keyboard activation leave the trigger-word editor unobscured, and verifies saved preferences stay unchanged.

## Historical: Puppeteer E2E suites (quarantined)

The `tests/*.test.js` files are (with two placeholder exceptions noted below) end-to-end suites that launch a real Chrome with the extension loaded through Puppeteer. They are kept for reference only: root `npm test` fails on purpose so they are not mistaken for a release gate, and some cases still assume behaviour and debug fields the extension no longer has. Chromium does not launch inside a sandboxed shell, and extensions need a headed (non-headless) browser.

### Setup

```bash
cd tests
npm install        # installs Puppeteer into tests/node_modules
node --test        # all suites; or node --test site-rules.test.js
```

`test-utils.js` provides `launchBrowserWithExtension()`, `setPhobiaWords()`, `setExtensionEnabled()`, `isElementBlurred()`, `waitForPhobiaBlur()` / `waitForPhobiaNoblur()` (both built on `waitForPhobiaClass()`), `countBlurredImages()`, `clearExtensionStorage()` and similar helpers. `EXTENSION_PATH` in that file must point at the repository root. Pages under `test-pages/` are loaded over `file://`.

### Suites

- `basic-functionality.test.js`: loading, trigger-word storage, blur/unblur, enable/disable, "always blur".
- `flash-prevention.test.js`: media is blurred by CSS before any script runs, with the right specificity.
- `framework-compatibility.test.js`: placeholder stub, a single `assert.ok(true)` that points to a manual checklist (`SITE_COMPATIBILITY_FIX.md`, not tracked in this repository). Launches no browser.
- `icon-status.test.js`: all fifteen icon variants (idle/processing/detected x 16/24/32/48/128 px) are preloaded in the service worker, pixel-level tint assertions (yellow for processing, red for detected, idle distinct), and the status flow (processing to idle on clean pages, processing to detected on trigger pages, idle-only when disabled, detected-only when `blurIsAlwaysOn`).
- `hover-preview.test.js`: reduced blur on hover, `--previewBlurAmount`, pointer-events on blurred elements, live settings updates.
- `nlp-analysis.test.js`: plurals, irregular plurals, verb forms, case, possessives, partial-match prevention, special characters.
- `site-rules.test.js`: whitelist and blacklist storage, wildcard/subdomain/path matching, precedence.
- `storage-persistence.test.js`: placeholder stub, a single `assert.ok(true)` that points to a manual checklist (`STORAGE_BUG_FIX.md`, not tracked in this repository). Launches no browser and touches no storage.
- `visual-content.test.js`: img, background images, video, cross-origin vs same-origin iframes.
- `attribute-lifecycle.test.js`: the `data-phobia-blur` attribute and blur-class lifecycle, including dynamically injected images.

### Notes when reviving a suite

- The eight browser suites each launch one browser in `before()`, call `clearExtensionStorage()` there and reuse the browser for the whole file. Most also share one page; `site-rules.test.js` opens a fresh page per test. `framework-compatibility.test.js` and `storage-persistence.test.js` are the `assert.ok(true)` placeholders above: no `before()`, no browser, no storage. Each run gets its own Chrome profile (`TEST_USER_DATA_DIR` in `test-utils.js` includes the process id and thread id), so state does not carry over between runs.
- Timing relies on the `wait(ms)` helper from `test-utils.js` for content-script start (~500 ms), analysis (1-3 s) and unveil timers; raise the waits before blaming the extension.
- If the service worker is not found, check `EXTENSION_PATH` and that `manifest.json` declares `background.service_worker`.
- If blur is not detected, confirm `phobiaBlockerEnabled: true`, the trigger words, that analysis finished, and the computed `filter` in DevTools.
