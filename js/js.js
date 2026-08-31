'use strict'

const Policy = globalThis.PhobiaBlockerPolicy
const Storage = globalThis.PhobiaBlockerStorage
const PageTextIndex = globalThis.PhobiaBlockerPageTextIndex

if (!Policy || !Storage || !PageTextIndex) {
    throw new Error('PhobiaBlocker: required shared modules are unavailable')
}

const { DEFAULTS, PROTECTION_MODE, STORAGE_KEYS } = Policy
const FAIL_CLOSED_RESULT = Object.freeze({
    shouldBlur: true,
    matchedWords: [],
    matchedInputWords: [],
})
const ANALYZE_TIMEOUT_MS = 3000
const MEDIA_SELECTOR = 'img, video, iframe'
const BACKGROUND_READY_ATTR = 'data-phobiablocker-background-ready'
const BACKGROUND_SCANNING_ATTR = 'data-phobiablocker-background-scanning'
const BACKGROUND_MARKER_ATTR = 'data-phobiablocker-background'
const ROOT_BACKGROUND_MARKER_ATTR = 'data-phobiablocker-root-background'
const MEDIA_MARKER_ATTR = 'data-phobiablocker-media'
const WORD_RE = /[-\p{L}]+/gu
const POLICY_STORAGE_KEYS = new Set(Object.values(STORAGE_KEYS))
const INTERNAL_ATTRIBUTE_STATE = new WeakMap()
const INTERNAL_CAPTURE_PENDING = new WeakSet()
const OBSERVED_ATTRIBUTES = Object.freeze([
    'class', 'style', 'hidden', 'aria-hidden',
    'src', 'srcset', 'sizes', 'poster', 'srcdoc', 'sandbox',
    'href', 'rel', 'media', 'disabled', 'type',
    BACKGROUND_READY_ATTR, BACKGROUND_SCANNING_ATTR,
])
const STYLESHEET_POLL_INTERVAL_MS = 2000
// Coalesce analysis across a burst of mutations instead of re-analysing the
// whole page once per batch.
const ANALYSIS_DEBOUNCE_MS = 200
// Resize fires continuously while a window is dragged; one rescan is enough.
const RESIZE_DEBOUNCE_MS = 200
const SETTINGS_READ_TIMEOUT_MS = 3000
const SETTINGS_READ_ATTEMPTS = 3
const MAX_BACKGROUND_SCAN_RETRIES = 3
// Throttle for the pointer hit test that drives hover previews.
const HOVER_HIT_TEST_INTERVAL_MS = 30
const MEDIA_RESOURCE_EVENTS = Object.freeze(['load', 'loadstart', 'loadedmetadata', 'loadeddata', 'emptied'])
const IFRAME_NAVIGATION_ATTRIBUTES = Object.freeze(['src', 'srcdoc', 'sandbox'])
const IFRAME_NAVIGATION_START_EVENTS = Object.freeze(['pagehide', 'unload'])
const IFRAME_RESTORATION_EVENT = 'pageshow'
const IFRAME_GUARD_EVENTS = Object.freeze([...IFRAME_NAVIGATION_START_EVENTS, IFRAME_RESTORATION_EVENT])
const MAX_SUSPENDED_IFRAME_GUARDS = 2
const ANALYSIS_DEBUG_STATE = {
    pageAnalysisRequests: 0,
    mutationBatches: 0,
    directWordCovers: 0,
}
const PB_CSS_VARS = Object.freeze({
    blurNs: '--phobiablocker-blurValueAmount',
    blurLegacy: '--blurValueAmount',
    previewNs: '--phobiablocker-previewBlurAmount',
    previewLegacy: '--previewBlurAmount',
})

let lastElementContext = null
let lastContextMenuPoint = null
let iconStatusTimer = null

function markInternalMutationTarget(node) {
    if (!(node instanceof Element) || INTERNAL_CAPTURE_PENDING.has(node)) return
    INTERNAL_CAPTURE_PENDING.add(node)
    queueMicrotask(() => {
        INTERNAL_CAPTURE_PENDING.delete(node)
        const snapshot = {}
        OBSERVED_ATTRIBUTES.forEach((name) => {
            snapshot[name] = node.getAttribute(name)
        })
        INTERNAL_ATTRIBUTE_STATE.set(node, snapshot)
        setTimeout(() => INTERNAL_ATTRIBUTE_STATE.delete(node), 0)
    })
}

function isInternalMutation(mutation) {
    if (!mutation || !mutation.target) return true
    if (mutation.type !== 'attributes' || !(mutation.target instanceof Element)) return false
    const snapshot = INTERNAL_ATTRIBUTE_STATE.get(mutation.target)
    if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, mutation.attributeName)) return false
    return snapshot[mutation.attributeName] === mutation.target.getAttribute(mutation.attributeName)
}

function isTopFrameContext() {
    try { return window.top === window } catch (_) { return false }
}

function reportIconStatus(status) {
    if (!isTopFrameContext()) return
    clearTimeout(iconStatusTimer)

    const send = () => {
        try {
            const result = chrome.runtime.sendMessage({ target: 'background', type: 'iconStatus', status })
            if (result && typeof result.catch === 'function') result.catch(() => {})
        } catch (_) { /* The background stylesheet remains the fallback. */ }
    }

    if (status === 'processing') {
        send()
        return
    }
    iconStatusTimer = setTimeout(send, 250)
}

function setRootCssVar(name, value, priority = '') {
    const root = document.documentElement
    if (!root || !root.style) return
    if (root.style.getPropertyValue(name) === value && root.style.getPropertyPriority(name) === priority) return
    markInternalMutationTarget(root)
    root.style.setProperty(name, value, priority)
}

function setBlurCssValue(value) {
    setRootCssVar(PB_CSS_VARS.blurNs, value)
    setRootCssVar(PB_CSS_VARS.blurLegacy, value)
}

function setPreviewBlurCssValue(value) {
    setRootCssVar(PB_CSS_VARS.previewNs, value)
    setRootCssVar(PB_CSS_VARS.previewLegacy, value)
}

function computeBlurPixels(value) {
    const sliderValue = typeof value === 'number' ? value : DEFAULTS.blurValueAmount
    return Math.pow(sliderValue * 0.09, 1.8) * 2
}

function normalizeAnalysisResult(result) {
    const validWords = value => Array.isArray(value) && value.every(word => typeof word === 'string')
    if (!result || typeof result.shouldBlur !== 'boolean' ||
        !validWords(result.matchedWords) || !validWords(result.matchedInputWords)) {
        return { ...FAIL_CLOSED_RESULT }
    }
    return {
        shouldBlur: result.shouldBlur,
        matchedWords: [...new Set(result.matchedWords.filter(Boolean))],
        matchedInputWords: [...new Set(result.matchedInputWords.filter(Boolean))],
    }
}

async function analyzePageWordsWithOffscreen(words) {
    let timeoutId = null
    try {
        ANALYSIS_DEBUG_STATE.pageAnalysisRequests++
        const response = await Promise.race([
            chrome.runtime.sendMessage({
                target: 'background',
                type: 'PB_ANALYZE_WORDS',
                words: Array.isArray(words) ? words : [],
            }),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Analysis timed out')), ANALYZE_TIMEOUT_MS)
            }),
        ])
        return normalizeAnalysisResult(response)
    } catch (error) {
        console.error('PhobiaBlocker: page analysis failed; keeping media blurred', error)
        return { ...FAIL_CLOSED_RESULT }
    } finally {
        if (timeoutId !== null) clearTimeout(timeoutId)
    }
}

function getMediaFingerprint(element, knownBackgroundImage = null) {
    try {
        if (element instanceof HTMLImageElement) {
            const pictureSources = element.parentElement instanceof HTMLPictureElement
                ? [...element.parentElement.querySelectorAll('source')].map(source => [
                    source.getAttribute('srcset'),
                    source.getAttribute('media'),
                    source.getAttribute('sizes'),
                    source.getAttribute('type'),
                ])
                : []
            // currentSrc is deliberately excluded: it changes when a responsive
            // srcset or lazy loader swaps resolution, which would silently
            // invalidate a reveal the user asked for on the same image.
            return JSON.stringify([
                'img',
                element.getAttribute('src'),
                element.getAttribute('srcset'),
                pictureSources,
            ])
        }
        if (element instanceof HTMLVideoElement) {
            const sources = [...element.querySelectorAll('source')].map(source => [
                source.getAttribute('src'),
                source.src,
            ])
            return JSON.stringify([
                'video',
                element.getAttribute('src'),
                element.poster,
                sources,
            ])
        }
        if (element instanceof HTMLIFrameElement) {
            return JSON.stringify([
                'iframe',
                element.getAttribute('src'),
                element.getAttribute('srcdoc'),
            ])
        }
        const backgroundImage = knownBackgroundImage === null
            ? getComputedStyle(element).backgroundImage
            : knownBackgroundImage
        return JSON.stringify(['background', backgroundImage])
    } catch (_) {
        return ''
    }
}

