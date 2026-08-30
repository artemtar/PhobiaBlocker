(() => {
    'use strict'

    const Policy = globalThis.PhobiaBlockerPolicy
    const Storage = globalThis.PhobiaBlockerStorage
    if (!Policy || !Storage) {
        console.error('PhobiaBlocker: shared policy or storage module is unavailable; keeping protection active')
        return
    }

    const WORD_RE = /[-\p{L}]+/gu
    const PB_CSS_VARS = Object.freeze({
        blurNs: '--phobiablocker-blurValueAmount',
        blurLegacy: '--blurValueAmount',
        previewNs: '--phobiablocker-previewBlurAmount',
        previewLegacy: '--previewBlurAmount',
    })
    const state = {
        mode: Policy.PROTECTION_MODE.ALWAYS_BLUR,
        targetWords: new Set(),
        wordCoverEnabled: false,
    }

    let observer = null
    let projectionObserver = null
    let handedOff = false
    const earlyCovers = new Set()

    function getRoot() {
        return document.documentElement || document.querySelector('html')
    }

    function setRootCssVar(name, value) {
        const root = getRoot()
        if (!root || !root.style) return
        try {
            if (root.style.getPropertyValue(name) === value) return
            root.style.setProperty(name, value)
        } catch (_) { /* Keep stylesheet defaults. */ }
    }

    function computeBlurPixels(value) {
        const sliderValue = typeof value === 'number' ? value : Policy.DEFAULTS.blurValueAmount
        return Math.pow(sliderValue * 0.09, 1.8) * 2
    }

    function applyVisualSettings(settings) {
        const blurValue = `${computeBlurPixels(settings.blurValueAmount)}px`
        const previewValue = settings.previewEnabled
            ? `${settings.previewBlurStrength}px`
            : `var(${PB_CSS_VARS.blurNs}, var(${PB_CSS_VARS.blurLegacy}, 40px))`
        setRootCssVar(PB_CSS_VARS.blurNs, blurValue)
        setRootCssVar(PB_CSS_VARS.blurLegacy, blurValue)
        setRootCssVar(PB_CSS_VARS.previewNs, previewValue)
        setRootCssVar(PB_CSS_VARS.previewLegacy, previewValue)
    }

    function ensureFrameMarker() {
        const root = getRoot()
        if (!root) return
        let isTop = false
        try { isTop = window.top === window } catch (_) { /* Treat inaccessible parents as subframes. */ }
        root.setAttribute('data-phobiablocker-frame', isTop ? 'top' : 'sub')
    }

    function isExcludedTextNode(node) {
        const parent = node && node.parentElement
        if (!parent) return true
        if (parent.closest && parent.closest([
            'script', 'style', 'noscript', 'input', 'textarea', 'select', 'option',
            'form', '[contenteditable="true"]', '[hidden]', '[aria-hidden="true"]',
        ].join(', '))) return true
        let current = parent
        while (current) {
            if (earlyCovers.has(current)) return true
            current = current.parentElement
        }
        return parent.isContentEditable
    }

    function coverColorFor(parent) {
        try {
            const color = getComputedStyle(parent).color
            if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color
        } catch (_) { /* Use the CSS currentColor fallback. */ }
        return 'currentColor'
    }

    function createCover(word, parent) {
        const cover = document.createElement('span')
        cover.className = 'phobia-word-cover'
        cover.setAttribute('data-phobia-word-cover', '1')
        cover.setAttribute('data-phobiablocker-early-word-cover', '1')
        cover.setAttribute('title', 'Covered by PhobiaBlocker')
        cover.setAttribute('aria-label', 'Covered by PhobiaBlocker')
        cover.style.setProperty('--phobiablocker-word-cover-color', coverColorFor(parent))
        cover.textContent = word
        earlyCovers.add(cover)
        return cover
    }

    function canCoverWords() {
        return !handedOff && state.mode !== Policy.PROTECTION_MODE.DISABLED &&
            state.wordCoverEnabled && state.targetWords.size > 0
    }

    function coverTextNode(textNode) {
        if (!canCoverWords() || isExcludedTextNode(textNode)) return
        const text = textNode.nodeValue || ''
        const fragment = document.createDocumentFragment()
        let lastIndex = 0
        let changed = false
        let match

        WORD_RE.lastIndex = 0
        while ((match = WORD_RE.exec(text)) !== null) {
            const normalized = match[0].normalize('NFKC').toLowerCase()
            if (!state.targetWords.has(normalized)) continue
            changed = true
            if (match.index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
            }
            fragment.appendChild(createCover(match[0], textNode.parentElement))
            lastIndex = match.index + match[0].length
        }
        WORD_RE.lastIndex = 0

        if (!changed || !textNode.parentNode) return
        if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
        textNode.parentNode.replaceChild(fragment, textNode)
    }

    function coverSubtree(node) {
        if (!node || !canCoverWords()) return
        if (node.nodeType === Node.TEXT_NODE) {
            coverTextNode(node)
            return
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return

        const textNodes = []
        try {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
            let current = walker.nextNode()
            while (current) {
                textNodes.push(current)
                current = walker.nextNode()
            }
        } catch (_) {
            return
        }
        textNodes.forEach(coverTextNode)
    }

    function unwrapEarlyCovers() {
        Array.from(earlyCovers).forEach((cover) => {
            earlyCovers.delete(cover)
            if (!cover.parentNode) return
            const parent = cover.parentNode
            parent.replaceChild(document.createTextNode(cover.textContent || ''), cover)
            try { parent.normalize() } catch (_) { /* Detached parents need no normalization. */ }
        })
    }

    function stopCovering(unwrap = false) {
        if (observer) observer.disconnect()
        observer = null
        if (unwrap) unwrapEarlyCovers()
    }

    function startCovering() {
        if (!canCoverWords()) {
            stopCovering(true)
            return
        }

        coverSubtree(document.body || document.documentElement)
        if (observer) return

        observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes') {
                    const cover = mutation.target
                    if (earlyCovers.has(cover) && !cover.classList.contains('phobia-word-cover')) {
                        cover.classList.add('phobia-word-cover')
                    }
                    return
                }
                if (mutation.type === 'characterData') {
                    coverTextNode(mutation.target)
                    return
                }
                mutation.addedNodes.forEach(coverSubtree)
            })
        })
        observer.observe(document, {
            childList: true,
            characterData: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
        })
    }

    function syncRootProjection() {
        const root = getRoot()
        if (!root) return
        const disabled = state.mode === Policy.PROTECTION_MODE.DISABLED
        root.classList.toggle('phobia-disabled', disabled)

        if (disabled) {
            if (root.hasAttribute('data-phobiablocker-background-scanning')) {
                root.removeAttribute('data-phobiablocker-background-scanning')
            }
            if (root.getAttribute('data-phobiablocker-background-ready') !== '1') {
                root.setAttribute('data-phobiablocker-background-ready', '1')
            }
            return
        }
        if (root.hasAttribute('data-phobiablocker-background-ready')) {
            root.removeAttribute('data-phobiablocker-background-ready')
        }
        if (root.hasAttribute('data-phobiablocker-background-scanning')) {
            root.removeAttribute('data-phobiablocker-background-scanning')
        }
    }

    function startProjectionObserver() {
        const root = getRoot()
        if (!root || projectionObserver) return
        projectionObserver = new MutationObserver(() => {
            if (!handedOff) syncRootProjection()
        })
        projectionObserver.observe(root, {
            attributes: true,
            attributeFilter: [
                'class', 'style',
                'data-phobiablocker-background-ready',
                'data-phobiablocker-background-scanning',
            ],
        })
    }

    function applyMode(mode) {
        const root = getRoot()
        if (!root) return
        state.mode = mode
        syncRootProjection()

        if (mode === Policy.PROTECTION_MODE.DISABLED) {
            stopCovering(true)
            return
        }

        startCovering()
    }

    async function initialize() {
        const root = getRoot()
        if (root) {
            syncRootProjection()
            startProjectionObserver()
        }
        ensureFrameMarker()

        try {
            const settings = await Storage.getWithDefaults(Object.keys(Policy.DEFAULTS))
            if (handedOff) return
            applyVisualSettings(settings)
            state.targetWords = new Set(Policy.normalizeTargetWords(settings.targetWords).valid)
            state.wordCoverEnabled = settings.wordCoverEnabled
            applyMode(Policy.resolveProtectionMode(settings, location.href))
        } catch (error) {
            if (handedOff) return
            console.error('PhobiaBlocker: initial settings read failed; keeping media blurred', error)
            state.targetWords = new Set()
            state.wordCoverEnabled = false
            applyMode(Policy.PROTECTION_MODE.ALWAYS_BLUR)
        }
    }

    window.addEventListener('phobiablocker:word-cover-manager-ready', () => {
        handedOff = true
        if (projectionObserver) projectionObserver.disconnect()
        projectionObserver = null
        stopCovering(true)
    }, { once: true })

    void initialize()
})()
