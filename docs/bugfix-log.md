# PhobiaBlocker Bug Fix Log

Session date: 2026-04-23
Audit: 5 parallel Oracle agents (Memory, Race Conditions, Logic/NLP, Chrome APIs, DOM/CSS/State)

> Historical record: this log describes changes and validation claims from the 2026-04-23 session. The approved 2026-08-29 protection architecture supersedes conflicting behavior below. Synthetic browser tests and fixtures are quarantined historical assets, not current browser-behavior proof. Source-string assertions, fixed sleeps, and external iframe fixtures do not establish runtime behavior. Storage API failure handling has received static/code-path validation, but it has not been runtime-injected.

## Current Product Contracts (2026-08-29)

- Detection is page-wide: a trigger anywhere in eligible page text or the title keeps all supported media blurred. Semantic/per-card scopes are not supported.
- Blacklist wins over whitelist and remains active while global protection is off.
- Plain domain rules match the named domain and its subdomains.
- `keepCrossOriginIframesBlurred` defaults to `true`. After a successful clean page analysis, cross-origin or uncertain-origin iframes stay blurred when the setting is on and may reveal when it is off. Triggers and analysis failures keep them blurred in either mode; explicit context-menu Unblur remains available.
- Ordinary computed CSS backgrounds are covered. Pseudo-elements, browser-internal surfaces, fenced frames, and closed shadow roots cannot be guaranteed.
- Backgrounds introduced only by transient CSS states such as `:hover`, `:focus`, or `:checked`, without a DOM, class, style, or stylesheet mutation, cannot be guaranteed. Ordinary computed stylesheet backgrounds remain supported.

## Fix Queue (Priority Order)

| # | Priority | Bug | Status | File(s) |
|---|----------|-----|--------|---------|
| 1 | P0 | ImageNodeList unbounded growth + listener leak | DONE | js/js.js |
| 2 | P0 | `_permanentlyUnblurred` not reset on blurIsAlwaysOn | DONE | js/js.js |
| 3 | P0 | NLP first-two-letter pre-filter misses irregular forms | DONE | js/js.js |
| 4 | P1 | blurIsAlwaysOn ON->OFF race condition | DONE | js/js.js |
| 5 | P1 | BgImageNode.unblur() stale inline filter | DONE | js/js.js |
| 6 | P1 | _tableImageCache strong DOM refs (Map -> WeakMap) | DONE | js/js.js |
| 7 | P2 | Observer feedback loop from BgImageNode styles | DONE | js/js.js |
| 8 | P2 | Historical clean-page cross-origin iframe unblur | SUPERSEDED | js/js.js |
| 9 | P2 | Bootstrap/popup.js toggle conflict | DONE | popup.html, js/popup.js |
| 10 | P2 | runningTextProcessing counter race on src change | DONE | js/js.js |

---

## Fix Details

