// Content-script controller: owns the blur projection of every media element
// and trigger word in this frame, the mutation-driven re-analysis, and the
// frame protocols that decide when an iframe may be released.
'use strict'

const Policy = globalThis.PhobiaBlockerPolicy
const Storage = globalThis.PhobiaBlockerStorage
const PageTextIndex = globalThis.PhobiaBlockerPageTextIndex
const EditorFrames = globalThis.PhobiaBlockerEditorFrames
const FrameClearance = globalThis.PhobiaBlockerFrameClearance

// This script is last in its manifest content_scripts entry; the earlier
// ones publish these globals. Failing loudly is safer than running without a
// policy: protection.css keeps the page fail-closed (early-blur.js bails out
// the same way when these are missing).
if (!Policy || !Storage || !PageTextIndex || !EditorFrames || !FrameClearance) {
    throw new Error('PhobiaBlocker: required shared modules are unavailable')
}

const debug = Policy.createDebugLogger('content', () => window.PHOBIABLOCKER_DEBUG === true)

const {
    DEFAULTS, PROTECTION_MODE, STORAGE_KEYS, FAIL_CLOSED_RESULT, FRAME_MESSAGES, CSS_VARS, ROOT_ATTRS,
    computeBlurPixels, isTopFrameContext, withTimeout,
} = Policy
// Bound on one round trip to the service worker, for the word analysis and
// the frame aggregate request alike. Expiry yields the fail-closed answer.
const ANALYZE_TIMEOUT_MS = 3000
// Element media registered directly; CSS backgrounds are found separately by
// computed-style scans and registered with kind 'background'.
const MEDIA_SELECTOR = 'img, video, iframe'
const BACKGROUND_READY_ATTR = ROOT_ATTRS.backgroundReady
const BACKGROUND_SCANNING_ATTR = ROOT_ATTRS.backgroundScanning
// Per-element markers. protection.css keys off three of them: a background
// node is blurred unless marked suppressed (root and editor backdrops hide the
// image instead of filtering it, so the page text stays readable), and a
// registered media element loses the startup pointer-events:none that
// unregistered media carry.
const BACKGROUND_MARKER_ATTR = 'data-phobiablocker-background'
// Legacy: protection.css used to key its root-background exception on this
// before the suppressed marker replaced it. Nothing reads it any more; it is
// still written and restored so VisualNode's attribute bookkeeping stays
// complete.
const ROOT_BACKGROUND_MARKER_ATTR = 'data-phobiablocker-root-background'
const SUPPRESSED_BACKGROUND_MARKER_ATTR = 'data-phobiablocker-suppressed-background'
const MEDIA_MARKER_ATTR = 'data-phobiablocker-media'
const POLICY_STORAGE_KEYS = new Set(Object.values(STORAGE_KEYS))
// Popup accordion state never affects a page.
const UI_ONLY_STORAGE_KEYS = new Set([STORAGE_KEYS.detectedWordsCollapsed, STORAGE_KEYS.supportedWordsCollapsed])
// Keys whose change never alters the protection mode or verdict (blur
// strength, preview, debug logging): setSettings re-styles without
// re-applying policy.
const VISUAL_STORAGE_KEYS = new Set([
    STORAGE_KEYS.blurAmount, STORAGE_KEYS.previewEnabled, STORAGE_KEYS.previewStrength, STORAGE_KEYS.debugMode,
])
// Element -> snapshot of the attribute values this script last wrote, alive
// for one task; isInternalMutation compares records against it.
const INTERNAL_ATTRIBUTE_STATE = new WeakMap()
// The only observed attributes this script writes itself.
const INTERNAL_SNAPSHOT_ATTRIBUTES = Object.freeze(['class', 'style', BACKGROUND_READY_ATTR, BACKGROUND_SCANNING_ATTR])
// Attribute records the observer asks for. class/style/hidden/aria-hidden and
// contenteditable change text visibility or editability; src..sandbox change
// what a media element or iframe shows; href/rel/media/disabled/type change
// stylesheets and <source> selection; slot/name/role move slotted content or
// mark an editing surface. Anything else is ignored to keep batches small.
const OBSERVED_ATTRIBUTES = Object.freeze([
    'class', 'style', 'hidden', 'aria-hidden', 'contenteditable', 'role', 'slot', 'name',
    'src', 'srcset', 'sizes', 'poster', 'srcdoc', 'sandbox',
    'href', 'rel', 'media', 'disabled', 'type',
    BACKGROUND_READY_ATTR, BACKGROUND_SCANNING_ATTR,
])
// CSSOM edits (insertRule, adoptedStyleSheets, sheet.disabled) produce no
// mutation records, so stylesheets are fingerprinted on a timer instead.
const STYLESHEET_POLL_INTERVAL_MS = 2000
// The fallback shadow-root sweep walks the whole page one element at a time.
// Each slice stops after this many nodes or ~4 ms (well inside a 60 Hz frame)
// and resumes a frame later, so a large page never sees a long task from it.
const SHADOW_DISCOVERY_NODE_BUDGET = 250
const SHADOW_DISCOVERY_TIME_BUDGET_MS = 4
const SHADOW_DISCOVERY_YIELD_MS = 16
// Hosts still waiting for a declarative shadow root while the document is
// parsed: custom elements, elements holding a shadowrootmode template and
// the elements the parser left open. Bounded; anything dropped is found by
// the discovery sweep.
const MAX_PENDING_SHADOW_HOSTS = 256
// Coalesce analysis across a burst of mutations instead of re-analysing the
// whole page once per batch.
const ANALYSIS_DEBOUNCE_MS = 200
// Resize fires continuously while a window is dragged; one rescan is enough.
const RESIZE_DEBOUNCE_MS = 200
// Stylesheet edits arrive in bursts (CSS-in-JS inserts one <style> per
// component). Rebuild the visible-text index once per burst, off the observer.
const STYLESHEET_REINDEX_DEBOUNCE_MS = 200
// Each storage read attempt is bounded so a read that never settles cannot
// leave the page in the shim's fail-closed state forever; after the last
// attempt the controller applies conservative settings itself.
const SETTINGS_READ_TIMEOUT_MS = 3000
const SETTINGS_READ_ATTEMPTS = 3
// A failed full background scan keeps the page-wide background-image:none
// rule in force; after this many failures the page is accepted as ready.
const MAX_BACKGROUND_SCAN_RETRIES = 3
// Throttle for the pointer hit test that drives hover previews.
const HOVER_HIT_TEST_INTERVAL_MS = 30
// How many times a "nothing found" verdict may be postponed while the page is
// still producing text, before it is accepted anyway.
const MAX_DEFERRED_CLEAR_VERDICTS = 4
// protection.css blurs media at 40px until the controller projects the user's
// strength. Until the first settings read is applied the controller must not
// weaken that, so its own projection starts from the same value.
const FAIL_CLOSED_BLUR_PIXELS = '40px'
// Events on img/video that can swap the displayed picture under an existing
// verdict (new src, poster, srcObject). Each re-applies the current result
// unless the user's explicit reveal still matches what the element shows.
const MEDIA_RESOURCE_EVENTS = Object.freeze(['load', 'loadstart', 'loadedmetadata', 'loadeddata', 'emptied'])
// Attributes that navigate an iframe or change its origin rules. The guard
// events fire inside the child window: pagehide/unload announce a navigation
// before the new document exists, pageshow(persisted) brings an old document
// back from the back/forward cache with no load event.
const IFRAME_NAVIGATION_ATTRIBUTES = Object.freeze(['src', 'srcdoc', 'sandbox'])
const IFRAME_NAVIGATION_START_EVENTS = Object.freeze(['pagehide', 'unload'])
const IFRAME_RESTORATION_EVENT = 'pageshow'
const IFRAME_GUARD_EVENTS = Object.freeze([...IFRAME_NAVIGATION_START_EVENTS, IFRAME_RESTORATION_EVENT])
// Guards of documents parked in the back/forward cache are kept per iframe so
// a restored document is recognised; the bound stops a frame that navigates
// endlessly from retaining every cached window. Two is an arbitrary small
// allowance, not a browser or back/forward-cache limit.
const MAX_SUSPENDED_IFRAME_GUARDS = 2
// Only <iframe> is registered as media and bound to a ticket by its
// contentWindow, so only it can be blurred and released on its own. frame,
// object, embed and fencedframe can also host documents, but the controller
// never projects onto them: their presence is reported as an unsupported
// owner and the worker refuses the whole-tree verdict (per-iframe tickets
// may still be issued).
const FRAME_OWNER_SELECTOR = 'iframe'
const UNSUPPORTED_FRAME_OWNER_SELECTOR = 'frame, object, embed, fencedframe'
const TRACKED_FRAME_OWNER_SELECTOR = `${FRAME_OWNER_SELECTOR}, ${UNSUPPORTED_FRAME_OWNER_SELECTOR}`
// Coalesce the aggregate requests from a burst of invalidations into one.
const FRAME_AGGREGATE_REFRESH_DEBOUNCE_MS = 100
// Bounded retries cover a transient failure; afterwards the next invalidation
// (a navigation, a child status change, a topology change) asks again.
const FRAME_AGGREGATE_MAX_RETRIES = 3
const FRAME_AGGREGATE_INITIAL_RETRY_MS = 1000
// attributeOldValue is required: style records are diffed against the old
// text to tell a page edit from our own projection.
const DOM_OBSERVER_OPTIONS = Object.freeze({
    childList: true, characterData: true, subtree: true,
    attributes: true, attributeOldValue: true, attributeFilter: OBSERVED_ATTRIBUTES,
})
// A second observer that stays connected in every mode, including while the
// main one is torn down between analyses, so iframe navigations and owner
// changes always invalidate the frame aggregate.
const FRAME_OBSERVER_OPTIONS = Object.freeze({
    attributes: true, childList: true, subtree: true, attributeFilter: IFRAME_NAVIGATION_ATTRIBUTES,
})
// Before the first settings read only inserted subtrees matter (shadow root
// discovery); attribute and text records would be ignored anyway.
const STARTUP_OBSERVER_OPTIONS = Object.freeze({ childList: true, subtree: true })
// The document stylesheet cannot cross a shadow boundary. Keep its initial
// media protection and word-cover appearance in an owned sheet in each root.
// Unlike protection.css's literal 40px, unregistered shadow media follow the
// root blur variable once settings are projected (40px until then);
// registered media in either tree carry an inline filter that outranks both.
const SHADOW_PROTECTION_CSS = `
    :host-context(html:not([data-phobiablocker-background-ready]):not([data-phobiablocker-background-scanning])) * {
        background-image: none !important;
    }
    :is(img, video, iframe) {
        filter: blur(var(--phobiablocker-blurValueAmount, 40px)) !important;
    }
    :is(img, video, iframe)[data-phobia-blur] {
        cursor: pointer !important;
        transition: filter 0.2s ease;
    }
    .phobia-word-cover {
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
        background-color: var(--phobiablocker-word-cover-color, currentColor) !important;
        background-image: repeating-linear-gradient(135deg,
            rgba(255,255,255,.22) 0, rgba(255,255,255,.22) 2px,
            rgba(0,0,0,.16) 2px, rgba(0,0,0,.16) 4px) !important;
        border-radius: 2px !important;
        outline: 1px solid rgba(127,127,127,.5) !important;
        outline-offset: 1px !important;
        text-shadow: none !important;
        box-decoration-break: clone !important;
        -webkit-box-decoration-break: clone !important;
        cursor: help !important;
    }
`
// Counters exposed through getAnalysisDebugState for the test suites;
// nothing reads them to make a decision.
const ANALYSIS_DEBUG_STATE = {
    pageAnalysisRequests: 0,
    mutationBatches: 0,
    directWordCovers: 0,
}
// Detached style declarations reused to parse inline style text without
// creating an element per mutation.
const SIGNATURE_STYLE_PROBE = document.createElement('span').style
const PREVIOUS_STYLE_PROBE = document.createElement('span').style

// Where the user right-clicked, captured on contextmenu so the "unblur"
// message that the service worker sends later can find the media element or
// covered word under the menu.
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

