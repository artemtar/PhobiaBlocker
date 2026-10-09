# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PhobiaBlur is a Chrome extension (Manifest V3) that blurs visual content (images, videos, iframes and CSS background images) on pages whose text mentions a user-defined phobia trigger, and can cover the trigger words themselves. Page text is analysed with NLP (compromise.js) in an offscreen document. The verdict is page-wide: one trigger anywhere blurs all media on the page.

The store name is PhobiaBlur (`manifest.json`, `pack*.sh`, `README.md`). Internal identifiers keep the original name: globals `PhobiaBlocker*`, attributes `data-phobiablocker-*`, DOM events `phobiablocker:*`, the storage key `phobiaBlockerEnabled`, and console prefixes. Do not rename them; stored settings and page markup depend on them.

## Development Commands

### Linting
```bash
npm run lint
```
Runs eslint over an explicit file list in `package.json`: every hand-written script in `js/` plus `scripts/*.cjs`. The bundled libraries (`compromise.min.js`, `natural.js`, `stopWords.js`) are excluded. A new module must be added to that list or it is never linted.

### Unit tests
```bash
npm run test:unit
```
Runs `node --test tests/unit/*.test.js`. The suites execute the real extension scripts inside `node:vm` and fake only the Chrome and DOM boundaries (`tests/unit/helpers/content-harness.js` models a small DOM tree; the popup and settings tests fake `chrome.storage` callback ordering). No browser is launched. Suites also cover the pack scripts and the release scripts under `scripts/`.

`tests/live/popup-sizing.js` is a browser check for Chrome's native action popup; it runs through the extension-enabled Playwright server, not from `npm`. The Puppeteer suites at `tests/*.test.js` are historical and quarantined. `npm test` fails on purpose so they are not mistaken for a release gate; see `tests/README.md`.

### Packaging
- `npm run dev` (`pack-dev.sh`): copies the runtime set (`manifest.json`, the three HTML pages, `css/`, `js/`, `icons/`) to `build/dev/` and rewrites the manifest name to "PhobiaBlur DEV" with a `-dev` version name. Needs `jq`.
- `npm run prod` (`pack.sh [version]`): bumps the version in `manifest.json` (patch increment unless a version is given) and zips the same runtime set into `phobiablur-v<version>.zip`.
- Store release: `.github/workflows/chrome-web-store.yml` (manual `workflow_dispatch` with `version` and `submit_for_review`, default branch only). `validate` runs `npm run test:unit`, `npm run lint`, `bash -n` on the pack scripts and `git diff --check`. `package` runs `node scripts/prepare-store-release.cjs <version>` from a pristine checkout with no npm install and keeps `build/store-release/` as an artifact. `upload` runs `node scripts/upload-webstore.cjs build/store-release` with the Chrome Web Store credentials of the `chrome-web-store` environment. Both scripts use Node built-ins only.

### Loading the Extension
1. Open `chrome://extensions/` and enable "Developer mode".
2. "Load unpacked" and select the repository root (or `build/dev/` after `npm run dev`).
3. After changing content scripts, the service worker or the offscreen document, click the reload icon on the extension card. Popup and settings changes only need the page reopened.

## Architecture

Six execution contexts talk to each other only through `chrome.runtime` messages, `chrome.storage.sync` keys, `window.postMessage` for one frame-clearance ticket, and attributes/CSS variables/events projected onto the DOM.

