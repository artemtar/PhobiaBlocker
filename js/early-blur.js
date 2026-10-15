// document_start shim: keeps the page fail-closed from the first paint until the
// controller in js.js has real settings. Media are blurred by protection.css on
// its own; this script only drives what <html> projects and covers trigger words.
(() => {
    'use strict'

    const Policy = globalThis.PhobiaBlockerPolicy
    const Storage = globalThis.PhobiaBlockerStorage
    const PageTextIndex = globalThis.PhobiaBlockerPageTextIndex
    // Returning leaves protection.css in charge: its 40px blur on every image,
    // video and iframe is only ever countered per element by the controller, so
    // with no shim and no controller nothing is revealed.
    if (!Policy || !Storage || !PageTextIndex) {
        console.error('PhobiaBlocker: shared modules are unavailable; keeping protection active')
        return
    }

    const { CSS_VARS, ROOT_ATTRS, PROTECTION_MODE } = Policy
    // Fail-closed until the settings read resolves; only that read changes the
    // mode. The hand-off below retires the shim instead of changing its state.
    const state = {
        mode: PROTECTION_MODE.ALWAYS_BLUR,
        targetWords: new Set(),
        wordCoverEnabled: false,
    }

    let observer = null
    let projectionObserver = null
    let handedOff = false
    // Needed so the hand-off can unwrap exactly these and nothing the controller made.
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
            // Skip writes that change nothing: each one is a style mutation the
            // projection observer below and the controller's observer would see.
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

    // Consumed by protection.css: its startup click lock on unregistered media is
    // keyed on "top", so media inside sub-frames are never locked. js.js re-asserts
    // the attribute because pages rewrite <html> attributes while booting.
    function ensureFrameMarker() {
        const root = getRoot()
        if (!root) return
        root.setAttribute(ROOT_ATTRS.frame, Policy.isTopFrameContext() ? 'top' : 'sub')
    }

    function isExcludedTextNode(node) {
        const parent = PageTextIndex.composedParent(node)
        if (!parent) return true
        if (PageTextIndex.closestAcrossRoots(parent, PageTextIndex.EXCLUDED_SELECTOR)) return true
        // Text inside one of our own covers is the trigger word itself; covering
        // it again would nest covers and loop through the MutationObserver.
        let current = parent
        while (current) {
            if (earlyCovers.has(current)) return true
            current = current.parentElement
        }
        return PageTextIndex.isEditableElement(parent)
    }

    // After the hand-off this shim never creates another cover, even from a
    // mutation callback that was already queued when the controller took over.
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
            // Merge the split text run back into one node. Safe here because the shim
            // keeps no index; the controller's _unwrap must not do this since its index
            // tracks text nodes by identity.
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

        // Cover what the parser has already produced before observing: a
        // MutationObserver only reports nodes added after it starts.
        coverSubtree(document.body || document.documentElement)
        if (observer) return

        observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes') {
                    // A region that became editable must lose its covers: a span inside
                    // an editor breaks the caret and typing. Re-covering the subtree
                    // handles the opposite toggle, since editable text is skipped anyway.
                    if (mutation.attributeName === 'contenteditable') {
                        unwrapEarlyCovers(cover => PageTextIndex.isEditableElement(cover))
                        coverSubtree(mutation.target)
                        return
                    }
                    // Frameworks rewrite className wholesale; restore the class so a
                    // cover never renders as plain readable text.
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

    // protection.css hides every background image and locks clicks on media until
    // background-ready is set. DISABLED marks the root ready at once so a
    // whitelisted page is not left blank; any other mode clears both attributes
    // so the stylesheet's fail-closed rules hold until the controller's own scan.
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

    // Pages reset className or attributes on <html> while booting (theme scripts,
    // hydration); re-project after each change until the controller owns the root.
    function startProjectionObserver() {
        const root = getRoot()
        if (!root || projectionObserver) return
        projectionObserver = new MutationObserver(() => {
            if (!handedOff) syncRootProjection()
        })
        projectionObserver.observe(root, {
            attributes: true,
            attributeFilter: [
                // 'style' only re-runs the idempotent class/attribute sync. A page that wipes
                // the inline style also drops the blur variables; that is safe because every
                // consumer falls back to 40px, and the controller rewrites them on take-over.
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

        // The controller awaits the same promise but can also finish first through
        // its own retry path; after the hand-off nothing here may touch the page.
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
            // Unknown settings mean blur everything. Without a trigger list no word
            // can be covered, so covering is switched off rather than guessed.
            state.targetWords = new Set()
            state.wordCoverEnabled = false
            applyMode(PROTECTION_MODE.ALWAYS_BLUR)
        }
    }

    // Hand-off. Controller.applyProtectionMode dispatches this in the same
    // synchronous turn that configures its own WordCoverManager, so unwrapping
    // here and re-covering there both happen before the page paints. Registered
    // at document_start, before js.js runs, so the event cannot be missed.
    window.addEventListener('phobiablocker:word-cover-manager-ready', () => {
        handedOff = true
        if (projectionObserver) projectionObserver.disconnect()
        projectionObserver = null
        stopCovering(true)
    }, { once: true })

    void initialize()
})()