// Site rules match origin and path only, and a fragment change never replaces
// the document. Policy and clearance therefore compare URLs without it; a
// hash update must not re-blur or re-analyse an unchanged page.
function stripUrlFragment(href) {
    const text = String(href || '')
    const hashIndex = text.indexOf('#')
    return hashIndex === -1 ? text : text.slice(0, hashIndex)
}

function currentPolicyUrl() {
    return stripUrlFragment(location.href)
}

// Ours only if the attribute still holds the value snapshotted after our
// write; a page edit in between leaves a different value and is processed.
function isInternalMutation(mutation) {
    // A record without a target carries nothing to act on and is dropped as ours.
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

// The toolbar icon belongs to the tab, so only the top frame reports. Idle and
// detected are delayed 250 ms because verdicts flip quickly during a page load
// and the icon would flicker; processing is shown at once.
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

// Identical writes are skipped: each one would produce a style record the
// observer then has to recognise as ours.
function setRootCssVar(name, value, priority = '') {
    const root = document.documentElement
    if (!root || !root.style) return
    if (root.style.getPropertyValue(name) === value && root.style.getPropertyPriority(name) === priority) return
    markInternalMutationTarget(root)
    root.style.setProperty(name, value, priority)
}

// Both the namespaced and the legacy variable names; see CSS_VARS.
function setBlurCssValue(value) {
    setRootCssVar(CSS_VARS.blurNs, value)
    setRootCssVar(CSS_VARS.blurLegacy, value)
}

function setPreviewBlurCssValue(value) {
    setRootCssVar(CSS_VARS.previewNs, value)
    setRootCssVar(CSS_VARS.previewLegacy, value)
}

// Serialises an inline style with our projected properties and root variables
// removed, so two style strings compare equal when only our own writes differ.
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
    debug('analysis.requested', () => ({ inputWordCount: words.length }))
    try {
        const response = await withTimeout(chrome.runtime.sendMessage({
            target: 'background',
            type: 'PB_ANALYZE_WORDS',
            words: Array.isArray(words) ? words : [],
        }), ANALYZE_TIMEOUT_MS, 'Analysis')
        const result = Policy.normalizeAnalysisResult(response) || { ...FAIL_CLOSED_RESULT }
        debug('analysis.completed', () => ({
            shouldBlur: result.shouldBlur, matchedWordCount: result.matchedInputWords.length,
        }))
        return result
    } catch (error) {
        console.error('PhobiaBlocker: page analysis failed; keeping media blurred', error)
        return { ...FAIL_CLOSED_RESULT }
    }
}

// Identity of what an element displays, used to decide whether an explicit
// reveal, a committed clearance or a completed iframe navigation still refers
// to the same content. An empty string means "no identity": callers then
// refuse to retain a reveal or clearance for the element.
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

// Whether an iframe's document must go through the cross-origin frame
// protocol before it may be released. Any doubt answers true (stay blurred);
// false is returned only once the child document is known to be same-origin
// and to be the one the markup asked for, not a transitional about:blank.
function isCrossOriginIframe(iframe, navigationComplete = false) {
    try {
        if (!(iframe instanceof HTMLIFrameElement)) return true
        // Any sandbox value counts, even one with allow-same-origin: a sandboxed
        // document takes the protocol path like a cross-origin one.
        if (iframe.hasAttribute('sandbox')) return true

        const hasSourceDocument = iframe.hasAttribute('srcdoc')
        const source = iframe.getAttribute('src')
        let declared = null
        // A declared src other than about:blank (or a srcdoc) must actually have
        // been navigated to. Until then the frame still shows the initial blank
        // document, which says nothing about the page it is about to load.
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
        // A still-loading document may yet be replaced by the declared one.
        if (frameDocument.readyState !== 'complete' && requiresDeclaredNavigation) return true
        if (hasSourceDocument) return !isSourceDocument
        if (requiresDeclaredNavigation && (isInitialBlankDocument || isSourceDocument)) return true
        if (isInitialBlankDocument || isSourceDocument) return false
        if (!effective.origin || effective.origin === 'null' || effective.origin !== location.origin) return true
        // The frame shows a URL other than its src (redirect or in-frame
        // navigation). Only a load the controller observed, passed in as
        // navigationComplete, proves this is the settled document.
        if (declared && effective.href !== declared.href && !navigationComplete) {
            return true
        }
        return false
    } catch (_) {
        return true
    }
}

// Only url() images count as media; gradients are decoration and never blur.
function getComputedBackgroundImage(element) {
    if (!(element instanceof Element)) return ''
    const value = getComputedStyle(element).backgroundImage
    return value && value !== 'none' && value.includes('url(') ? value : ''
}

// One registered element's blur projection: classes, marker attributes and an
// inline filter or background-image, each written with !important so page CSS
// cannot undo it. Everything the page had before registration is recorded so
// the element can be handed back untouched when the node is released.
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
            [SUPPRESSED_BACKGROUND_MARKER_ATTR, element.getAttribute(SUPPRESSED_BACKGROUND_MARKER_ATTR)],
            [MEDIA_MARKER_ATTR, element.getAttribute(MEDIA_MARKER_ATTR)],
        ])
        this._pageStyles = new Map([
            ['filter', this._readStyleProperty(element.style, 'filter')],
            ['background-image', this._readStyleProperty(element.style, 'background-image')],
        ])
        this._styleProjections = new Map()
        // Filtering <html> or <body> would blur the whole page, and filtering
        // the backdrop of an editing surface would blur the text being typed.
        // Such nodes hide their background-image instead of blurring it.
        this.isRootBackground = kind === 'background' &&
            (element === document.documentElement || element === document.body)
        this.suppressesBackground = this.isRootBackground ||
            (kind === 'background' && PageTextIndex.containsEditingSurface(element))
        this._backgroundModeDirty = false
        this.backgroundImage = ''
        // A node is born blurred: registering never reveals anything, the
        // controller applies the current verdict afterwards.
        this.isBlurred = true
        // Last projection actually written to the DOM. Repeated requests for the
        // same state become no-ops, which is what stops mutation batches from
        // rewriting every node's class and inline filter over and over.
        this._renderState = null
        this._previewActive = false
        markInternalMutationTarget(this.element)
        this.element.setAttribute(MEDIA_MARKER_ATTR, '1')
        if (this.isRootBackground) this.element.setAttribute(ROOT_BACKGROUND_MARKER_ATTR, '1')
        if (this.suppressesBackground) this.element.setAttribute(SUPPRESSED_BACKGROUND_MARKER_ATTR, '1')
        this.blur()
    }

    // Never strips a projection class the page itself had on the element.
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
        // A current value that is not our last projection was written by the
        // page since then; remember it as the value to restore.
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

    // Called for a style record on a registered element. Returns whether the
    // page changed anything (an unowned property, or one of ours to a value we
    // did not write) and re-asserts any projection the page overwrote (a
    // framework rewriting cssText drops our filter), so a style rewrite can
    // never leave media revealed.
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

    // Before a computed-style read: our background-image:none would otherwise
    // be read back as "no background" and the node dropped from the registry.
    prepareBackgroundScan() {
        if (!this.suppressesBackground) return
        this._restorePageStyle('background-image')
        this.invalidateRendering()
    }

    // An editing surface can appear or disappear beneath an element
    // (contenteditable toggled, slot reassigned), switching it between blur
    // and suppress. Both projections are restored first so the old mode's
    // write does not linger under the new one.
    refreshBackgroundMode() {
        if (this.kind !== 'background' || !this._backgroundModeDirty) return
        this._backgroundModeDirty = false
        const suppress = this.isRootBackground || PageTextIndex.containsEditingSurface(this.element)
        if (suppress === this.suppressesBackground) return
        this._restorePageStyle('filter')
        this._restorePageStyle('background-image')
        this.suppressesBackground = suppress
        this._previewActive = false
        markInternalMutationTarget(this.element)
        if (suppress) this.element.setAttribute(SUPPRESSED_BACKGROUND_MARKER_ATTR, '1')
        else this._restoreAttribute(SUPPRESSED_BACKGROUND_MARKER_ATTR)
        this.invalidateRendering()
    }

    // Forces the next blur/unblur to rewrite the DOM. Called when the page
    // itself touched our element, so a repair still happens even though the
    // requested state has not changed.
    invalidateRendering() {
        this._renderState = null
    }

    // isBlurred is updated before the render-state short-circuit so hover and
    // preview logic see the requested state even when nothing was rewritten.
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
        if (this.suppressesBackground) {
            this._setStyleProjection('background-image', 'none', 'important')
            this._previewActive = false
            return
        }
        this._setStyleProjection('filter', this.controller.blurFilter, 'important')
        // A re-render while the pointer is still over the element must not drop
        // back to full blur; re-assert the preview instead.
        if (this._previewActive) this._applyPreviewFilter()
    }

    // "explicit" is the user's own reveal (context menu, unblur all). It has
    // its own render state and class so a later automatic release does not
    // collapse into the same no-op and the DOM shows which kind applies.
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
        if (this.suppressesBackground) {
            this._restorePageStyle('background-image')
            this._previewActive = false
            return
        }
        this._setStyleProjection('filter', 'none', 'important')
        this._previewActive = false
    }

    // Hands the element back exactly as found. Used when the node leaves the
    // registry (removed, no longer a background, protection disabled), never
    // as a way to unblur.
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
        this._restoreAttribute(SUPPRESSED_BACKGROUND_MARKER_ATTR)
        this._restoreAttribute(MEDIA_MARKER_ATTR)
        if (this._styleProjections.has('filter')) this._restorePageStyle('filter')
        if (this._styleProjections.has('background-image')) this._restorePageStyle('background-image')
        this._styleProjections.clear()
    }

    // With previews disabled the "preview" is the full blur, so hovering never
    // reveals more than the page-wide setting allows.
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
        if (this.suppressesBackground || this._previewActive || !this.isBlurred || !this.element) return
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
        if (this._renderState !== 'blur' || this.suppressesBackground) return
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
                // A removed iframe still has our listeners on its child window.
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

