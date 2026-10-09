(() => {
    'use strict'

    const Policy = globalThis.PhobiaBlockerPolicy
    const Storage = globalThis.PhobiaBlockerStorage
    const PageTextIndex = globalThis.PhobiaBlockerPageTextIndex
    if (!Policy || !Storage || !PageTextIndex) {
        console.error('PhobiaBlocker: shared modules are unavailable; keeping protection active')
        return
    }

    const { CSS_VARS, ROOT_ATTRS, PROTECTION_MODE } = Policy
    const state = {
        mode: PROTECTION_MODE.ALWAYS_BLUR,
        targetWords: new Set(),
        wordCoverEnabled: false,
    }

    let observer = null
    let projectionObserver = null
    let handedOff = false
    const earlyCovers = new Set()

    // Both content scripts need the same settings at load. Publish this read so
    // the controller can await it instead of paying a second storage round-trip
    // in every frame.
    const initialSettingsRead = Storage.getWithDefaults(Object.keys(Policy.DEFAULTS))
    globalThis.PhobiaBlockerInitialSettingsRead = initialSettingsRead

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

    function applyVisualSettings(settings) {
        const blurValue = `${Policy.computeBlurPixels(settings.blurValueAmount)}px`
        const previewValue = Policy.previewBlurCssValue(settings)
        setRootCssVar(CSS_VARS.blurNs, blurValue)
        setRootCssVar(CSS_VARS.blurLegacy, blurValue)
        setRootCssVar(CSS_VARS.previewNs, previewValue)
        setRootCssVar(CSS_VARS.previewLegacy, previewValue)
    }

    function ensureFrameMarker() {
        const root = getRoot()
        if (!root) return
        root.setAttribute(ROOT_ATTRS.frame, Policy.isTopFrameContext() ? 'top' : 'sub')
    }

    function isExcludedTextNode(node) {
        const parent = PageTextIndex.composedParent(node)
        if (!parent) return true
        if (PageTextIndex.closestAcrossRoots(parent, PageTextIndex.EXCLUDED_SELECTOR)) return true
        let current = parent
        while (current) {
            if (earlyCovers.has(current)) return true
            current = current.parentElement
        }
        return PageTextIndex.isEditableElement(parent)
    }

    function canCoverWords() {
        return !handedOff && state.mode !== PROTECTION_MODE.DISABLED &&
            state.wordCoverEnabled && state.targetWords.size > 0
    }

    function coverTextNode(textNode) {
        if (!canCoverWords() || isExcludedTextNode(textNode) || !textNode.parentNode) return
        const split = PageTextIndex.splitTextNodeByWords(textNode, word => state.targetWords.has(word))
        if (!split) return
        split.covers.forEach(cover => earlyCovers.add(cover))
        textNode.parentNode.replaceChild(split.fragment, textNode)
    }

    function coverSubtree(node) {
        if (!node || !canCoverWords()) return
        if (node.nodeType === Node.TEXT_NODE) {
            coverTextNode(node)
            return
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return
        PageTextIndex.collectTextNodes(node).forEach(coverTextNode)
    }

    function unwrapEarlyCovers(shouldUnwrap = () => true) {
        Array.from(earlyCovers).forEach((cover) => {
            if (!shouldUnwrap(cover)) return
            earlyCovers.delete(cover)
            const parent = cover.parentNode
            if (!parent) return
            // Same unwrap as the controller's covers, so page-added markup
            // inside a cover survives the hand-off too.
            PageTextIndex.unwrapWordCover(cover)
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
                    if (mutation.attributeName === 'contenteditable') {
                        unwrapEarlyCovers(cover => PageTextIndex.isEditableElement(cover))
                        coverSubtree(mutation.target)
                        return
                    }
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
            attributeFilter: ['class', 'contenteditable'],
        })
    }

    function syncRootProjection() {
        const root = getRoot()
        if (!root) return
        const disabled = state.mode === PROTECTION_MODE.DISABLED
        root.classList.toggle('phobia-disabled', disabled)

        if (disabled) {
            if (root.hasAttribute(ROOT_ATTRS.backgroundScanning)) {
                root.removeAttribute(ROOT_ATTRS.backgroundScanning)
            }
            if (root.getAttribute(ROOT_ATTRS.backgroundReady) !== '1') {
                root.setAttribute(ROOT_ATTRS.backgroundReady, '1')
            }
            return
        }
        if (root.hasAttribute(ROOT_ATTRS.backgroundReady)) {
            root.removeAttribute(ROOT_ATTRS.backgroundReady)
        }
        if (root.hasAttribute(ROOT_ATTRS.backgroundScanning)) {
            root.removeAttribute(ROOT_ATTRS.backgroundScanning)
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
                ROOT_ATTRS.backgroundReady,
                ROOT_ATTRS.backgroundScanning,
            ],
        })
    }

    function applyMode(mode) {
        const root = getRoot()
        if (!root) return
        state.mode = mode
        syncRootProjection()

        if (mode === PROTECTION_MODE.DISABLED) {
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
            const settings = await initialSettingsRead
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
            applyMode(PROTECTION_MODE.ALWAYS_BLUR)
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