function isCrossOriginIframe(iframe, navigationComplete = false, navigationPending = false) {
    try {
        if (!(iframe instanceof HTMLIFrameElement)) return true
        if (iframe.hasAttribute('sandbox')) return true
        if (navigationPending) return true

        const hasSourceDocument = iframe.hasAttribute('srcdoc')
        const source = iframe.getAttribute('src')
        let declared = null
        let requiresDeclaredNavigation = hasSourceDocument
        if (source && !hasSourceDocument) {
            declared = new URL(source, document.baseURI)
            const inheritsParentOrigin = declared.protocol === 'about:' && declared.pathname === 'blank'
            if (!inheritsParentOrigin &&
                (!declared.origin || declared.origin === 'null' || declared.origin !== location.origin)) return true
            requiresDeclaredNavigation = !inheritsParentOrigin
        }

        const frameWindow = iframe.contentWindow
        const frameDocument = iframe.contentDocument
        if (!frameWindow || !frameDocument) return true

        const effectiveSource = frameWindow.location.href
        const effective = new URL(effectiveSource, document.baseURI)
        const isInitialBlankDocument = effective.protocol === 'about:' && effective.pathname === 'blank'
        const isSourceDocument = effective.protocol === 'about:' && effective.pathname === 'srcdoc'
        if (frameDocument.readyState !== 'complete' && requiresDeclaredNavigation) return true
        if (hasSourceDocument) return !isSourceDocument
        if (requiresDeclaredNavigation && (isInitialBlankDocument || isSourceDocument)) return true
        if (isInitialBlankDocument || isSourceDocument) return false
        if (!effective.origin || effective.origin === 'null' || effective.origin !== location.origin) return true
        if (declared && effective.href !== declared.href && !navigationComplete) {
            return true
        }
        return false
    } catch (_) {
        return true
    }
}

function getComputedBackgroundImage(element) {
    if (!(element instanceof Element)) return ''
    const value = getComputedStyle(element).backgroundImage
    return value && value !== 'none' && value.includes('url(') ? value : ''
}

class VisualNode {
    constructor(element, kind, controller) {
        this.element = element
        this.kind = kind
        this.controller = controller
        this._projectionClasses = [
            'phobia-blur',
            'phobia-noblur',
            'phobia-preview',
            'phobia-permanent-unblur',
        ]
        this._originalClasses = new Set(this._projectionClasses.filter(name => element.classList.contains(name)))
        this._originalAttributes = new Map([
            ['data-phobia-blur', element.getAttribute('data-phobia-blur')],
            [BACKGROUND_MARKER_ATTR, element.getAttribute(BACKGROUND_MARKER_ATTR)],
            [ROOT_BACKGROUND_MARKER_ATTR, element.getAttribute(ROOT_BACKGROUND_MARKER_ATTR)],
            [MEDIA_MARKER_ATTR, element.getAttribute(MEDIA_MARKER_ATTR)],
        ])
        this._pageStyles = new Map([
            ['filter', this._readStyleProperty(element.style, 'filter')],
            ['background-image', this._readStyleProperty(element.style, 'background-image')],
        ])
        this._styleProjections = new Map()
        this.isRootBackground = kind === 'background' &&
            (element === document.documentElement || element === document.body)
        this.backgroundImage = ''
        this.isBlurred = true
        this.matchedWords = []
        // Last projection actually written to the DOM. Repeated requests for the
        // same state become no-ops, which is what stops mutation batches from
        // rewriting every node's class and inline filter over and over.
        this._renderState = null
        this._previewActive = false
        markInternalMutationTarget(this.element)
        this.element.setAttribute(MEDIA_MARKER_ATTR, '1')
        if (this.isRootBackground) this.element.setAttribute(ROOT_BACKGROUND_MARKER_ATTR, '1')
        this.blur()
    }

    _setProjectionClass(name, enabled) {
        if (enabled) this.element.classList.add(name)
        else if (!this._originalClasses.has(name)) this.element.classList.remove(name)
    }

    _restoreAttribute(name) {
        const original = this._originalAttributes.get(name)
        if (original === null) this.element.removeAttribute(name)
        else this.element.setAttribute(name, original)
    }

    _readStyleProperty(style, name) {
        return {
            value: style.getPropertyValue(name),
            priority: style.getPropertyPriority(name),
        }
    }

    _stylePropertyMatches(left, right) {
        return left.value === right.value && left.priority === right.priority
    }

    _setStyleProjection(name, value, priority = '') {
        const current = this._readStyleProperty(this.element.style, name)
        const previousProjection = this._styleProjections.get(name)
        if (!previousProjection || !this._stylePropertyMatches(current, previousProjection)) {
            this._pageStyles.set(name, current)
        }

        const projection = { value, priority }
        this._styleProjections.set(name, projection)
        if (this._stylePropertyMatches(current, projection)) return
        markInternalMutationTarget(this.element)
        this.element.style.setProperty(name, value, priority)
    }

    _restorePageStyle(name) {
        const current = this._readStyleProperty(this.element.style, name)
        const projection = this._styleProjections.get(name)
        if (!projection) {
            this._pageStyles.set(name, current)
            return
        }
        if (!this._stylePropertyMatches(current, projection)) {
            this._pageStyles.set(name, current)
        }
        this._styleProjections.delete(name)
        const pageStyle = this._pageStyles.get(name) || { value: '', priority: '' }
        if (this._stylePropertyMatches(current, pageStyle)) return
        markInternalMutationTarget(this.element)
        if (pageStyle.value) this.element.style.setProperty(name, pageStyle.value, pageStyle.priority)
        else this.element.style.removeProperty(name)
    }

    _unownedStyleSignature(styleText) {
        const probe = document.createElement('span').style
        probe.cssText = styleText || ''
        probe.removeProperty('filter')
        probe.removeProperty('background-image')
        Object.values(PB_CSS_VARS).forEach(name => probe.removeProperty(name))
        return probe.cssText
    }

    captureStyleMutation(oldStyleText) {
        const previous = document.createElement('span').style
        previous.cssText = oldStyleText || ''
        let pageChanged = this._unownedStyleSignature(oldStyleText) !==
            this._unownedStyleSignature(this.element.getAttribute('style'))

        for (const name of this._pageStyles.keys()) {
            const before = this._readStyleProperty(previous, name)
            const current = this._readStyleProperty(this.element.style, name)
            if (this._stylePropertyMatches(before, current)) continue

            const projection = this._styleProjections.get(name)
            if (projection && this._stylePropertyMatches(current, projection)) continue

            this._pageStyles.set(name, current)
            pageChanged = true
            if (projection) this._setStyleProjection(name, projection.value, projection.priority)
        }

        return pageChanged
    }

    prepareBackgroundScan() {
        if (!this.isRootBackground) return
        this._restorePageStyle('background-image')
    }

    // Forces the next blur/unblur to rewrite the DOM. Called when the page
    // itself touched our element, so a repair still happens even though the
    // requested state has not changed.
    invalidateRendering() {
        this._renderState = null
    }

    blur(matchedWords = []) {
        if (!this.element || this.element.isConnected === false) return
        this.isBlurred = true
        this.matchedWords = [...matchedWords]
        if (this._renderState === 'blur') return
        this._renderState = 'blur'
        markInternalMutationTarget(this.element)
        this._setProjectionClass('phobia-noblur', false)
        this._setProjectionClass('phobia-permanent-unblur', false)
        this._setProjectionClass('phobia-preview', false)
        this._setProjectionClass('phobia-blur', true)
        this.element.setAttribute('data-phobia-blur', '1')
        if (this.kind === 'background') this.element.setAttribute(BACKGROUND_MARKER_ATTR, '1')
        if (this.isRootBackground) {
            this._setStyleProjection('background-image', 'none', 'important')
            this._detachPreview()
            return
        }
        this._setStyleProjection('filter', this.controller.blurFilter, 'important')
        // A re-render while the pointer is still over the element must not drop
        // back to full blur; re-assert the preview instead.
        if (this._previewActive) this._applyPreviewFilter()
    }

    unblur(options = {}) {
        if (!this.element || this.element.isConnected === false) return
        const nextState = options.explicit === true ? 'unblur-explicit' : 'unblur'
        this.isBlurred = false
        this.matchedWords = []
        if (this._renderState === nextState) return
        this._renderState = nextState
        markInternalMutationTarget(this.element)
        this._setProjectionClass('phobia-blur', false)
        this._setProjectionClass('phobia-preview', false)
        this._setProjectionClass('phobia-noblur', true)
        this._setProjectionClass('phobia-permanent-unblur', options.explicit === true)
        this._restoreAttribute('data-phobia-blur')
        if (this.isRootBackground) {
            this._restorePageStyle('background-image')
            this._detachPreview()
            return
        }
        this._setStyleProjection('filter', 'none', 'important')
        this._detachPreview()
    }

    clearRendering() {
        if (!this.element) return
        this._renderState = null
        markInternalMutationTarget(this.element)
        this._detachPreview()
        this._projectionClasses.forEach((name) => {
            this.element.classList.toggle(name, this._originalClasses.has(name))
        })
        this._restoreAttribute('data-phobia-blur')
        this._restoreAttribute(BACKGROUND_MARKER_ATTR)
        this._restoreAttribute(ROOT_BACKGROUND_MARKER_ATTR)
        this._restoreAttribute(MEDIA_MARKER_ATTR)
        if (this._styleProjections.has('filter')) this._restorePageStyle('filter')
        if (this.isRootBackground) this._restorePageStyle('background-image')
        this._styleProjections.clear()
    }

