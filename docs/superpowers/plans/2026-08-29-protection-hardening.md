# PhobiaBlocker Protection Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PhobiaBlocker's page-wide protection consistent, fail-closed, resistant to page-authored bypasses, efficient on dynamic pages, safely configurable for cross-origin embeds, and reproducibly packaged.

**Architecture:** Add classic shared policy and storage modules, then make early protection, the main controller, popup, settings, background, and offscreen analysis consume those contracts. Replace semantic-scope machinery and repeated `body.innerText` scans with one incremental page-wide text index, store explicit reveals in isolated-world state, consolidate protection CSS, and apply committed setting changes without navigation.

**Tech Stack:** Chrome Extension Manifest V3, classic JavaScript content scripts, Chrome storage/offscreen/runtime APIs, HTML/CSS, Bash, ESLint, ZIP/UnZip, connected Chrome live-site inspection.

**Spec:** `docs/superpowers/specs/2026-08-29-protection-architecture-design.md`

## Global Constraints

- Detection remains page-wide: one configured trigger anywhere in eligible page text or title blurs all visual media on that page.
- Protection precedence is blacklist, whitelist, global enabled state, Always Blur Media, then analysis.
- `keepCrossOriginIframesBlurred` defaults to `true`; analysis and storage failures remain fail-closed.
- Public DOM classes and attributes are rendering outputs, never authorization inputs.
- Synthetic/local browser fixtures and automated behavior suites remain quarantined and must not be run.
- Functional verification uses natural content on live public websites without injected trigger or media DOM.
- Lint, shell syntax, manifest parsing, and fresh-archive inspection are permitted static/build checks.
- Preserve all pre-existing staged and unstaged work. Do not stash, reset, clean, or stage implementation files.
- Because target files already contain user-approved dirty baseline changes, do not create implementation commits until the user reviews the combined final diff.
- Follow the repository style: four-space indentation, single quotes, no semicolons, Unix line endings.

## File Structure

- Create `js/shared-policy.js`: frozen defaults, storage keys, target-word grammar, site-rule matching, and protection-mode resolution.
- Create `js/storage.js`: promise-based `chrome.storage.sync` reads/writes with explicit missing-value and API-failure semantics.
- Create `js/page-text-index.js`: page-wide rendered-text indexing and mutation-driven incremental updates.
- Create `css/protection.css`: single protection-state stylesheet.
- Modify `manifest.json`: deterministic shared-script/CSS order and single content-script declaration.
- Modify `popup.html`, `settings.html`, `offscreen.html`: load shared scripts before consumers and add the iframe safety setting UI.
- Modify `js/background.js`: install defaults, cache valid targets, and return fail-closed analysis results after storage failure.
- Modify `js/offscreen.js`: consume shared target normalization and reject malformed analysis input safely.
- Modify `js/popup.js`: shared validation, shared policy status, and awaited storage operations.
- Modify `js/settings.js`: iframe switch, awaited site-rule writes, and no tab reload broadcasts.
- Modify `js/early-blur.js`: shared policy/storage, pending state, immediate direct-word covering, and no embedded CSS copy.
- Modify `js/js.js`: one page-wide controller, in-place mode transitions, incremental analysis, internal reveal ownership, and computed-background lifecycle.
- Modify `css/settings.css`: iframe setting and storage error presentation.
- Modify `css/tags.css`: invalid stored-trigger and popup validation-error presentation.
- Remove `css/early-blur.css` and `css/style.css` after their unique required rules are represented in `css/protection.css`.
- Modify `pack.sh`: fresh temporary archive, validation, and atomic replacement.
- Modify `package.json`: quarantine synthetic test commands and add an explicit lint command.
- Modify `AGENTS.md`, `README.md`, `docs/bugfix-log.md`, and `tests/agent-testing-charter.md`: align claims with actual page-wide behavior and live-only verification.
- Create `docs/live-site-validation.md`: evidence table for the final live browser pass.

---

### Task 1: Create the shared policy and storage contracts

**Files:**
- Create: `js/shared-policy.js`
- Create: `js/storage.js`

**Interfaces:**
- Produces: `globalThis.PhobiaBlockerPolicy`.
- Produces: `globalThis.PhobiaBlockerStorage`.
- Consumes: `chrome.storage.sync` only from `js/storage.js`.

- [ ] **Step 1: Define the shared policy namespace**

Implement an idempotent classic-script wrapper with this public surface:

```js
(() => {
    'use strict'
    if (globalThis.PhobiaBlockerPolicy) return

    const STORAGE_KEYS = Object.freeze({
        targetWords: 'targetWords',
        enabled: 'phobiaBlockerEnabled',
        alwaysBlur: 'blurIsAlwaysOn',
        wordCover: 'wordCoverEnabled',
        blurAmount: 'blurValueAmount',
        previewEnabled: 'previewEnabled',
        previewStrength: 'previewBlurStrength',
        whitelist: 'whitelistedSites',
        blacklist: 'blacklistedSites',
        keepCrossOriginIframesBlurred: 'keepCrossOriginIframesBlurred',
        debugMode: 'debugMode',
    })

    const DEFAULTS = Object.freeze({
        targetWords: Object.freeze(['clown', 'mice', 'spider']),
        phobiaBlockerEnabled: true,
        blurIsAlwaysOn: false,
        wordCoverEnabled: true,
        blurValueAmount: 50,
        previewEnabled: true,
        previewBlurStrength: 5,
        whitelistedSites: Object.freeze([]),
        blacklistedSites: Object.freeze([]),
        keepCrossOriginIframesBlurred: true,
        debugMode: false,
    })

    const PROTECTION_MODE = Object.freeze({
        DISABLED: 'DISABLED',
        ALWAYS_BLUR: 'ALWAYS_BLUR',
        ANALYZE: 'ANALYZE',
    })

    function isValidStoredValue(name, value) {
        if (name === 'targetWords' || name === 'whitelistedSites' || name === 'blacklistedSites') {
            return Array.isArray(value) && value.every(item => typeof item === 'string')
        }
        if (name === 'blurValueAmount' || name === 'previewBlurStrength') {
            return typeof value === 'number' && Number.isFinite(value)
        }
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, name)) {
            return typeof value === typeof DEFAULTS[name]
        }
        return false
    }
})()
```

