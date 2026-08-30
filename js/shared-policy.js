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

    function isValidStoredValue(name, value) {
        if (name === STORAGE_KEYS.targetWords || name === STORAGE_KEYS.whitelist ||
            name === STORAGE_KEYS.blacklist) {
            return Array.isArray(value) && value.every(item => typeof item === 'string')
        }
        if (name === STORAGE_KEYS.blurAmount || name === STORAGE_KEYS.previewStrength) {
            return typeof value === 'number' && Number.isFinite(value)
        }
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, name)) {
            return typeof value === typeof DEFAULTS[name]
        }
        return false
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
        const path = rawPath === '/' ? '' : rawPath
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

    function matchesSiteRule(currentUrl, rawRule) {
        const rule = parseSiteRule(rawRule)
        if (!rule.valid) return false

        let url
        try {
            url = new URL(currentUrl)
        } catch (_) {
            return false
        }

        const hostname = url.hostname.toLowerCase()
        const hostMatches = hostname === rule.host || hostname.endsWith(`.${rule.host}`)
        if (!hostMatches) return false
        if (!rule.path) return true
        return url.pathname === rule.path || url.pathname.startsWith(`${rule.path}/`)
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
        isValidStoredValue,
        validateTargetWord,
        normalizeTargetWords,
        parseSiteRule,
        matchesSiteRule,
        resolveProtectionMode,
    })
})()