    _applyPreviewFilter() {
        if (!this.element) return
        const settings = this.controller.settings
        const previewValue = settings.previewEnabled
            ? `${settings.previewBlurStrength}px`
            : this.controller.blurPixels
        markInternalMutationTarget(this.element)
        this._setProjectionClass('phobia-preview', true)
        this._setStyleProjection('filter', `blur(${previewValue})`, 'important')
    }

    // Hover state is driven by the controller's pointer hit test rather than
    // per-element listeners. Listening on the element missed media covered by an
    // overlay, and listening on the parent missed media inside a wrapper smaller
    // than itself; hit testing the whole stack handles both.
    showPreview() {
        if (this._previewActive || !this.isBlurred || !this.element) return
        this._previewActive = true
        this._applyPreviewFilter()
    }

    hidePreview() {
        if (!this._previewActive) return
        this._previewActive = false
        if (!this.isBlurred || !this.element) return
        markInternalMutationTarget(this.element)
        this._setProjectionClass('phobia-preview', false)
        this._setStyleProjection('filter', this.controller.blurFilter, 'important')
    }

    _detachPreview() {
        this._previewActive = false
    }
}

class VisualRegistry {
    constructor(controller) {
        this._controller = controller
        this._nodes = new Set()
        this._byElement = new WeakMap()
    }

    register(element, kind) {
        const existing = this._byElement.get(element)
        if (existing) return { node: existing, created: false }
        const node = new VisualNode(element, kind, this._controller)
        this._nodes.add(node)
        this._byElement.set(element, node)
        return { node, created: true }
    }

    get(element) {
        return this._byElement.get(element)
    }

    remove(element) {
        const node = this._byElement.get(element)
        if (!node) return false
        node.clearRendering()
        this._nodes.delete(node)
        this._byElement.delete(element)
        return true
    }

    prune() {
        this._nodes.forEach((node) => {
            if (!node.element || node.element.isConnected === false) {
                if (node.kind === 'iframe' && node.element) {
                    this._controller._disarmIframeNavigationGuard(node.element)
                }
                node.clearRendering()
                this._nodes.delete(node)
                if (node.element) this._byElement.delete(node.element)
            }
        })
    }

    clear() {
        this._nodes.forEach(node => node.clearRendering())
        this._nodes.clear()
        this._byElement = new WeakMap()
    }

    all() {
        return [...this._nodes]
    }
}

class WordCoverManager {
    constructor() {
        this._pageTextIndex = null
        this._targets = new Set()
        this._active = false
        this._ownedWrappers = new Set()
        this._revealedWrappers = new WeakSet()
    }

    attachIndex(pageTextIndex) {
        this._pageTextIndex = pageTextIndex
    }

    configure(settings, mode) {
        this._targets = new Set(Policy.normalizeTargetWords(settings.targetWords).valid)
        this._active = mode !== PROTECTION_MODE.DISABLED &&
            settings.wordCoverEnabled === true && this._targets.size > 0
        if (this._pageTextIndex) this._pageTextIndex.setTargetWords([...this._targets])
        if (!this._active) this.unwrapAll()
    }

    ownsWrapper(element) {
        return this._ownedWrappers.has(element)
    }

    _findOwnedWrapper(element) {
        let current = element
        while (current) {
            if (this._ownedWrappers.has(current)) return current
            current = current.parentElement
        }
        return null
    }

    repairProjection(element) {
        if (!this._ownedWrappers.has(element)) return false
        markInternalMutationTarget(element)
        if (this._revealedWrappers.has(element)) {
            element.classList.remove('phobia-word-cover')
            element.classList.add('phobia-word-permanent-uncover')
            element.removeAttribute('data-phobia-word-cover')
            return true
        }
        element.classList.remove('phobia-word-permanent-uncover')
        element.classList.add('phobia-word-cover')
        element.setAttribute('data-phobia-word-cover', '1')
        return true
    }

    coverTextNode(textNode, directMatches) {
        if (!this._active || !textNode || !textNode.parentNode) return false
        const parentElement = textNode.parentElement
        if (!parentElement || parentElement.closest?.([
            'script', 'style', 'noscript', 'input', 'textarea', 'select', 'option',
            'form', '[contenteditable="true"]', '[hidden]', '[aria-hidden="true"]',
        ].join(', '))) return false
        if (this._findOwnedWrapper(parentElement)) return false

        const matchesToCover = directMatches instanceof Set ? directMatches : this._targets
        const text = textNode.nodeValue || ''
        const fragment = document.createDocumentFragment()
        const replacementTextNodes = []
        let lastIndex = 0
        let changed = false
        let match

        const appendText = (value) => {
            if (!value) return
            const node = document.createTextNode(value)
            replacementTextNodes.push({ node, includeCovered: false })
            fragment.appendChild(node)
        }

        WORD_RE.lastIndex = 0
        while ((match = WORD_RE.exec(text)) !== null) {
            const normalized = match[0].normalize('NFKC').toLowerCase()
            if (!matchesToCover.has(normalized) || !this._targets.has(normalized)) continue
            changed = true
            appendText(text.slice(lastIndex, match.index))

            const cover = document.createElement('span')
            const coverText = document.createTextNode(match[0])
            cover.className = 'phobia-word-cover'
            cover.setAttribute('data-phobia-word-cover', '1')
            cover.setAttribute('title', 'Covered by PhobiaBlocker')
            cover.setAttribute('aria-label', 'Covered by PhobiaBlocker')
            try {
                const color = getComputedStyle(parentElement).color
                if (color) cover.style.setProperty('--phobiablocker-word-cover-color', color)
            } catch (_) { /* Use the stylesheet's currentColor fallback. */ }
            cover.appendChild(coverText)
            this._ownedWrappers.add(cover)
            markInternalMutationTarget(cover)
            replacementTextNodes.push({ node: coverText, includeCovered: true })
            fragment.appendChild(cover)
            lastIndex = match.index + match[0].length
        }
        WORD_RE.lastIndex = 0

        if (!changed) return false
        appendText(text.slice(lastIndex))
        if (this._pageTextIndex) this._pageTextIndex.removeTextNode(textNode)
        markInternalMutationTarget(parentElement)
        parentElement.replaceChild(fragment, textNode)
        replacementTextNodes.forEach(({ node, includeCovered }) => {
            this._pageTextIndex?.indexTextNode(node, { includeCovered, notify: false })
        })
        ANALYSIS_DEBUG_STATE.directWordCovers += replacementTextNodes
            .filter(({ includeCovered }) => includeCovered).length
        return true
    }

    revealContextWord(target) {
        const element = target && target.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement
        const cover = this._findOwnedWrapper(element)
        if (!cover) return false
        this._revealedWrappers.add(cover)
        markInternalMutationTarget(cover)
        cover.classList.remove('phobia-word-cover')
        cover.classList.add('phobia-word-permanent-uncover')
        cover.removeAttribute('data-phobia-word-cover')
        cover.removeAttribute('title')
        cover.removeAttribute('aria-label')
        cover.removeAttribute('style')
        return true
    }

    // "Unblur all" must stay unblurred. Deactivating stops the text index from
    // re-covering the same words on the next mutation; a settings change calls
    // configure() again and turns covering back on.
    revealAll() {
        this._active = false
        this.unwrapAll()
    }

    stop() {
        this._active = false
        this._targets.clear()
        if (this._pageTextIndex) this._pageTextIndex.setTargetWords([])
        this.unwrapAll()
    }

    unwrapAll() {
        Array.from(this._ownedWrappers).forEach(wrapper => this._unwrap(wrapper))
    }

    _unwrap(wrapper) {
        if (!this._ownedWrappers.has(wrapper)) return
        this._ownedWrappers.delete(wrapper)
        this._revealedWrappers.delete(wrapper)
        if (!wrapper.parentNode) return
        const parent = wrapper.parentNode
        const replacement = document.createTextNode(wrapper.textContent || '')
        wrapper.querySelectorAll('*').forEach((element) => {
            element.childNodes.forEach((node) => this._pageTextIndex?.removeTextNode(node))
        })
        wrapper.childNodes.forEach((node) => this._pageTextIndex?.removeTextNode(node))
        markInternalMutationTarget(parent)
        parent.replaceChild(replacement, wrapper)
        this._pageTextIndex?.indexTextNode(replacement, { notify: false })
    }
}