- [ ] **Step 2: Implement the exact target-word contract**

Expose these functions:

```js
function validateTargetWord(rawWord) {
    const normalized = typeof rawWord === 'string'
        ? rawWord.normalize('NFKC').trim().toLowerCase()
        : ''
    const letters = normalized.match(/\p{L}/gu) || []
    const validShape = /^\p{L}+(?:-\p{L}+)*$/u.test(normalized)
    let reason = ''
    if (!normalized) reason = 'Enter a trigger word.'
    else if (normalized.length > 30) reason = 'Use 30 characters or fewer.'
    else if (letters.length < 3) reason = 'Use at least three letters.'
    else if (!validShape) reason = 'Use one word containing letters; hyphens are allowed between letters.'
    return { valid: reason === '', normalized, reason }
}

function normalizeTargetWords(rawWords) {
    const valid = []
    const invalid = []
    const seen = new Set()
    for (const raw of Array.isArray(rawWords) ? rawWords : []) {
        const result = validateTargetWord(raw)
        if (!result.valid) {
            invalid.push({ raw, reason: result.reason })
        } else if (!seen.has(result.normalized)) {
            seen.add(result.normalized)
            valid.push(result.normalized)
        }
    }
    return { valid, invalid }
}
```

- [ ] **Step 3: Implement site-rule parsing and matching**

`parseSiteRule(rawRule)` must return either `{ valid: false, reason }` or `{ valid: true, normalized, host, path }`. Lowercase only `host`; preserve `path` case. Strip an optional scheme, reject credentials/query/hash, accept an optional leading `*.`, and normalize both plain and wildcard base domains to current runtime behavior: the base host and all subdomains match.

```js
function parseSiteRule(rawRule) {
    const input = typeof rawRule === 'string' ? rawRule.trim() : ''
    if (!input) return { valid: false, reason: 'Enter a domain.' }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) {
        return { valid: false, reason: 'Only HTTP and HTTPS website addresses are supported.' }
    }
    let rule = input.replace(/^https?:\/\//i, '')
    if (/[?#@]/.test(rule)) {
        return { valid: false, reason: 'Do not include credentials, a query, or a page fragment.' }
    }
    const slashIndex = rule.indexOf('/')
    let host = (slashIndex === -1 ? rule : rule.slice(0, slashIndex)).toLowerCase()
    const path = slashIndex === -1 || rule.slice(slashIndex) === '/' ? '' : rule.slice(slashIndex)
    if (host.startsWith('*.')) host = host.slice(2)
    const domain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
    if (!domain.test(host)) return { valid: false, reason: 'Enter a valid domain.' }
    return { valid: true, normalized: `${host}${path}`, host, path }
}
```

Use this matching rule:

```js
function matchesSiteRule(currentUrl, rawRule) {
    const rule = parseSiteRule(rawRule)
    if (!rule.valid) return false
    let url
    try { url = new URL(currentUrl) } catch (_) { return false }
    const hostname = url.hostname.toLowerCase()
    const hostMatches = hostname === rule.host || hostname.endsWith(`.${rule.host}`)
    if (!hostMatches) return false
    if (!rule.path) return true
    return url.pathname === rule.path || url.pathname.startsWith(`${rule.path}/`)
}
```

- [ ] **Step 4: Implement the single precedence resolver**

```js
function resolveProtectionMode(settings, currentUrl) {
    const blacklist = Array.isArray(settings.blacklistedSites) ? settings.blacklistedSites : []
    const whitelist = Array.isArray(settings.whitelistedSites) ? settings.whitelistedSites : []
    if (blacklist.some(rule => matchesSiteRule(currentUrl, rule))) return PROTECTION_MODE.ALWAYS_BLUR
    if (whitelist.some(rule => matchesSiteRule(currentUrl, rule))) return PROTECTION_MODE.DISABLED
    if (settings.phobiaBlockerEnabled === false) return PROTECTION_MODE.DISABLED
    if (settings.blurIsAlwaysOn === true) return PROTECTION_MODE.ALWAYS_BLUR
    return PROTECTION_MODE.ANALYZE
}
```

Freeze and publish only the named constants/functions. Do not publish mutable internal arrays or regular expressions.

- [ ] **Step 5: Implement fail-aware storage wrappers**

Expose `getRaw(keys)`, `getWithDefaults(keys)`, `set(values)`, and `initializeMissingDefaults(keys)`:

```js
const { DEFAULTS, isValidStoredValue } = globalThis.PhobiaBlockerPolicy

function getRaw(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get(keys, values => {
            const error = chrome.runtime.lastError
            if (error) reject(new Error(error.message))
            else resolve(values || {})
        })
    })
}

async function getWithDefaults(keys) {
    const values = await getRaw(keys)
    const names = Array.isArray(keys) ? keys : [keys]
    return Object.fromEntries(names.map(name => {
        const stored = values[name]
        if (stored !== undefined && !isValidStoredValue(name, stored)) {
            throw new Error(`Invalid stored value for ${name}`)
        }
        const value = stored === undefined ? DEFAULTS[name] : stored
        return [name, Array.isArray(value) ? [...value] : value]
    }))
}

function set(values) {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.set(values, () => {
            const error = chrome.runtime.lastError
            if (error) reject(new Error(error.message))
            else resolve()
        })
    })
}
```

