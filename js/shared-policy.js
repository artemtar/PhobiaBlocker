// Constants and pure helpers every execution context must agree on. Loaded first
// in every content frame, imported by the service worker and by both UI pages.
(() => {
    'use strict'

    // Scripts after this one capture the frozen object below, so a repeated
    // injection must keep the first copy rather than replace it.
    if (globalThis.PhobiaBlockerPolicy) return

    // Property names are the code-facing names. The string values are the keys
    // persisted in users' chrome.storage.sync and must never change, or every
    // existing user would lose their settings; hence the PhobiaBlocker-era names.
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
        detectedWordsCollapsed: 'detectedWordsCollapsed',
        supportedWordsCollapsed: 'supportedWordsCollapsed',
    })

    // Also the type oracle for isValidStoredValue: a stored value must have the
    // same typeof as its default here. Keys are the STORAGE_KEYS string values.
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
        detectedWordsCollapsed: false,
        supportedWordsCollapsed: false,
    })

    // ALWAYS_BLUR skips analysis entirely; ANALYZE blurs until a clear verdict;
    // DISABLED is the only mode that reveals media without a verdict.
    const PROTECTION_MODE = Object.freeze({
        DISABLED: 'DISABLED',
        ALWAYS_BLUR: 'ALWAYS_BLUR',
        ANALYZE: 'ANALYZE',
    })

    // Analysis verdict shapes shared by the content script, the service worker
    // and the offscreen document. Anything unreadable or malformed blurs.
    const FAIL_CLOSED_RESULT = Object.freeze({
        shouldBlur: true,
        matchedWords: [],
        matchedInputWords: [],
    })
    const CLEAR_RESULT = Object.freeze({
        shouldBlur: false,
        matchedWords: [],
        matchedInputWords: [],
    })

    // Messages exchanged between frames and the service worker to decide
    // whether a parent may release its cross-origin iframes.
    const FRAME_MESSAGES = Object.freeze({
        aggregateRequest: 'PB_FRAME_AGGREGATE_REQUEST',
        aggregateInvalidated: 'PB_FRAME_AGGREGATE_INVALIDATED',
        statusRequest: 'PB_FRAME_STATUS_REQUEST',
        statusChanged: 'PB_FRAME_STATUS_CHANGED',
        clearanceArm: 'PB_FRAME_CLEARANCE_ARM',
        clearanceEmit: 'PB_FRAME_CLEARANCE_EMIT',
        clearanceLink: 'PB_FRAME_CLEARANCE_LINK',
    })

    // Root-level CSS custom properties both content scripts write. The legacy
    // names stay for stylesheets and tests that predate the namespaced ones.
    const CSS_VARS = Object.freeze({
        blurNs: '--phobiablocker-blurValueAmount',
        blurLegacy: '--blurValueAmount',
        previewNs: '--phobiablocker-previewBlurAmount',
        previewLegacy: '--previewBlurAmount',
    })

    // Attributes projected onto <html> that protection.css keys off.
    const ROOT_ATTRS = Object.freeze({
        frame: 'data-phobiablocker-frame',
        backgroundReady: 'data-phobiablocker-background-ready',
        backgroundScanning: 'data-phobiablocker-background-scanning',
    })

    // One word, for both indexing page text and covering trigger words:
    // letters with internal hyphens.
    // Letters only: digits and format characters split a word, and so do
    // combining marks (Mn/Mc), which fragments scripts such as Devanagari or Thai
    // that NFKC does not compose. validateTargetWord's shape regex below and the
    // anchored twin in offscreen.js must stay consistent with it.
    const WORD_RE = /[-\p{L}]+/gu

    function isStringArray(value) {
        return Array.isArray(value) && value.every(item => typeof item === 'string')
    }

    // Shape check only, no range check: the numeric keys accept any finite number
    // because the legacy conversion below stores fractional values. Unknown keys
    // are rejected so a stray key can never be written or read as a setting.
    function isValidStoredValue(name, value) {
        if (name === STORAGE_KEYS.targetWords || name === STORAGE_KEYS.whitelist ||
            name === STORAGE_KEYS.blacklist) {
            return isStringArray(value)
        }
        if (name === STORAGE_KEYS.blurAmount || name === STORAGE_KEYS.previewStrength) {
            return typeof value === 'number' && Number.isFinite(value)
        }
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, name)) {
            return typeof value === typeof DEFAULTS[name]
        }
        return false
    }

    function computeBlurPixels(value) {
        const sliderValue = Number.isFinite(value) ? value : DEFAULTS.blurValueAmount
        const boundedValue = Math.min(100, Math.max(0, sliderValue))
        // Keep fine control through the middle (~9px at 50), with 100px at the top.
        // The base 101 is what makes both ends land exactly: 0 gives 0px, 100 gives 100px.
        return Math.pow(101, boundedValue / 100) - 1
    }

    // Slider values saved before 1.3.1 drove a steeper curve (50 gave 30px).
    // Map one onto the current curve so an update leaves the rendered blur
    // unchanged. The maximum stays the maximum: a user at the top asked for
    // the strongest blur available, never a weaker one.
    const LEGACY_BLUR_SCALE = 0.09
    const LEGACY_BLUR_EXPONENT = 1.8
    const LEGACY_BLUR_MULTIPLIER = 2
    // A scale factor, not a digit count: rounding to tenths keeps the synced value
    // short, and the pixel drift it introduces stays well under one pixel.
    const CONVERTED_SLIDER_DECIMALS = 10

    function convertLegacyBlurSliderValue(value) {
        // A missing or unreadable value converts as the legacy default, which is
        // the strength such a user was actually seeing.
        const sliderValue = Number.isFinite(value) ? value : DEFAULTS.blurValueAmount
        const boundedValue = Math.min(100, Math.max(0, sliderValue))
        if (boundedValue >= 100) return 100
        const legacyPixels = Math.pow(boundedValue * LEGACY_BLUR_SCALE, LEGACY_BLUR_EXPONENT) * LEGACY_BLUR_MULTIPLIER
        const currentValue = 100 * Math.log(legacyPixels + 1) / Math.log(101)
        const rounded = Math.round(currentValue * CONVERTED_SLIDER_DECIMALS) / CONVERTED_SLIDER_DECIMALS
        return Math.min(100, Math.max(0, rounded))
    }

    // With previews off the preview strength falls back to the full blur, so
    // hovering can never reveal more than the page-wide setting allows.
    function previewBlurCssValue(settings) {
        return settings.previewEnabled
            ? `${settings.previewBlurStrength}px`
            : `var(${CSS_VARS.blurNs}, var(${CSS_VARS.blurLegacy}, 40px))`
    }

    // window.top is readable even cross-origin, so the guard is only defensive.
    // A throw is treated as a sub-frame, the less-privileged answer.
    function isTopFrameContext() {
        try { return window.top === window } catch (_) { return false }
    }

    function createDebugLogger(context, isEnabled) {
        // Callers supply only counts, flags and fixed labels. Build summaries
        // lazily so disabled diagnostics do not walk the page or media registry.
        return (event, getDetails = () => ({})) => {
            if (isEnabled() !== true) return
            console.debug?.(`[PhobiaBlur:${context}] ${event}`, getDetails())
        }
    }

    // Rejects on time but cannot cancel the underlying work, so callers must still
    // ignore a late result. Clearing the timer keeps a settled race from leaving a
    // stray timeout behind, which keeps a Node test process alive.
    function withTimeout(promise, timeoutMs, label) {
        let timeoutId = null
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
            }),
        ]).finally(() => {
            if (timeoutId !== null) clearTimeout(timeoutId)
        })
    }

    function normalizeMatchedWords(words) {
        return [...new Set(words.map(word => word.trim()).filter(Boolean))]
    }

    // Returns null when the payload is not a well-formed verdict, so each
    // side of the message boundary can decide how to fail.
    function normalizeAnalysisResult(result) {
        if (!result || typeof result.shouldBlur !== 'boolean' ||
            !isStringArray(result.matchedWords) || !isStringArray(result.matchedInputWords)) {
            return null
        }
        return {
            shouldBlur: result.shouldBlur,
            matchedWords: normalizeMatchedWords(result.matchedWords),
            matchedInputWords: normalizeMatchedWords(result.matchedInputWords),
        }
    }

    // NFKC + lowercase is the same normalization tokenize() applies to page text,
    // so a stored target compares equal to its page token. The letter floor and
    // the shape mirror HAS_THREE_LETTERS_RE and WORD_RE: a word that could never
    // be tokenized on a page is rejected here instead of silently never matching.
    function validateTargetWord(rawWord) {
        const normalized = typeof rawWord === 'string'
            ? rawWord.normalize('NFKC').trim().toLowerCase()
            : ''
        const letters = normalized.match(/\p{L}/gu) || []
        const validShape = /^\p{L}+(?:-\p{L}+)*$/u.test(normalized)
        let reason = ''

        if (!normalized) reason = 'Enter a trigger word.'
        // Product bound on one trigger word, mirrored by maxlength="30" on the word
        // inputs in popup.html and settings.html; history records no other reason.
        else if (normalized.length > 30) reason = 'Use 30 characters or fewer.'
        else if (letters.length < 3) reason = 'Use at least three letters.'
        else if (!validShape) reason = 'Use one word containing letters; hyphens are allowed between letters.'

        return { valid: reason === '', normalized, reason }
    }

    // Order is preserved; duplicates collapse after normalization, so 'Spider'
    // and 'spider' become one entry.
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

    function parseSiteRule(rawRule) {
        const input = typeof rawRule === 'string' ? rawRule.trim() : ''
        if (!input) return { valid: false, reason: 'Enter a domain.' }

        // Only an http(s) prefix is stripped below; any other scheme would be read as
        // part of the host and never match, so reject it instead of storing a dead rule.
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) {
            return {
                valid: false,
                reason: 'Only HTTP and HTTPS website addresses are supported.',
            }
        }

        const rule = input.replace(/^https?:\/\//i, '')
        if (/[?#@]/.test(rule)) {
            return {
                valid: false,
                reason: 'Do not include credentials, a query, or a page fragment.',
            }
        }

        const slashIndex = rule.indexOf('/')
        let host = (slashIndex === -1 ? rule : rule.slice(0, slashIndex)).toLowerCase()
        const rawPath = slashIndex === -1 ? '' : rule.slice(slashIndex)
        // Browser URLs ignore tabs/newlines. Escape whitespace exposed by
        // removing trailing slashes so later trim() or URL parsing preserves it.
        const path = rawPath.replace(/[\t\n\r]/g, '').replace(/\/+$/, '')
            .replace(/\s+$/u, encodeURIComponent)
        // Matching already covers every subdomain, so a wildcard prefix is redundant.
        if (host.startsWith('*.')) host = host.slice(2)

        // Hostname labels (1-63 chars, no leading or trailing hyphen) with at
        // least one dot, so a bare name such as 'localhost' is rejected.
        const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
        if (!domainPattern.test(host)) {
            return { valid: false, reason: 'Enter a valid domain.' }
        }

        return {
            valid: true,
            normalized: `${host}${path}`,
            host,
            path,
        }
    }

    function normalizePathEscapes(pathname) {
        // Hex case does not change an encoded byte. Decoding would turn %2F
        // into a directory separator and incorrectly broaden a rule.
        return pathname.replace(/%[a-f0-9]{2}/gi, escape => escape.toUpperCase())
    }

    function matchesSiteRule(currentUrl, rawRule) {
        const rule = parseSiteRule(rawRule)
        if (!rule.valid) return false

        let url
        let rulePath
        try {
            url = new URL(currentUrl)
            // Serialize raw Unicode and spaces exactly as a browser URL does.
            rulePath = new URL(`https://${rule.normalized}`).pathname.replace(/\/+$/, '')
        } catch (_) {
            return false
        }

        // A rule covers its exact host and every subdomain; a path rule covers that
        // directory and everything below it, never a sibling sharing the prefix.
        const hostname = url.hostname.toLowerCase()
        const hostMatches = hostname === rule.host || hostname.endsWith(`.${rule.host}`)
        if (!hostMatches) return false
        if (!rulePath) return true
        const pathname = normalizePathEscapes(url.pathname)
        rulePath = normalizePathEscapes(rulePath)
        return pathname === rulePath || pathname.startsWith(`${rulePath}/`)
    }

    // Site rules outrank the global toggles: a blacklist match wins over
    // everything, including the off switch, and a whitelist match wins over the
    // always-on toggle. Blacklist is tested first, so a URL in both lists blurs.
    function resolveProtectionMode(settings, currentUrl) {
        const blacklist = Array.isArray(settings?.blacklistedSites) ? settings.blacklistedSites : []
        const whitelist = Array.isArray(settings?.whitelistedSites) ? settings.whitelistedSites : []
        if (blacklist.some(rule => matchesSiteRule(currentUrl, rule))) return PROTECTION_MODE.ALWAYS_BLUR
        if (whitelist.some(rule => matchesSiteRule(currentUrl, rule))) return PROTECTION_MODE.DISABLED
        if (settings?.phobiaBlockerEnabled === false) return PROTECTION_MODE.DISABLED
        if (settings?.blurIsAlwaysOn === true) return PROTECTION_MODE.ALWAYS_BLUR
        return PROTECTION_MODE.ANALYZE
    }

    globalThis.PhobiaBlockerPolicy = Object.freeze({
        STORAGE_KEYS,
        DEFAULTS,
        PROTECTION_MODE,
        FAIL_CLOSED_RESULT,
        CLEAR_RESULT,
        FRAME_MESSAGES,
        CSS_VARS,
        ROOT_ATTRS,
        WORD_RE,
        isStringArray,
        isValidStoredValue,
        computeBlurPixels,
        convertLegacyBlurSliderValue,
        previewBlurCssValue,
        isTopFrameContext,
        createDebugLogger,
        withTimeout,
        normalizeAnalysisResult,
        validateTargetWord,
        normalizeTargetWords,
        parseSiteRule,
        matchesSiteRule,
        resolveProtectionMode,
    })
})()
