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
        detectedWordsCollapsed: 'detectedWordsCollapsed',
        supportedWordsCollapsed: 'supportedWordsCollapsed',
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
        detectedWordsCollapsed: false,
        supportedWordsCollapsed: false,
    })

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
    const WORD_RE = /[-\p{L}]+/gu

    function isStringArray(value) {
        return Array.isArray(value) && value.every(item => typeof item === 'string')
    }

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
        const sliderValue = typeof value === 'number' ? value : DEFAULTS.blurValueAmount
        return Math.pow(sliderValue * 0.09, 1.8) * 2
    }

    // With previews off the preview strength falls back to the full blur, so
    // hovering can never reveal more than the page-wide setting allows.
    function previewBlurCssValue(settings) {
        return settings.previewEnabled
            ? `${settings.previewBlurStrength}px`
            : `var(${CSS_VARS.blurNs}, var(${CSS_VARS.blurLegacy}, 40px))`
    }

    function isTopFrameContext() {
        try { return window.top === window } catch (_) { return false }
    }

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

    function parseSiteRule(rawRule) {
        const input = typeof rawRule === 'string' ? rawRule.trim() : ''
        if (!input) return { valid: false, reason: 'Enter a domain.' }

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
        if (host.startsWith('*.')) host = host.slice(2)

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

        const hostname = url.hostname.toLowerCase()
        const hostMatches = hostname === rule.host || hostname.endsWith(`.${rule.host}`)
        if (!hostMatches) return false
        if (!rulePath) return true
        const pathname = normalizePathEscapes(url.pathname)
        rulePath = normalizePathEscapes(rulePath)
        return pathname === rulePath || pathname.startsWith(`${rulePath}/`)
    }

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
        previewBlurCssValue,
        isTopFrameContext,
        withTimeout,
        normalizeAnalysisResult,
        validateTargetWord,
        normalizeTargetWords,
        parseSiteRule,
        matchesSiteRule,
        resolveProtectionMode,
    })
})()