`initializeMissingDefaults(keys)` reads raw values, builds one object containing only absent keys, clones array defaults before writing, and resolves only after the write succeeds. It is called only by `background.js` during installation.

- [ ] **Step 6: Run allowed static checks**

Run:

```bash
npx eslint js/shared-policy.js js/storage.js
```

Expected: exit 0 with no lint errors. Do not run `npm test` or any file under `tests/`.

- [ ] **Step 7: Review the task diff without staging it**

Run:

```bash
git diff --check -- js/shared-policy.js js/storage.js
git status --short js/shared-policy.js js/storage.js
```

Expected: no whitespace errors; both new files remain untracked for the final combined review.

### Task 2: Wire shared contracts into every extension context

**Files:**
- Modify: `manifest.json`
- Modify: `popup.html`
- Modify: `settings.html`
- Modify: `offscreen.html`
- Modify: `js/background.js`

**Interfaces:**
- Consumes: `globalThis.PhobiaBlockerPolicy` and `globalThis.PhobiaBlockerStorage` from Task 1.
- Produces: deterministic script order for content, popup, settings, offscreen, and background contexts.

- [ ] **Step 1: Consolidate content-script ordering in the manifest**

Replace the two duplicate document-start entries with one:

```json
{
    "matches": ["<all_urls>"],
    "js": [
        "js/shared-policy.js",
        "js/storage.js",
        "js/early-blur.js",
        "js/js.js"
    ],
    "css": ["css/protection.css"],
    "all_frames": true,
    "run_at": "document_start"
}
```

Task 8 adds `js/page-text-index.js` between `js/storage.js` and `js/early-blur.js` after the file exists, so the unpacked extension remains loadable between tasks.

- [ ] **Step 2: Load the shared scripts before UI consumers**

Use this order at the bottom of `popup.html` and `settings.html`:

```html
<script src="js/shared-policy.js"></script>
<script src="js/storage.js"></script>
<script src="js/popup.js"></script>
```

Use `js/settings.js` instead of `js/popup.js` in the settings page. In `offscreen.html`, load `js/shared-policy.js` before `js/compromise.min.js` and `js/offscreen.js`; do not load `js/storage.js` there because the analyzer does not own settings persistence.

- [ ] **Step 3: Load shared scripts in the service worker**

Add this as the first executable line in `js/background.js`:

```js
importScripts('shared-policy.js', 'storage.js')
```

Then bind local constants from the frozen namespaces rather than redeclaring defaults.

- [ ] **Step 4: Parse the manifest and lint the wiring changes**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8'))"
npx eslint js/background.js
```

Expected: both commands exit 0. Do not load Chrome until every manifest-listed file exists.

### Task 3: Make background and offscreen analysis fail closed

**Files:**
- Modify: `js/background.js`
- Modify: `js/offscreen.js`

**Interfaces:**
- Consumes: `normalizeTargetWords()`, `DEFAULTS`, `getRaw()`, `set()`, and `initializeMissingDefaults()`.
- Produces: cached valid targets or an explicit unavailable state; analysis responses shaped as `{ shouldBlur: boolean, matchedWords: string[] }`.

- [ ] **Step 1: Initialize all shared defaults only on installation**

In `runtime.onInstalled`, call:

```js
if (details.reason === 'install') {
    await PhobiaBlockerStorage.initializeMissingDefaults(Object.keys(PhobiaBlockerPolicy.DEFAULTS))
}
```

Wrap the async handler so a failure is logged once and does not create partial fallback writes from other contexts.

- [ ] **Step 2: Replace target cache loading with three explicit states**

Use `null` for not loaded/unavailable and an array for successfully loaded valid targets:

```js
async function loadTargetWordsFromStorage() {
    try {
        const values = await PhobiaBlockerStorage.getRaw(PhobiaBlockerPolicy.STORAGE_KEYS.targetWords)
        const raw = values.targetWords === undefined
            ? PhobiaBlockerPolicy.DEFAULTS.targetWords
            : values.targetWords
        _cachedTargetWords = PhobiaBlockerPolicy.normalizeTargetWords(raw).valid
        return _cachedTargetWords
    } catch (error) {
        _cachedTargetWords = null
        console.error('PhobiaBlocker: target-word storage read failed', error)
        throw error
    }
}
```

The storage change listener sets the cache to `null` before reloading. It must not write defaults when a key is removed or a read fails.

- [ ] **Step 3: Refuse to analyze without a successful target cache**

Before sending work to the offscreen document:

```js
if (_cachedTargetWords === null) {
    try { await loadTargetWordsFromStorage() } catch (_) {
        return { ...FAIL_CLOSED_ANALYSIS_RESULT }
    }
}
```

Every malformed, rejected, timed-out, or missing offscreen response also returns `FAIL_CLOSED_ANALYSIS_RESULT`.

- [ ] **Step 4: Use shared target normalization in offscreen analysis**

Replace the private input filter with:

```js
const { normalizeTargetWords } = globalThis.PhobiaBlockerPolicy
const safeTargets = normalizeTargetWords(message.targetWords).valid
if (!Array.isArray(message.words) || safeTargets.length === 0) {
    sendAnalysisResponse({ shouldBlur: true, matchedWords: [] })
    return
}
```

Keep NLP expansion/normalization after this boundary. Do not convert invalid input into a clean result.

- [ ] **Step 5: Run static checks**

Run:

```bash
npx eslint js/background.js js/offscreen.js
```

Expected: exit 0. Do not use a mocked storage failure or run an automated test; record that runtime failure injection remains unverified.

### Task 4: Make popup and settings use committed shared state

**Files:**
- Modify: `popup.html`
- Modify: `settings.html`
- Modify: `css/settings.css`
- Modify: `css/tags.css`
- Modify: `js/popup.js`
- Modify: `js/settings.js`

**Interfaces:**
- Consumes: `validateTargetWord()`, `normalizeTargetWords()`, `parseSiteRule()`, `resolveProtectionMode()`, `getWithDefaults()`, and `set()`.
- Produces: validated target persistence, truthful site status, awaited site-rule changes, and `keepCrossOriginIframesBlurred` UI.

- [ ] **Step 1: Add the approved cross-origin iframe switch**

Add a Protection navigation item and section to `settings.html` containing:

```html
<section id="protection" class="settings-section">
    <h2 class="section-title">Protection</h2>
    <div class="settings-group">
        <div class="setting-item">
            <div class="setting-left">
                <label for="cross-origin-iframe-switch" class="setting-label">Keep unchecked embedded content blurred</label>
                <p class="setting-description">
                    Videos, maps, posts, and advertisements can be embedded from another website.
                    PhobiaBlocker cannot reliably inspect what is inside them.
                    Keep this on for stronger protection: embeds stay blurred until you reveal them manually.
                    Turn it off for easier browsing: embeds appear when the rest of the page is safe,
                    but they could still contain something you asked PhobiaBlocker to hide.
                </p>
            </div>
            <div class="setting-right">
                <label class="switch">
                    <input type="checkbox" id="cross-origin-iframe-switch">
                    <span class="slider"></span>
                </label>
            </div>
        </div>
    </div>