class Controller {
    constructor() {
        this.settings = this._cloneDefaults()
        this.blurPixels = `${computeBlurPixels(DEFAULTS.blurValueAmount)}px`
        this.blurFilter = `blur(${this.blurPixels})`
        this.mode = PROTECTION_MODE.ALWAYS_BLUR
        this._policyGeneration = 0
        this._pageAnalysisResult = { ...FAIL_CLOSED_RESULT }
        this._registry = new VisualRegistry(this)
        this._explicitReveals = new WeakMap()
        this._loadedIframeFingerprints = new WeakMap()
        this._pendingIframeNavigations = new WeakSet()
        this._iframeNavigationGuards = new WeakMap()
        this._disabledMediaFilters = new WeakMap()
        this._manualBlurAllActive = false
        this._observer = null
        this._analysisTimer = null
        this._backgroundTimer = null
        this._stylesheetPollTimer = null
        this._stylesheetFingerprint = ''
        this._backgroundLinks = new WeakSet()
        this._backgroundPhase = 'pending'
        this._backgroundRetries = 0
        this._hasCompletedBackgroundScan = false
        this._mediaEventListenersAttached = false
        this._iframeLifecycleListenerAttached = false
        this._iframeLifecycleObserver = null
        this._onMediaResourceEvent = event => this._handleMediaResourceEvent(event)
        this._onIframeLifecycleLoad = event => this._handleIframeLifecycleLoad(event)
        this._globalRescanTimer = null
        this._onGlobalBackgroundStateEvent = () => {
            this._scheduleDebouncedRescan()
            this._scheduleHoverPreviewUpdate()
        }
        this._earlyCoverReleased = false
        this._wordCoverManager = new WordCoverManager()
        this._pageTextIndex = new PageTextIndex({
            onDirectMatch: (node, matches) => this._wordCoverManager.coverTextNode(node, matches),
            isOwnedCover: element => this._wordCoverManager.ownsWrapper(element),
        })
        this._wordCoverManager.attachIndex(this._pageTextIndex)
        this._hoverListenerAttached = false
        this._hoverNode = null
        this._hoverPoint = null
        this._lastHoverUpdateAt = 0
        this._hoverTrailingTimer = null
        this._startHoverTracking()
        this._startIframeLifecycleTracking()
    }