1. **Content scripts** (`<all_urls>`, all frames, `about:blank` and origin fallback, `document_start`, loaded in manifest order)
   - `js/shared-policy.js`: everything every context must agree on. `STORAGE_KEYS`, `DEFAULTS`, `PROTECTION_MODE`, `FRAME_MESSAGES`, `CSS_VARS`, `ROOT_ATTRS`, `WORD_RE`, the verdict shapes `FAIL_CLOSED_RESULT` / `CLEAR_RESULT`, site-rule parsing and matching, `resolveProtectionMode(settings, url)`, `normalizeAnalysisResult`, `withTimeout`.
   - `js/frame-clearance.js`: `FrameClearance`, the per-iframe release tickets. Installs a capture-phase `message` listener before any page script so a child's `PB_FRAME_CLEARANCE_LINK` ticket is consumed and tied to the exact `<iframe>` by `contentWindow` identity, never by URL. Tickets expire after 3 s. A stale-document guard, not a security boundary.
   - `js/storage.js`: validated `chrome.storage.sync` access (`getWithDefaults`, `set`, `initializeMissingDefaults`). An invalid stored value throws, so every reader fails closed the same way.
   - `js/page-text-index.js`: `PageTextIndex`, an incremental index of the visible text tokens per text node with page-wide counts, plus the word-cover and editability helpers shared with the early shim (`EXCLUDED_SELECTOR`, `collectTextNodes`, `splitTextNodeByWords`, `unwrapWordCover`, `isEditableElement`, `isEditableDocument`).
   - `js/early-blur.js`: the fail-closed shim. Marks the frame, owns the root projection (`phobia-disabled` class, background attributes, blur CSS variables), issues the single initial settings read that `js.js` reuses (`globalThis.PhobiaBlockerInitialSettingsRead`), and covers trigger words with its own MutationObserver until the controller takes over. If the read fails it applies `ALWAYS_BLUR` with no words.
   - `js/editor-frames.js`: `EditorFrames`, the same-origin editable-iframe handshake. The parent writes `data-phobiablocker-editor-request="blur|clear:<token>"` on the iframe and dispatches `phobiablocker:editor-frame-request` into the child document; the child controller applies the requested protection to its own media synchronously and acknowledges with `data-phobiablocker-editor-ack=<token>` on its `<html>`. Only a matching ack lets the parent drop its own filter so the editor text stays readable. A child announces readiness with `phobiablocker:editor-frame-ready` on its owner element.
   - `js/js.js`: the controller. `VisualNode` owns one element's blur projection and hover preview; `VisualRegistry` tracks them; `WordCoverManager` wraps matched words in `.phobia-word-cover` spans and reconciles them when the page edits them; `Controller` owns the protection mode, the MutationObserver, analysis scheduling, shadow-root discovery, iframe navigation guards, the cross-origin frame aggregate protocol and the `FrameClearance` / `EditorFrames` instances.

2. **MAIN-world shim** (`js/shadow-root-notifier.js`, separate `content_scripts` entry with `"world": "MAIN"`)
   - Wraps `Element.prototype.attachShadow` and dispatches `phobiablocker:shadow-root-attached` (bubbling, composed) on the host for every open root, so the isolated controller can adopt the protection stylesheet into the root before the page populates it. It reads nothing from the page and the controller trusts only the DOM it finds, never the event payload. Declarative shadow roots arrive without `attachShadow`; the controller re-checks candidate hosts after the parser has run.

3. **Service worker** (`js/background.js`)
   - Creates the offscreen document and proxies `PB_ANALYZE_WORDS` to it, caching the validated trigger-word list.
   - Context menu ("Unblur"), keyboard commands, toolbar icon status (idle / processing / detected at 16, 24, 32, 48 and 128 px).
   - Frame coordination: relays `webNavigation` URL changes to the exact document (`PB_URL_CHANGED`), computes from the authenticated frame tree whether a parent may release its cross-origin iframes as a whole (`PB_FRAME_AGGREGATE_REQUEST`), and when only some children are clear mints one-time tokens per clear child, arms the parent (`PB_FRAME_CLEARANCE_ARM`) and tells each child document to post its token to its parent window (`PB_FRAME_CLEARANCE_EMIT`).

4. **Offscreen document** (`offscreen.html`, `js/offscreen.js`, `js/compromise.min.js`)
   - Runs compromise.js normalization in one shared offscreen document for all frames. Target words are expanded (plurals, verb forms) into a normalized set, and page words are normalized before comparison; hyphenated targets match literally.

5. **Popup** (`popup.html`, `js/popup.js`, `js/ui-help.js`, `css/ui-help.css`)
   - Trigger-word list, protection mode (smart / always / off), word-cover and hover-preview toggles, a site-rule select for the current domain, manual "Blur media" / "Reveal current content", detected and supported word disclosures, link to settings. Blur strength is not in the popup.
   - `js/ui-help.js` with `css/ui-help.css` renders the `data-tooltip` help: hover and focus show it, `.pb-help` buttons pin it, Escape dismisses it. Written to be page-agnostic; today only `popup.html` loads it.

6. **Settings page** (`settings.html`, `js/settings.js`)
   - Blur strength (`#blur-strength-slider`, `blurValueAmount`), hover preview and its remaining blur, word cover, cross-origin iframe policy, debug mode, trigger words, whitelist and blacklist site rules, keyboard shortcut display and version.

`js/settings-ui.js` holds the DOM helpers both pages share, including `createRevisionedReader`, which keeps `storage.onChanged` refreshes from overwriting a newer read.

### Data Flow