</section>
```

- [ ] **Step 2: Persist the iframe switch only after success**

Load it through `getWithDefaults()`. On change, disable the switch while awaiting `set({ keepCrossOriginIframesBlurred: checked })`; re-enable after settlement. On failure, restore the previous checked state and show an inline `.settings-error` containing `Could not save this setting. Your previous setting is still active.`

Add `.settings-error` to `css/settings.css`, and add `.word-error` plus `.tag-invalid` to `css/tags.css`:

```css
.settings-error,
.word-error {
    color: #b42318;
    font-size: 0.875rem;
    margin-top: 8px;
}

.tag-invalid {
    border: 1px solid #b42318;
    background: #fff1f0;
}
```

- [ ] **Step 3: Await site-rule add and remove writes**

Build a candidate array without mutating the rendered source array:

```js
const candidate = [...whitelistedSites, parsed.normalized]
try {
    await PhobiaBlockerStorage.set({ whitelistedSites: candidate })
    whitelistedSites = candidate
    renderWhitelist()
    input.value = ''
} catch (_) {
    showSettingsError('Could not save the whitelist. Nothing was changed.')
}
```

Use the equivalent flow for blacklist and removal. Delete `notifyTabsToReload()` and every `siteRulesChanged` broadcast.

- [ ] **Step 4: Correct site-rule UI semantics**

Replace `isValidSitePattern()` with `parseSiteRule()`. Preserve path case. Change the example copy for `example.com` to `This domain and its subdomains`; keep `example.com/path` documented as that case-sensitive path and its descendants.

- [ ] **Step 5: Reject invalid popup target words before persistence**

Use the shared result and a visible error node:

```html
<p id="word-error" class="word-error" role="alert" hidden></p>
```

```js
const result = PhobiaBlockerPolicy.validateTargetWord(word)
if (!result.valid) {
    showWordError(result.reason)
    return
}
if (targetWords.some(existing => (
    PhobiaBlockerPolicy.validateTargetWord(existing).normalized === result.normalized
))) {
    showWordError('That trigger word is already in your list.')
    return
}
```

Keep the 20-word limit. Persist through `await PhobiaBlockerStorage.set()` before updating the displayed list. Mark existing invalid stored tags with `.tag-invalid`, their validation reason, and a remove button; keep their stored values until explicit removal.

- [ ] **Step 6: Derive popup status from the shared resolver**

Read the complete policy settings and call `resolveProtectionMode(settings, activeTab.url)`. Map modes and rule matches to the existing status labels, ensuring a blacklisted site reports `Blacklisted — always blurred` even when global protection is off or the site is also whitelisted.

- [ ] **Step 7: Remove speculative settings messages**

Convert popup controls that represent stored policy to awaited storage writes. Content scripts will react to `storage.onChanged`; keep runtime messages only for immediate commands such as Blur All, Unblur All, context Unblur, and icon/debug queries.

- [ ] **Step 8: Run static checks**

Run:

```bash
npx eslint js/popup.js js/settings.js
```

Expected: exit 0. Read back the HTML to confirm the shared scripts precede the page consumer script and every referenced element ID exists once.

### Task 5: Replace divergent policy branches with one in-place controller transition

**Files:**
- Modify: `js/early-blur.js`
- Modify: `js/js.js`

**Interfaces:**
- Consumes: shared defaults/storage/policy and committed `chrome.storage.onChanged` events.
- Produces: `applyProtectionMode(mode, settings, generation)` and stale-result cancellation.

- [ ] **Step 1: Remove private defaults and site matchers**

Delete duplicated `DEFAULT_*`, `matchesSitePattern()`, `isWhitelisted()`, and `isBlacklisted()` implementations from both scripts. Bind shared constants once and keep a single current settings object.

- [ ] **Step 2: Make initial settings reads fail closed**

Read all policy keys with `getWithDefaults()`. On rejection, pass `ALWAYS_BLUR` to the transition function and retain pending protection. Do not replace a read error with default target words or a clean analysis.

- [ ] **Step 3: Add a generation-guarded mode transition**

Use one effect function:

```js
async function applyProtectionMode(mode, settings) {
    const generation = ++controller._policyGeneration
    controller.cancelPendingAnalysis()
    controller.setSettings(settings)
    if (mode === PROTECTION_MODE.DISABLED) {
        controller.disableProtection()
        return
    }
    controller.enableProtection()
    controller.protectAllKnownVisuals()
    if (mode === PROTECTION_MODE.ALWAYS_BLUR) return
    const result = await controller.analyzeCurrentPage(generation)
    if (generation !== controller._policyGeneration) return
    controller.applyPageResult(result, settings)
}
```

`cancelPendingAnalysis()` clears timers, marks in-flight results stale, and stops only extension-owned observers/listeners. `disableProtection()` removes word covers and rendering state without navigation. `enableProtection()` reattaches observers idempotently.

- [ ] **Step 4: React only to committed storage changes**

Register one `chrome.storage.onChanged` listener for policy keys. Re-read the complete policy snapshot after a relevant sync change, resolve the mode, and call `applyProtectionMode()`. Delete the `siteRulesChanged` reload case and policy-setting message cases made obsolete by storage events.

- [ ] **Step 5: Preserve immediate manual commands**

Keep Blur All and Unblur All as per-tab commands. Blur All cancels pending analysis and clears explicit reveals. Unblur All reveals only registered current media; it does not set a flag that automatically reveals future lazy-loaded media.

- [ ] **Step 6: Run static checks and search for duplicated branches**

Run:

```bash
npx eslint js/early-blur.js js/js.js
rg -n "siteRulesChanged|window\.location\.reload|function matchesSitePattern|function isWhitelisted|function isBlacklisted" js/early-blur.js js/js.js js/popup.js js/settings.js
```

Expected: lint exits 0 and the search returns no private site-policy implementations or site-rule reload behavior.

### Task 6: Move explicit reveal authorization into isolated-world state

**Files:**
- Modify: `js/js.js`
- Modify: `css/protection.css`

**Interfaces:**
- Produces: `ExplicitRevealRegistry` behavior owned by the controller.
- Consumes: visual-node resource fingerprints and manual commands.

- [ ] **Step 1: Add media fingerprinting**

Implement `getMediaFingerprint(element)` with stable, type-specific fields:

```js
function getMediaFingerprint(element) {
    if (element instanceof HTMLImageElement) {
        return JSON.stringify(['img', element.getAttribute('src'), element.getAttribute('srcset'), element.currentSrc])
    }
    if (element instanceof HTMLVideoElement) {
        const sources = [...element.querySelectorAll('source')].map(source => source.src)
        return JSON.stringify(['video', element.getAttribute('src'), element.poster, element.currentSrc, sources])
    }
    if (element instanceof HTMLIFrameElement) {
        return JSON.stringify(['iframe', element.getAttribute('src'), element.getAttribute('srcdoc')])
    }
    return JSON.stringify(['background', getComputedStyle(element).backgroundImage])
}
```

- [ ] **Step 2: Store explicit reveals in a `WeakMap`**

Add controller methods:

```js
rememberExplicitReveal(element) {
    this._explicitReveals.set(element, getMediaFingerprint(element))
}