    _cloneDefaults() {
        return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => (
            [key, Array.isArray(value) ? [...value] : value]
        )))
    }

    setSettings(settings) {
        this.settings = {
            ...this._cloneDefaults(),
            ...(settings || {}),
            targetWords: Array.isArray(settings?.targetWords) ? [...settings.targetWords] : [],
            whitelistedSites: Array.isArray(settings?.whitelistedSites) ? [...settings.whitelistedSites] : [],
            blacklistedSites: Array.isArray(settings?.blacklistedSites) ? [...settings.blacklistedSites] : [],
        }
        window.PHOBIABLOCKER_DEBUG = this.settings.debugMode === true
        this.blurPixels = `${computeBlurPixels(this.settings.blurValueAmount)}px`
        this.blurFilter = `blur(${this.blurPixels})`
        setBlurCssValue(this.blurPixels)
        const previewValue = this.settings.previewEnabled
            ? `${this.settings.previewBlurStrength}px`
            : 'var(--phobiablocker-blurValueAmount, var(--blurValueAmount, 40px))'
        setPreviewBlurCssValue(previewValue)
        if (this._hoverNode) {
            this._hoverNode.hidePreview()
            this._hoverNode = null
        }
        this._scheduleHoverPreviewUpdate()
    }

    cancelPendingAnalysis() {
        clearTimeout(this._analysisTimer)
        clearTimeout(this._backgroundTimer)
        clearTimeout(this._globalRescanTimer)
        clearInterval(this._stylesheetPollTimer)
        this._analysisTimer = null
        this._backgroundTimer = null
        this._globalRescanTimer = null
        this._stylesheetPollTimer = null
        if (this._observer) this._observer.disconnect()
        this._detachMediaResourceListeners()
    }

    async applyProtectionMode(mode, settings) {
        const generation = ++this._policyGeneration
        this.cancelPendingAnalysis()
        this.setSettings(settings)
        this.mode = mode
        this._releaseEarlyWordCover()

        if (mode === PROTECTION_MODE.DISABLED) {
            this.disableProtection()
            return
        }

        this._pageAnalysisResult = { ...FAIL_CLOSED_RESULT }
        this.enableProtection()
        this.protectAllKnownVisuals()
        if (mode === PROTECTION_MODE.ALWAYS_BLUR || this._manualBlurAllActive) {
            this._pageAnalysisResult = { ...FAIL_CLOSED_RESULT }
            reportIconStatus('detected')
            return
        }

        const result = await this.analyzeCurrentPage(generation)
        if (generation !== this._policyGeneration) return
        this.applyPageResult(result)
    }

    enableProtection() {
        const root = document.documentElement
        if (!root) return
        this._restoreDisabledMedia(document)
        this._setBackgroundPhase('pending')
        this._syncRootProjection()
        this._ensureFrameMarker()

        this._wordCoverManager.stop()
        this._wordCoverManager.configure(this.settings, this.mode)
        this._pageTextIndex.build(document.body || root)
        this._registerMedia(document)
        this._scanBackgrounds(document, { full: true })
        document.querySelectorAll('link[rel~="stylesheet"]').forEach(link => this._watchStylesheetLink(link))
        this._attachMediaResourceListeners()
        this._startStylesheetPolling()
        this._observerInit()
    }

    disableProtection() {
        const root = document.documentElement
        if (root) {
            this._setBackgroundPhase('ready')
            this._syncRootProjection()
        }
        this._clearHoverPreview()
        this._wordCoverManager.stop()
        this._pageTextIndex.clear()
        this._registry.clear()
        this._showMediaWhileDisabled(document)
        this._observerInit()
        reportIconStatus('idle')
    }

    _mediaElements(root) {
        const elements = []
        if (root?.nodeType === Node.ELEMENT_NODE && root.matches?.(MEDIA_SELECTOR)) elements.push(root)
        root?.querySelectorAll?.(MEDIA_SELECTOR).forEach(element => elements.push(element))
        return elements
    }

    _showMediaWhileDisabled(root, options = {}) {
        const refreshOriginal = options.refreshOriginal === true
        this._mediaElements(root).forEach((element) => {
            let state = this._disabledMediaFilters.get(element)
            const currentValue = element.style.getPropertyValue('filter')
            const currentPriority = element.style.getPropertyPriority('filter')
            if (!state) {
                state = {
                    originalValue: currentValue,
                    originalPriority: currentPriority,
                    appliedValue: '',
                }
                this._disabledMediaFilters.set(element, state)
            } else if (refreshOriginal &&
                (currentValue !== state.appliedValue || currentPriority !== 'important')) {
                state.originalValue = currentValue
                state.originalPriority = currentPriority
            }

            const visibleValue = state.originalValue || 'none'
            state.appliedValue = visibleValue
            if (currentValue === visibleValue && currentPriority === 'important') return
            markInternalMutationTarget(element)
            element.style.setProperty('filter', visibleValue, 'important')
        })
    }

    _restoreDisabledMedia(root) {
        this._mediaElements(root).forEach((element) => {
            const state = this._disabledMediaFilters.get(element)
            if (!state) return
            markInternalMutationTarget(element)
            if (state.originalValue) {
                element.style.setProperty('filter', state.originalValue, state.originalPriority)
            } else {
                element.style.removeProperty('filter')
            }
            this._disabledMediaFilters.delete(element)
        })
    }

    _discardDisabledMediaState(root) {
        this._mediaElements(root).forEach((element) => {
            const state = this._disabledMediaFilters.get(element)
            if (!state) return

            const currentValue = element.style.getPropertyValue('filter')
            const currentPriority = element.style.getPropertyPriority('filter')
            if (currentValue === state.appliedValue && currentPriority === 'important') {
                markInternalMutationTarget(element)
                if (state.originalValue) {
                    element.style.setProperty('filter', state.originalValue, state.originalPriority)
                } else {
                    element.style.removeProperty('filter')
                }
            }
            this._disabledMediaFilters.delete(element)
        })
    }

    _disarmDetachedIframeGuards(root) {
        this._mediaElements(root).forEach((element) => {
            if (element instanceof HTMLIFrameElement && element.isConnected === false) {
                this._disarmIframeNavigationGuard(element)
            }
        })
    }

    _handleDisabledMutations(records) {
        records.forEach((mutation) => {
            if (mutation.type !== 'childList') return
            mutation.removedNodes.forEach(node => this._discardDisabledMediaState(node))
        })

        records.forEach((mutation) => {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => this._showMediaWhileDisabled(node))
                return
            }
            if (mutation.type !== 'attributes' || !(mutation.target instanceof Element)) return
            if (mutation.target === document.documentElement) this._syncRootProjection()
            if (mutation.target.matches(MEDIA_SELECTOR)) {
                this._showMediaWhileDisabled(mutation.target, {
                    refreshOriginal: mutation.attributeName === 'style',
                })
            }
        })
    }

    _disabledStyleMutationIsExternal(element, oldStyleText) {
        const state = this._disabledMediaFilters.get(element)
        if (!state) return false

        const currentValue = element.style.getPropertyValue('filter')
        const currentPriority = element.style.getPropertyPriority('filter')
        if (currentValue !== state.appliedValue || currentPriority !== 'important') return true

        const signature = (styleText) => {
            const probe = document.createElement('span').style
            probe.cssText = styleText || ''
            probe.removeProperty('filter')
            Object.values(PB_CSS_VARS).forEach(name => probe.removeProperty(name))
            return probe.cssText
        }
        return signature(oldStyleText) !== signature(element.getAttribute('style'))
    }

    _setBackgroundPhase(phase) {
        this._backgroundPhase = phase
        this._syncRootProjection()
    }

    _syncRootProjection() {
        const root = document.documentElement
        if (!root) return
        const disabled = this.mode === PROTECTION_MODE.DISABLED
        const shouldScan = !disabled && this._backgroundPhase === 'scanning'
        const isReady = disabled || this._backgroundPhase === 'ready'

        markInternalMutationTarget(root)
        root.classList.toggle('phobia-disabled', disabled)
        root.toggleAttribute(BACKGROUND_SCANNING_ATTR, shouldScan)
        if (isReady) root.setAttribute(BACKGROUND_READY_ATTR, '1')
        else root.removeAttribute(BACKGROUND_READY_ATTR)
    }

    protectAllKnownVisuals() {
        this._registry.prune()
        this._registry.all().forEach((node) => {
            if (this.isExplicitlyRevealed(node.element)) node.unblur({ explicit: true })
            else node.blur()
        })
    }

    async analyzeCurrentPage(generation) {
        reportIconStatus('processing')
        const words = this._pageTextIndex.getWords()
        const result = await analyzePageWordsWithOffscreen(words)
        if (generation !== this._policyGeneration) return { ...FAIL_CLOSED_RESULT }
        this._pageAnalysisResult = normalizeAnalysisResult(result)
        return this._pageAnalysisResult
    }

    applyPageResult(result, nodes = this._registry.all()) {
        const normalized = normalizeAnalysisResult(result)
        this._pageAnalysisResult = normalized
        nodes.forEach(node => this._applyResultToNode(node, normalized))
        reportIconStatus(normalized.shouldBlur ? 'detected' : 'idle')
    }

    rememberExplicitReveal(element) {
        if (!element) return false
        const node = this._registry.get(element)
        if (!node) return false
        const fingerprint = getMediaFingerprint(element, node.kind === 'background' ? node.backgroundImage : null)
        if (!fingerprint) return false
        this._explicitReveals.set(element, fingerprint)
        node.unblur({ explicit: true })
        return true
    }

    isExplicitlyRevealed(element) {
        const saved = this._explicitReveals.get(element)
        if (!saved) return false

        const node = this._registry.get(element)
        const fingerprint = getMediaFingerprint(element, node?.kind === 'background' ? node.backgroundImage : null)
        if (saved !== fingerprint) {
            this._explicitReveals.delete(element)
            return false
        }
        return true
    }

    _markIframeNavigationComplete(element) {
        const fingerprint = getMediaFingerprint(element)
        if (!fingerprint) return
        this._loadedIframeFingerprints.set(element, fingerprint)
        this._pendingIframeNavigations.delete(element)
    }

    _isIframeNavigationComplete(element) {
        const fingerprint = getMediaFingerprint(element)
        return Boolean(fingerprint && this._loadedIframeFingerprints.get(element) === fingerprint)
    }

    _markIframeNavigationPending(element) {
        this._loadedIframeFingerprints.delete(element)
        this._pendingIframeNavigations.add(element)
    }

    blurAll() {
        ++this._policyGeneration
        this.cancelPendingAnalysis()
        this._manualBlurAllActive = true
        this._explicitReveals = new WeakMap()
        this._registerMedia(document)
        this._scanBackgrounds(document, { full: true })
        this._registry.all().forEach(node => node.blur())
        this._attachMediaResourceListeners()
        this._startStylesheetPolling()
        this._observerInit()
        reportIconStatus('detected')
    }

    unblurAll() {
        ++this._policyGeneration
        this.cancelPendingAnalysis()
        this._manualBlurAllActive = false
        this._registerMedia(document)
        this._scanBackgrounds(document, { full: true })
        this._registry.all().forEach(node => this.rememberExplicitReveal(node.element))
        this._wordCoverManager.revealAll()
        this._attachMediaResourceListeners()
        this._startStylesheetPolling()
        this._observerInit()
        reportIconStatus('idle')
    }

    getVisualNodes() {
        return this._registry.all()
    }

    getVisualNode(element) {
        return this._registry.get(element)
    }

    _applyResultToNode(node, result) {
        if (!node || !node.element || node.element.isConnected === false) return
        if (this.isExplicitlyRevealed(node.element)) {
            node.unblur({ explicit: true })
            return
        }
        if (this._manualBlurAllActive || result.shouldBlur) {
            node.blur(result.matchedWords)
            return
        }
        if (node.kind === 'iframe' && this.settings.keepCrossOriginIframesBlurred &&
            isCrossOriginIframe(
                node.element,
                this._isIframeNavigationComplete(node.element),
                this._pendingIframeNavigations.has(node.element)
            )) {
            node.blur()
            return
        }
        node.unblur()
    }

    _registerMedia(root) {
        const touched = new Set()
        if (!root) return touched

        const register = (element) => {
            if (!(element instanceof Element)) return
            let kind = null
            if (element instanceof HTMLImageElement) kind = 'image'
            else if (element instanceof HTMLVideoElement) kind = 'video'
            else if (element instanceof HTMLIFrameElement) kind = 'iframe'
            if (!kind) return
            const { node } = this._registry.register(element, kind)
            if (kind === 'iframe') this._armIframeNavigationGuard(element)
            touched.add(node)
        }

        if (root.nodeType === Node.ELEMENT_NODE) register(root)
        try {
            root.querySelectorAll?.(MEDIA_SELECTOR).forEach(register)
        } catch (_) { /* Detached roots have no media to register. */ }
        return touched
    }

    _addOwningMedia(element, touched) {
        if (!(element instanceof Element)) return
        const owners = []
        if (element instanceof HTMLVideoElement || element instanceof HTMLImageElement) owners.push(element)
        if (element instanceof HTMLSourceElement) {
            const video = element.closest('video')
            if (video) owners.push(video)
            const picture = element.closest('picture')
            const image = picture?.querySelector('img')
            if (image) owners.push(image)
        }
        if (element instanceof HTMLPictureElement) {
            const image = element.querySelector('img')
            if (image) owners.push(image)
        }
        owners.forEach((owner) => {
            this._registerMedia(owner).forEach(node => touched.add(node))
            const node = this._registry.get(owner)
            if (node) touched.add(node)
        })
    }

    _scanBackgrounds(root, options = {}) {
        const full = options.full === true
        const documentRoot = document.documentElement
        const touched = new Set()
        if (!root || !documentRoot) return { nodes: touched, success: false }
        // Disabled protection must not register or project onto anything.
        if (this.mode === PROTECTION_MODE.DISABLED) return { nodes: touched, success: false }

        if (full) {
            this._setBackgroundPhase('scanning')
            this._registry.all().forEach(node => node.prepareBackgroundScan())
        }

        try {
            const candidates = []
            if (root.nodeType === Node.ELEMENT_NODE) candidates.push(root)
            root.querySelectorAll?.('*').forEach(element => candidates.push(element))
            const backgroundState = new Map()

            candidates.forEach((element) => {
                if (!(element instanceof Element)) return
                if (element.matches('head, script, style, link, meta, title, img, video, iframe')) return
                backgroundState.set(element, getComputedBackgroundImage(element))
            })

            backgroundState.forEach((backgroundImage, element) => {
                const existing = this._registry.get(element)
                if (backgroundImage) {
                    if (existing && existing.kind !== 'background') return
                    const { node } = this._registry.register(element, 'background')
                    node.backgroundImage = backgroundImage
                    markInternalMutationTarget(element)
                    element.setAttribute(BACKGROUND_MARKER_ATTR, '1')
                    touched.add(node)
                } else if (existing?.kind === 'background') {
                    this._registry.remove(element)
                }
            })

            if (full) {
                this._registry.all().forEach((node) => {
                    if (node.kind !== 'background') return
                    if (!backgroundState.get(node.element)) {
                        this._registry.remove(node.element)
                    }
                })
            }

            const nodesToApply = full
                ? this._registry.all().filter(node => node.kind === 'background')
                : [...touched]
            nodesToApply.forEach(node => this._applyResultToNode(node, this._currentVisualResult()))
            if (full) {
                this._stylesheetFingerprint = this._computeStylesheetFingerprint()
                this._backgroundRetries = 0
                this._hasCompletedBackgroundScan = true
                this._setBackgroundPhase('ready')
            }
            return { nodes: touched, success: true }
        } catch (error) {
            this._registry.all().forEach((node) => {
                if (node.kind === 'background') node.blur()
            })
            console.error('PhobiaBlocker: computed background discovery failed; backgrounds remain suppressed', error)

            // A failed full scan leaves the page-wide background-image:none rule
            // in force, so retry a bounded number of times and then accept the
            // page as ready rather than suppressing every background forever.
            if (full && this._backgroundRetries >= MAX_BACKGROUND_SCAN_RETRIES) {
                this._backgroundRetries = 0
                this._setBackgroundPhase('ready')
                return { nodes: touched, success: false }
            }
            this._backgroundRetries++
            this._setBackgroundPhase('pending')
            this._scheduleFullBackgroundRescan()
            return { nodes: touched, success: false }
        }
    }

    _currentVisualResult() {
        if (this.mode === PROTECTION_MODE.ALWAYS_BLUR || this._manualBlurAllActive) {
            return FAIL_CLOSED_RESULT
        }
        return this._pageAnalysisResult
    }

    // resize fires for every frame of a window drag; collapse the burst into
    // one rescan instead of one full getComputedStyle sweep per event.
    _scheduleDebouncedRescan() {
        if (this.mode === PROTECTION_MODE.DISABLED) return
        clearTimeout(this._globalRescanTimer)
        this._globalRescanTimer = setTimeout(() => {
            this._globalRescanTimer = null
            this._scheduleFullBackgroundRescan()
        }, RESIZE_DEBOUNCE_MS)
    }

    _scheduleFullBackgroundRescan() {
        if (this.mode === PROTECTION_MODE.DISABLED) return
        if (this._backgroundTimer !== null || this._backgroundPhase === 'scanning') return
        // Only suppress backgrounds before the first successful scan. Dropping to
        // 'pending' here yields to the event loop with the page-wide
        // background-image:none rule in force, which blanks every background for
        // a frame on each rescan. After one good scan the per-element decisions
        // still hold, so leave them projected until the new scan replaces them.
        if (!this._hasCompletedBackgroundScan) this._setBackgroundPhase('pending')
        this._backgroundTimer = setTimeout(() => {
            this._backgroundTimer = null
            this._scanBackgrounds(document, { full: true })
        }, 0)
    }

    _watchStylesheetLink(element) {
        if (!(element instanceof HTMLLinkElement) || this._backgroundLinks.has(element)) return
        this._backgroundLinks.add(element)
        element.addEventListener('load', () => {
            if (this.mode !== PROTECTION_MODE.DISABLED &&
                String(element.rel || '').toLowerCase().split(/\s+/).includes('stylesheet')) {
                this._scheduleFullBackgroundRescan()
            }
        })
    }

    _mutationTouchesStylesheet(mutation) {
        const target = mutation.target.nodeType === Node.ELEMENT_NODE
            ? mutation.target
            : mutation.target.parentElement
        if (target?.closest?.('style')) return true
        if (mutation.type === 'attributes' && target instanceof HTMLLinkElement) {
            return ['href', 'rel', 'media', 'disabled'].includes(mutation.attributeName)
        }
        if (mutation.type === 'attributes' && target instanceof HTMLStyleElement) {
            return ['media', 'disabled'].includes(mutation.attributeName)
        }
        if (mutation.type !== 'childList') return false
        return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
            const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
            if (!element) return false
            if (element.tagName === 'STYLE') return true
            if (element.tagName === 'LINK' && String(element.rel || '').toLowerCase() === 'stylesheet') return true
            return Boolean(element.querySelector?.('style, link[rel~="stylesheet"]'))
        })
    }

    _computeStylesheetFingerprint() {
        let hash = 2166136261
        let itemCount = 0
        const seen = new Set()
        const update = (value) => {
            const text = String(value ?? '')
            itemCount++
            for (let index = 0; index < text.length; index++) {
                hash ^= text.charCodeAt(index)
                hash = Math.imul(hash, 16777619)
            }
        }
        const stylesheets = [
            ...Array.from(document.styleSheets || []),
            ...Array.from(document.adoptedStyleSheets || []),
        ]

        // Deliberately cheap: identity, enabled state, media match and rule
        // count per sheet. That still detects sheets being added, removed,
        // toggled, media-flipped, or edited through insertRule/deleteRule,
        // without hashing every rule's cssText on every poll. Viewport size is
        // excluded because the debounced resize listener already rescans.
        stylesheets.forEach((sheet) => {
            if (!sheet || seen.has(sheet)) return
            seen.add(sheet)
            update(sheet.href)
            update(sheet.disabled)
            update(sheet.media?.mediaText)
            if (sheet.media?.mediaText) {
                try { update(matchMedia(sheet.media.mediaText).matches) } catch (_) { update('invalid-media') }
            }
            try {
                update(sheet.cssRules ? sheet.cssRules.length : 0)
            } catch (_) {
                update('inaccessible')
            }
        })
        return `${itemCount}:${hash >>> 0}`
    }

    _startStylesheetPolling() {
        clearInterval(this._stylesheetPollTimer)
        this._stylesheetFingerprint = this._computeStylesheetFingerprint()
        this._stylesheetPollTimer = setInterval(() => {
            if (this.mode === PROTECTION_MODE.DISABLED) return
            const next = this._computeStylesheetFingerprint()
            if (next === this._stylesheetFingerprint) return
            this._stylesheetFingerprint = next
            this._scheduleFullBackgroundRescan()
        }, STYLESHEET_POLL_INTERVAL_MS)
    }

    _attachMediaResourceListeners() {
        if (this._mediaEventListenersAttached) return
        this._mediaEventListenersAttached = true
        MEDIA_RESOURCE_EVENTS.forEach((type) => {
            document.addEventListener(type, this._onMediaResourceEvent, true)
        })
        window.addEventListener('resize', this._onGlobalBackgroundStateEvent)
        window.addEventListener('hashchange', this._onGlobalBackgroundStateEvent)
    }

    _detachMediaResourceListeners() {
        if (!this._mediaEventListenersAttached) return
        this._mediaEventListenersAttached = false
        MEDIA_RESOURCE_EVENTS.forEach((type) => {
            document.removeEventListener(type, this._onMediaResourceEvent, true)
        })
        window.removeEventListener('resize', this._onGlobalBackgroundStateEvent)
        window.removeEventListener('hashchange', this._onGlobalBackgroundStateEvent)
    }

    _attachIframeLifecycleListener() {
        if (this._iframeLifecycleListenerAttached) return
        this._iframeLifecycleListenerAttached = true
        document.addEventListener('load', this._onIframeLifecycleLoad, true)
    }

    _removeIframeNavigationGuardListeners(guard, types = IFRAME_GUARD_EVENTS) {
        if (!guard) return
        const eventWindow = guard.eventWindow || guard.frameWindow
        types.forEach((type) => {
            try {
                eventWindow.removeEventListener(type, guard.listener, true)
            } catch (_) { /* A completed cross-origin navigation owns the old window now. */ }
        })
    }

    _disarmIframeNavigationGuard(element, targetGuard = null) {
        const state = this._iframeNavigationGuards.get(element)
        if (!state) return
        if (targetGuard && state.active !== targetGuard && !state.suspended.includes(targetGuard)) return

        const guards = targetGuard
            ? [targetGuard]
            : [...new Set([state.active, ...state.suspended].filter(Boolean))]
        guards.forEach((guard) => {
            this._removeIframeNavigationGuardListeners(guard)
            if (state.active === guard) state.active = null
            state.suspended = state.suspended.filter(candidate => candidate !== guard)
        })
        if (!state.active && state.suspended.length === 0) {
            this._iframeNavigationGuards.delete(element)
        }
    }

    _addIframeNavigationGuardListeners(guard) {
        try {
            IFRAME_GUARD_EVENTS.forEach((type) => {
                guard.frameWindow.addEventListener(type, guard.listener, true)
            })
            return true
        } catch (_) {
            this._removeIframeNavigationGuardListeners(guard)
            return false
        }
    }

    _armIframeNavigationGuard(element) {
        let frameWindow = null
        let frameDocument = null
        try {
            if (!(element instanceof HTMLIFrameElement) || element.isConnected === false ||
                element.hasAttribute('sandbox')) {
                this._disarmIframeNavigationGuard(element)
                return
            }
            frameWindow = element.contentWindow
            frameDocument = element.contentDocument
            if (!frameWindow || !frameDocument || frameDocument.readyState !== 'complete') {
                const state = this._iframeNavigationGuards.get(element)
                if (state?.active && state.active.frameDocument !== frameDocument) {
                    this._disarmIframeNavigationGuard(element, state.active)
                }
                return
            }
            if (typeof frameWindow.location.href !== 'string') throw new Error('Inaccessible iframe location')
        } catch (_) {
            const state = this._iframeNavigationGuards.get(element)
            if (state?.active) this._disarmIframeNavigationGuard(element, state.active)
            return
        }

        let state = this._iframeNavigationGuards.get(element)
        if (state?.active?.frameDocument === frameDocument) return
        if (state?.active) this._disarmIframeNavigationGuard(element, state.active)

        state = this._iframeNavigationGuards.get(element) || { active: null, suspended: [] }
        const restoredGuard = state.suspended.find(guard => guard.frameDocument === frameDocument)
        if (restoredGuard) {
            state.suspended = state.suspended.filter(guard => guard !== restoredGuard)
            state.active = restoredGuard
            restoredGuard.frameWindow = frameWindow
            this._iframeNavigationGuards.set(element, state)
            if (!this._addIframeNavigationGuardListeners(restoredGuard)) {
                this._disarmIframeNavigationGuard(element, restoredGuard)
            }
            return
        }

        const guard = { frameWindow, frameDocument, eventWindow: null, listener: null }
        guard.listener = (event) => {
            if (event.type === IFRAME_RESTORATION_EVENT) {
                this._handleIframeRestoration(element, event, guard)
            } else {
                this._handleIframeNavigationStart(element, event, guard)
            }
        }
        state.active = guard
        this._iframeNavigationGuards.set(element, state)
        if (!this._addIframeNavigationGuardListeners(guard)) {
            this._disarmIframeNavigationGuard(element, guard)
        }
    }

    _handleIframeNavigationStart(element, event, guard) {
        const state = this._iframeNavigationGuards.get(element)
        if (!state || state.active !== guard || !event?.isTrusted ||
            !IFRAME_NAVIGATION_START_EVENTS.includes(event.type)) return

        guard.eventWindow = event.currentTarget || guard.eventWindow
        this._markIframeNavigationPending(element)
        if (this.mode !== PROTECTION_MODE.DISABLED) {
            const node = this._registry.get(element)
            if (node) node.blur()
        }

        if (event.type === 'pagehide' && event.persisted === true) {
            this._removeIframeNavigationGuardListeners(guard, IFRAME_NAVIGATION_START_EVENTS)
            state.active = null
            state.suspended = state.suspended.filter(candidate => candidate !== guard)
            state.suspended.push(guard)
            while (state.suspended.length > MAX_SUSPENDED_IFRAME_GUARDS) {
                this._removeIframeNavigationGuardListeners(state.suspended.shift())
            }
            return
        }
        this._disarmIframeNavigationGuard(element, guard)
    }

    _handleIframeRestoration(element, event, guard) {
        const state = this._iframeNavigationGuards.get(element)
        if (!state || !state.suspended.includes(guard) || !event?.isTrusted ||
            event.type !== IFRAME_RESTORATION_EVENT || event.persisted !== true) return

        guard.eventWindow = event.currentTarget || guard.eventWindow
        try {
            if (element.isConnected === false || element.hasAttribute('sandbox') ||
                element.contentDocument !== guard.frameDocument ||
                element.contentWindow !== guard.frameWindow ||
                guard.frameDocument.readyState !== 'complete' ||
                typeof guard.frameWindow.location.href !== 'string') return
        } catch (_) {
            return
        }

        const node = this.mode === PROTECTION_MODE.DISABLED ? null : this._registry.get(element)
        if (node) node.blur()
        this._armIframeNavigationGuard(element)
        const currentState = this._iframeNavigationGuards.get(element)
        if (currentState?.active !== guard) return
        this._markIframeNavigationComplete(element)
        if (node) this._applyResultToNode(node, this._currentVisualResult())
    }

    // One passive pointer listener drives every preview. elementsFromPoint
    // returns the whole stack under the cursor, so media sitting beneath an
    // overlay (posters and thumbnails on most media sites) is still found.
    _startHoverTracking() {
        if (this._hoverListenerAttached) return
        this._hoverListenerAttached = true
        this._onPointerMove = (event) => {
            this._hoverPoint = { x: event.clientX, y: event.clientY }
            this._scheduleHoverPreviewUpdate()
        }
        // pointerleave does not bubble, but a capture listener on document still
        // receives it for every descendant the pointer exits. Only treat it as
        // the pointer leaving the page, otherwise moving within a card cancels
        // the preview that the same movement just started.
        this._onPointerGone = (event) => {
            if (event.type === 'pointerleave' &&
                event.target !== document && event.target !== document.documentElement) return
            this._hoverPoint = null
            this._clearHoverPreview()
        }
        document.addEventListener('pointermove', this._onPointerMove, { capture: true, passive: true })
        document.addEventListener('pointerleave', this._onPointerGone, { capture: true, passive: true })
        document.addEventListener('pointercancel', this._onPointerGone, { capture: true, passive: true })
    }

    // Runs on the pointer event itself. Deferring to requestAnimationFrame tied
    // the preview to frames being produced, which never happens in a background
    // tab and proved unreliable even in a foreground one. A leading call keeps
    // it responsive and a trailing one guarantees the final pointer position is
    // always processed, so the preview cannot be left stale between ticks.
    _scheduleHoverPreviewUpdate() {
        if (!this._hoverPoint) return

        clearTimeout(this._hoverTrailingTimer)
        this._hoverTrailingTimer = setTimeout(() => {
            this._hoverTrailingTimer = null
            this._updateHoverPreview()
        }, HOVER_HIT_TEST_INTERVAL_MS)

        const now = performance.now()
        if (now - this._lastHoverUpdateAt < HOVER_HIT_TEST_INTERVAL_MS) return
        this._lastHoverUpdateAt = now
        this._updateHoverPreview()
    }

    _canRenderPreview(node) {
        if (node.kind !== 'video') return true
        const video = node.element
        if (!(video instanceof HTMLVideoElement)) return false
        // YouTube and similar sites insert an empty hover-video layer before it
        // has a frame. Preview the loaded thumbnail underneath until either a
        // poster or current video data can actually be painted.
        return Boolean(video.poster) || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    }

    _updateHoverPreview() {
        if (this.mode === PROTECTION_MODE.DISABLED || this.settings.previewEnabled !== true) {
            this._clearHoverPreview()
            return
        }
        const point = this._hoverPoint
        if (!point) return

        let found = null
        let backgroundFallback = null
        try {
            for (const element of document.elementsFromPoint(point.x, point.y)) {
                const node = this._registry.get(element)
                if (!node || !node.isBlurred || !this._canRenderPreview(node)) continue
                // Prefer real media over a decorative background. Sites stack
                // gradient overlays above posters and thumbnails, and previewing
                // the overlay instead of the image underneath is never useful.
                if (node.kind !== 'background') {
                    found = node
                    break
                }
                if (!backgroundFallback) backgroundFallback = node
            }
        } catch (_) { /* An unusable hit test simply means no preview. */ }
        if (!found) found = backgroundFallback

        if (found === this._hoverNode) return
        if (this._hoverNode) this._hoverNode.hidePreview()
        this._hoverNode = found
        if (found) found.showPreview()
    }

    _clearHoverPreview() {
        if (!this._hoverNode) return
        this._hoverNode.hidePreview()
        this._hoverNode = null
    }

    _startIframeLifecycleTracking() {
        this._attachIframeLifecycleListener()
        if (this._iframeLifecycleObserver) return
        this._iframeLifecycleObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.removedNodes.forEach(node => this._disarmDetachedIframeGuards(node))
                    return
                }
                if (mutation.target instanceof HTMLIFrameElement) {
                    this._markIframeNavigationPending(mutation.target)
                    if (mutation.attributeName === 'sandbox' && mutation.target.hasAttribute('sandbox')) {
                        this._disarmIframeNavigationGuard(mutation.target)
                    }
                }
            })
        })
        this._iframeLifecycleObserver.observe(document, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: IFRAME_NAVIGATION_ATTRIBUTES,
        })
    }

    _handleIframeLifecycleLoad(event) {
        const element = event?.target
        if (!(element instanceof HTMLIFrameElement) || !event.isTrusted) return

        const node = this.mode === PROTECTION_MODE.DISABLED ? null : this._registry.get(element)
        if (node) node.blur()
        this._markIframeNavigationComplete(element)
        this._armIframeNavigationGuard(element)
        if (node) this._applyResultToNode(node, this._currentVisualResult())
    }

    _handleMediaResourceEvent(event) {
        const element = event?.target
        if (!(element instanceof HTMLImageElement) && !(element instanceof HTMLVideoElement)) return
        const node = this._registry.get(element)
        if (!node) return
        if (element instanceof HTMLVideoElement) this._scheduleHoverPreviewUpdate()
        if (!this._explicitReveals.has(element)) return
        if (this.isExplicitlyRevealed(element)) return
        node.blur()
        this._applyResultToNode(node, this._currentVisualResult())
    }

    _observerInit() {
        if (this._observer) this._observer.disconnect()
        this._observer = new MutationObserver((mutations) => this._handleMutations(mutations))
        this._observer.observe(document, {
            childList: true,
            characterData: true,
            subtree: true,
            attributes: true,
            attributeOldValue: true,
            attributeFilter: OBSERVED_ATTRIBUTES,
        })
    }

    _handleMutations(mutations) {
        const records = mutations.filter((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'style' &&
                mutation.target instanceof Element) {
                if (this.mode === PROTECTION_MODE.DISABLED &&
                    this._disabledStyleMutationIsExternal(mutation.target, mutation.oldValue)) return true
                const visual = this._registry.get(mutation.target)
                if (visual?.captureStyleMutation(mutation.oldValue)) return true
            }
            return !isInternalMutation(mutation)
        })
        if (records.length === 0) return
        if (this.mode === PROTECTION_MODE.DISABLED) {
            this._handleDisabledMutations(records)
            return
        }
        ANALYSIS_DEBUG_STATE.mutationBatches++

        const touched = new Set()
        let stylesheetChanged = false

        records.forEach((mutation) => {
            stylesheetChanged = this._mutationTouchesStylesheet(mutation) || stylesheetChanged

            if (mutation.type === 'childList') {
                this._addOwningMedia(mutation.target, touched)
                mutation.addedNodes.forEach((node) => {
                    this._restoreDisabledMedia(node)
                    this._registerMedia(node).forEach(visual => touched.add(visual))
                    this._scanBackgrounds(node).nodes.forEach(visual => touched.add(visual))
                    const element = node.nodeType === Node.ELEMENT_NODE ? node : null
                    if (element) {
                        this._watchStylesheetLink(element)
                        element.querySelectorAll?.('link').forEach(link => this._watchStylesheetLink(link))
                        this._addOwningMedia(element, touched)
                    }
                })
                return
            }

            if (mutation.type !== 'attributes') return
            const element = mutation.target
            if (!(element instanceof Element)) return
            if (element === document.documentElement) this._syncRootProjection()
            this._wordCoverManager.repairProjection(element)
            if (element instanceof HTMLLinkElement) this._watchStylesheetLink(element)

            this._registerMedia(element).forEach(visual => touched.add(visual))
            this._addOwningMedia(element, touched)
            if (mutation.attributeName === 'class' || mutation.attributeName === 'style') {
                if (element === document.documentElement || element === document.body) {
                    this._scheduleFullBackgroundRescan()
                } else {
                    this._scanBackgrounds(element).nodes.forEach(visual => touched.add(visual))
                }
            }
            const visual = this._registry.get(element)
            if (visual) {
                // Only class and style can disturb the projection, so only those
                // force a rewrite. Invalidating on every observed attribute
                // (src, poster, rel, ...) rewrote nodes that were already correct.
                if (mutation.attributeName === 'class' || mutation.attributeName === 'style') {
                    visual.invalidateRendering()
                }
                touched.add(visual)
            }
        })

        this._registry.prune()
        this._scheduleHoverPreviewUpdate()

        const textResult = this._pageTextIndex.applyMutations(records)
        const newWordsAppeared = textResult.added instanceof Set && textResult.added.size > 0

        if (stylesheetChanged) {
            this._scheduleFullBackgroundRescan()
        }

        if (this.mode === PROTECTION_MODE.ALWAYS_BLUR || this._manualBlurAllActive) {
            touched.forEach(node => this._applyResultToNode(node, FAIL_CLOSED_RESULT))
            return
        }

        // Only vocabulary that is new to the page can flip the verdict, so a
        // re-index that yielded the same words needs no analysis and no
        // re-blur. When new words do appear we stay fail-closed until the
        // analysis returns.
        if (newWordsAppeared) {
            this.protectAllKnownVisuals()
            this._scheduleAnalysis()
            return
        }

        touched.forEach(node => this._applyResultToNode(node, this._pageAnalysisResult))
    }

    _scheduleAnalysis() {
        clearTimeout(this._analysisTimer)
        const generation = ++this._policyGeneration
        this._analysisTimer = setTimeout(async () => {
            this._analysisTimer = null
            const result = await this.analyzeCurrentPage(generation)
            if (generation !== this._policyGeneration || this.mode !== PROTECTION_MODE.ANALYZE) return
            this.applyPageResult(result)
        }, ANALYSIS_DEBOUNCE_MS)
    }

    _ensureFrameMarker() {
        const root = document.documentElement
        if (!root) return
        let topFrame = false
        try { topFrame = window.top === window } catch (_) { /* Treat inaccessible parents as subframes. */ }
        markInternalMutationTarget(root)
        root.setAttribute('data-phobiablocker-frame', topFrame ? 'top' : 'sub')
    }

    _releaseEarlyWordCover() {
        if (this._earlyCoverReleased) return
        this._earlyCoverReleased = true
        try {
            window.dispatchEvent(new Event('phobiablocker:word-cover-manager-ready'))
        } catch (_) { /* Early covering remains fail-closed if handoff signaling fails. */ }
    }
}