1. `early-blur.js` marks the frame, projects the fail-closed state and covers trigger words as soon as its settings read resolves. The `Controller` constructor only discovers shadow roots (so streamed-in roots adopt the protection sheet); media, text, URL policy and the hand-off all wait for `applyProtectionMode`.
2. `js.js` awaits the shared settings read (bounded by `withTimeout`, retried, fail-closed on failure), resolves the protection mode from site rules and toggles, and calls `Controller.applyProtectionMode`. That method dispatches `phobiablocker:word-cover-manager-ready` once per page, at which point `early-blur.js` disconnects its observers and unwraps its covers; in the same synchronous turn `enableProtection` configures `WordCoverManager` and rebuilds the text index, so words are re-covered before the page paints. In `DISABLED` mode the covers stay unwrapped on purpose.
3. The controller registers all media, scans computed backgrounds, builds the text index and sends the page's word list to the service worker, which forwards it to the offscreen document.
4. A clear verdict is deferred while the page is still producing text (`MAX_DEFERRED_CLEAR_VERDICTS`); a blur verdict is applied at once.
5. The MutationObserver keeps the index incremental. New vocabulary re-protects media and re-analyses; removing a word that produced the current blur verdict re-analyses without re-blurring; identical text needs nothing. Stylesheet changes rebuild the index after a debounce because they can change visibility. `attachShadow` notifications and declarative-root re-checks pull new open shadow roots into the same observer set.
6. With `keepCrossOriginIframesBlurred` on, an iframe stays blurred until the service worker confirms every frame inside it reports a clear verdict (or a whitelisted mode). If only some children are clear, the ticket protocol releases exactly those: the parent is armed with the tokens, each clear child posts its token with `FrameClearance.emit`, the parent's capture listener matches it to the iframe element, and only then is that single iframe unblurred. A sibling that is not clear never hides a clear one, and a failed sibling never reveals anything.
7. Same-origin editable iframes (rich-text editors) use the `EditorFrames` handshake instead: the parent keeps its filter over the iframe until the child acknowledges that it has applied the requested protection to the media inside.

### Protection modes

`DISABLED` (extension off, or the site is whitelisted), `ALWAYS_BLUR` (always-on toggle, or the site is blacklisted), `ANALYZE` (default). See `resolveProtectionMode` in `js/shared-policy.js`.

### Message Passing

`chrome.runtime` messages, by `target`:
- Content script (`target: 'content'`): `blurAll`, `unblurAll`, `unblur` (context-menu point), `getTriggeredWords`, `getAnalysisDebugState`, `PB_URL_CHANGED`, `PB_FRAME_STATUS_REQUEST`, `PB_FRAME_AGGREGATE_INVALIDATED`, `PB_FRAME_CLEARANCE_ARM` (parent: `{ epoch, tokens }`), `PB_FRAME_CLEARANCE_EMIT` (child: `{ token }`).
- Service worker (`target: 'background'`): `PB_ANALYZE_WORDS`, `toggleWordCover`, `iconStatus`, `PB_FRAME_AGGREGATE_REQUEST` (with `individualClearance` to request tokens), `PB_FRAME_STATUS_CHANGED`.
- Offscreen document (`target: 'offscreen'`): `PB_ANALYZE_SCOPES`.

Other channels:
- `window.postMessage` child → parent: `{ type: 'PB_FRAME_CLEARANCE_LINK', token }`, consumed by `frame-clearance.js` in the capture phase.
- DOM events: `phobiablocker:word-cover-manager-ready` (window; early-blur hand-off), `phobiablocker:shadow-root-attached` (host element, from the MAIN world), `phobiablocker:editor-frame-request` (child document) and `phobiablocker:editor-frame-ready` (owner iframe), plus the `data-phobiablocker-editor-request` / `-ack` attributes.

### Storage Keys (`chrome.storage.sync`)

Defined once in `STORAGE_KEYS` / `DEFAULTS` in `js/shared-policy.js`: `targetWords`, `phobiaBlockerEnabled`, `blurIsAlwaysOn`, `wordCoverEnabled`, `blurValueAmount` (0-100, settings page only), `previewEnabled`, `previewBlurStrength`, `whitelistedSites`, `blacklistedSites`, `keepCrossOriginIframesBlurred`, `debugMode`, `detectedWordsCollapsed`, `supportedWordsCollapsed`.

The two `*Collapsed` keys are legacy popup-accordion state: they stay in `STORAGE_KEYS` / `DEFAULTS` so old values validate, no page reads or writes them any more, and the controller lists them in `UI_ONLY_STORAGE_KEYS` so a change never triggers a settings re-read.

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
- Closed shadow roots are not protected: the MAIN-world notifier only reports open roots and the controller cannot reach into a closed one, so media and text inside it are neither blurred nor indexed.
- Cross-origin iframes can only be released through the frame protocol; frames without a content script (extension pages, PDF viewer, non-http schemes) stay blurred.
- The browser test suites under `tests/` need a real Chrome and are not maintained as a gate.