isExplicitlyRevealed(element) {
    const saved = this._explicitReveals.get(element)
    if (!saved) return false
    if (saved !== getMediaFingerprint(element)) {
        this._explicitReveals.delete(element)
        return false
    }
    return true
}
```

Context Unblur calls `rememberExplicitReveal()` before rendering the element revealed. Blur All replaces the registry with a new `WeakMap`.

- [ ] **Step 3: Remove DOM authorization reads**

No blur/unblur decision may branch on `phobia-permanent-unblur`, `phobia-noblur`, or an authorable data attribute. Those markers may remain as diagnostics, but every generic protection selector applies regardless of pre-existing marker classes, and the controller reapplies an authorized reveal only after consulting the `WeakMap`.

- [ ] **Step 4: Invalidate changed resources during mutation handling**

Observe `src`, `srcset`, `poster`, `sizes`, `class`, and `style`. When a registered element changes, call `isExplicitlyRevealed()` before applying the current page result. A fingerprint mismatch removes diagnostic reveal markers and immediately protects the new resource.

- [ ] **Step 5: Run static checks and bypass search**

Run:

```bash
npx eslint js/js.js
rg -n "not\(\.phobia-permanent-unblur\)|contains\('phobia-permanent-unblur'\)|contains\('phobia-noblur'\)" js/js.js css/protection.css
```

Expected: the stylesheet has no permanent-unblur exemption and JavaScript contains no class-based authorization decision.

### Task 7: Consolidate protection CSS and discover stylesheet backgrounds

**Files:**
- Create: `css/protection.css`
- Modify: `js/early-blur.js`
- Modify: `js/js.js`
- Modify: `manifest.json`
- Remove: `css/early-blur.css`
- Remove: `css/style.css`

**Interfaces:**
- Consumes: controller-owned rendering state.
- Produces: one protection stylesheet and computed-background registration.

- [ ] **Step 1: Build one static protection stylesheet**

Move the unique required blur, preview, pointer-event, disabled, word-cover, and CSS-variable rules into `css/protection.css`. Add pending background suppression:

```css
:root:not(.phobia-disabled):not([data-phobiablocker-background-ready]) body * {
    background-image: none !important;
}

