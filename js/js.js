'use strict'

const Policy = globalThis.PhobiaBlockerPolicy
const Storage = globalThis.PhobiaBlockerStorage
const PageTextIndex = globalThis.PhobiaBlockerPageTextIndex

if (!Policy || !Storage || !PageTextIndex) {
    throw new Error('PhobiaBlocker: required shared modules are unavailable')
}

const {
    DEFAULTS, PROTECTION_MODE, STORAGE_KEYS, FAIL_CLOSED_RESULT, FRAME_MESSAGES, CSS_VARS, ROOT_ATTRS,
    computeBlurPixels, isTopFrameContext, withTimeout,
} = Policy
const ANALYZE_TIMEOUT_MS = 3000
const MEDIA_SELECTOR = 'img, video, iframe'
const BACKGROUND_READY_ATTR = ROOT_ATTRS.backgroundReady
const BACKGROUND_SCANNING_ATTR = ROOT_ATTRS.backgroundScanning
const BACKGROUND_MARKER_ATTR = 'data-phobiablocker-background'
const ROOT_BACKGROUND_MARKER_ATTR = 'data-phobiablocker-root-background'
const MEDIA_MARKER_ATTR = 'data-phobiablocker-media'
const POLICY_STORAGE_KEYS = new Set(Object.values(STORAGE_KEYS))
// Popup accordion state never affects a page.
const UI_ONLY_STORAGE_KEYS = new Set([STORAGE_KEYS.detectedWordsCollapsed, STORAGE_KEYS.supportedWordsCollapsed])
// Keys that only change how media is rendered, never whether it is blurred.
const VISUAL_STORAGE_KEYS = new Set([
    STORAGE_KEYS.blurAmount, STORAGE_KEYS.previewEnabled, STORAGE_KEYS.previewStrength, STORAGE_KEYS.debugMode,
])
const INTERNAL_ATTRIBUTE_STATE = new WeakMap()
// The only observed attributes this script writes itself.
const INTERNAL_SNAPSHOT_ATTRIBUTES = Object.freeze(['class', 'style', BACKGROUND_READY_ATTR, BACKGROUND_SCANNING_ATTR])
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
// Stylesheet edits arrive in bursts (CSS-in-JS inserts one <style> per
// component). Rebuild the visible-text index once per burst, off the observer.
const STYLESHEET_REINDEX_DEBOUNCE_MS = 200
const SETTINGS_READ_TIMEOUT_MS = 3000
const SETTINGS_READ_ATTEMPTS = 3
const MAX_BACKGROUND_SCAN_RETRIES = 3
// Throttle for the pointer hit test that drives hover previews.
const HOVER_HIT_TEST_INTERVAL_MS = 30
// How many times a "nothing found" verdict may be postponed while the page is
// still producing text, before it is accepted anyway.
const MAX_DEFERRED_CLEAR_VERDICTS = 4
const MEDIA_RESOURCE_EVENTS = Object.freeze(['load', 'loadstart', 'loadedmetadata', 'loadeddata', 'emptied'])
const IFRAME_NAVIGATION_ATTRIBUTES = Object.freeze(['src', 'srcdoc', 'sandbox'])
const IFRAME_NAVIGATION_START_EVENTS = Object.freeze(['pagehide', 'unload'])
const IFRAME_RESTORATION_EVENT = 'pageshow'
const IFRAME_GUARD_EVENTS = Object.freeze([...IFRAME_NAVIGATION_START_EVENTS, IFRAME_RESTORATION_EVENT])
const MAX_SUSPENDED_IFRAME_GUARDS = 2
const FRAME_OWNER_SELECTOR = 'iframe'
const UNSUPPORTED_FRAME_OWNER_SELECTOR = 'frame, object, embed, fencedframe'
const TRACKED_FRAME_OWNER_SELECTOR = `${FRAME_OWNER_SELECTOR}, ${UNSUPPORTED_FRAME_OWNER_SELECTOR}`
// Coalesce the aggregate requests from a burst of invalidations into one.
const FRAME_AGGREGATE_REFRESH_DEBOUNCE_MS = 100
// Bounded retries cover a transient failure; afterwards the next invalidation
// (a navigation, a child status change, a topology change) asks again.
const FRAME_AGGREGATE_MAX_RETRIES = 3
const FRAME_AGGREGATE_INITIAL_RETRY_MS = 1000
const ANALYSIS_DEBUG_STATE = {
    pageAnalysisRequests: 0,
    mutationBatches: 0,
    directWordCovers: 0,
}
// Detached style declarations reused to parse inline style text without
// creating an element per mutation.
const SIGNATURE_STYLE_PROBE = document.createElement('span').style
const PREVIOUS_STYLE_PROBE = document.createElement('span').style

let lastElementContext = null
let lastContextMenuPoint = null
let iconStatusTimer = null
let internalMutationTargets = null

