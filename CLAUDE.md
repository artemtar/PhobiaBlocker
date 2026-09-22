# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PhobiaBlocker is a Chrome extension (Manifest V3) that blurs visual content (images, videos, iframes and CSS background images) on pages whose text mentions a user-defined phobia trigger, and can cover the trigger words themselves. Page text is analysed with NLP (compromise.js) in an offscreen document. The verdict is page-wide: one trigger anywhere blurs all media on the page.

## Development Commands

### Linting
```bash
npm run lint
```
Runs eslint over the hand-written scripts in `js/`. `npx eslint js/*.js` also works but includes the bundled libraries.

### Unit tests
```bash
npm run test:unit
```
Runs `node --test tests/unit/*.test.js`. The suites execute the real extension scripts inside `node:vm` and fake only the Chrome and DOM boundaries (`tests/unit/helpers/content-harness.js` models a small DOM tree; the popup and settings tests fake `chrome.storage` callback ordering). No browser is launched.

The Puppeteer suites at `tests/*.test.js` are historical and quarantined. `npm test` fails on purpose so they are not mistaken for a release gate; see `tests/README.md`.

### Packaging
- `npm run dev` (`pack-dev.sh`): builds a development copy under `build/`.
- `npm run prod` (`pack.sh`): produces the store zip from `manifest.json`, the three HTML pages and the whole `css/`, `js/` and `icons/` folders.

### Loading the Extension
1. Open `chrome://extensions/` and enable "Developer mode".
2. "Load unpacked" and select the repository root.
3. After changing content scripts, the service worker or the offscreen document, click the reload icon on the extension card. Popup and settings changes only need the page reopened.

## Architecture

Five execution contexts talk to each other only through `chrome.runtime` messages, `chrome.storage.sync` keys, and attributes/CSS variables projected onto `<html>`.

1. **Content scripts** (`<all_urls>`, all frames, `document_start`, loaded in manifest order)
   - `js/shared-policy.js`: everything every context must agree on. `STORAGE_KEYS`, `DEFAULTS`, `PROTECTION_MODE`, `FRAME_MESSAGES`, `CSS_VARS`, `ROOT_ATTRS`, `WORD_RE`, the verdict shapes `FAIL_CLOSED_RESULT` / `CLEAR_RESULT`, site-rule parsing and matching, `resolveProtectionMode(settings, url)`, `normalizeAnalysisResult`, `withTimeout`.
   - `js/storage.js`: validated `chrome.storage.sync` access (`getWithDefaults`, `set`, `initializeMissingDefaults`). An invalid stored value throws, so every reader fails closed the same way.
   - `js/page-text-index.js`: `PageTextIndex`, an incremental index of the visible text tokens per text node with page-wide counts, plus the word-cover helpers shared with the early shim (`EXCLUDED_SELECTOR`, `collectTextNodes`, `splitTextNodeByWords`, `unwrapWordCover`).
   - `js/early-blur.js`: runs first. Projects the fail-closed state onto `<html>` (root attributes, blur CSS variables), issues the initial settings read that `js.js` reuses, and covers trigger words until the controller takes over (hand-off event `phobiablocker:word-cover-manager-ready`).
   - `js/js.js`: the controller. `VisualNode` owns one element's blur projection and hover preview; `VisualRegistry` tracks them; `WordCoverManager` wraps matched words in `.phobia-word-cover` spans and reconciles them when the page edits them; `Controller` owns the protection mode, the MutationObserver, analysis scheduling, iframe navigation guards and the cross-origin frame aggregate protocol.

2. **Service worker** (`js/background.js`)
   - Creates the offscreen document and proxies `PB_ANALYZE_WORDS` to it, caching the validated trigger-word list.
   - Context menu ("Unblur"), keyboard commands, toolbar icon status.
   - Frame coordination: relays `webNavigation` URL changes to the exact document (`PB_URL_CHANGED`) and computes from the authenticated frame tree whether a parent may release its cross-origin iframes (`PB_FRAME_*` messages).