[data-phobiablocker-background][data-phobia-blur] {
    filter: var(--filterStrength) !important;
}
```

Do not exclude `.phobia-permanent-unblur` or `.phobia-noblur` from generic protection selectors. Authorized reveals are applied afterward by controller-owned inline rendering with `important` priority.

- [ ] **Step 2: Delete the embedded CSS string and injection lifecycle**

Remove `EARLY_BLUR_CSS`, `_injectEarlyStyle()`, `_removeEarlyStyle()`, and `STYLE_ID` from `js/early-blur.js`. The manifest-injected stylesheet is the only protection CSS source.

- [ ] **Step 3: Register computed backgrounds on any ordinary element**

Replace tag/inline-style-only discovery with a tree walk whose candidate check uses:

```js
function hasComputedBackgroundImage(element) {
    if (!(element instanceof Element)) return false
    const value = getComputedStyle(element).backgroundImage
    return Boolean(value && value !== 'none' && value.includes('url('))
}
```

Mark registered elements with `data-phobiablocker-background` only as a rendering/debug projection. Keep the authoritative node registry in JavaScript.

- [ ] **Step 4: Make background readiness fail closed**

Do not set `data-phobiablocker-background-ready` until the initial walk has registered and applied the current protected state to every discovered background. If discovery throws, keep the pending suppression rule active and log the failure.

- [ ] **Step 5: Invalidate computed-background state on live changes**

For added subtrees and `class`/`style` mutations, scan only the affected subtree. When a `<style>` or stylesheet `<link>` is added, or a stylesheet link finishes loading, schedule one coalesced document background rescan. Removed nodes are deleted from the strong registry so detached elements do not leak.

- [ ] **Step 6: Switch the manifest and remove duplicate files**

After `css/protection.css` is complete, ensure the content-script CSS list names only that file. Remove `css/early-blur.css` and `css/style.css`, then search for stale references.

- [ ] **Step 7: Run static checks**

Run:

```bash
npx eslint js/early-blur.js js/js.js
rg -n "early-blur\.css|style\.css|EARLY_BLUR_CSS" manifest.json js css
```

Expected: lint exits 0 and the search returns no stale protection CSS source/reference.

### Task 8: Replace scope rescans with one incremental page text index

**Files:**
- Create: `js/page-text-index.js`
- Modify: `manifest.json`
- Modify: `js/early-blur.js`
- Modify: `js/js.js`

**Interfaces:**
- Produces: `globalThis.PhobiaBlockerPageTextIndex` constructor.
- Consumes: DOM roots, mutation records, and a callback for synchronously covering direct target matches.

- [ ] **Step 1: Implement the page text index**

Create an idempotent classic script exposing a class with `build(root)`, `applyMutations(records)`, `getWords()`, `setTargetWords(words)`, and `clear()`.

Use a `Map<Text, string[]>` so removed nodes can be deleted and current page words can be counted without calling `body.innerText`. Exclude text whose parent is inside:

```js
const EXCLUDED_SELECTOR = [
    'script', 'style', 'noscript', 'input', 'textarea', 'select', 'option',
    'form', '[contenteditable="true"]', '[hidden]', '[aria-hidden="true"]',
    '.phobia-word-cover', '.phobia-word-permanent-uncover',
].join(', ')
```

Check rendered visibility at indexing time with `getClientRects().length` and computed `display`, `visibility`, and `contentVisibility`. Reindex an affected subtree after `class`, `style`, `hidden`, or `aria-hidden` changes.

- [ ] **Step 2: Maintain token counts incrementally**

When indexing a text node, remove its previous tokens from a `Map<string, number>`, normalize its current tokens, then add new counts. `getWords()` returns keys whose counts are positive. Subtree removal walks existing indexed text descendants and decrements their counts.

- [ ] **Step 3: Cover direct target matches in the observer turn**

Before scheduling NLP, call the existing word-cover renderer only for changed text nodes and only with the shared validated target set. Remove the fixed 500 ms mutation batch plus 350 ms word-cover debounce for this path. Mark extension-created wrapper mutations so they do not reenter the index.

- [ ] **Step 4: Collapse controller scope state to one page result**

Remove `_scopeStatesByElement`, `_resolveAnalysisScopeElement()`, `_extractScopeWords()`, `_analyzeScopes()`, `_reanalyzeScopes()`, and their semantic-scope helpers. Replace them with:

```js
async analyzeCurrentPage(generation) {
    const words = this._pageTextIndex.getWords()
    const result = await analyzePageWordsWithOffscreen(words)
    if (generation !== this._policyGeneration) return FAIL_CLOSED_RESULT
    this._pageAnalysisResult = this._normalizeAnalysisResult(result)
    return this._pageAnalysisResult
}
```

One trigger result applies to every registered media/background node.

- [ ] **Step 5: Implement cross-origin iframe result handling**

Use:

```js
function isCrossOriginIframe(iframe) {
    try {
        const source = iframe.getAttribute('src')
        if (!source || source === 'about:blank' || iframe.hasAttribute('srcdoc')) return false
        return new URL(source, document.baseURI).origin !== location.origin
    } catch (_) {
        return true
    }
}
```

On a successful clean result, reveal an iframe only when it is same-origin or `settings.keepCrossOriginIframesBlurred === false`. Triggered and failed results blur every iframe. An explicit internal reveal still wins for the unchanged iframe resource.

- [ ] **Step 6: Handle title and dynamic mutations**

Observe the document element so title text, body text, and stylesheet additions enter the same mutation stream. Protect new media synchronously, apply index changes, then issue one generation-guarded analysis per coalesced observer turn. A trigger removal may reveal content only after the updated complete index produces a successful clean result.

- [ ] **Step 7: Run static checks and full-scan searches**

Run:

```bash
npx eslint js/page-text-index.js js/early-blur.js js/js.js
rg -n "body\.innerText|_scopeStatesByElement|_resolveAnalysisScopeElement|_analyzeScopes|_reanalyzeScopes" js/js.js js/page-text-index.js
```

Expected: lint exits 0; no repeated `body.innerText` or semantic-scope implementation remains.

### Task 9: Make production packaging fresh and atomic

**Files:**
- Modify: `pack.sh`

**Interfaces:**
- Consumes: current manifest version and explicit `PACKAGE_FILES` allowlist.
- Produces: validated `phobiablocker-v<version>.zip` or leaves the prior archive untouched.

- [ ] **Step 1: Create a destination-adjacent temporary directory**

After determining `ZIP_FILE`, add:

```bash
OUTPUT_DIR=$(pwd -P)
TMP_DIR=$(mktemp -d "${OUTPUT_DIR}/.phobiablocker-pack.XXXXXX")
TMP_ZIP="${TMP_DIR}/${ZIP_FILE}"
cleanup() {
    if [[ -n "${TMP_ZIP:-}" && -f "$TMP_ZIP" ]]; then
        rm -f -- "$TMP_ZIP"
    fi
    if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
        rmdir -- "$TMP_DIR"
    fi
}
trap cleanup EXIT INT TERM
```

`TMP_DIR` is created from the validated explicit output directory; do not use a broad or unresolved deletion target.

- [ ] **Step 2: Build only the temporary archive**

Replace the in-place ZIP command with:

```bash
zip -r "$TMP_ZIP" "${PACKAGE_FILES[@]}"
```

- [ ] **Step 3: Validate before replacement**

Run inside the script:

```bash
unzip -t "$TMP_ZIP"
ARCHIVED_VERSION=$(unzip -p "$TMP_ZIP" manifest.json | grep -o '"version": "[^"]*"' | grep -o '[0-9.]*')
if [[ "$ARCHIVED_VERSION" != "$NEW_VERSION" ]]; then
    echo "Error: archived manifest version is $ARCHIVED_VERSION, expected $NEW_VERSION" >&2
    exit 1