// Records the attribute values this script writes so the observer can tell
// its own mutations from the page's. One microtask snapshots every node
// touched in the current task and one timer releases them on the next.
function markInternalMutationTarget(node) {
    if (!(node instanceof Element)) return
    if (internalMutationTargets) {
        internalMutationTargets.add(node)
        return
    }
    internalMutationTargets = new Set([node])
    queueMicrotask(() => {
        const nodes = internalMutationTargets
        internalMutationTargets = null
        nodes.forEach((target) => {
            const snapshot = {}
            INTERNAL_SNAPSHOT_ATTRIBUTES.forEach((name) => {
                snapshot[name] = target.getAttribute(name)
            })
            INTERNAL_ATTRIBUTE_STATE.set(target, snapshot)
        })
        setTimeout(() => nodes.forEach(target => INTERNAL_ATTRIBUTE_STATE.delete(target)), 0)
    })
}

function isInternalMutation(mutation) {
    if (!mutation || !mutation.target) return true
    if (mutation.type !== 'attributes' || !(mutation.target instanceof Element)) return false
    const snapshot = INTERNAL_ATTRIBUTE_STATE.get(mutation.target)
    if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, mutation.attributeName)) return false
    return snapshot[mutation.attributeName] === mutation.target.getAttribute(mutation.attributeName)
}