// Wraps matched words in .phobia-word-cover spans and owns their lifecycle.
// While inactive no new covers are made. A wrapper the user revealed stays a
// wrapper (so its text remains indexed) but is projected as uncovered.
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

    // Covering needs a non-disabled mode, the toggle and at least one valid
    // target; otherwise every existing cover is unwrapped. DISABLED mode leaves
    // words readable on purpose.
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

    // Re-asserts the cover classes after the page rewrote a wrapper's class
    // attribute. A wrapper that became editable is removed instead: a span
    // inside an editor breaks the caret and the editor's own model.
    repairProjection(element) {
        if (!this._ownedWrappers.has(element)) return false
        if (PageTextIndex.isEditableElement(element)) {
            this._unwrap(element)
            return true
        }
        markInternalMutationTarget(element)
        const revealed = this._revealedWrappers.has(element)
        element.classList.toggle('phobia-word-cover', !revealed)
        element.classList.toggle('phobia-word-permanent-uncover', revealed)
        return true
    }

    coverTextNode(textNode, directMatches) {
        if (!this._active || !textNode || !textNode.parentNode) return false
        const parentElement = PageTextIndex.composedParent(textNode)
        if (!parentElement || PageTextIndex.closestAcrossRoots(parentElement, PageTextIndex.EXCLUDED_SELECTOR)) return false
        if (PageTextIndex.isEditableElement(parentElement)) return false
        if (this._findOwnedWrapper(parentElement)) return false

        // directMatches is what the index found in this node; a word is covered
        // only if it is also a current target, since the set may predate a
        // configure() that removed it.
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
        textNode.parentNode.replaceChild(split.fragment, textNode)
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

    // Drops covers the page removed and covers an editor has since grown over.
    prune() {
        Array.from(this._ownedWrappers).forEach((wrapper) => {
            if (wrapper.isConnected === false || PageTextIndex.isEditableElement(wrapper)) this._unwrap(wrapper)
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
        // Fail-closed until applyProtectionMode installs the real settings:
        // the stylesheet's 40px blur and ALWAYS_BLUR, never the defaults'
        // weaker blur or hover preview.
        this.settings = this._cloneDefaults()
        this.blurPixels = FAIL_CLOSED_BLUR_PIXELS
        this.blurFilter = `blur(${this.blurPixels})`
        this.mode = PROTECTION_MODE.ALWAYS_BLUR
        // Bumped by every policy application, scheduled analysis and manual
        // command. An async verdict whose generation is stale is dropped, so an
        // older answer can never overwrite a newer state.
        this._policyGeneration = 0
        // The committed verdict. applyProtectionMode resets it to fail-closed;
        // only applyPageResult commits an analysis result into it.
        this._pageAnalysisResult = { ...FAIL_CLOSED_RESULT }
        // Media identities as of the last committed clear verdict on this URL.
        // While a re-analysis is pending, unchanged media keep their release
        // instead of flashing blurred; anything new or changed does not.
        this._clearedMedia = new WeakMap()
        this._clearedUrl = null
        this._policyUrl = currentPolicyUrl()
        this._registry = new VisualRegistry(this)
        // Element -> fingerprint of what the user revealed; the reveal lapses
        // as soon as the element starts showing something else.
        this._explicitReveals = new WeakMap()
        // _loadedIframeFingerprints: src/srcdoc identity at the load this
        // controller observed; a later attribute change no longer matches and
        // reads as 'not loaded yet'. _iframeEditorStates: last-seen editability
        // of each child document, so a flip re-evaluates the backgrounds above
        // the frame.
        this._loadedIframeFingerprints = new WeakMap()
        this._iframeEditorStates = new WeakMap()
        // Iframes in _pendingIframeNavigations have a new document that has
        // not loaded yet: they stay blurred and no ticket can clear them. The
        // guards are listeners inside each child window for the guard events.
        this._pendingIframeNavigations = new WeakSet()
        this._iframeNavigationGuards = new WeakMap()
        // _frameAggregateClear: the service worker confirmed every frame under
        // this document is clear. _verifiedClearIframes: the subset released
        // one by one through tickets when only some are. The epoch stamps each
        // request so a late answer to an earlier question is ignored.
        this._frameAggregateClear = false
        this._frameAggregateEpoch = 0
        this._frameAggregateRefreshTimer = null
        this._frameAggregateRetryAttempt = 0
        this._verifiedClearIframes = new Set()
        // Parent side of the per-iframe tickets. The worker arms this document
        // with fresh tokens, each clear child posts its token to the parent
        // window, and onClear releases exactly the iframe whose contentWindow
        // sent it. isCurrent ties tickets to the epoch they were minted for,
        // canClear refuses a frame mid-navigation, fingerprint catches an
        // owner whose content changed between arming and the posted message.
        this._frameClearance = new FrameClearance({
            frames: () => this._registry.all().filter(node => node.kind === 'iframe').map(node => node.element),
            fingerprint: element => JSON.stringify([
                getMediaFingerprint(element), element.getAttribute('sandbox'), element.baseURI || '',
            ]),
            isCurrent: epoch => epoch === this._frameAggregateEpoch && this._shouldRefreshFrameAggregate(),
            canClear: element => !this._pendingIframeNavigations.has(element),
            onClear: element => {
                this._verifiedClearIframes.add(element)
                this._applyResultToNode(this._registry.get(element), this._currentVisualResult())
            },
        })
        // This document's own back/forward-cache trip: child frames may have
        // navigated while it was frozen, so the aggregate is dropped on hide
        // (nothing to refresh while frozen) and asked again on restore.
        window.addEventListener('pagehide', () => this._invalidateFrameAggregate({ refresh: false }))
        window.addEventListener('pageshow', event => {
            if (event.persisted) this._invalidateFrameAggregate()
        })
        // Pending from birth: no verdict exists, so the visual result is
        // fail-closed until applyPageResult commits one.
        this._analysisPending = true
        this._lastFrameStatusSignature = ''
        // protection.css blurs every img/video/iframe unconditionally, DISABLED
        // mode included, so the controller counters it with an inline
        // filter:none !important per element. This remembers the page's own
        // inline filter so it can be put back.
        this._disabledMediaFilters = new WeakMap()
        // "Blur media" from the popup or hotkey, and the blur a child editor
        // iframe inherits from its parent through the EditorFrames handshake.
        // Both override any clear verdict until withdrawn.
        this._manualBlurAllActive = false
        this._inheritedEditorBlur = false
        this._editorDocumentEditable = PageTextIndex.isEditableDocument(document)
        this._observer = null
        this._analysisTimer = null
        this._backgroundTimer = null
        this._stylesheetPollTimer = null
        this._stylesheetFingerprints = new Map()
        this._stylesheetIds = new WeakMap()
        this._nextStylesheetId = 0
        this._backgroundLinks = new WeakSet()
        // pending -> scanning -> ready, projected onto <html> for protection.css:
        // pending hides every background-image page-wide, scanning makes the
        // page invisible (opacity 0) while the page's own backgrounds are read
        // back, ready releases all but the registered ones.
        this._backgroundPhase = 'pending'
        this._backgroundRetries = 0
        this._hasCompletedBackgroundScan = false
        this._mediaEventListenersAttached = false
        this._iframeLifecycleObserver = null
        this._shadowRoots = new Set()
        this._shadowStyleSheet = null
        this._shadowDiscovery = null
        this._shadowDiscoveryTimer = null
        this._onMediaResourceEvent = event => this._handleMediaResourceEvent(event)
        this._onIframeLifecycleLoad = event => this._handleIframeLifecycleLoad(event)
        this._globalRescanTimer = null
        // Bound to window resize and hashchange: resize changes layout and media
        // queries, a hash change re-evaluates :target, and either can alter
        // computed backgrounds and text visibility with no DOM record. Rescan,
        // and re-run the hover hit test since content may have moved under the
        // pointer.
        this._onGlobalBackgroundStateEvent = () => {
            this._scheduleDebouncedRescan()
            this._scheduleHoverPreviewUpdate()
        }
        // Slot reassignment moves light content under a different rendered
        // ancestor, which can put a registered background above or below an
        // editing surface; re-evaluate those backgrounds, then rescan.
        this._onSlotChange = event => {
            if (this.mode === PROTECTION_MODE.DISABLED) return
            const touched = new Set()
            this._invalidateBackgroundAncestors(event.target, touched)
            touched.forEach(node => this._applyResultToNode(node, this._currentVisualResult()))
            this._scheduleDebouncedRescan()
        }
        this._earlyCoverReleased = false
        this._stylesheetReindexTimer = null
        // True once applyProtectionMode has run; settings shortcuts that only
        // re-style the page must not pre-empt that first application.
        this.protectionApplied = false
        this._wordCoverManager = new WordCoverManager()
        // The index reports matched words per text node for covering, and page
        // edits inside our own wrappers so a cover is rebuilt rather than left
        // half-covering a changed word.
        this._pageTextIndex = new PageTextIndex({
            onDirectMatch: (node, matches) => this._wordCoverManager.coverTextNode(node, matches),
            onOwnedCoverChange: wrapper => this._wordCoverManager.reconcileCover(wrapper),
            isOwnedCover: element => this._wordCoverManager.ownsWrapper(element),
            hasOwnedCovers: () => this._wordCoverManager.ownedCount > 0,
        })
        this._wordCoverManager.attachIndex(this._pageTextIndex)
        // Both ends of the same-origin editor handshake: as a child, the
        // parent's blur/clear request arrives as inherited protection; as a
        // parent, a child that announces readiness is registered as media.
        this._editorFrames = new EditorFrames({
            applyInheritedProtection: blurred => this._applyInheritedEditorProtection(blurred),
            onFrameReady: frame => {
                if (this.mode === PROTECTION_MODE.DISABLED) return
                const touched = this._registerMedia(frame)
                this._invalidateBackgroundAncestors(frame, touched)
                touched.forEach(node => this._applyResultToNode(node, this._currentVisualResult()))
            },
        })
        this._hoverNode = null
        this._hoverPoint = null
        this._lastHoverUpdateAt = 0
        this._hoverTrailingTimer = null
        // -1 never equals a real word count, so the first clear verdict is
        // deferred at least once while there is media to protect and the page
        // may still be rendering.
        this._lastVerdictWordCount = -1
        this._deferredClearVerdicts = 0
        this._startHoverTracking()
        this._startIframeLifecycleTracking()
        // Capture phase: a page listener on the host cannot stop the event
        // before the controller has seen it.
        document.addEventListener('phobiablocker:shadow-root-attached', event => {
            const host = event.composedPath()[0]
            // The page can dispatch this event too. Only inspect the actual DOM;
            // the event never supplies settings, frame verdicts or commands.
            if (host instanceof Element && host.shadowRoot && this._discoverShadowRoots(host.shadowRoot)) {
                this._initializeShadowRoot(host.shadowRoot)
            }
        }, true)
        // The document stylesheet cannot reach into shadow roots, so roots that
        // stream in while the shared settings read waits are discovered at
        // once and adopt the protection sheet. Everything else (media, text,
        // URL policy, the early-blur hand-off) waits for applyProtectionMode:
        // until then the user's settings are unknown and the page stays in
        // the stylesheet's fail-closed state with early-blur covering words.
        this._discoverShadowRoots(document)
        this._pendingShadowHosts = new Set()
        document.addEventListener('readystatechange', () => this._finishPendingShadowHosts())
        this._startupObserverInit()
    }

    _cloneDefaults() {
        return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => (
            [key, Array.isArray(value) ? [...value] : value]
        )))
    }

    // Roots whose host has left the document are skipped until
    // _pruneShadowRoots drops them.
    _documentRoots() {
        return [document, ...this._shadowRoots].filter(root => !root.host || root.host.isConnected)
    }

    // querySelectorAll stops at shadow boundaries; this spans every known open
    // root beneath `root` as well.
    _queryAll(root, selector) {
        const roots = root === document ? this._documentRoots() : PageTextIndex.collectDomRoots(root)
        return roots.flatMap(tree => Array.from(tree.querySelectorAll?.(selector) || []))
    }

    _observeRoot(root) {
        this._observer?.observe(root, DOM_OBSERVER_OPTIONS)
        this._iframeLifecycleObserver?.observe(root, FRAME_OBSERVER_OPTIONS)
    }

    // One constructed sheet shared by every root: adoptedStyleSheets is the
    // only way to style inside a shadow root without touching its DOM. The
    // array is replaced rather than pushed to because older Chrome exposes it
    // as a frozen array.
    _ensureShadowStyles(root) {
        if (!this._shadowStyleSheet) {
            this._shadowStyleSheet = new CSSStyleSheet()
            this._shadowStyleSheet.replaceSync(SHADOW_PROTECTION_CSS)
        }
        if (!root.adoptedStyleSheets.includes(this._shadowStyleSheet)) {
            root.adoptedStyleSheets = [...root.adoptedStyleSheets, this._shadowStyleSheet]
        }
    }

    _discoverShadowRoots(subtree) {
        return this._collectNewShadowRoots(subtree).length > 0
    }

    // The roots registered by this call, for callers that must know whether
    // any of them changed the frame topology.
    _collectNewShadowRoots(subtree) {
        return PageTextIndex.collectDomRoots(subtree).filter(root => this._registerShadowRoot(root))
    }

    // Only a root that holds frame owners affects the cross-origin frame
    // aggregate; the iframe lifecycle observer reports anything inserted into
    // a registered root later.
    _rootsContainFrameOwners(roots) {
        return roots.some(root => this._queryAll(root, TRACKED_FRAME_OWNER_SELECTOR).length > 0)
    }

    // A component may replace adoptedStyleSheets after attachShadow (Lit,
    // FAST, Stencil), dropping the protection sheet. Content it renders
    // afterwards must be covered at once, not at the next stylesheet poll.
    _ensureShadowStylesForTarget(target) {
        const root = target?.getRootNode?.()
        if (root && this._shadowRoots.has(root)) this._ensureShadowStyles(root)
    }

    // A hyphenated name is a custom element, the usual host of a declarative
    // template; any element can also already hold the <template shadowrootmode>
    // the parser inserted but has not yet turned into a root.
    _mayGainDeclarativeShadowRoot(element) {
        if (element.shadowRoot) return false
        if (element.localName.includes('-')) return true
        return Array.from(element.children || []).some(child => (
            child.localName === 'template' && child.hasAttribute('shadowrootmode')))
    }

    // The parser creates a declarative shadow root without attachShadow, so no
    // notification arrives. A host whose insertion record is delivered before
    // its template is parsed has no root yet; look again once the parser has
    // had a chance to continue: in this task's microtasks, in the next task
    // and, while the document is still being parsed, at every later mutation
    // batch and when parsing ends. The template itself never enters the DOM,
    // so a root created by a later network chunk produces no record of its own.
    // `openElements` are the ones the parser still had open when the batch was
    // delivered; they are watched whatever their tag name, because a plain
    // <div> host has nothing but its position to announce the template.
    _scheduleLateShadowRootCheck(elements, openElements = []) {
        const hosts = [...new Set([
            ...elements.filter(element => this._mayGainDeclarativeShadowRoot(element)),
            ...openElements.filter(element => !element.shadowRoot),
        ])]
        if (hosts.length === 0) return
        if (document.readyState === 'loading') hosts.forEach(host => this._rememberPendingShadowHost(host))
        const check = () => hosts.forEach(host => this._adoptLateShadowRoot(host))
        queueMicrotask(check)
        setTimeout(check, 0)
    }

    // The parser inserts nodes in tree order, so the last node of a batch is
    // where it yielded: that node (or the element holding a trailing text or
    // comment node) and its ancestors are the elements still open, and any of
    // them can gain a declarative root from the next chunk. Everything before
    // them is closed and cannot. O(depth) per batch; callers bound the pending set.
    _openParserElements(childLists) {
        const last = this._lastInsertedNode(childLists)
        const chain = []
        let node = last instanceof Element ? last : last?.parentNode
        for (; node instanceof Element; node = node.parentNode) chain.push(node)
        return chain
    }

    _lastInsertedNode(childLists) {
        for (let index = childLists.length - 1; index >= 0; index--) {
            const addedNodes = childLists[index].addedNodes
            if (addedNodes.length > 0) return addedNodes[addedNodes.length - 1]
        }
        return null
    }

    _rememberPendingShadowHost(host) {
        this._pendingShadowHosts.add(host)
        // The oldest hosts are the ones the parser has most likely passed.
        for (const oldest of this._pendingShadowHosts) {
            if (this._pendingShadowHosts.size <= MAX_PENDING_SHADOW_HOSTS) break
            this._pendingShadowHosts.delete(oldest)
        }
    }

    _recheckPendingShadowHosts() {
        this._pendingShadowHosts.forEach(host => this._adoptLateShadowRoot(host))
    }

    // Once parsing has ended a host without a root will not get a declarative
    // one; roots attached later are notified by the main-world shim.
    _finishPendingShadowHosts() {
        if (document.readyState === 'loading') return
        this._recheckPendingShadowHosts()
        this._pendingShadowHosts.clear()
    }

    // Whether the root is initialised is decided now, not when the check was
    // scheduled: settings may have arrived in between, and applyProtectionMode
    // indexed the page without this root. Before settings the root only adopts
    // the protection sheet; the first application indexes it with the page.
    _adoptLateShadowRoot(host) {
        if (!host.isConnected) {
            this._pendingShadowHosts.delete(host)
            return
        }
        const root = host.shadowRoot
        if (!root) return
        this._pendingShadowHosts.delete(host)
        if (this._shadowRoots.has(root)) return
        if (this._discoverShadowRoots(root) && this.protectionApplied) this._initializeShadowRoot(root)
    }

    _registerShadowRoot(root) {
        if (!root.host || !root.host.isConnected) return false
        this._ensureShadowStyles(root)
        if (this._shadowRoots.has(root)) return false
        this._shadowRoots.add(root)
        // Baseline only this new root: recording all sheets here could hide a
        // simultaneous CSSOM change elsewhere before the next polling tick.
        this._stylesheetFingerprints.set(root, this._computeStylesheetFingerprint(root))
        this._observeRoot(root)
        // load, scroll, slotchange and the media resource events are not
        // composed, so the document-level capture listeners never see them from
        // inside a shadow tree; every root needs its own. _pruneShadowRoots must
        // remove exactly this set.
        root.addEventListener('load', this._onIframeLifecycleLoad, true)
        root.addEventListener('scroll', this._onHoverScroll, { capture: true, passive: true })
        root.addEventListener('slotchange', this._onSlotChange)
        // Resource listeners exist only while protection is enabled; a root
        // registered in DISABLED mode gets them from _attachMediaResourceListeners.
        if (this._mediaEventListenersAttached) {
            MEDIA_RESOURCE_EVENTS.forEach(type => root.addEventListener(type, this._onMediaResourceEvent, true))
        }
        return true
    }

    _initializeShadowRoot(root) {
        // Shadow styles can affect :host and ::slotted light content as well
        // as the new tree. Reconcile this host, not unrelated document text.
        const subtree = root.host
        if (this.mode === PROTECTION_MODE.DISABLED) {
            this._showMediaWhileDisabled(subtree)
            return
        }
        // A fallback may find an already-populated root. Index only that new
        // content; its protection stylesheet and observer are already installed.
        const touched = this._registerMedia(subtree)
        this._invalidateBackgroundAncestors(subtree, touched)
        this._scanBackgrounds(subtree).nodes.forEach(node => touched.add(node))
        this._queryAll(subtree, 'link').forEach(link => this._watchStylesheetLink(link))
        const { added, removed } = this._pageTextIndex.applyMutations([{
            type: 'childList', target: subtree, addedNodes: [subtree], removedNodes: [],
        }])
        this._handleVocabularyChange(added, removed)
        touched.forEach(node => this._applyResultToNode(node, this._currentVisualResult()))
        if (this._rootsContainFrameOwners([root])) this._handleFrameTopologyChange({ force: false })
    }

    _cancelShadowDiscovery() {
        clearTimeout(this._shadowDiscoveryTimer)
        this._shadowDiscoveryTimer = null
        this._shadowDiscovery = null
    }

    // Fallback sweep, run from the stylesheet poll, for open roots that neither
    // the attachShadow notification nor the declarative re-checks reported.
    // Incremental: one bounded slice per timer tick, see the discovery budgets.
    _scheduleShadowDiscovery() {
        if (this.mode === PROTECTION_MODE.DISABLED || this._shadowDiscovery) return
        const roots = this._documentRoots()
        this._shadowDiscovery = { roots, seen: new Set(roots), index: 0, walker: null }
        this._shadowDiscoveryTimer = setTimeout(() => this._continueShadowDiscovery(), SHADOW_DISCOVERY_YIELD_MS)
    }

    _continueShadowDiscovery() {
        this._shadowDiscoveryTimer = null
        const state = this._shadowDiscovery
        if (!state || this.mode === PROTECTION_MODE.DISABLED) {
            this._cancelShadowDiscovery()
            return
        }
        const started = performance.now()
        let visited = 0
        while (state.index < state.roots.length && visited < SHADOW_DISCOVERY_NODE_BUDGET &&
            performance.now() - started < SHADOW_DISCOVERY_TIME_BUDGET_MS) {
            const root = state.roots[state.index]
            // A removed cursor can otherwise keep its detached subtree alive
            // and prevent a TreeWalker from reaching the rest of the document.
            if ((root.host && !root.host.isConnected) ||
                (state.walker && !root.contains(state.walker.currentNode))) {
                state.index++
                state.walker = null
                continue
            }
            if (!state.walker) state.walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
            const element = state.walker.nextNode()
            if (!element) {
                state.index++
                state.walker = null
                continue
            }
            visited++
            const shadow = element.shadowRoot
            if (!shadow) continue
            if (!state.seen.has(shadow)) {
                state.seen.add(shadow)
                state.roots.push(shadow)
            }
            if (!this._shadowRoots.has(shadow) && this._discoverShadowRoots(shadow)) {
                this._initializeShadowRoot(shadow)
            }
        }
        if (state.index === state.roots.length) this._shadowDiscovery = null
        else this._shadowDiscoveryTimer = setTimeout(() => this._continueShadowDiscovery(), SHADOW_DISCOVERY_YIELD_MS)
    }

    _pruneShadowRoots() {
        const pruned = [...this._shadowRoots].filter(root => !root.host.isConnected)
        pruned.forEach((root) => {
            this._shadowRoots.delete(root)
            this._stylesheetFingerprints.delete(root)
            root.removeEventListener('load', this._onIframeLifecycleLoad, true)
            root.removeEventListener('scroll', this._onHoverScroll, true)
            root.removeEventListener('slotchange', this._onSlotChange)
            MEDIA_RESOURCE_EVENTS.forEach(type => root.removeEventListener(type, this._onMediaResourceEvent, true))
        })
        if (pruned.length === 0) return
        // Flush records already queued against the dropped roots before the
        // disconnect below discards them.
        this._handleIframeMutations(this._iframeLifecycleObserver.takeRecords())
        // MutationObserver has no unobserve(root). Reconnect to release detached
        // component trees rather than retaining them for the document lifetime.
        this._observer?.disconnect()
        this._iframeLifecycleObserver?.disconnect()
        this._documentRoots().forEach(root => this._observeRoot(root))
        if (this._rootsContainFrameOwners(pruned)) this._handleFrameTopologyChange({ force: false })
    }

    // What this document reports to the service worker. The worker compares
    // frameElementCount with the direct children it sees in the frame tree and
    // refuses the whole-tree verdict on a mismatch (an owner with no reachable
    // document) or when an unsupported owner is present; per-iframe tickets
    // for the clear children can still be issued.
    _frameOwnerState() {
        return {
            frameElementCount: this._queryAll(document, FRAME_OWNER_SELECTOR).length,
            hasUnsupportedFrameOwner: this._queryAll(document, UNSUPPORTED_FRAME_OWNER_SELECTOR).length > 0,
        }
    }

    // Whether this document would release its own media. A child reports it so
    // a parent can release an iframe only once every frame inside has reached
    // this state. DISABLED counts as clear: a whitelisted or switched-off child
    // must not keep its parent blurred.
    _allowsFrameRelease() {
        if (this.mode === PROTECTION_MODE.DISABLED) return true
        return this.mode === PROTECTION_MODE.ANALYZE && !this._manualBlurAllActive && !this._inheritedEditorBlur &&
            !this._analysisPending && this._pageAnalysisResult.shouldBlur === false
    }

    getFrameProtectionStatus() {
        return {
            allowsUnblur: this._allowsFrameRelease(),
            ...this._frameOwnerState(),
        }
    }

    // Child side of the frame protocol: tells the worker this frame's status
    // changed so ancestors re-ask for their aggregate. The top frame has no
    // parent to inform. The signature dedupes bursts unless forced.
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
        // Going pending drops the aggregate without re-asking: the answer
        // depends on this document's own verdict, which is unknown again.
        if (next) this._invalidateFrameAggregate({ refresh: false })
        this._notifyFrameStatusChanged()
    }

    // A parent only asks about its frames once it would release them itself.
    _shouldRefreshFrameAggregate() {
        return this.settings.keepCrossOriginIframesBlurred === true &&
            this.mode === PROTECTION_MODE.ANALYZE && this._allowsFrameRelease() &&
            this._queryAll(document, FRAME_OWNER_SELECTOR).length > 0
    }

    _applyCurrentResultToIframes() {
        const result = this._currentVisualResult()
        this._registry.all().forEach((node) => {
            if (node.kind === 'iframe') this._applyResultToNode(node, result)
        })
    }

    _setFrameAggregateClear(clear) {
        const next = clear === true
        // Individually cleared iframes are revoked with the aggregate, so a
        // changed answer re-blurs them even when the flag itself is unchanged.
        const hadIndividualClearance = this._verifiedClearIframes.size > 0
        this._verifiedClearIframes.clear()
        if (this._frameAggregateClear === next && !hadIndividualClearance) return
        this._frameAggregateClear = next
        this._applyCurrentResultToIframes()
    }

    // Bumping the epoch orphans any in-flight request and any armed tickets.
    // Protocol-governed iframes go back to blurred at once; only a fresh
    // answer releases them.
    _invalidateFrameAggregate({ refresh = true } = {}) {
        this._frameAggregateEpoch++
        this._frameClearance.reset()
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
        this._frameClearance.begin(epoch)
        const ownerState = this._frameOwnerState()
        let response = null
        try {
            response = await withTimeout(chrome.runtime.sendMessage({
                target: 'background',
                type: FRAME_MESSAGES.aggregateRequest,
                epoch,
                individualClearance: true,
                ...ownerState,
            }), ANALYZE_TIMEOUT_MS, 'Embedded-frame check')
        } catch (_) {
            response = null
        }

        // A newer invalidation happened while waiting; its refresh owns the
        // state now and this answer describes a question no longer asked.
        if (epoch !== this._frameAggregateEpoch) return
        if (!this._shouldRefreshFrameAggregate()) {
            this._setFrameAggregateClear(false)
            return
        }
        // The owner set changed in flight: the answer is about another document.
        const currentOwnerState = this._frameOwnerState()
        if (currentOwnerState.frameElementCount !== ownerState.frameElementCount ||
            currentOwnerState.hasUnsupportedFrameOwner !== ownerState.hasUnsupportedFrameOwner) {
            this._invalidateFrameAggregate()
            return
        }

        // Only an answer carrying this epoch counts. A timeout, a wrong epoch or
        // ok:false all read as "not clear"; tokens are approved only when verified.
        const verified = response?.ok === true && response.epoch === epoch
        const clear = verified && response.clear === true
        this._verifiedClearIframes = this._frameClearance.approve(epoch, verified ? response.clearTokens : [])
        this._frameAggregateClear = clear
        this._applyCurrentResultToIframes()
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
        // Arrays are copied so a later storage event cannot mutate the settings
        // this page has already applied.
        this.settings = {
            ...this._cloneDefaults(),
            ...(settings || {}),
            targetWords: Array.isArray(settings?.targetWords) ? [...settings.targetWords] : [],
            whitelistedSites: Array.isArray(settings?.whitelistedSites) ? [...settings.whitelistedSites] : [],
            blacklistedSites: Array.isArray(settings?.blacklistedSites) ? [...settings.blacklistedSites] : [],
        }
        window.PHOBIABLOCKER_DEBUG = this.settings.debugMode === true
        debug('settings.applied', () => ({
            enabled: this.settings.phobiaBlockerEnabled,
            alwaysBlur: this.settings.blurIsAlwaysOn,
            targetWordCount: this.settings.targetWords.length,
            wordCoverEnabled: this.settings.wordCoverEnabled,
        }))
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

    // Stops the analysis, background, rescan and stylesheet timers plus the
    // main observer. The iframe lifecycle observer, the hover tracking, the
    // frame guards and the frame-aggregate refresh stay up: they do not depend
    // on settings and must keep invalidating state while a new policy is applied.
    cancelPendingAnalysis() {
        this._cancelShadowDiscovery()
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

    // The single entry point for a (re)applied policy: first load, settings
    // change, SPA URL change. Every automatic release from the previous policy
    // or URL (clearance snapshot, frame aggregate, armed tickets) is dropped;
    // explicit user reveals are fingerprint-bound and kept, as is a manual
    // blur-all.
    async applyProtectionMode(mode, settings) {
        const generation = ++this._policyGeneration
        const url = currentPolicyUrl()
        this._policyUrl = url
        this._invalidateClearance()
        this.protectionApplied = true
        this.cancelPendingAnalysis()
        this.setSettings(settings)
        this.mode = mode
        debug('protection.mode', () => ({ mode }))
        this._invalidateFrameAggregate({ refresh: false })
        // Pending only when a verdict will actually be sought; ALWAYS_BLUR,
        // DISABLED and a manual blur-all already have their answer.
        this._setAnalysisPending(mode === PROTECTION_MODE.ANALYZE && !this._manualBlurAllActive)
        // Hand-off from early-blur.js, which unwraps its covers and stops its
        // observers on this event, synchronously. enableProtection below
        // re-covers in the same turn, so the words are never painted bare; in
        // DISABLED mode they stay uncovered on purpose.
        this._releaseEarlyWordCover()

        if (mode === PROTECTION_MODE.DISABLED) {
            this.disableProtection()
            this._notifyFrameStatusChanged()
            return
        }

        // Media registered by enableProtection are projected against this
        // fail-closed result until analysis commits a verdict.
        this._pageAnalysisResult = { ...FAIL_CLOSED_RESULT }
        this.enableProtection()
        this.protectAllKnownVisuals()
        this._editorFrames.refresh()
        if (mode === PROTECTION_MODE.ALWAYS_BLUR || this._manualBlurAllActive) {
            this._notifyFrameStatusChanged()
            reportIconStatus('detected')
            return
        }

        const result = await this.analyzeCurrentPage(generation)
        // The page may have navigated or re-applied policy while analysis ran;
        // a verdict for the old state is discarded, never applied.
        if (generation !== this._policyGeneration || url !== currentPolicyUrl()) return
        this.applyPageResult(result)
    }

    enableProtection() {
        const root = document.documentElement
        if (!root) return
        this._discoverShadowRoots(document)
        // Leaving DISABLED mode: take back the inline filter:none before the
        // elements are registered, or VisualNode would record it as the page's.
        this._restoreDisabledMedia(document)
        // 'pending' hides every background page-wide until the full scan below
        // decides which elements actually carry an image.
        this._setBackgroundPhase('pending')
        this._syncRootProjection()
        this._ensureFrameMarker()

        // stop() before configure(): covers made for the previous targets are
        // unwrapped so build() indexes clean text and re-covers against the
        // current ones in this same synchronous turn.
        this._wordCoverManager.stop()
        this._wordCoverManager.configure(this.settings, this.mode)
        this._pageTextIndex.build(document.body || root)
        this._registerMedia(document)
        this._scanBackgrounds(document, { full: true })
        this._queryAll(document, 'link[rel~="stylesheet"]').forEach(link => this._watchStylesheetLink(link))
        // Observation starts only after the initial build: every record from
        // the writes above would be our own.
        this._resumeObservation()
    }

    // Re-arms everything cancelPendingAnalysis() tears down.
    _resumeObservation() {
        this._attachMediaResourceListeners()
        this._startStylesheetPolling()
        this._observerInit()
    }

    // DISABLED is not "do nothing": the stylesheet blur and the adopted shadow
    // sheet still apply, so media need an inline counter-projection, and new
    // media and shadow roots must keep being tracked for it.
    disableProtection() {
        this._cancelShadowDiscovery()
        this._editorFrames.clear()
        this._discoverShadowRoots(document)
        const root = document.documentElement
        if (root) {
            // 'ready' plus the phobia-disabled class: backgrounds come back and
            // protection.css restores pointer events and cursors.
            this._setBackgroundPhase('ready')
            this._syncRootProjection()
        }
        this._clearHoverPreview()
        this._wordCoverManager.stop()
        this._pageTextIndex.clear()
        // Registry nodes hand their elements back to the page's own styling
        // first; only then is the DISABLED filter:none written over them.
        this._registry.clear()
        this._showMediaWhileDisabled(document)
        this._observerInit()
        reportIconStatus('idle')
    }

    // Child side of the editor handshake: the parent's blur/clear request lands
    // here. The return value decides whether the child acks, so it is true only
    // when the whole document was re-registered and the full background scan
    // succeeded; on false the parent keeps its own filter over the iframe.
    _applyInheritedEditorProtection(blurred) {
        // Recorded even before protection is applied or in DISABLED mode, so a
        // later applyProtectionMode projects the parent's request as well.
        this._inheritedEditorBlur = blurred === true
        if (!this.protectionApplied || this.mode === PROTECTION_MODE.DISABLED) return false
        this._wordCoverManager.prune()
        this._registerMedia(document)
        const scan = this._scanBackgrounds(document, { full: true })
        this._registry.all().forEach(node => this._applyResultToNode(node, this._currentVisualResult()))
        this._notifyFrameStatusChanged()
        return scan.success
    }

    // The document itself can become an editing surface (designMode, a
    // contenteditable <body>) without a record on any element the observer
    // watches, so both the mutation handler and the poll re-check it. A flip
    // changes which backgrounds suppress instead of blur and what is indexed.
    _refreshEditorState() {
        const editable = PageTextIndex.isEditableDocument(document)
        if (editable === this._editorDocumentEditable) return
        this._editorDocumentEditable = editable
        const touched = new Set()
        this._invalidateBackgroundSubtree(document, touched)
        touched.forEach(node => this._applyResultToNode(node, this._currentVisualResult()))
        this._wordCoverManager.prune()
        this._reindexAfterStylesheetChange()
        this._editorFrames.refresh()
    }

    _mediaElements(root) {
        const elements = []
        if (root?.nodeType === Node.ELEMENT_NODE && root.matches?.(MEDIA_SELECTOR)) elements.push(root)
        this._queryAll(root, MEDIA_SELECTOR).forEach(element => elements.push(element))
        return elements
    }

    // protection.css blurs img/video/iframe with !important in every mode, so
    // in DISABLED mode the page's own inline filter (or none) is re-asserted
    // over it with !important. appliedValue is what this script last wrote; on
    // a style record (refreshOriginal) a differing filter is the page's new value.
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

    // Removed iframes keep our listeners on their child window until disarmed.
    // The registry may never have held them (guards are also armed on load in
    // DISABLED mode), so the removed subtree itself is walked.
    _disarmDetachedIframeGuards(root) {
        this._mediaElements(root).forEach((element) => {
            if (element instanceof HTMLIFrameElement && element.isConnected === false) {
                this._disarmIframeNavigationGuard(element)
            }
        })
    }

    // Mutation handling while DISABLED: shadow roots keep being tracked so a
    // later enable finds them, new media get the filter:none counter-projection,
    // and frame-owner changes are still reported because an ancestor frame's
    // aggregate counts this document's children.
    _handleDisabledMutations(records) {
        let elementsChanged = false
        const newRoots = []
        const addedSubtrees = []
        records.forEach((mutation) => {
            if (mutation.type !== 'childList') return
            if (mutation.target.shadowRoot && !this._shadowRoots.has(mutation.target.shadowRoot)) {
                newRoots.push(...this._collectNewShadowRoots(mutation.target))
                this._showMediaWhileDisabled(mutation.target)
            }
            mutation.removedNodes.forEach(node => {
                if (node.nodeType !== Node.ELEMENT_NODE) return
                elementsChanged = true
                this._discardDisabledMediaState(node)
            })
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) addedSubtrees.push(node)
            })
        })
        PageTextIndex.minimalRoots(addedSubtrees).forEach(node => {
            newRoots.push(...this._collectNewShadowRoots(node))
        })
        if (elementsChanged) this._pruneShadowRoots()
        if (this._rootsContainFrameOwners(newRoots)) this._handleFrameTopologyChange({ force: false })

        records.forEach((mutation) => {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => this._showMediaWhileDisabled(node))
                return
            }
            if (mutation.type !== 'attributes' || !(mutation.target instanceof Element)) return
            // A page rewriting <html>'s class would drop phobia-disabled and let
            // protection.css blur again.
            if (mutation.target === document.documentElement) this._syncRootProjection()
            if (mutation.target.matches(MEDIA_SELECTOR)) {
                this._showMediaWhileDisabled(mutation.target, {
                    refreshOriginal: mutation.attributeName === 'style',
                })
            }
        })
    }

    // Whether a style record on counter-projected media was the page's doing:
    // either the filter is no longer what this script wrote, or something other
    // than the filter changed. Our own filter write alone is not a page edit.
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
        // DISABLED always reads as ready: the page-wide background-image:none
        // and the scanning opacity:0 must never apply while the extension is off.
        const shouldScan = !disabled && this._backgroundPhase === 'scanning'
        const isReady = disabled || this._backgroundPhase === 'ready'

        markInternalMutationTarget(root)
        root.classList.toggle('phobia-disabled', disabled)
        root.toggleAttribute(BACKGROUND_SCANNING_ATTR, shouldScan)
        if (isReady) root.setAttribute(BACKGROUND_READY_ATTR, '1')
        else root.removeAttribute(BACKGROUND_READY_ATTR)
    }

    // Blurs every registered node against the fail-closed result. Explicit
    // reveals and retained clearance still win inside _applyResultToNode, so
    // "all" means everything without a user- or verdict-backed release.
    protectAllKnownVisuals() {
        this._registry.prune()
        this._registry.all().forEach(node => this._applyResultToNode(node, FAIL_CLOSED_RESULT))
    }

    _invalidateClearance() {
        this._clearedMedia = new WeakMap()
        this._clearedUrl = null
    }

    // Retention is the one path that leaves media released while a verdict is
    // pending, so every condition is a reason to refuse: iframes are governed
    // by the frame protocol, any mode or override other than a plain ANALYZE
    // clear verdict, a different URL, or media whose content changed since.
    _canRetainClearance(node) {
        if (node.kind === 'iframe' || this.mode !== PROTECTION_MODE.ANALYZE ||
            this._manualBlurAllActive || this._inheritedEditorBlur || this._pageAnalysisResult.shouldBlur ||
            this._clearedUrl !== currentPolicyUrl()) return false
        const saved = this._clearedMedia.get(node)
        const current = this._clearanceIdentity(node)
        return Boolean(saved && current.fingerprint && saved.fingerprint === current.fingerprint &&
            saved.resource === current.resource && saved.stream === current.stream)
    }

    _clearanceIdentity(node) {
        const element = node.element
        return {
            fingerprint: getMediaFingerprint(element, node.kind === 'background' ? node.backgroundImage : null),
            // Automatic clearance is stricter than an explicit user reveal:
            // responsive selection and resolved URLs can change the resource.
            resource: JSON.stringify([element.currentSrc || '', element.src || '', element.baseURI || '']),
            stream: element instanceof HTMLVideoElement ? element.srcObject : null,
        }
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
        // Commit point. The clearance snapshot is rebuilt from scratch for a
        // clear verdict so only media as they are right now may be retained
        // later; pending is cleared before the nodes are applied, or each one
        // would still read as fail-closed.
        this._pageAnalysisResult = result
        this._invalidateClearance()
        if (!result.shouldBlur) {
            this._clearedUrl = currentPolicyUrl()
            nodes.forEach(node => {
                const identity = this._clearanceIdentity(node)
                if (identity.fingerprint) this._clearedMedia.set(node, identity)
            })
        }
        this._setAnalysisPending(false)
        this._notifyFrameStatusChanged()
        nodes.forEach(node => this._applyResultToNode(node, result))
        debug('media.protection-applied', () => ({ mediaCount: nodes.length, shouldBlur: result.shouldBlur }))
        this._scheduleFrameAggregateRefresh()
        reportIconStatus(result.shouldBlur ? 'detected' : 'idle')
        // The pointer may already be resting on media that only just became
        // blurred, and a stationary pointer produces no further events.
        this._scheduleHoverPreviewUpdate()
    }

    // User action (context menu, unblur all). The reveal is tied to the media
    // fingerprint, so an element that later shows different content goes back
    // to the verdict; an element with no fingerprint cannot be revealed at
    // all rather than being revealed for whatever it shows next.
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

    // Only a load this controller observed counts as complete, and only for the
    // src/srcdoc it saw: a later attribute change makes the fingerprint differ,
    // which _isIframeNavigationComplete reads as "not loaded yet".
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
        this._invalidateClearance()
        this.cancelPendingAnalysis()
        this._manualBlurAllActive = blurAllActive
        this._setAnalysisPending(false)
    }

    // "Blur media": withdraws every explicit reveal. The override survives
    // settings changes and same-document URL changes; only unblurAll clears
    // it. Word covers are not re-activated here; after an unblurAll they
    // return with the next configure().
    blurAll() {
        this._beginManualCommand(true)
        this._invalidateFrameAggregate({ refresh: false })
        this._explicitReveals = new WeakMap()
        this._registerMedia(document)
        this._scanBackgrounds(document, { full: true })
        this.protectAllKnownVisuals()
        this._resumeObservation()
        this._notifyFrameStatusChanged()
        reportIconStatus('detected')
    }

    // "Reveal current content": every registered node becomes an explicit
    // reveal tied to its current content, covers are dropped and covering is
    // switched off. The pending analysis is cancelled so a late verdict cannot
    // re-blur what the user just revealed; media added later still follow it.
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

    // The single decision point for one node. Order matters: an acknowledged
    // editor iframe is released because the child protects its own media; an
    // explicit reveal beats every verdict; retained clearance may hold through
    // a pending analysis; everything else blurs unless the verdict is clear.
    _applyResultToNode(node, result) {
        if (!node || !node.element || node.element.isConnected === false) return
        node.refreshBackgroundMode()
        // Same-origin editable iframe whose current document is the one the
        // guard knows (loaded, not mid-navigation). release() asks the child to
        // apply this document's state and is true only on a matching ack; the
        // outer filter then drops so the editor text stays readable.
        if (node.kind === 'iframe' && !this._pendingIframeNavigations.has(node.element) &&
            this._iframeNavigationGuards.get(node.element)?.active?.frameDocument === node.element.contentDocument &&
            this._editorFrames.release(node.element, !this.isExplicitlyRevealed(node.element) &&
                (this._analysisPending || this._manualBlurAllActive || this._inheritedEditorBlur || result.shouldBlur))) {
            node.unblur()
            return
        }
        if (this.isExplicitlyRevealed(node.element)) {
            node.unblur({ explicit: true })
            return
        }
        if (this._analysisPending && this._canRetainClearance(node)) {
            node.unblur()
            return
        }
        if (this._analysisPending || this._manualBlurAllActive || this._inheritedEditorBlur || result.shouldBlur) {
            node.blur()
            return
        }
        // A clear verdict for this document is not enough for a cross-origin
        // iframe: it stays blurred until the worker has confirmed the whole
        // aggregate or this exact frame holds a verified ticket, and never
        // while a navigation is pending.
        if (node.kind === 'iframe' && this.settings.keepCrossOriginIframesBlurred) {
            const navigationPending = this._pendingIframeNavigations.has(node.element)
            if (navigationPending || (!this._frameAggregateClear && !this._verifiedClearIframes.has(node.element) &&
                isCrossOriginIframe(node.element, this._isIframeNavigationComplete(node.element)))) {
                node.blur()
                return
            }
        }
        node.unblur()
    }

    _registerMedia(root, { subtree = true } = {}) {
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
            if (kind === 'iframe') {
                this._armIframeNavigationGuard(element)
                this._refreshIframeEditorState(element, touched)
            }
            touched.add(node)
        }

        if (root.nodeType === Node.ELEMENT_NODE) register(root)
        try {
            if (subtree) this._queryAll(root, MEDIA_SELECTOR).forEach(register)
        } catch (_) { /* Detached roots have no media to register. */ }
        return touched
    }

    // A mutation on <source> or <picture> changes what the owning <img> or
    // <video> displays without a record on the media element itself, so the
    // owner is (re)registered and re-applied instead.
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
            this._registerMedia(owner, { subtree: false }).forEach(node => touched.add(node))
        })
    }

    // A background node blurs or suppresses depending on whether an editing
    // surface sits beneath it, so a change anywhere in a subtree marks every
    // background ancestor for re-evaluation in refreshBackgroundMode.
    _invalidateBackgroundAncestors(element, touched) {
        const pending = [element]
        const seen = new Set()
        while (pending.length > 0) {
            const current = pending.pop()
            if (!current || seen.has(current)) continue
            seen.add(current)
            const node = this._registry.get(current)
            if (node?.kind === 'background') {
                node._backgroundModeDirty = true
                touched.add(node)
            }
            // A slotted control has both an owning ancestor and a rendered
            // ancestor. Either can have a background that would blur the editor.
            pending.push(current.parentNode || current.host, current.assignedSlot)
        }
    }

    // An iframe whose document turns editable (or stops being so) changes how
    // its own node and the backgrounds above it are projected, with no record
    // in the parent document. The first look only records the state.
    _refreshIframeEditorState(frame, touched) {
        let editable = false
        try {
            editable = PageTextIndex.isEditableDocument(frame.contentDocument)
        } catch (_) { /* Cross-origin documents cannot expose an editing surface. */ }
        const previous = this._iframeEditorStates.get(frame)
        this._iframeEditorStates.set(frame, editable)
        if (previous === undefined || previous === editable) return
        this._invalidateBackgroundAncestors(frame, touched)
        const node = this._registry.get(frame)
        if (node) touched.add(node)
    }

    _refreshIframeEditorStates() {
        // Disabled or uninstrumented children may never emit readiness. Read
        // only each known frame's editing flag, never its descendant tree.
        const touched = new Set()
        this._registry.all().forEach(node => {
            if (node.kind === 'iframe') this._refreshIframeEditorState(node.element, touched)
        })
        touched.forEach(node => this._applyResultToNode(node, this._currentVisualResult()))
    }

    // Counterpart of _invalidateBackgroundAncestors for an editability change
    // on root itself: every registered background inside it may now sit above
    // (or no longer above) an editing surface.
    _invalidateBackgroundSubtree(root, touched) {
        this._registry.all().forEach(node => {
            if (node.kind !== 'background') return
            for (let current = node.element; current; current = current.parentNode || current.host) {
                if (current !== root) continue
                node._backgroundModeDirty = true
                touched.add(node)
                break
            }
        })
    }

    _scanBackgrounds(root, options = {}) {
        const full = options.full === true
        const documentRoot = document.documentElement
        const touched = new Set()
        if (!root || !documentRoot) return { nodes: touched, success: false }
        // Disabled protection must not register or project onto anything.
        if (this.mode === PROTECTION_MODE.DISABLED) return { nodes: touched, success: false }

        if (full) this._setBackgroundPhase('scanning')

        try {
            const candidates = []
            if (root.nodeType === Node.ELEMENT_NODE) candidates.push(root)
            this._queryAll(root, '*').forEach(element => candidates.push(element))
            const backgroundState = new Map()

            candidates.forEach((element) => {
                if (!(element instanceof Element)) return
                if (element.matches('head, script, style, link, meta, title, img, video, iframe')) return
                // Read the page's background, not our suppression projection,
                // including during a partial scan of a changed control.
                this._registry.get(element)?.prepareBackgroundScan()
                backgroundState.set(element, getComputedBackgroundImage(element))
            })

            backgroundState.forEach((backgroundImage, element) => {
                const existing = this._registry.get(element)
                if (backgroundImage) {
                    if (existing && existing.kind !== 'background') return
                    const { node } = this._registry.register(element, 'background')
                    if (existing) node._backgroundModeDirty = true
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
            // Whatever the scan found so far is untrustworthy; fail closed on
            // every background already registered.
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

    // What nodes are projected against right now: fail-closed whenever any
    // override or a pending analysis applies, otherwise the committed verdict.
    _currentVisualResult() {
        if (this._analysisPending || this.mode === PROTECTION_MODE.ALWAYS_BLUR ||
            this._manualBlurAllActive || this._inheritedEditorBlur) {
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
        this._wordCoverManager.prune()
        this._pageTextIndex.build(document.body || document.documentElement)
        this._stylesheetFingerprints = this._captureStylesheetFingerprints()
        const words = this._pageTextIndex.getWords()
        const currentWords = new Set(words)
        this._handleVocabularyChange(new Set(words.filter(word => !previousWords.has(word))),
            new Set([...previousWords].filter(word => !currentWords.has(word))))
        this._scheduleFullBackgroundRescan()
    }

    _handleVocabularyChange(added, removed) {
        if (this.mode !== PROTECTION_MODE.ANALYZE || this._manualBlurAllActive) return
        if (added.size > 0) {
            // Only the offscreen analyser can tell whether a new word is an
            // inflection of a trigger (spiders, mice, fell). A literal check
            // here would keep cleared media revealed while such a word is
            // already on the page, so any new vocabulary drops the clearance.
            this._invalidateClearance()
            // Mark pending before touching media. Only a committed clear verdict
            // can preserve an unchanged node across incremental analysis.
            this._scheduleAnalysis()
            this.protectAllKnownVisuals()
            return
        }
        // Removing words can only turn a blur verdict into a clear one, so a
        // re-analysis is needed only when a matched word left or the pending
        // analysis was fed text that is gone; media stay as they are meanwhile.
        const pendingInputRemoved = removed.size > 0 && this._analysisPending
        const matchedWordRemoved = removed.size > 0 && this._pageAnalysisResult.shouldBlur === true &&
            this._pageAnalysisResult.matchedInputWords.some(word => removed.has(word))
        if (pendingInputRemoved || matchedWordRemoved) this._scheduleAnalysis()
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
            const scan = this._scanBackgrounds(document, { full: true })
            // A failed child scan cannot acknowledge editor release. Tell its
            // parent when a scheduled retry succeeds, outside the handshake.
            if (scan.success && PageTextIndex.isEditableDocument(document)) this._editorFrames.refresh()
        }, 0)
    }

    // A <link> stylesheet arriving from the network changes visibility with no
    // DOM record; its load event is the only signal. rel is read when the event
    // fires, not when the link was found, since pages flip preload links to
    // stylesheet once they have loaded.
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
            const element = node.nodeType === Node.ELEMENT_NODE ? node : null
            if (!element) return false
            if (element.tagName === 'STYLE') return true
            if (element.tagName === 'LINK' && String(element.rel || '').toLowerCase() === 'stylesheet') return true
            return Boolean(element.querySelector?.('style, link[rel~="stylesheet"]'))
        })
    }

    _captureStylesheetFingerprints() {
        return new Map(this._documentRoots().map(root => [root, this._computeStylesheetFingerprint(root)]))
    }

    _computeStylesheetFingerprint(root) {
        // 32-bit FNV-1a. A collision only means one stylesheet change goes
        // unnoticed until the next one changes the hash again.
        let hash = 2166136261
        let itemCount = 0
        const update = (value) => {
            const text = String(value ?? '')
            itemCount++
            for (let index = 0; index < text.length; index++) {
                hash ^= text.charCodeAt(index)
                hash = Math.imul(hash, 16777619)
            }
        }
        // Deliberately cheap: identity, enabled state, media match and rule
        // count per sheet. That still detects sheets being added, removed,
        // toggled, media-flipped, or edited through insertRule/deleteRule,
        // without hashing every rule's cssText on every poll. Viewport size is
        // excluded because the debounced resize listener already rescans.
        // Keep each root's cascade order, including adopted sheets.
        const sheets = [...Array.from(root.styleSheets || []), ...Array.from(root.adoptedStyleSheets || [])]
        sheets.forEach(sheet => {
            if (!sheet) return
            if (!this._stylesheetIds.has(sheet)) this._stylesheetIds.set(sheet, ++this._nextStylesheetId)
            update(this._stylesheetIds.get(sheet))
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

    // The 2 s tick is also the catch-all for state that produces no mutation
    // record: designMode flips, editable child documents, shadow roots the
    // notifier missed and protection sheets a component dropped from
    // adoptedStyleSheets.
    _startStylesheetPolling() {
        clearInterval(this._stylesheetPollTimer)
        this._stylesheetFingerprints = this._captureStylesheetFingerprints()
        this._stylesheetPollTimer = setInterval(() => {
            if (this.mode === PROTECTION_MODE.DISABLED) return
            this._refreshEditorState()
            this._editorFrames.prune()
            this._refreshIframeEditorStates()
            // Keep the native attachShadow fallback, but yield between bounded
            // TreeWalker slices instead of enumerating the whole page here.
            this._scheduleShadowDiscovery()
            this._shadowRoots.forEach(root => {
                if (root.host.isConnected) this._ensureShadowStyles(root)
            })
            const next = this._captureStylesheetFingerprints()
            const changed = next.size !== this._stylesheetFingerprints.size ||
                [...next].some(([root, fingerprint]) => this._stylesheetFingerprints.get(root) !== fingerprint)
            this._stylesheetFingerprints = next
            if (changed) this._handleStylesheetChange()
        }, STYLESHEET_POLL_INTERVAL_MS)
    }

    // load, loadeddata and the rest do not bubble, so they are caught in the
    // capture phase; and a non-composed event never leaves its shadow root, so
    // every known root gets its own listener rather than only the document.
    _attachMediaResourceListeners() {
        if (this._mediaEventListenersAttached) return
        this._mediaEventListenersAttached = true
        this._documentRoots().forEach(root => MEDIA_RESOURCE_EVENTS.forEach(type => {
            root.addEventListener(type, this._onMediaResourceEvent, true)
        }))
        window.addEventListener('resize', this._onGlobalBackgroundStateEvent)
        window.addEventListener('hashchange', this._onGlobalBackgroundStateEvent)
    }

    _detachMediaResourceListeners() {
        if (!this._mediaEventListenersAttached) return
        this._mediaEventListenersAttached = false
        this._documentRoots().forEach(root => MEDIA_RESOURCE_EVENTS.forEach(type => {
            root.removeEventListener(type, this._onMediaResourceEvent, true)
        }))
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
            // Guards live inside the child window, so only a same-origin, fully
            // loaded document can be guarded. A sandboxed frame is treated as
            // cross-origin by isCrossOriginIframe and gets no guard at all.
            if (!(element instanceof HTMLIFrameElement) || element.isConnected === false ||
                element.hasAttribute('sandbox')) {
                this._disarmIframeNavigationGuard(element)
                return
            }
            frameWindow = element.contentWindow
            frameDocument = element.contentDocument
            // Still loading: the load listener re-arms once the document has
            // settled. A guard left over from a previous document is stale.
            if (!frameWindow || !frameDocument || frameDocument.readyState !== 'complete') {
                const state = this._iframeNavigationGuards.get(element)
                if (state?.active && state.active.frameDocument !== frameDocument) {
                    this._disarmIframeNavigationGuard(element, state.active)
                }
                return
            }
            // Reading location.href throws for a cross-origin document; the
            // catch below turns that into "no guard".
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
        // The document came back from the back/forward cache: its parked guard
        // becomes active again and gets its navigation-start listeners back.
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

        // pagehide with persisted=true means the document is going into the
        // back/forward cache and may return via pageshow, so its guard is
        // parked (keeping only the pageshow listener) instead of dropped; the
        // oldest parked guard is evicted past the bound. Anything else ends it.
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
        // The restored document must still be the frame's current one and
        // fully loaded; otherwise this pageshow is for a document the frame
        // has already moved on from.
        try {
            if (element.isConnected === false || element.hasAttribute('sandbox') ||
                element.contentDocument !== guard.frameDocument ||
                element.contentWindow !== guard.frameWindow ||
                guard.frameDocument.readyState !== 'complete' ||
                typeof guard.frameWindow.location.href !== 'string') return
        } catch (_) {
            return
        }

        // A restored document is re-judged like a fresh load: blur, re-arm, and
        // only if this guard is the active one again mark the navigation done.
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
        if (node.suppressesBackground) return false
        if (node.kind !== 'video') return true
        const video = node.element
        if (!(video instanceof HTMLVideoElement)) return false
        // YouTube and similar sites insert an empty hover-video layer before it
        // has a frame. Preview the loaded thumbnail underneath until either a
        // poster or current video data can actually be painted.
        return Boolean(video.poster) || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    }

    _updateHoverPreview() {
        // Before the first settings read the preview preference is unknown;
        // revealing media on hover with the default would not be fail-closed.
        if (!this.protectionApplied || this.mode === PROTECTION_MODE.DISABLED ||
            this.settings.previewEnabled !== true) {
            this._clearHoverPreview()
            return
        }
        const point = this._hoverPoint
        if (!point) return

        let found = null
        let backgroundFallback = null
        try {
            const elements = []
            const seen = new Set()
            // document.elementsFromPoint stops at shadow hosts; each open root
            // is asked for its own stack so media inside components are found.
            const visit = (root) => {
                for (const element of root.elementsFromPoint(point.x, point.y)) {
                    if (seen.has(element)) continue
                    seen.add(element)
                    if (element.shadowRoot) visit(element.shadowRoot)
                    elements.push(element)
                }
            }
            visit(document)
            for (const element of elements) {
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

    // Replacing one frame with another keeps the owner count, so iframe
    // mutations force the status message. Shadow-root changes only matter
    // when they add or remove frame owners, which the signature reflects.
    _handleFrameTopologyChange({ force = true } = {}) {
        this._notifyFrameStatusChanged(force)
        this._invalidateFrameAggregate()
    }

    // Runs from construction in every mode: iframe loads and src/srcdoc/sandbox
    // changes must blur the frame and invalidate the aggregate even while the
    // main observer is disconnected. load does not bubble, hence capture.
    _startIframeLifecycleTracking() {
        document.addEventListener('load', this._onIframeLifecycleLoad, true)
        this._iframeLifecycleObserver = new MutationObserver(mutations => this._handleIframeMutations(mutations))
        this._documentRoots().forEach(root => this._iframeLifecycleObserver.observe(root, FRAME_OBSERVER_OPTIONS))
    }

    _handleIframeMutations(mutations) {
        let frameTopologyChanged = false
        // Check the changed subtrees themselves: replacing one frame with
        // another can preserve the owner count while invalidating its verdict.
        const hasFrameOwner = (nodes) => {
            for (const node of nodes) {
                if (node instanceof Element && (node.matches(TRACKED_FRAME_OWNER_SELECTOR) ||
                        this._queryAll(node, TRACKED_FRAME_OWNER_SELECTOR).length > 0)) return true
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
    }

    // A trusted load on an iframe means a new document settled: re-judge the
    // frame, then the backgrounds above it, whose editing-surface state may
    // have changed with the document.
    _handleIframeLifecycleLoad(event) {
        const element = event?.composedPath?.()[0] || event?.target
        if (!(element instanceof HTMLIFrameElement) || !event.isTrusted) return

        const node = this._blurForIframeNavigation(element)
        this._armIframeNavigationGuard(element)
        this._completeIframeNavigation(element, node)
        const touched = new Set()
        this._invalidateBackgroundAncestors(element, touched)
        touched.forEach(visual => this._applyResultToNode(visual, this._currentVisualResult()))
    }

    _handleMediaResourceEvent(event) {
        const element = event?.composedPath?.()[0] || event?.target
        if (!(element instanceof HTMLImageElement) && !(element instanceof HTMLVideoElement)) return
        const node = this._registry.get(element)
        if (!node) return
        // A video that just gained a frame or poster can now preview, and the
        // pointer may already be resting on it.
        if (element instanceof HTMLVideoElement) this._scheduleHoverPreviewUpdate()
        // The picture may have changed under the verdict; re-apply unless the
        // user's reveal still matches what the element shows.
        if (this._explicitReveals.has(element) && this.isExplicitlyRevealed(element)) return
        this._applyResultToNode(node, this._currentVisualResult())
    }

    _observerInit() {
        if (this._observer) this._observer.disconnect()
        this._observer = new MutationObserver((mutations) => this._handleMutations(mutations))
        this._documentRoots().forEach(root => this._observer.observe(root, DOM_OBSERVER_OPTIONS))
    }

    // The observer that runs from document_start until applyProtectionMode
    // replaces it through _observerInit. It only finds shadow roots (declarative
    // ones produce no attachShadow notification) so they adopt the protection
    // stylesheet; it registers no media, indexes no text and applies no policy.
    _startupObserverInit() {
        if (this._observer) this._observer.disconnect()
        this._observer = new MutationObserver((mutations) => this._handleStartupMutations(mutations))
        this._documentRoots().forEach(root => this._observer.observe(root, STARTUP_OBSERVER_OPTIONS))
    }

    _handleStartupMutations(mutations) {
        if (this.protectionApplied) return
        this._recheckPendingShadowHosts()
        // Until settings arrive the adopted sheet is the only protection inside
        // a root (media and covers are not projected against unknown settings),
        // so a component that replaced adoptedStyleSheets before rendering must
        // get the sheet back with the first content it renders.
        mutations.forEach(mutation => this._ensureShadowStylesForTarget(mutation.target))
        const childLists = mutations.filter(mutation => mutation.type === 'childList')
        // The parser reports every insertion against its parent, usually <body>.
        // Walking that target per record would cost a whole-page query each
        // time; like _handleMutations, look at it only when it hosts a root
        // that is not registered yet.
        const hosts = childLists.map(mutation => mutation.target)
            .filter(target => target instanceof Element && target.shadowRoot &&
                !this._shadowRoots.has(target.shadowRoot))
        const added = childLists.flatMap(mutation => [...mutation.addedNodes])
            .filter(node => node instanceof Element && node.isConnected)
        const walkRoots = [...hosts, ...PageTextIndex.minimalRoots(added)].filter(node => node.isConnected)
        walkRoots.forEach(node => this._discoverShadowRoots(node))
        // Every inserted element, not only the outermost, may be a custom host
        // whose template is still to come; while the parser is running, so may
        // any plain element it left open at the end of this batch.
        const openElements = document.readyState === 'loading'
            ? this._openParserElements(childLists).filter(node => node.isConnected)
            : []
        this._scheduleLateShadowRootCheck(added, openElements)
    }

    _handleMutations(mutations) {
        // Only a page whose settings have been applied may re-resolve its policy;
        // before that the defaults must not be analysed against or projected.
        if (this.protectionApplied && this._policyUrl !== currentPolicyUrl()) {
            void this.applyProtectionMode(Policy.resolveProtectionMode(this.settings, location.href), this.settings)
            return
        }
        // Any batch means the parser (or a script) moved on; a declarative root
        // created since the last look leaves no record of its own.
        this._recheckPendingShadowHosts()
        const records = mutations.filter((mutation) => {
            // Editors often write the same class/style string on every key.
            // MutationObserver still reports it, but nothing needs rescanning.
            if (mutation.type === 'attributes' && mutation.target instanceof Element &&
                (mutation.attributeName === 'class' || mutation.attributeName === 'style') &&
                mutation.oldValue === mutation.target.getAttribute(mutation.attributeName)) return false
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
        debug('dom.mutations', () => ({ mutationCount: records.length }))
        if (this.mode === PROTECTION_MODE.DISABLED) {
            this._handleDisabledMutations(records)
            return
        }
        ANALYSIS_DEBUG_STATE.mutationBatches++

        const touched = new Set()
        const addedSubtrees = []
        const backgroundSubtrees = []
        const discoveredHosts = new Set()
        const newRoots = []
        let stylesheetChanged = false
        let elementsChanged = false
        let attributesChanged = false

        records.forEach((mutation) => {
            // Before any cover or media projection is created in a shadow root.
            this._ensureShadowStylesForTarget(mutation.target)
            stylesheetChanged = stylesheetChanged || this._mutationTouchesStylesheet(mutation)

            if (mutation.type === 'childList') {
                this._addOwningMedia(mutation.target, touched)
                const addedElements = [...mutation.addedNodes].filter(node => node.nodeType === Node.ELEMENT_NODE)
                const removedElements = [...mutation.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE)
                if (addedElements.length > 0 || removedElements) {
                    elementsChanged = true
                    this._invalidateBackgroundAncestors(mutation.target, touched)
                }
                addedSubtrees.push(...addedElements)
                backgroundSubtrees.push(...addedElements)
                if (mutation.target.shadowRoot && !this._shadowRoots.has(mutation.target.shadowRoot)) {
                    const roots = this._collectNewShadowRoots(mutation.target)
                    if (roots.length > 0) {
                        newRoots.push(...roots)
                        discoveredHosts.add(mutation.target)
                        addedSubtrees.push(mutation.target)
                        backgroundSubtrees.push(mutation.target)
                        this._invalidateBackgroundAncestors(mutation.target, touched)
                    }
                }
                return
            }

            if (mutation.type !== 'attributes') return
            const element = mutation.target
            if (!(element instanceof Element)) return
            attributesChanged = true
            if (element === document.documentElement) this._syncRootProjection()
            this._wordCoverManager.repairProjection(element)
            if (element instanceof HTMLLinkElement) this._watchStylesheetLink(element)

            this._registerMedia(element, { subtree: false }).forEach(visual => touched.add(visual))
            this._addOwningMedia(element, touched)
            if (['class', 'style', 'contenteditable', 'role', 'slot', 'name'].includes(mutation.attributeName)) {
                this._invalidateBackgroundAncestors(element, touched)
            }
            if (mutation.attributeName === 'contenteditable') {
                this._invalidateBackgroundSubtree(element, touched)
            }
            if (mutation.attributeName === 'class' || mutation.attributeName === 'style') {
                if (element === document.documentElement || element === document.body) {
                    this._scheduleFullBackgroundRescan()
                } else {
                    backgroundSubtrees.push(element)
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

        // Attribute batches often describe the same editor subtree several
        // times. Discover media only for inserted elements and scan each
        // affected background subtree once, after all cache invalidations.
        PageTextIndex.minimalRoots(addedSubtrees).forEach(element => {
            if (!element.isConnected) return
            newRoots.push(...this._collectNewShadowRoots(element))
            // A media element detached while DISABLED can still carry the
            // filter:none counter-projection if its removal record was lost
            // with the observer; take it back before registration snapshots it.
            this._restoreDisabledMedia(element)
            this._registerMedia(element).forEach(visual => touched.add(visual))
            this._watchStylesheetLink(element)
            this._queryAll(element, 'link').forEach(link => this._watchStylesheetLink(link))
            this._addOwningMedia(element, touched)
        })
        PageTextIndex.minimalRoots(backgroundSubtrees).forEach(element => {
            if (element.isConnected) this._scanBackgrounds(element).nodes.forEach(visual => touched.add(visual))
        })
        this._scheduleLateShadowRootCheck(addedSubtrees.filter(element => element.isConnected))
        if (elementsChanged) {
            this._pruneShadowRoots()
            this._registry.prune()
            this._editorFrames.prune()
        }
        if (this._rootsContainFrameOwners(newRoots)) this._handleFrameTopologyChange({ force: false })
        this._refreshEditorState()
        // Media can be registered or replaced under a pointer that is not
        // moving, so re-run the hit test rather than waiting for another event.
        this._scheduleHoverPreviewUpdate()

        // A host whose shadow root was discovered in this batch is fed to the
        // index as an insertion, so the text inside the root is indexed and
        // covered even though no record described it.
        const { added, removed } = this._pageTextIndex.applyMutations([
            ...records,
            ...[...discoveredHosts].map(host => ({
                type: 'childList', target: host, addedNodes: [host], removedNodes: [],
            })),
        ])
        debug('dom.processed', () => ({
            touchedMediaCount: touched.size, addedWordCount: added.size, removedWordCount: removed.size,
        }))
        if (elementsChanged || attributesChanged) this._wordCoverManager.prune()

        if (stylesheetChanged) {
            this._handleStylesheetChange()
        }

        // No verdict is sought in these states, so vocabulary changes are
        // irrelevant and touched nodes simply blur.
        if (this.mode === PROTECTION_MODE.ALWAYS_BLUR || this._manualBlurAllActive) {
            touched.forEach(node => this._applyResultToNode(node, FAIL_CLOSED_RESULT))
            return
        }

        this._handleVocabularyChange(added, removed)
        touched.forEach(node => this._applyResultToNode(node, this._currentVisualResult()))
    }

    // Debounced. The generation and URL captured here must still be current
    // when the verdict returns, and the mode must still be ANALYZE; otherwise
    // the verdict describes a page state that no longer exists and is dropped
    // (whatever changed that state has already blurred the media).
    _scheduleAnalysis() {
        clearTimeout(this._analysisTimer)
        const generation = ++this._policyGeneration
        const url = currentPolicyUrl()
        this._setAnalysisPending(true)
        this._analysisTimer = setTimeout(async () => {
            this._analysisTimer = null
            const result = await this.analyzeCurrentPage(generation)
            if (generation !== this._policyGeneration || url !== currentPolicyUrl() ||
                this.mode !== PROTECTION_MODE.ANALYZE) return
            this.applyPageResult(result)
        }, ANALYSIS_DEBOUNCE_MS)
    }

    // protection.css keys its startup pointer-events rule on this attribute.
    // early-blur.js writes it first; it is re-asserted here because pages
    // rewrite <html> attributes while booting.
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

// Applied when every settings read failed: blur everything (always-on) and,
// with the trigger list unknown, cover nothing rather than guess.
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
        // A later storage change started a newer read; its result wins.
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

// Same-document navigation (popstate, hashchange, the worker's PB_URL_CHANGED
// relay). Nothing happens before the first settings read: the first
// applyProtectionMode resolves the mode for whatever URL is current by then.
function applyCurrentUrlPolicy() {
    if (!settingsInitialized) return
    const mode = Policy.resolveProtectionMode(controller.settings, location.href)
    if (mode !== controller.mode || controller._policyUrl !== currentPolicyUrl()) {
        void controller.applyProtectionMode(mode, controller.settings)
    }
}

// These events also work while protection is disabled. The service worker
// relays pushState/replaceState changes, which do not emit popstate themselves.
window.addEventListener('popstate', applyCurrentUrlPolicy)
window.addEventListener('hashchange', applyCurrentUrlPolicy)

// Context-menu target resolution. The click point is tried first and the
// smallest registered node containing it wins, so an overlay or a wrapper
// with a background does not swallow the reveal meant for the image under
// it; the composed ancestor chain of the right-clicked node is the fallback.
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

// Unmeasurable or zero-size elements sort last.
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
        current = PageTextIndex.composedParent(current)
    }
    return null
}

// composedPath()[0] is the real target inside an open shadow root, where
// event.target has been retargeted to the host.
document.addEventListener('contextmenu', (event) => {
    lastElementContext = event.composedPath?.()[0] || event.target
    lastContextMenuPoint = { clientX: event.clientX, clientY: event.clientY }
}, true)

// Trigger-word cover toggle from the page itself; the worker dedupes it
// against the chrome.commands delivery of the same press. Only a trusted,
// unmodified Alt+Shift+W outside editable fields counts, so a page script
// cannot switch covers off by synthesising the event.
document.addEventListener('keydown', (event) => {
    if (!event || !event.isTrusted || event.defaultPrevented || event.repeat) return
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return
    if (event.code !== 'KeyW' && String(event.key || '').toLowerCase() !== 'w') return
    const element = event.target?.nodeType === Node.ELEMENT_NODE ? event.target : event.target?.parentElement
    if (element?.matches?.('input, textarea, select, [contenteditable="true"]')) return
    event.preventDefault()
    sendToBackground({ type: 'toggleWordCover', source: 'keyboard' })
}, true)

// Any sync change makes the shared document_start read stale, even one to a
// key this page ignores. Visual-only changes take the re-style shortcut.
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

    if (['PB_URL_CHANGED', 'getTriggeredWords', 'blurAll', 'unblurAll', 'unblur',
        FRAME_MESSAGES.statusRequest, FRAME_MESSAGES.aggregateInvalidated].includes(message.type)) {
        debug('message.received', () => ({ type: message.type }))
    }

    switch (message.type) {
    case 'PB_URL_CHANGED':
        applyCurrentUrlPolicy()
        sendResponse({ ok: true })
        return true

    case FRAME_MESSAGES.statusRequest:
        sendResponse(controller.getFrameProtectionStatus())
        return true

    case FRAME_MESSAGES.clearanceArm:
        sendResponse({ ok: controller._frameClearance.arm(message.epoch, message.tokens) })
        return true

    case FRAME_MESSAGES.clearanceEmit:
        sendResponse({ ok: FrameClearance.emit(message.token) })
        return true

    case FRAME_MESSAGES.aggregateInvalidated:
        controller._invalidateFrameAggregate()
        sendResponse({ ok: true })
        return true

    // Every frame in the tab receives the popup's message; only the top
    // document answers so Chrome delivers exactly one response.
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
        // Nothing is listed unless the committed verdict is a blur: in DISABLED
        // mode or on a clear page the popup must not show detected words.
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

    // Context-menu "Unblur": a covered word under the menu takes precedence
    // over media behind it.
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

// The first application waits for the parsed document so the initial index
// and media registration see the whole static page rather than an empty
// <html>. Until then protection.css and early-blur.js keep the page
// fail-closed.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void readAndApplySettings(), { once: true })
} else {
    void readAndApplySettings()
}
