// Early blur injector (MV3 content script).
// Purpose: apply a last-in-cascade blur style at document_start without loading NLP libs.
// This file must stay dependency-free (no compromise/natural).

(() => {
    const STYLE_ID = 'phobiablocker-early-blur'
    const FRAME_ATTR = 'data-phobiablocker-frame'

    const DEFAULT_BLUR_SLIDER_VALUE = 50 // Matches popup.js slider default
    const DEFAULT_PREVIEW_BLUR_STRENGTH = 5 // Matches settings.js default

    const PB_CSS_VARS = Object.freeze({
        blurNs: '--phobiablocker-blurValueAmount',
        blurLegacy: '--blurValueAmount',
        previewNs: '--phobiablocker-previewBlurAmount',
        previewLegacy: '--previewBlurAmount',
    })

    const EARLY_BLUR_CSS = `
:root {
    --blurValueAmount: 40px;
    --filterStrength: blur(var(--phobiablocker-blurValueAmount, var(--blurValueAmount, 40px)));
}

/* Apply blur broadly, but keep pointer-events gating separate so we can
 * avoid breaking iframe interaction (and optionally avoid disabling media
 * pointer-events in subframes). */
:is(img, video):not(.phobia-noblur):not(.phobia-permanent-unblur) {
    filter: var(--filterStrength) !important;
    cursor: default;
}

:is(iframe):not(.phobia-noblur):not(.phobia-permanent-unblur) {
    filter: var(--filterStrength) !important;
    cursor: default;
}

:is(div, span, section, article, aside, header, footer, main, figure)[style*="background-image"]:not(.phobia-noblur):not(.phobia-permanent-unblur),
:is(div, span, section, article, aside, header, footer, main, figure)[style*="background: url("]:not(.phobia-noblur):not(.phobia-permanent-unblur),
:is(div, span, section, article, aside, header, footer, main, figure)[style*="background:url("]:not(.phobia-noblur):not(.phobia-permanent-unblur) {
    filter: var(--filterStrength) !important;
    cursor: default;
}

/* In the TOP frame only, keep unprocessed media non-interactive to prevent
 * hover-preview flashes before analysis marks nodes with data-phobia-blur. */
:root[data-phobiablocker-frame="top"] :is(img, video):not(.phobia-noblur):not(.phobia-permanent-unblur):not([data-phobia-blur]) {
    pointer-events: none !important;
}

:is(img, video, iframe)[data-phobia-blur]:not(.phobia-permanent-unblur) {
    pointer-events: auto !important;
    cursor: pointer !important;
    transition: filter 0.2s ease;
}

:is(img, video, iframe).phobia-preview:not(.phobia-permanent-unblur) {
    filter: blur(var(--phobiablocker-previewBlurAmount, var(--previewBlurAmount, 4px))) !important;
}

:is(img, video, iframe, div, span, section, article, aside, header, footer, main, figure).phobia-noblur {
    filter: none !important;
}

html.phobia-disabled :is(img, video, iframe):not(.phobia-noblur) {
    filter: none !important;
    pointer-events: auto !important;
    cursor: auto !important;
    transition: none !important;
}
`.trim()

    const state = {
        phobiaBlockerEnabled: true,
        blurIsAlwaysOn: false,
        blurValueAmount: undefined,
        whitelistedSites: [],
        blacklistedSites: [],
        previewEnabled: true,
        previewBlurStrength: DEFAULT_PREVIEW_BLUR_STRENGTH,
    }

    function _getRoot() {
        return document.documentElement || document.querySelector('html')
    }

    function _setRootCssVar(name, value, priority) {
        const root = _getRoot()
        if (!root || !root.style) return
        try {
            root.style.setProperty(name, value, priority || '')
        } catch (_) {}
    }

    function setBlurCssValue(value, priority) {
        _setRootCssVar(PB_CSS_VARS.blurNs, value, priority)
        _setRootCssVar(PB_CSS_VARS.blurLegacy, value, priority)
    }

    function setPreviewBlurCssValue(value, priority) {
        _setRootCssVar(PB_CSS_VARS.previewNs, value, priority)
        _setRootCssVar(PB_CSS_VARS.previewLegacy, value, priority)
    }

    function _computeBlurPixels(sliderValue) {
        const v = typeof sliderValue === 'number' ? sliderValue : DEFAULT_BLUR_SLIDER_VALUE
        return Math.pow(v * 0.09, 1.8) * 2
    }

    function _ensureFrameMarker() {
        const root = _getRoot()
        if (!root) return
        let isTop = true
        try { isTop = (window.top === window) } catch (_) { isTop = true }
        root.setAttribute(FRAME_ATTR, isTop ? 'top' : 'sub')
    }

    function _injectEarlyStyle() {
        const root = _getRoot()
        if (!root) return
        if (document.getElementById(STYLE_ID)) return

        const styleEl = document.createElement('style')
        styleEl.id = STYLE_ID
        styleEl.textContent = EARLY_BLUR_CSS
        ;(document.head || root).appendChild(styleEl)
    }

    function _removeEarlyStyle() {
        const styleEl = document.getElementById(STYLE_ID)
        if (styleEl) styleEl.remove()
    }

    function matchesSitePattern(currentUrl, pattern) {
        try {
            const url = new URL(currentUrl)
            const hostname = url.hostname.toLowerCase()
            const rule = String(pattern || '').toLowerCase()
            const [hostPattern, ...pathParts] = rule.split('/')
            const pathPattern = pathParts.length > 0 ? `/${pathParts.join('/')}` : ''

            const hostMatches = (candidate, r) => {
                if (r.startsWith('*.')) {
                    const base = r.substring(2)
                    return candidate === base || candidate.endsWith(`.${base}`)
                }
                return candidate === r || candidate.endsWith(`.${r}`)
            }

            if (!hostPattern || !hostMatches(hostname, hostPattern)) return false
            if (!pathPattern) return true
            return url.pathname === pathPattern || url.pathname.startsWith(`${pathPattern}/`)
        } catch (_) {
            return false
        }
    }

    function _isWhitelisted() {
        const currentUrl = window.location.href
        return (state.whitelistedSites || []).some((p) => matchesSitePattern(currentUrl, p))
    }

    function _isBlacklisted() {
        const currentUrl = window.location.href
        return (state.blacklistedSites || []).some((p) => matchesSitePattern(currentUrl, p))
    }

    function _applyState() {
        const root = _getRoot()
        if (!root) return

        _ensureFrameMarker()
        _injectEarlyStyle()

        const blacklisted = _isBlacklisted()
        const whitelisted = _isWhitelisted()

        // Match js/js.js precedence:
        // - blacklist overrides everything (always blur)
        // - whitelist disables completely
        // - global disabled disables unless blacklisted
        const shouldDisable = whitelisted || (!state.phobiaBlockerEnabled && !blacklisted)

        if (shouldDisable) {
            root.classList.add('phobia-disabled')
            setBlurCssValue('0px')
            setPreviewBlurCssValue('0px')
            _removeEarlyStyle()
            return
        }

        root.classList.remove('phobia-disabled')
        _injectEarlyStyle()

        const blurPixels = _computeBlurPixels(state.blurValueAmount)
        setBlurCssValue(`${blurPixels}px`)

        if (state.previewEnabled === false) {
            setPreviewBlurCssValue('var(--phobiablocker-blurValueAmount, var(--blurValueAmount, 40px))')
        } else {
            const strength = typeof state.previewBlurStrength === 'number'
                ? state.previewBlurStrength
                : DEFAULT_PREVIEW_BLUR_STRENGTH
            setPreviewBlurCssValue(`${strength}px`)
        }
    }

    function _loadInitialState() {
        try {
            chrome.storage.sync.get([
                'phobiaBlockerEnabled',
                'blurIsAlwaysOn',
                'blurValueAmount',
                'whitelistedSites',
                'blacklistedSites',
                'previewEnabled',
                'previewBlurStrength',
            ], (storage) => {
                if (storage && typeof storage === 'object') {
                    if (storage.phobiaBlockerEnabled !== undefined) state.phobiaBlockerEnabled = Boolean(storage.phobiaBlockerEnabled)
                    if (storage.blurIsAlwaysOn !== undefined) state.blurIsAlwaysOn = Boolean(storage.blurIsAlwaysOn)
                    if (storage.blurValueAmount !== undefined) state.blurValueAmount = Number(storage.blurValueAmount)
                    if (Array.isArray(storage.whitelistedSites)) state.whitelistedSites = storage.whitelistedSites
                    if (Array.isArray(storage.blacklistedSites)) state.blacklistedSites = storage.blacklistedSites
                    if (storage.previewEnabled !== undefined) state.previewEnabled = Boolean(storage.previewEnabled)
                    if (storage.previewBlurStrength !== undefined) state.previewBlurStrength = Number(storage.previewBlurStrength)
                }
                _applyState()
            })
        } catch (_) {
            // Storage not available: fail-safe is "blur on" via injected CSS default.
            _applyState()
        }
    }

    function _listenForChanges() {
        try {
            chrome.storage.onChanged.addListener((changes, areaName) => {
                if (areaName !== 'sync') return
                let touched = false

                const setIf = (key, assignFn) => {
                    if (!Object.prototype.hasOwnProperty.call(changes, key)) return
                    assignFn(changes[key].newValue)
                    touched = true
                }

                setIf('phobiaBlockerEnabled', (v) => { state.phobiaBlockerEnabled = Boolean(v) })
                setIf('blurIsAlwaysOn', (v) => { state.blurIsAlwaysOn = Boolean(v) })
                setIf('blurValueAmount', (v) => { state.blurValueAmount = v === undefined ? undefined : Number(v) })
                setIf('whitelistedSites', (v) => { state.whitelistedSites = Array.isArray(v) ? v : [] })
                setIf('blacklistedSites', (v) => { state.blacklistedSites = Array.isArray(v) ? v : [] })
                setIf('previewEnabled', (v) => { state.previewEnabled = Boolean(v) })
                setIf('previewBlurStrength', (v) => { state.previewBlurStrength = v === undefined ? DEFAULT_PREVIEW_BLUR_STRENGTH : Number(v) })

                if (touched) _applyState()
            })
        } catch (_) {}
    }

    // Execute as early as possible.
    _ensureFrameMarker()
    _injectEarlyStyle()
    _loadInitialState()
    _listenForChanges()
})()