fi
mv -f -- "$TMP_ZIP" "${OUTPUT_DIR}/${ZIP_FILE}"
```

- [ ] **Step 4: Run allowed shell/build validation without invoking browser tests**

Run:

```bash
bash -n pack.sh
```

Then copy the repository's package allowlist inputs to an exact temporary workspace under `/tmp`, run the copied pack script twice for the same explicit version, remove one copied sentinel between builds, and inspect the second ZIP with `unzip -l`. This validates fresh-archive behavior without modifying the working manifest or invoking synthetic website tests.

```bash
PACK_TEST_DIR=$(mktemp -d /tmp/phobiablocker-pack-test.XXXXXX)
cp -R manifest.json popup.html settings.html offscreen.html css js icons pack.sh "$PACK_TEST_DIR/"
cd "$PACK_TEST_DIR"
cp js/background.js js/obsolete-sentinel.js
bash pack.sh 9.9.9
unzip -l phobiablocker-v9.9.9.zip | rg obsolete-sentinel
mv js/obsolete-sentinel.js "$PACK_TEST_DIR/obsolete-sentinel.removed"
bash pack.sh 9.9.9
if unzip -l phobiablocker-v9.9.9.zip | rg -q obsolete-sentinel; then exit 1; fi
unzip -t phobiablocker-v9.9.9.zip
```

Expected: shell syntax passes; the second ZIP has no removed sentinel; `unzip -t` passes; the repository's existing ZIP is unchanged during the isolated validation.

- [ ] **Step 5: Review the packaging diff without staging**

Run:

```bash
git diff --check -- pack.sh
git diff -- pack.sh
```

Expected: only fresh-build, validation, cleanup, and atomic replacement behavior changes.

### Task 10: Quarantine synthetic tests and correct documentation claims

**Files:**
- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/bugfix-log.md`
- Modify: `tests/agent-testing-charter.md`
- Create: `docs/live-site-validation.md`

**Interfaces:**
- Produces: an explicit non-runnable automated-test entrypoint and truthful behavior/validation documentation.

- [ ] **Step 1: Disable synthetic package scripts**

Replace behavior-test scripts with:

```json
"scripts": {
    "test": "node -e \"console.error('Synthetic browser tests are quarantined. Validate with the live-site charter.'); process.exit(1)\"",
    "lint": "eslint js/*.js",
    "dev": "bash pack-dev.sh",
    "prod": "bash pack.sh"
}
```

Do not delete any test file and do not preserve a convenience command that runs the quarantined suites.

- [ ] **Step 2: Align product behavior documentation**

State consistently that detection is page-wide, blacklist wins over every other policy, plain domains include subdomains, and cross-origin iframes use the new default-on safety switch. Remove semantic-local requirements and permanent-cross-origin-blur requirements from the charter.

- [ ] **Step 3: State the actual visibility limits**

Document that ordinary computed CSS backgrounds are covered, while pseudo-elements, browser-internal surfaces, fenced frames, and closed shadow roots cannot be guaranteed. Do not claim that all visual web content is inspectable.

- [ ] **Step 4: Correct test-quality claims**

Label existing synthetic tests as quarantined historical assets. Remove statements that source-string assertions, fixed sleeps, or external iframe fixtures prove browser behavior. State that storage API failure handling received static/code-path validation but was not runtime-injected.

- [ ] **Step 5: Create the live validation evidence template**

Use this table in `docs/live-site-validation.md`:

```markdown
# Live-site validation

| Time (Asia/Tokyo) | URL | Settings | Action | Expected | Observed | Console/runtime errors | Evidence |
|---|---|---|---|---|---|---|---|
```