3. **Offscreen document** (`offscreen.html`, `js/offscreen.js`, `js/compromise.min.js`)
   - Runs compromise.js normalization in one shared offscreen document for all frames. Target words are expanded (plurals, verb forms) into a normalized set, and page words are normalized before comparison; hyphenated targets match literally.

4. **Popup** (`popup.html`, `js/popup.js`)
   - Trigger-word list, enable / always-blur / word-cover toggles, blur strength, manual blur and unblur, detected words for the active tab.

5. **Settings page** (`settings.html`, `js/settings.js`)
   - Hover preview, cross-origin iframe policy, debug mode, whitelist and blacklist site rules, keyboard shortcut display.

`js/settings-ui.js` holds the DOM helpers both pages share, including `createRevisionedReader`, which keeps `storage.onChanged` refreshes from overwriting a newer read.

### Data Flow

1. `early-blur.js` marks the frame and keeps everything blurred. `js.js` reads settings (reusing that first read), resolves the protection mode from site rules and toggles, and calls `Controller.applyProtectionMode`.
2. The controller registers all media, scans computed backgrounds, builds the text index and sends the page's word list to the service worker, which forwards it to the offscreen document.
3. A clear verdict is deferred while the page is still producing text (`MAX_DEFERRED_CLEAR_VERDICTS`); a blur verdict is applied at once.
4. The MutationObserver keeps the index incremental. New vocabulary re-protects media and re-analyses; removing a word that produced the current blur verdict re-analyses without re-blurring; identical text needs nothing. Stylesheet changes rebuild the index after a debounce because they can change visibility.
5. With `keepCrossOriginIframesBlurred` on, an iframe stays blurred until every frame inside it reports a clear verdict (or a whitelisted mode) through the service worker.

### Protection modes

`DISABLED` (extension off, or the site is whitelisted), `ALWAYS_BLUR` (always-on toggle, or the site is blacklisted), `ANALYZE` (default). See `resolveProtectionMode` in `js/shared-policy.js`.

### Message Passing (`chrome.runtime`)

- Content script (`target: 'content'`): `blurAll`, `unblurAll`, `unblur` (context-menu point), `getTriggeredWords`, `getAnalysisDebugState`, `PB_URL_CHANGED`, `PB_FRAME_STATUS_REQUEST`, `PB_FRAME_AGGREGATE_INVALIDATED`.
- Service worker (`target: 'background'`): `PB_ANALYZE_WORDS`, `toggleWordCover`, `iconStatus`, `PB_FRAME_AGGREGATE_REQUEST`, `PB_FRAME_STATUS_CHANGED`.
- Offscreen document (`target: 'offscreen'`): `PB_ANALYZE_SCOPES`.

### Storage Keys (`chrome.storage.sync`)

Defined once in `STORAGE_KEYS` / `DEFAULTS` in `js/shared-policy.js`: `targetWords`, `phobiaBlockerEnabled`, `blurIsAlwaysOn`, `wordCoverEnabled`, `blurValueAmount` (0-100 slider), `previewEnabled`, `previewBlurStrength`, `whitelistedSites`, `blacklistedSites`, `keepCrossOriginIframesBlurred`, `debugMode`, `detectedWordsCollapsed`, `supportedWordsCollapsed`.

## Code Style (ESLint)

- 4 spaces indentation, single quotes, no semicolons, unix line breaks
- Plain DOM APIs; no jQuery or UI frameworks

## Hotkeys

- **Alt+Shift+B**: blur all visual content on the current page
- **Alt+Shift+U**: unblur all visual content on the current page
- **Alt+Shift+W**: toggle trigger-word covers
- **Right-click "Unblur"**: reveals the clicked media or covered word

## Bundled Libraries (`js/`)

- `compromise.min.js`: NLP normalization; loaded only by `offscreen.html`
- `natural.js`, `stopWords.js`: legacy tokenization helpers that no page or manifest entry currently loads

## Limitations & Known Issues

- Analysis is page-wide, not per element.
- Cross-origin iframes can only be released through the frame protocol; frames without a content script (extension pages, PDF viewer, non-http schemes) stay blurred.
- The browser test suites under `tests/` need a real Chrome and are not maintained as a gate.
