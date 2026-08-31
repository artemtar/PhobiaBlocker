# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

PhobiaBlocker is a Chrome Extension (Manifest V3) that protects supported visual content (images, videos, iframes, and ordinary computed CSS backgrounds) when a page might contain content related to user-defined phobias. It uses one page-wide Natural Language Processing (NLP) decision: a trigger anywhere in eligible page text or the title keeps all supported media blurred.

## Development Commands

### Linting
```bash
npm run lint
```

### Behavior Testing

The repository's synthetic browser suites are quarantined historical assets. `npm test` intentionally exits with a quarantine message; do not invoke individual fixture suites or represent them as current behavior proof. Validate behavior on natural content from live public sites and record the evidence in `docs/live-site-validation.md`.

### Loading the Extension
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked" and select the repository root directory

### Reloading After Changes
- For popup changes: Close and reopen the popup
- For content script changes: Click the reload icon on the extension card in `chrome://extensions/`
- For background script changes: Click the reload icon on the extension card

## Architecture

### Three Main Components

1. **Content Script** ([js/js.js](js/js.js))
   - Runs on all web pages (`<all_urls>`)
   - Core business logic: analyzes text and manages image blur states
   - Uses MutationObserver to detect dynamically loaded content
   - Listens for messages from popup and background scripts

2. **Background Script** ([js/background.js](js/background.js))
   - Service worker (Manifest V3)
   - Creates context menu on extension install/update
   - Coordinates context-menu commands and the offscreen NLP analyzer
   - Caches validated target words and fails closed when storage or analysis is unavailable

3. **Popup UI** ([popup.js](js/popup.js) + [popup.html](popup.html))
   - User interface for configuration
   - Manages validated trigger words with the repository's custom tag UI
   - Controls: enable/disable, blur amount slider, manual blur/unblur buttons
   - Persists through the shared promise-based storage adapter

### Key Classes in js/js.js

- **`VisualNode`**: Projects blur, reveal, and hover-preview rendering for one registered image, video, iframe, or computed background
- **`VisualRegistry`**: Owns registered visual nodes and prunes detached elements
- **`WordCoverManager`**: Covers direct target-word matches in the same mutation turn and keeps the text index synchronized while wrapping text
- **`PhobiaBlockerPageTextIndex`** ([js/page-text-index.js](js/page-text-index.js)): Maintains page-wide token counts incrementally from text and visibility mutations

- **`Controller`**: Orchestrates the entire system
  - Applies generation-guarded protection-mode transitions
  - Coordinates visual discovery, incremental text state, analysis, explicit reveal fingerprints, and live settings changes

### Data Flow

1. Manifest CSS protects media at `document_start`; `early-blur.js` covers direct trigger words while settings and the document load
2. The controller resolves the shared blacklist/whitelist/global/always-blur policy and applies it without navigation
3. The controller discovers supported visual content and builds one page-wide incremental text index from eligible body text plus the title
4. A trigger anywhere keeps every supported visual node blurred; only a successful clean result may reveal content
5. MutationObserver callbacks protect new visuals and direct target text synchronously, update only affected text-index entries, and coalesce asynchronous NLP analysis
6. Analysis errors, timeouts, invalid responses, and settings-read failures remain fail-closed

### Protection Policy

Policy precedence is authoritative and shared across extension contexts:

1. A matching blacklist rule selects `ALWAYS_BLUR`.
2. Otherwise, a matching whitelist rule selects `DISABLED`.
3. Otherwise, disabling global protection selects `DISABLED`.
4. Otherwise, Always Blur Media selects `ALWAYS_BLUR`.
5. Otherwise, the page selects `ANALYZE`.

Blacklist therefore wins over whitelist and remains active when global protection is off. Plain domain rules match the named domain and its subdomains; URL path rules match the named path and descendants.

Cross-origin iframe behavior is controlled by `keepCrossOriginIframesBlurred`, which defaults to `true`. After a successful clean page-wide analysis, same-origin iframes reveal normally. Cross-origin or uncertain-origin iframes stay blurred while the setting is on and may reveal while it is off. A page-wide trigger or analysis failure keeps every iframe blurred, and explicit context-menu Unblur may reveal one iframe in either mode.

### NLP Normalization

The extension uses two levels of NLP processing:

1. **Target Word Expansion** ([js/offscreen.js](js/offscreen.js)): When target words are loaded, they're automatically expanded to include variations:
   - Plurals: "mouse" → ["mouse", "mice"]
   - Singulars: "spiders" → ["spiders", "spider"]
   - Verb forms: "run" → ["run", "running", "ran", "runs"]
   - This ensures the first-two-letter optimization catches all word forms

2. **Text Normalization**: Both target words and page text are normalized to handle variations:
   - Plurals, verb forms, contractions, possessives
   - Whitespace, unicode normalization
   - Parameters are configured by `NORMALIZE_PARAMS` in `js/offscreen.js`

### Runtime Updates

Explicit user commands may use these content-script message types:
- `blurAll` / `unblurAll`: Manual blur control from popup
- `unblur`: Unblurs image at context menu click location

Committed setting changes use `chrome.storage.onChanged` as the event bus. Content scripts reevaluate the current page in place; popup and settings code must not broadcast speculative changes or reload tabs.

### Storage Keys (chrome.storage.sync)

- `targetWords`: Array of phobia words entered by user
- `phobiaBlockerEnabled`: Boolean for extension on/off state
- `blurIsAlwaysOn`: Boolean for "always blur" mode
- `blurValueAmount`: Number (0-5+) for blur intensity
- `keepCrossOriginIframesBlurred`: Boolean safety switch for unchecked embedded content; defaults to `true`
- `supportedWordsCollapsed`: UI state for popup accordion

## Code Style (ESLint)

- 4 spaces indentation
- Single quotes
- No semicolons
- Unix line breaks

## Hotkeys

- **Alt+Shift+B**: Blur all visual content on current page
- **Alt+Shift+U**: Unblur all visual content on current page
- **Right-click context menu**: "Unblur" - reveals the selected media resource through later analysis; a resource fingerprint change invalidates the exception

## External Libraries

Located in `js/` directory:
- `jquery-3.4.1.min.js`: DOM manipulation
- `compromise.min.js`: NLP normalization
- `natural.js`: Word tokenization
- `tagify.js` / `jQuery.tagify.min.js`: Tag input UI in popup
- `bootstrap.js`: UI styling for popup
- `stopWords.js`: List of words to ignore during analysis

## Limitations & Known Issues

- Synthetic browser tests remain in the repository as quarantined historical assets and are not current proof of behavior; use the live-site charter and evidence template
- Ordinary computed CSS backgrounds can be discovered, but pseudo-elements, browser-internal surfaces, fenced frames, and closed shadow roots cannot be guaranteed through current Chrome extension APIs
- Backgrounds introduced only by transient CSS states such as `:hover`, `:focus`, or `:checked`, without a DOM, class, style, or stylesheet mutation, cannot be guaranteed; ordinary computed stylesheet backgrounds remain supported
- Storage API failure handling has static/code-path validation only; it has not been runtime-injected on a live site
- Performance: NLP normalization is expensive, uses first-two-letter optimization (but target words are auto-expanded to include variations, so irregular plurals like "mouse/mice" now work)
- Extension persistence is centralized in `js/storage.js`; direct callback-based storage calls outside that adapter are unsupported