Add sections for page-wide trigger, stylesheet background, dynamic content, policy precedence, no-reload settings, iframe setting on/off, explicit reveal fingerprint, and invalid word validation. Do not pre-fill observations before running them.

- [ ] **Step 6: Validate metadata without running tests**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8'))"
rg -n "semantic|nearby|cross-origin|automated|quarantined|page-wide|subdomains" AGENTS.md README.md docs tests/agent-testing-charter.md
```

Expected: package JSON parses; remaining behavior statements agree with the approved spec. Do not run `npm test` to demonstrate quarantine because the user explicitly prohibited artificial test execution.

### Task 11: Run final static/build verification

**Files:**
- Verify all production and documentation files from Tasks 1-10.

**Interfaces:**
- Consumes: the completed integrated implementation.
- Produces: evidence that production files parse/lint/package without invoking quarantined behavior tests.

- [ ] **Step 1: Run the repository lint command**

Run:

```bash
npm run lint
```

Expected: exit 0.

- [ ] **Step 2: Parse both JSON manifests**

Run:

```bash
node -e "for (const file of ['manifest.json','package.json']) JSON.parse(require('fs').readFileSync(file, 'utf8'))"
```

Expected: exit 0.

- [ ] **Step 3: Validate shell syntax and build behavior**

Run:

```bash
bash -n pack.sh pack-dev.sh
```

Expected: exit 0. Repeat the isolated `/tmp` fresh-archive check from Task 9 after all packaging inputs are final.

- [ ] **Step 4: Check for stale architecture patterns**

Run:

```bash
rg -n "window\.location\.reload|siteRulesChanged|body\.innerText|EARLY_BLUR_CSS|function matchesSitePattern|DEFAULT_TARGET_WORDS" js manifest.json css
```

Expected: no stale reload, full-scan, embedded-CSS, private-matcher, or duplicated-target-default implementation remains.

- [ ] **Step 5: Inspect the complete dirty-tree delta**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors. Separate pre-existing/user baseline changes from implementation changes in the handoff; do not stage or commit them.

### Task 12: Validate the unpacked extension on live public websites

**Files:**
- Modify after observation: `docs/live-site-validation.md`

**Interfaces:**
- Consumes: connected Chrome with the current unpacked extension reloaded, temporary user-approved extension settings, and natural public-site content.
- Produces: browser evidence for each user-visible behavior and an explicit residual-risk list.

- [ ] **Step 1: Obtain authority for temporary synced-setting changes**

Before changing Chrome extension settings, ask permission to temporarily enable PhobiaBlocker, set a known trigger such as `spider`, alter whitelist/blacklist entries for the selected public domains, and toggle `keepCrossOriginIframesBlurred`. Record original values and restore them after validation.

- [ ] **Step 2: Reload the unpacked extension and establish a clean baseline**

Use the connected Chrome extension management UI if browser policy permits it; otherwise ask the user to click Reload. Confirm the live page carries the new script/CSS markers and no extension runtime error is visible. Do not substitute a different browser or shell-driven headless browser without user approval.

- [ ] **Step 3: Verify page-wide trigger and ordinary media**

Open a public page that naturally contains the configured word and multiple images, such as Wikipedia's Spider article. Confirm all registered visuals remain blurred, the popup reports protection active, and the trigger is reported without injecting page content.

- [ ] **Step 4: Verify stylesheet background protection**

Find a public page whose visible image is supplied by a CSS class rather than an inline style. Confirm computed `background-image` is registered and the element remains protected when the page-wide trigger is present. Record the exact URL and inspected element description.

- [ ] **Step 5: Verify naturally dynamic content**

Use a public infinite-scroll, search-suggestion, or client-rendered page that naturally loads the configured trigger. Observe the added content from before insertion through analysis completion and confirm direct matching target text is covered in the mutation turn and media never transitions through an unprotected state.

- [ ] **Step 6: Verify policy precedence and no-reload writes**

On a public form page, enter non-sensitive throwaway text without submitting it. Add the domain to both whitelist and blacklist and turn global protection off. Confirm it remains always blurred, the popup says blacklisted, the page does not navigate, and the unsent form value remains. Remove the temporary rules afterward.

- [ ] **Step 7: Verify both iframe switch modes**

Use a public page with a cross-origin video/map/demo iframe. On a clean page, confirm the iframe stays blurred with **Keep unchecked embedded content blurred** on, becomes visible when it is off, and stays blurred when the page contains a trigger. Confirm context-menu Unblur reveals only the selected unchanged iframe.

- [ ] **Step 8: Verify explicit reveal fingerprint invalidation**

On a public dynamic gallery or carousel, context-unblur one media element, cause the same DOM element to load a different natural resource, and confirm the new resource is protected again. Do not change its DOM through DevTools or script injection.

- [ ] **Step 9: Verify target-word errors in the live popup**

Attempt to add `ox`, `spider man`, and `snake2`. Confirm each is rejected with the documented explanation and the synced target list is unchanged. Confirm a valid Unicode or hyphenated word can be added, then restore the original list.

- [ ] **Step 10: Record evidence and restore settings**

Fill `docs/live-site-validation.md` only with observed results, URLs, timestamps, console/runtime errors, and screenshots. Restore all original target words, policy switches, and site lists. Any scenario blocked by public-site drift, browser policy, or inaccessible extension management remains explicitly unverified rather than replaced by a local fixture.

- [ ] **Step 11: Present the combined diff for approval**

Summarize changed files, static/build results, live outcomes, and residual risks. Because this is a dirty baseline, ask before staging or committing any implementation file.