(Each fix documented below as it's applied)

---

### Fix #1: ImageNodeList unbounded growth + listener leak
**Status:** DONE
**Severity:** CRITICAL (memory leak)
**Files changed:** js/js.js

**Problem:** `ImageNodeList._imageNodeList` array only grows (push, no remove). On infinite-scroll pages, detached DOM nodes and their event listeners accumulate indefinitely (~10KB/entry, 30-100MB in 30-min session).

**Changes made:**
1. Added `prune()` method to `ImageNodeList` (after line 493) — filters out nodes where `el.isConnected === false`, calls `_detachContainerListeners()` on each before discarding
2. Added `teardown()` method to `ImageNodeList` — detaches all container listeners, called before replacing list with new instance
3. Call `this._imageNodeList.prune()` at start of `Controller._processMutationBatch()` (runs every ~500ms)
4. Call `controller._imageNodeList.teardown()` before both `new ImageNodeList()` calls in `blurIsAlwaysOn` toggle handler (ON branch and OFF branch)

**Verification:** eslint shows 12 pre-existing errors only, no new errors introduced.

---

### Fix #2: _permanentlyUnblurred not reset on blurIsAlwaysOn toggle
**Status:** DONE
**Severity:** HIGH (safety mode bypass)
**Files changed:** js/js.js

**Problem:** After "Unblur All" sets `_permanentlyUnblurred = true`, toggling "Blur Always On" never resets the flag. New images from infinite scroll are immediately permanently unblurred, completely defeating the safety mode.

**Changes made:**
1. Added `controller._permanentlyUnblurred = false` at top of `blurIsAlwaysOn` case handler (line 1802), before the whitelist check. Covers both ON and OFF branches since the flag should reset regardless of toggle direction.

**Why one line covers both branches:** The flag is set at the handler entry, before any branching logic. Both the ON branch (blur everything) and the OFF branch (re-analyze) need the flag cleared so `checkAndUpdate()` in `updateImageList()` processes new images normally.

---

### Fix #3: NLP first-two-letter pre-filter misses irregular forms
**Status:** DONE
**Severity:** HIGH (core matching failure)
**Files changed:** js/js.js

**Problem:** `compareTargetsToTextWords()` was called with `targetWordsNormalized` (post-normalization, e.g. only `["mouse"]`). When page text contained "mice", the pre-filter compared prefix "mi" vs "mo" and rejected it before normalization could match them. Same for geese/goose, went/go, was/be, etc.

**Changes made:**
1. Changed line 571 from `compareTargetsToTextWords(targetWordsNormalized, cleanWordsSet)` to `compareTargetsToTextWords(targetWords, cleanWordsSet)`. The `targetWords` list is the expanded pre-normalization list that includes both "mouse" AND "mice", so "mice" on the page passes the "mi"=="mi" prefix check.
2. The final match at line 576 still compares against `targetWordsNormalized` for accuracy — no change needed there.

---

### Fix #4: blurIsAlwaysOn ON->OFF race condition
**Status:** DONE
**Severity:** HIGH (state corruption on rapid toggle)
**Files changed:** js/js.js

**Problem:** Toggle ON defers work into `chrome.storage.sync.get` callback (async). Toggle OFF runs synchronously. Rapid ON->OFF: OFF finishes, sets up clean state, then stale ON callback fires and overwrites everything — blurs all images despite `blurIsAlwaysOn=false`.

**Changes made:**
1. Added `_blurToggleGeneration` counter field to Controller constructor (line 632), initialized to 0
2. ON branch: capture generation with `const blurGen = ++controller._blurToggleGeneration` before the async callback (line 1812)
3. ON callback: guard with `if (blurGen !== controller._blurToggleGeneration) return` (line 1814) — bails if another toggle happened since
4. OFF branch: increment `++controller._blurToggleGeneration` (line 1843) — invalidates any pending ON callback

---

### Fix #5: BgImageNode.unblur() stale inline filter
**Status:** DONE
**Severity:** MEDIUM-HIGH (blocks re-blur after word changes)
**Files changed:** js/js.js

**Problem:** `BgImageNode.unblur()` set `style.setProperty('filter', 'none', 'important')` — a permanent inline style that prevented re-blurring via CSS class changes. After `targetWordsChanged`, bg-image elements got `.phobia-blur` class but the inline `filter: none !important` won. No CSS rule exists for `div.phobia-blur`, so bg images stayed visually unblurred.

**Changes made:**
1. Changed `BgImageNode.unblur()` from `style.setProperty('filter', 'none', 'important')` to `style.removeProperty('filter')`. The CSS rule `div.phobia-noblur { filter: none !important }` (style.css:116-121) already provides the `!important` override that protects against site animation JS re-blurring.

---

### Fix #6: _tableImageCache strong DOM refs (Map -> WeakMap)
**Status:** DONE
**Severity:** MEDIUM (memory leak on table-heavy SPAs)
**Files changed:** js/js.js

**Problem:** `_tableImageCache` was a regular `Map` with table DOM elements as keys — strong references that prevented GC when tables were removed from the DOM. The cleanup block only triggered at >100 entries and only deleted expired ones, so tables removed before expiry leaked permanently.

**Changes made:**
1. Changed `new Map()` to `new WeakMap()` (line 1008). WeakMap keys are weakly held — when a table element is removed from the DOM and has no other references, the entry is automatically GC'd.
2. Removed the 11-line manual cleanup block (`if (this._tableImageCache.size > 100) { ... }`) — unnecessary with WeakMap since it handles GC automatically.
3. Kept the 5-second TTL check on read (line 1016) — stale entries are still refreshed on access.

---

### Fix #7: Observer feedback loop from BgImageNode styles
**Status:** DONE
**Severity:** MEDIUM (performance)
**Files changed:** js/js.js

**Problem:** MutationObserver watches `style` attribute changes. The filter at line 1199 skips style/class mutations on IMG/VIDEO/IFRAME, but BgImageNode targets DIV/SPAN — those pass through. Every `BgImageNode.blur()`/`unblur()` triggers wasted mutation→batch cycles (2-3 per element). On bg-image-heavy pages (Pinterest), this causes measurable layout thrashing.

**Changes made:**
1. Added a second filter condition after line 1199: skip `style` attribute mutations on elements that have `.phobia-blur` or `.phobia-noblur` class (extension-managed elements). This catches BgImageNode inline style changes without affecting `class` mutations or `src` changes on media elements.

---

### Fix #8: Historical clean-page cross-origin iframe unblur
**Status:** SUPERSEDED by the 2026-08-29 configurable iframe policy
**Severity:** MEDIUM (UX issue — all YouTube/Vimeo embeds stay blurred)
**Files changed:** js/js.js

**Historical problem statement:** `IframeNode.textProcessingFinished()` returned early unconditionally if `_isCrossOrigin()` was true. Even when the page-wide text analysis found zero phobia words, cross-origin iframes (YouTube, Vimeo, etc.) stayed blurred. Users had to manually unblur every embedded video.

**Historical change:**
1. Changed line 445 from `if (this._isCrossOrigin()) return` to `if (this._isCrossOrigin() && !this.hasBeenAnalyzed) return`. That implementation allowed cross-origin iframes to unblur after clean analysis.

**Current replacement policy:** `keepCrossOriginIframesBlurred` is enabled by default. It keeps cross-origin and uncertain-origin iframes blurred after clean analysis while on; turning it off allows them to reveal after a clean result. A page-wide trigger or analysis failure keeps them blurred regardless of the switch.

---

### Fix #9: Bootstrap/popup.js toggle conflict
**Status:** DONE
**Severity:** MEDIUM (broken popup toggle buttons)
**Files changed:** popup.html, js/popup.js

**Problem:** Both Bootstrap collapse JS (`data-bs-toggle="collapse"`) and popup.js click handlers controlled the same collapsible sections. On click: Bootstrap toggled `aria-expanded` and expanded the section, then popup.js read the updated `aria-expanded` and collapsed it. Net result: toggles appeared broken.

**Changes made:**
1. Removed `data-bs-toggle`, `data-bs-target`, `aria-expanded`, `aria-controls` from both toggle buttons in popup.html (lines 33, 117). popup.js is now the sole controller.
2. Changed popup.js click handlers (lines 213-225) to check actual DOM state (`area.classList.contains('show')`) instead of reading the now-removed `aria-expanded` attribute.

---

### Fix #10: runningTextProcessing counter race on src change
**Status:** DONE
**Severity:** MEDIUM (premature unblur flash during lazy load)
**Files changed:** js/js.js

**Problem:** When an element's `src` changes, `runningTextProcessing` is reset to 0 and a new analysis starts. But the previous in-flight analysis eventually calls `textProcessingFinished()`, decrementing the counter past what the new analysis expects. This causes premature unblur (counter hits 0 while new analysis is still running).

**Changes made:**
1. Added `_analysisGeneration` counter field to `ImageNode` constructor (line 138), initialized to 0
2. `newTextProcessingStarted()` now returns the current generation value (line 322)
3. `textProcessingFinished(generation)` accepts a generation parameter. If the generation doesn't match the current `_analysisGeneration`, the call is silently ignored (stale callback from a pre-src-change analysis)
4. `_analysisGeneration` is incremented on src change (line 1092) alongside the counter reset
5. `startAnalysis()` captures per-node generation via `generationByNode` Map at start, passes it through to `textProcessingFinished` on completion
6. Error recovery path calls `textProcessingFinished()` without generation (undefined) — skips the stale check to always decrement, preventing stuck counters
7. `TagImageNode.textProcessingFinished` and `IframeNode.textProcessingFinished` overrides updated to pass generation through

**Verification:** eslint shows 12 pre-existing errors only, no new errors.