const controller = new Controller()
let settingsReadGeneration = 0

function conservativeSettings() {
    return {
        ...controller._cloneDefaults(),
        targetWords: [],
        phobiaBlockerEnabled: true,
        blurIsAlwaysOn: true,
    }
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

// A settings read that never settles used to leave the page fail-closed
// forever: every image blurred and, before the CSS fix, unclickable. Bound each
// attempt so the fail-closed path is always reached instead of hanging.
async function readSettingsWithRetry() {
    let lastError = null
    for (let attempt = 1; attempt <= SETTINGS_READ_ATTEMPTS; attempt++) {
        try {
            return await withTimeout(
                Storage.getWithDefaults(Object.keys(DEFAULTS)),
                SETTINGS_READ_TIMEOUT_MS,
                'Settings read'
            )
        } catch (error) {
            lastError = error
            console.warn(`PhobiaBlocker: settings read attempt ${attempt} failed`, error)
        }
    }
    throw lastError || new Error('Settings read failed')
}

async function readAndApplySettings() {
    const readGeneration = ++settingsReadGeneration
    try {
        const settings = await readSettingsWithRetry()
        if (readGeneration !== settingsReadGeneration) return
        const mode = Policy.resolveProtectionMode(settings, location.href)
        await controller.applyProtectionMode(mode, settings)
    } catch (error) {
        if (readGeneration !== settingsReadGeneration) return
        console.error('PhobiaBlocker: settings read failed; applying fail-closed mode', error)
        await controller.applyProtectionMode(PROTECTION_MODE.ALWAYS_BLUR, conservativeSettings())
    }
}

function contextPointInside(element, point) {
    if (!point || typeof point.clientX !== 'number' || typeof point.clientY !== 'number') return false
    try {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 &&
            point.clientX >= rect.left && point.clientX <= rect.right &&
            point.clientY >= rect.top && point.clientY <= rect.bottom
    } catch (_) {
        return false
    }
}

function elementArea(element) {
    try {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 ? rect.width * rect.height : Number.MAX_SAFE_INTEGER
    } catch (_) {
        return Number.MAX_SAFE_INTEGER
    }
}

function resolveContextVisual() {
    const pointCandidates = controller.getVisualNodes()
        .filter(node => contextPointInside(node.element, lastContextMenuPoint))
        .sort((a, b) => elementArea(a.element) - elementArea(b.element))
    if (pointCandidates.length > 0) return pointCandidates[0]

    let current = lastElementContext && lastElementContext.nodeType === Node.ELEMENT_NODE
        ? lastElementContext
        : lastElementContext?.parentElement
    while (current && current !== document.documentElement) {
        const node = controller.getVisualNode(current)
        if (node) return node
        current = current.parentElement
    }
    return null
}

document.addEventListener('contextmenu', (event) => {
    lastElementContext = event.target
    lastContextMenuPoint = { clientX: event.clientX, clientY: event.clientY }
}, true)

document.addEventListener('keydown', (event) => {
    if (!event || event.defaultPrevented || event.repeat) return
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return
    if (event.code !== 'KeyW' && String(event.key || '').toLowerCase() !== 'w') return
    const element = event.target?.nodeType === Node.ELEMENT_NODE ? event.target : event.target?.parentElement
    if (element?.matches?.('input, textarea, select, [contenteditable="true"]')) return
    event.preventDefault()
    try {
        chrome.runtime.sendMessage({ target: 'background', type: 'toggleWordCover', source: 'keyboard' })
    } catch (_) { /* The background listener will report a disconnected runtime. */ }
}, true)

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    if (!Object.keys(changes).some(key => POLICY_STORAGE_KEYS.has(key))) return
    void readAndApplySettings()
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || (message.target && message.target !== 'content')) return false

    switch (message.type) {
    case 'getAnalysisDebugState':
        if (!isTopFrameContext()) return false
        sendResponse({
            ...ANALYSIS_DEBUG_STATE,
            mediaCount: controller.getVisualNodes().length,
            pageWordCount: controller._pageTextIndex.getWords().length,
            policyGeneration: controller._policyGeneration,
            protectionMode: controller.mode,
        })
        return true

    case 'getTriggeredWords': {
        if (!isTopFrameContext()) return false
        const result = controller._pageAnalysisResult
        const hidden = controller.mode === PROTECTION_MODE.DISABLED || !result.shouldBlur
        // matchedInputWords are the words as they actually appear on the page,
        // so they can be counted against the token index. matchedWords are
        // NLP-normalised forms and only serve as a display fallback.
        const source = result.matchedInputWords.length > 0
            ? result.matchedInputWords
            : result.matchedWords
        const words = hidden ? [] : [...new Set(source)].map(word => ({
            word,
            count: controller._pageTextIndex.getTokenCount(word) || 1,
        }))
        sendResponse({ words: words.sort((a, b) => a.word.localeCompare(b.word)) })
        return true
    }

    case 'blurAll':
        controller.blurAll()
        sendResponse({ ok: true })
        return true

    case 'unblurAll':
        controller.unblurAll()
        sendResponse({ ok: true })
        return true

    case 'unblur': {
        let unblurred = controller._wordCoverManager.revealContextWord(lastElementContext)
        if (!unblurred) {
            const node = resolveContextVisual()
            unblurred = Boolean(node && controller.rememberExplicitReveal(node.element))
        }
        lastElementContext = null
        lastContextMenuPoint = null
        sendResponse({ ok: true, unblurred })
        return true
    }

    default:
        return false
    }
})

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void readAndApplySettings(), { once: true })
} else {
    void readAndApplySettings()
}