// Fire-and-forget delivery to the service worker. A disconnected runtime
// leaves whatever is currently projected in force.
function sendToBackground(message) {
    try {
        const result = chrome.runtime.sendMessage({ target: 'background', ...message })
        if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch (_) { /* See above. */ }
}

function reportIconStatus(status) {
    if (!isTopFrameContext()) return
    clearTimeout(iconStatusTimer)

    const send = () => sendToBackground({ type: 'iconStatus', status })
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
    setRootCssVar(CSS_VARS.blurNs, value)
    setRootCssVar(CSS_VARS.blurLegacy, value)
}

function setPreviewBlurCssValue(value) {
    setRootCssVar(CSS_VARS.previewNs, value)
    setRootCssVar(CSS_VARS.previewLegacy, value)
}

function getUnownedStyleSignature(styleText, projectedProperties) {
    const probe = SIGNATURE_STYLE_PROBE
    probe.cssText = styleText || ''
    projectedProperties.forEach(name => probe.removeProperty(name))
    Object.values(CSS_VARS).forEach(name => probe.removeProperty(name))
    return probe.cssText
}

// The one place a verdict enters this script; everything downstream can
// trust its shape.
async function analyzePageWordsWithOffscreen(words) {
    ANALYSIS_DEBUG_STATE.pageAnalysisRequests++
    try {
        const response = await withTimeout(chrome.runtime.sendMessage({
            target: 'background',
            type: 'PB_ANALYZE_WORDS',
            words: Array.isArray(words) ? words : [],
        }), ANALYZE_TIMEOUT_MS, 'Analysis')
        return Policy.normalizeAnalysisResult(response) || { ...FAIL_CLOSED_RESULT }
    } catch (error) {
        console.error('PhobiaBlocker: page analysis failed; keeping media blurred', error)
        return { ...FAIL_CLOSED_RESULT }
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

function isCrossOriginIframe(iframe, navigationComplete = false) {
    try {
        if (!(iframe instanceof HTMLIFrameElement)) return true
        if (iframe.hasAttribute('sandbox')) return true

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
        if (!this._stylePropertyMatches(current, projection)) {
            markInternalMutationTarget(this.element)
            this.element.style.setProperty(name, value, priority)
        }
        // CSSOM can round numbers or otherwise serialize a different string.
        // Track what was applied so it is not mistaken for a later page edit.
        this._styleProjections.set(name, this._readStyleProperty(this.element.style, name))
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

    captureStyleMutation(oldStyleText) {
        const previous = PREVIOUS_STYLE_PROBE
        previous.cssText = oldStyleText || ''
        const projectedProperties = ['filter', 'background-image']
        let pageChanged = getUnownedStyleSignature(oldStyleText, projectedProperties) !==
            getUnownedStyleSignature(this.element.getAttribute('style'), projectedProperties)

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
        this.invalidateRendering()
    }

    // Forces the next blur/unblur to rewrite the DOM. Called when the page
    // itself touched our element, so a repair still happens even though the
    // requested state has not changed.
    invalidateRendering() {
        this._renderState = null
    }

    blur() {
        if (!this.element || this.element.isConnected === false) return
        this.isBlurred = true
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
            this._previewActive = false
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
            this._previewActive = false
            return
        }
        this._setStyleProjection('filter', 'none', 'important')
        this._previewActive = false
    }

    clearRendering() {
        if (!this.element) return
        this._renderState = null
        markInternalMutationTarget(this.element)
        this._previewActive = false
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
        if (this.isRootBackground || this._previewActive || !this.isBlurred || !this.element) return
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

    // Pushes the controller's current blur strength to a node that is already
    // blurred. blur() skips the rewrite when the render state is unchanged, so
    // without this a blurValueAmount change reached the element only once a
    // hover cycle or a page-side style mutation happened to rewrite the filter.
    refreshBlurFilter() {
        if (!this.element || this.element.isConnected === false) return
        if (this._renderState !== 'blur' || this.isRootBackground) return
        if (this._previewActive) {
            this._applyPreviewFilter()
            return
        }
        this._setStyleProjection('filter', this.controller.blurFilter, 'important')
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

    get size() {
        return this._nodes.size
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

    get ownedCount() {
        return this._ownedWrappers.size
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
        const revealed = this._revealedWrappers.has(element)
        element.classList.toggle('phobia-word-cover', !revealed)
        element.classList.toggle('phobia-word-permanent-uncover', revealed)
        return true
    }

    coverTextNode(textNode, directMatches) {
        if (!this._active || !textNode || !textNode.parentNode) return false
        const parentElement = textNode.parentElement
        if (!parentElement || parentElement.closest?.(PageTextIndex.EXCLUDED_SELECTOR)) return false
        if (this._findOwnedWrapper(parentElement)) return false

        const matchesToCover = directMatches instanceof Set ? directMatches : this._targets
        const split = PageTextIndex.splitTextNodeByWords(textNode, word => (
            matchesToCover.has(word) && this._targets.has(word)
        ))
        if (!split) return false

        split.covers.forEach((cover) => {
            this._ownedWrappers.add(cover)
            markInternalMutationTarget(cover)
        })
        if (this._pageTextIndex) this._pageTextIndex.removeTextNode(textNode)
        markInternalMutationTarget(parentElement)
        parentElement.replaceChild(split.fragment, textNode)
        // Re-index the pieces without notifying, or covering would recurse.
        split.plainTextNodes.forEach((node) => {
            this._pageTextIndex?.indexTextNode(node, { notify: false })
        })
        split.covers.forEach((cover) => {
            this._pageTextIndex?.indexTextNode(cover.firstChild, { notify: false })
        })
        ANALYSIS_DEBUG_STATE.directWordCovers += split.covers.length
        return true
    }

    revealContextWord(target) {
        const element = target && target.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement
        const cover = this._findOwnedWrapper(element)
        if (!cover) return false
        this._revealedWrappers.add(cover)
        this.repairProjection(cover)
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

    reconcileCover(wrapper) {
        this._unwrap(wrapper, { notify: true })
    }

    prune() {
        Array.from(this._ownedWrappers).forEach((wrapper) => {
            if (wrapper.isConnected === false) this._unwrap(wrapper)
        })
    }

    _unwrap(wrapper, { notify = false } = {}) {
        if (!this._ownedWrappers.has(wrapper)) return
        this._ownedWrappers.delete(wrapper)
        this._revealedWrappers.delete(wrapper)
        const textNodes = PageTextIndex.collectTextNodes(wrapper)
        textNodes.forEach(node => this._pageTextIndex?.removeTextNode(node))
        // A removed cover can itself be reinserted later. Leave no stale cover
        // projection on that now-unowned element, even when it has no parent.
        markInternalMutationTarget(wrapper)
        wrapper.classList.remove('phobia-word-cover', 'phobia-word-permanent-uncover')
        wrapper.style.removeProperty('--phobiablocker-word-cover-color')
        wrapper.removeAttribute('title')
        wrapper.removeAttribute('aria-label')
        const parent = wrapper.parentNode
        if (!parent) return
        markInternalMutationTarget(parent)
        PageTextIndex.unwrapWordCover(wrapper)
        textNodes.forEach(node => this._pageTextIndex?.indexTextNode(node, { notify }))
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
        this._frameAggregateClear = false
        this._frameAggregateEpoch = 0
        this._frameAggregateRefreshTimer = null
        this._frameAggregateRetryAttempt = 0
        this._analysisPending = true
        this._lastFrameStatusSignature = ''
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
        this._iframeLifecycleObserver = null
        this._onMediaResourceEvent = event => this._handleMediaResourceEvent(event)
        this._onIframeLifecycleLoad = event => this._handleIframeLifecycleLoad(event)
        this._globalRescanTimer = null
        this._onGlobalBackgroundStateEvent = () => {
            this._scheduleDebouncedRescan()
            this._scheduleHoverPreviewUpdate()
        }
        this._earlyCoverReleased = false
        this._stylesheetReindexTimer = null
        // True once applyProtectionMode has run; settings shortcuts that only
        // re-style the page must not pre-empt that first application.
        this.protectionApplied = false
        this._wordCoverManager = new WordCoverManager()
        this._pageTextIndex = new PageTextIndex({
            onDirectMatch: (node, matches) => this._wordCoverManager.coverTextNode(node, matches),
            onOwnedCoverChange: wrapper => this._wordCoverManager.reconcileCover(wrapper),
            isOwnedCover: element => this._wordCoverManager.ownsWrapper(element),
            hasOwnedCovers: () => this._wordCoverManager.ownedCount > 0,
        })
        this._wordCoverManager.attachIndex(this._pageTextIndex)
        this._hoverNode = null
        this._hoverPoint = null
        this._lastHoverUpdateAt = 0
        this._hoverTrailingTimer = null
        this._lastVerdictWordCount = -1
        this._deferredClearVerdicts = 0
        this._startHoverTracking()
        this._startIframeLifecycleTracking()
    }

    _cloneDefaults() {
        return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => (
            [key, Array.isArray(value) ? [...value] : value]
        )))
    }

    _frameOwnerState() {
        return {
            frameElementCount: document.querySelectorAll(FRAME_OWNER_SELECTOR).length,
            hasUnsupportedFrameOwner: Boolean(document.querySelector(UNSUPPORTED_FRAME_OWNER_SELECTOR)),
        }
    }

    _allowsFrameRelease() {
        if (this.mode === PROTECTION_MODE.DISABLED) return true
        return this.mode === PROTECTION_MODE.ANALYZE && !this._manualBlurAllActive &&
            !this._analysisPending && this._pageAnalysisResult.shouldBlur === false
    }

    getFrameProtectionStatus() {
        return {
            allowsUnblur: this._allowsFrameRelease(),
            ...this._frameOwnerState(),
        }
    }

    _notifyFrameStatusChanged(force = false) {
        if (isTopFrameContext()) return
        const status = this.getFrameProtectionStatus()
        const signature = JSON.stringify(status)
        if (!force && signature === this._lastFrameStatusSignature) return
        this._lastFrameStatusSignature = signature
        sendToBackground({ type: FRAME_MESSAGES.statusChanged })
    }

    _setAnalysisPending(pending) {
        const next = pending === true
        if (this._analysisPending === next) return
        this._analysisPending = next
        if (next) this._invalidateFrameAggregate({ refresh: false })
        this._notifyFrameStatusChanged()
    }

    // A parent only asks about its frames once it would release them itself.
    _shouldRefreshFrameAggregate() {
        return this.settings.keepCrossOriginIframesBlurred === true &&
            this.mode === PROTECTION_MODE.ANALYZE && this._allowsFrameRelease() &&
            document.querySelector(FRAME_OWNER_SELECTOR) !== null
    }

    _applyCurrentResultToIframes() {
        const result = this._currentVisualResult()
        this._registry.all().forEach((node) => {
            if (node.kind === 'iframe') this._applyResultToNode(node, result)
        })
    }

    _setFrameAggregateClear(clear) {
        const next = clear === true
        if (this._frameAggregateClear === next) return
        this._frameAggregateClear = next
        this._applyCurrentResultToIframes()
    }

    _invalidateFrameAggregate({ refresh = true } = {}) {
        this._frameAggregateEpoch++
        this._frameAggregateRetryAttempt = 0
        clearTimeout(this._frameAggregateRefreshTimer)
        this._frameAggregateRefreshTimer = null
        this._setFrameAggregateClear(false)
        if (refresh) this._scheduleFrameAggregateRefresh()
    }

    _scheduleFrameAggregateRefresh(delay = FRAME_AGGREGATE_REFRESH_DEBOUNCE_MS) {
        clearTimeout(this._frameAggregateRefreshTimer)
        this._frameAggregateRefreshTimer = null
        if (!this._shouldRefreshFrameAggregate()) {
            this._setFrameAggregateClear(false)
            return
        }
        this._frameAggregateRefreshTimer = setTimeout(() => {
            this._frameAggregateRefreshTimer = null
            void this._refreshFrameAggregate()
        }, delay)
    }

    async _refreshFrameAggregate() {
        if (!this._shouldRefreshFrameAggregate()) {
            this._setFrameAggregateClear(false)
            return
        }

        const epoch = ++this._frameAggregateEpoch
        const ownerState = this._frameOwnerState()
        let response = null
        try {
            response = await withTimeout(chrome.runtime.sendMessage({
                target: 'background',
                type: FRAME_MESSAGES.aggregateRequest,
                epoch,
                ...ownerState,
            }), ANALYZE_TIMEOUT_MS, 'Embedded-frame check')
        } catch (_) {
            response = null
        }

        if (epoch !== this._frameAggregateEpoch) return
        if (!this._shouldRefreshFrameAggregate()) {
            this._setFrameAggregateClear(false)
            return
        }
        const currentOwnerState = this._frameOwnerState()
        if (currentOwnerState.frameElementCount !== ownerState.frameElementCount ||
            currentOwnerState.hasUnsupportedFrameOwner !== ownerState.hasUnsupportedFrameOwner) {
            this._invalidateFrameAggregate()
            return
        }

        const clear = Boolean(response?.ok && response.clear && response.epoch === epoch)
        this._setFrameAggregateClear(clear)
        // Everything that can change the answer already invalidates this
        // aggregate: subframe navigations and child status changes arrive from
        // the service worker, frame additions and removals from the observers.
        // A clear verdict therefore holds until then, and a failed one retries
        // a bounded number of times for transient faults before waiting too.
        if (clear) {
            this._frameAggregateRetryAttempt = 0
            return
        }
        if (this._frameAggregateRetryAttempt >= FRAME_AGGREGATE_MAX_RETRIES) return
        const retryDelay = FRAME_AGGREGATE_INITIAL_RETRY_MS * (2 ** this._frameAggregateRetryAttempt)
        this._frameAggregateRetryAttempt++
        this._scheduleFrameAggregateRefresh(retryDelay)
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
        const previousBlurPixels = this.blurPixels
        this.blurPixels = `${computeBlurPixels(this.settings.blurValueAmount)}px`
        this.blurFilter = `blur(${this.blurPixels})`
        setBlurCssValue(this.blurPixels)
        setPreviewBlurCssValue(Policy.previewBlurCssValue(this.settings))
        this._clearHoverPreview()
        // Blurred nodes carry a literal blur(Npx) inline filter rather than a
        // var() reference, so a new amount has to be written to each of them.
        if (previousBlurPixels !== this.blurPixels) {
            this._registry.all().forEach(node => node.refreshBlurFilter())
        }
        this._scheduleHoverPreviewUpdate()
    }

    cancelPendingAnalysis() {
        clearTimeout(this._analysisTimer)
        clearTimeout(this._backgroundTimer)
        clearTimeout(this._globalRescanTimer)
        clearTimeout(this._stylesheetReindexTimer)
        clearInterval(this._stylesheetPollTimer)
        this._analysisTimer = null
        this._backgroundTimer = null
        this._globalRescanTimer = null
        this._stylesheetReindexTimer = null
        this._stylesheetPollTimer = null
        if (this._observer) this._observer.disconnect()
        this._detachMediaResourceListeners()
    }

    async applyProtectionMode(mode, settings) {
        const generation = ++this._policyGeneration
        this.protectionApplied = true
        this.cancelPendingAnalysis()
        this.setSettings(settings)
        this.mode = mode
        this._invalidateFrameAggregate({ refresh: false })
        this._setAnalysisPending(mode === PROTECTION_MODE.ANALYZE && !this._manualBlurAllActive)
        this._releaseEarlyWordCover()

        if (mode === PROTECTION_MODE.DISABLED) {
            this.disableProtection()
            this._notifyFrameStatusChanged()
            return
        }

        this._pageAnalysisResult = { ...FAIL_CLOSED_RESULT }
        this.enableProtection()
        this.protectAllKnownVisuals()
        if (mode === PROTECTION_MODE.ALWAYS_BLUR || this._manualBlurAllActive) {
            this._notifyFrameStatusChanged()
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
        this._resumeObservation()
    }

    // Re-arms everything cancelPendingAnalysis() tears down.
    _resumeObservation() {
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

    _restorePageFilter(element, state) {
        markInternalMutationTarget(element)
        if (state.originalValue) {
            element.style.setProperty('filter', state.originalValue, state.originalPriority)
        } else {
            element.style.removeProperty('filter')
        }
    }

    _restoreDisabledMedia(root) {
        this._mediaElements(root).forEach((element) => {
            const state = this._disabledMediaFilters.get(element)
            if (!state) return
            this._restorePageFilter(element, state)
            this._disabledMediaFilters.delete(element)
        })
    }

    // Removed media gets the page's own filter back only while ours is still
    // applied; anything the page wrote since is left alone.
    _discardDisabledMediaState(root) {
        this._mediaElements(root).forEach((element) => {
            const state = this._disabledMediaFilters.get(element)
            if (!state) return

            const currentValue = element.style.getPropertyValue('filter')
            const currentPriority = element.style.getPropertyPriority('filter')
            if (currentValue === state.appliedValue && currentPriority === 'important') {
                this._restorePageFilter(element, state)
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

        return getUnownedStyleSignature(oldStyleText, ['filter']) !==
            getUnownedStyleSignature(element.getAttribute('style'), ['filter'])
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
        this._setAnalysisPending(true)
        reportIconStatus('processing')
        const words = this._pageTextIndex.getWords()
        const result = await analyzePageWordsWithOffscreen(words)
        if (generation !== this._policyGeneration) return { ...FAIL_CLOSED_RESULT }
        // Deliberately does not commit to _pageAnalysisResult. applyPageResult
        // owns that, so a verdict it decides to postpone cannot be picked up by
        // a mutation batch and used to unblur media early.
        return result
    }

    // A "nothing found" verdict is only trustworthy once the page has stopped
    // producing text. Single-page apps render their content after the first
    // analysis, so acting on an early clear verdict unblurs media that is about
    // to be judged unsafe — on a YouTube search that painted real thumbnails at
    // filter:none for roughly a second before the blur came back.
    _shouldDeferClearVerdict(wordCount) {
        if (this._deferredClearVerdicts >= MAX_DEFERRED_CLEAR_VERDICTS) return false
        if (this._registry.size === 0) return false
        return wordCount !== this._lastVerdictWordCount || document.readyState !== 'complete'
    }

    applyPageResult(result, nodes = this._registry.all()) {
        const wordCount = this._pageTextIndex.wordCount

        if (!result.shouldBlur && this._shouldDeferClearVerdict(wordCount)) {
            this._deferredClearVerdicts++
            this._lastVerdictWordCount = wordCount
            this._scheduleAnalysis()
            return
        }

        this._deferredClearVerdicts = 0
        this._lastVerdictWordCount = wordCount
        this._pageAnalysisResult = result
        this._setAnalysisPending(false)
        this._notifyFrameStatusChanged()
        nodes.forEach(node => this._applyResultToNode(node, result))
        this._scheduleFrameAggregateRefresh()
        reportIconStatus(result.shouldBlur ? 'detected' : 'idle')
        // The pointer may already be resting on media that only just became
        // blurred, and a stationary pointer produces no further events.
        this._scheduleHoverPreviewUpdate()
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

    // A manual command supersedes any in-flight analysis.
    _beginManualCommand(blurAllActive) {
        ++this._policyGeneration
        this.cancelPendingAnalysis()
        this._manualBlurAllActive = blurAllActive
        this._setAnalysisPending(false)
    }

    blurAll() {
        this._beginManualCommand(true)
        this._invalidateFrameAggregate({ refresh: false })
        this._explicitReveals = new WeakMap()
        this._registerMedia(document)
        this._scanBackgrounds(document, { full: true })
        this._registry.all().forEach(node => node.blur())
        this._resumeObservation()
        this._notifyFrameStatusChanged()
        reportIconStatus('detected')
    }

    unblurAll() {
        this._beginManualCommand(false)
        this._registerMedia(document)
        this._scanBackgrounds(document, { full: true })
        this._registry.all().forEach(node => this.rememberExplicitReveal(node.element))
        this._wordCoverManager.revealAll()
        this._resumeObservation()
        this._notifyFrameStatusChanged()
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
        if (this._analysisPending || this._manualBlurAllActive || result.shouldBlur) {
            node.blur()
            return
        }
        if (node.kind === 'iframe' && this.settings.keepCrossOriginIframesBlurred) {
            const navigationPending = this._pendingIframeNavigations.has(node.element)
            if (navigationPending || (!this._frameAggregateClear &&
                isCrossOriginIframe(node.element, this._isIframeNavigationComplete(node.element)))) {
                node.blur()
                return
            }
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
        if (this._analysisPending || this.mode === PROTECTION_MODE.ALWAYS_BLUR || this._manualBlurAllActive) {
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
            this._reindexAfterStylesheetChange()
        }, RESIZE_DEBOUNCE_MS)
    }

    // Rebuilding the text index walks every text node with layout reads, so
    // it never runs inside the observer callback and at most once per burst.
    _handleStylesheetChange() {
        if (this.mode === PROTECTION_MODE.DISABLED) return
        clearTimeout(this._stylesheetReindexTimer)
        this._stylesheetReindexTimer = setTimeout(() => {
            this._stylesheetReindexTimer = null
            this._reindexAfterStylesheetChange()
        }, STYLESHEET_REINDEX_DEBOUNCE_MS)
    }

    _reindexAfterStylesheetChange() {
        if (this.mode === PROTECTION_MODE.DISABLED) return
        // Stylesheet edits can change visibility outside the mutated subtree.
        // Rebuild the visible-text index before reusing a page-wide verdict.
        const previousWords = new Set(this._pageTextIndex.getWords())
        this._pageTextIndex.build(document.body || document.documentElement)
        this._stylesheetFingerprint = this._computeStylesheetFingerprint()
        const words = this._pageTextIndex.getWords()
        const vocabularyChanged = words.length !== previousWords.size ||
            words.some(word => !previousWords.has(word))
        if (vocabularyChanged && this.mode === PROTECTION_MODE.ANALYZE && !this._manualBlurAllActive) {
            this.protectAllKnownVisuals()
            this._scheduleAnalysis()
        }
        this._scheduleFullBackgroundRescan()
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
                this._handleStylesheetChange()
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
            this._handleStylesheetChange()
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
        this._blurForIframeNavigation(element)
        this._markIframeNavigationPending(element)

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

        const node = this._blurForIframeNavigation(element)
        this._armIframeNavigationGuard(element)
        const currentState = this._iframeNavigationGuards.get(element)
        if (currentState?.active !== guard) return
        this._completeIframeNavigation(element, node)
    }

    // Every navigation signal blurs the frame first; its new document is
    // judged again only once it has settled.
    _blurForIframeNavigation(element) {
        this._invalidateFrameAggregate({ refresh: false })
        const node = this.mode === PROTECTION_MODE.DISABLED ? null : this._registry.get(element)
        if (node) node.blur()
        return node
    }

    _completeIframeNavigation(element, node) {
        this._markIframeNavigationComplete(element)
        if (node) this._applyResultToNode(node, this._currentVisualResult())
        this._scheduleFrameAggregateRefresh()
    }

    // One passive pointer listener drives every preview. elementsFromPoint
    // returns the whole stack under the cursor, so media sitting beneath an
    // overlay (posters and thumbnails on most media sites) is still found.
    _startHoverTracking() {
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
        // Scrolling moves content under a cursor that is not moving, so the
        // element beneath the pointer changes with no pointer event to notice
        // it. Reuse the same throttle rather than adding a second one.
        this._onHoverScroll = () => {
            if (this._hoverPoint) this._scheduleHoverPreviewUpdate()
        }
        document.addEventListener('pointermove', this._onPointerMove, { capture: true, passive: true })
        document.addEventListener('scroll', this._onHoverScroll, { capture: true, passive: true })
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
        if (node.isRootBackground) return false
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

    _handleFrameTopologyChange() {
        this._notifyFrameStatusChanged(true)
        this._invalidateFrameAggregate()
    }

    _startIframeLifecycleTracking() {
        document.addEventListener('load', this._onIframeLifecycleLoad, true)
        this._iframeLifecycleObserver = new MutationObserver((mutations) => {
            let frameTopologyChanged = false
            // Check the changed subtrees themselves: replacing one frame with
            // another can preserve the owner count while invalidating its verdict.
            const hasFrameOwner = (nodes) => {
                for (const node of nodes) {
                    if (node instanceof Element && (node.matches(TRACKED_FRAME_OWNER_SELECTOR) ||
                        node.querySelector(TRACKED_FRAME_OWNER_SELECTOR))) return true
                }
                return false
            }

            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.removedNodes.forEach(node => this._disarmDetachedIframeGuards(node))
                    frameTopologyChanged = frameTopologyChanged ||
                        hasFrameOwner(mutation.addedNodes) || hasFrameOwner(mutation.removedNodes)
                    return
                }
                if (mutation.target instanceof HTMLIFrameElement) {
                    frameTopologyChanged = true
                    if (mutation.attributeName === 'sandbox') {
                        // Sandbox changes affect future navigations; they do
                        // not navigate the current document or emit a load.
                        // Keep any actual src/srcdoc navigation pending.
                        this._armIframeNavigationGuard(mutation.target)
                    } else {
                        this._markIframeNavigationPending(mutation.target)
                    }
                }
            })

            if (frameTopologyChanged) this._handleFrameTopologyChange()
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

        const node = this._blurForIframeNavigation(element)
        this._armIframeNavigationGuard(element)
        this._completeIframeNavigation(element, node)
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
            stylesheetChanged = stylesheetChanged || this._mutationTouchesStylesheet(mutation)

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
        // Media can be registered or replaced under a pointer that is not
        // moving, so re-run the hit test rather than waiting for another event.
        this._scheduleHoverPreviewUpdate()

        const { added, removed } = this._pageTextIndex.applyMutations(records)
        this._wordCoverManager.prune()

        if (stylesheetChanged) {
            this._handleStylesheetChange()
        }

        if (this.mode === PROTECTION_MODE.ALWAYS_BLUR || this._manualBlurAllActive) {
            touched.forEach(node => this._applyResultToNode(node, FAIL_CLOSED_RESULT))
            return
        }

        // New vocabulary can flip a clear verdict, so stay fail-closed until the
        // analysis returns. Equivalent text replacement needs no new analysis.
        if (added.size > 0) {
            this.protectAllKnownVisuals()
            this._scheduleAnalysis()
            return
        }

        // Losing vocabulary can only clear a verdict, never create one, so
        // nothing needs re-protecting. A pending verdict still describes the
        // old vocabulary and must be discarded even if the last result was clear.
        const pendingInputRemoved = removed.size > 0 && this._analysisPending
        const matchedWordRemoved = removed.size > 0 && this._pageAnalysisResult.shouldBlur === true &&
            this._pageAnalysisResult.matchedInputWords.some(word => removed.has(word))
        if (pendingInputRemoved || matchedWordRemoved) this._scheduleAnalysis()

        touched.forEach(node => this._applyResultToNode(node, this._currentVisualResult()))
    }

    _scheduleAnalysis() {
        clearTimeout(this._analysisTimer)
        const generation = ++this._policyGeneration
        this._setAnalysisPending(true)
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
        markInternalMutationTarget(root)
        root.setAttribute(ROOT_ATTRS.frame, isTopFrameContext() ? 'top' : 'sub')
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
let settingsInitialized = false

function conservativeSettings() {
    return {
        ...controller._cloneDefaults(),
        targetWords: [],
        phobiaBlockerEnabled: true,
        blurIsAlwaysOn: true,
    }
}

// early-blur.js issues the first storage read at document_start. The load
// path reuses it so each frame pays one round-trip; any storage change since
// makes it stale, and the onChanged listener drops it.
let initialSettingsRead = globalThis.PhobiaBlockerInitialSettingsRead || null

function readSettings() {
    const shared = initialSettingsRead
    initialSettingsRead = null
    return shared || Storage.getWithDefaults(Object.keys(DEFAULTS))
}

// A settings read that never settles used to leave the page fail-closed
// forever: every image blurred and, before the CSS fix, unclickable. Bound each
// attempt so the fail-closed path is always reached instead of hanging.
async function readSettingsWithRetry() {
    let lastError = null
    for (let attempt = 1; attempt <= SETTINGS_READ_ATTEMPTS; attempt++) {
        try {
            return await withTimeout(readSettings(), SETTINGS_READ_TIMEOUT_MS, 'Settings read')
        } catch (error) {
            lastError = error
            console.warn(`PhobiaBlocker: settings read attempt ${attempt} failed`, error)
        }
    }
    throw lastError || new Error('Settings read failed')
}

// Visual-only changes (blur strength, preview) re-style what is already on
// the page; everything else re-resolves the protection mode from scratch.
async function readAndApplySettings({ visualOnly = false } = {}) {
    const readGeneration = ++settingsReadGeneration
    try {
        const settings = await readSettingsWithRetry()
        if (readGeneration !== settingsReadGeneration) return
        settingsInitialized = true
        const mode = Policy.resolveProtectionMode(settings, location.href)
        // A newer visual read may have superseded a still-pending policy read.
        // Compare against the settings actually applied, not just this event's keys.
        const protectionChanged = [...POLICY_STORAGE_KEYS].some(key => (
            !VISUAL_STORAGE_KEYS.has(key) && !UI_ONLY_STORAGE_KEYS.has(key) &&
            JSON.stringify(settings[key]) !== JSON.stringify(controller.settings[key])
        ))
        // Only a page whose protection has been applied once can take the
        // re-style shortcut; before that the initial application must run.
        if (visualOnly && controller.protectionApplied && mode === controller.mode && !protectionChanged) {
            controller.setSettings(settings)
            return
        }
        await controller.applyProtectionMode(mode, settings)
    } catch (error) {
        if (readGeneration !== settingsReadGeneration) return
        console.error('PhobiaBlocker: settings read failed; applying fail-closed mode', error)
        await controller.applyProtectionMode(PROTECTION_MODE.ALWAYS_BLUR, conservativeSettings())
    }
}

function applyCurrentUrlPolicy() {
    if (!settingsInitialized) return
    const mode = Policy.resolveProtectionMode(controller.settings, location.href)
    if (mode !== controller.mode) void controller.applyProtectionMode(mode, controller.settings)
}

// These events also work while protection is disabled. The service worker
// relays pushState/replaceState changes, which do not emit popstate themselves.
window.addEventListener('popstate', applyCurrentUrlPolicy)
window.addEventListener('hashchange', applyCurrentUrlPolicy)

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
    if (!event || !event.isTrusted || event.defaultPrevented || event.repeat) return
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return
    if (event.code !== 'KeyW' && String(event.key || '').toLowerCase() !== 'w') return
    const element = event.target?.nodeType === Node.ELEMENT_NODE ? event.target : event.target?.parentElement
    if (element?.matches?.('input, textarea, select, [contenteditable="true"]')) return
    event.preventDefault()
    sendToBackground({ type: 'toggleWordCover', source: 'keyboard' })
}, true)

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    initialSettingsRead = null
    const changedKeys = Object.keys(changes).filter(key => (
        POLICY_STORAGE_KEYS.has(key) && !UI_ONLY_STORAGE_KEYS.has(key)
    ))
    if (changedKeys.length === 0) return
    void readAndApplySettings({ visualOnly: changedKeys.every(key => VISUAL_STORAGE_KEYS.has(key)) })
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || (message.target && message.target !== 'content')) return false

    switch (message.type) {
    case 'PB_URL_CHANGED':
        applyCurrentUrlPolicy()
        sendResponse({ ok: true })
        return true

    case FRAME_MESSAGES.statusRequest:
        sendResponse(controller.getFrameProtectionStatus())
        return true

    case FRAME_MESSAGES.aggregateInvalidated:
        controller._invalidateFrameAggregate()
        sendResponse({ ok: true })
        return true

    case 'getAnalysisDebugState':
        if (!isTopFrameContext()) return false
        sendResponse({
            ...ANALYSIS_DEBUG_STATE,
            mediaCount: controller.getVisualNodes().length,
            pageWordCount: controller._pageTextIndex.wordCount,
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
