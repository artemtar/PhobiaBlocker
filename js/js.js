const DEFAULT_BLUR_SLIDER_VALUE = 50 // Matches popup.js slider default
const DEFAULT_PREVIEW_BLUR_STRENGTH = 5 // Matches settings.js default
const INTERACTIVE_ROLES = new Set(['button', 'tab', 'menuitem', 'option', 'treeitem', 'link'])
const PAGE_WORD_RE = /[-\p{L}]+/gu
const SEMANTIC_SCOPE_TAGS = new Set([
    'FIGURE', 'ARTICLE', 'SECTION', 'MAIN', 'ASIDE',
    'HEADER', 'FOOTER', 'NAV', 'LI', 'BLOCKQUOTE'
])
const FALLBACK_SCOPE_MEDIA_LIMIT = 3
const MIN_SCOPE_TEXT_LENGTH = 24
const FAIL_CLOSED_RESULT = Object.freeze({ shouldBlur: true, matchedWords: [] })
const BACKGROUND_SCAN_TAGS = new Set([
    'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER',
    'MAIN', 'FIGURE', 'LI', 'SPAN', 'A', 'BUTTON'
])
const BACKGROUND_HINTED_SCAN_TAGS = new Set(['DIV', 'LI', 'SPAN', 'A', 'BUTTON'])
const BACKGROUND_INLINE_SELECTOR = '[style*="background"]'
const INTERNAL_MUTATION_SUPPRESS_MS = 250

const INTERNAL_MUTATION_DEADLINE = new WeakMap()

const PB_CSS_VARS = Object.freeze({
    blurNs: '--phobiablocker-blurValueAmount',
    blurLegacy: '--blurValueAmount',
    previewNs: '--phobiablocker-previewBlurAmount',
    previewLegacy: '--previewBlurAmount',
})

function _setRootCssVar(name, value, priority) {
    try {
        if (!document || !document.documentElement || !document.documentElement.style) return
        document.documentElement.style.setProperty(name, value, priority || '')
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

function hashStringFNV1a(value) {
    let hash = 0x811c9dc5
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i)
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
    }
    return hash >>> 0
}

function markInternalMutationTarget(node) {
    if (!node) return
    INTERNAL_MUTATION_DEADLINE.set(node, Date.now() + INTERNAL_MUTATION_SUPPRESS_MS)
}

function isInternalMutationTarget(node) {
    if (!node) return false
    const deadline = INTERNAL_MUTATION_DEADLINE.get(node)
    if (!deadline) return false
    if (deadline <= Date.now()) {
        INTERNAL_MUTATION_DEADLINE.delete(node)
        return false
    }
    return true
}

let lastElementContext
let phobiaBlockerEnabled = true
let blurIsAlwaysOn = false
let whitelistedSites = []
let blacklistedSites = []
let previewEnabled = true
let previewBlurStrength = DEFAULT_PREVIEW_BLUR_STRENGTH

let _iconStatusTimer = null
function isTopFrameContext() {
    try {
        return window.top === window
    } catch (_) {
        return false
    }
}

function reportIconStatus(status) {
    if (!isTopFrameContext()) return

    if (status === 'processing') {
        // Show immediately — cancel any pending idle/detected so it doesn't fire after us
        clearTimeout(_iconStatusTimer)
        _iconStatusTimer = null
        try { chrome.runtime.sendMessage({ target: 'background', type: 'iconStatus', status }).catch(() => {}) } catch (_) {}
    } else {
        // Debounce idle/detected: only fire after 800 ms with no new processing cycle.
        // Prevents rapid yellow→normal→yellow flicker from repeated MutationObserver batches.
        clearTimeout(_iconStatusTimer)
        _iconStatusTimer = setTimeout(() => {
            try { chrome.runtime.sendMessage({ target: 'background', type: 'iconStatus', status }).catch(() => {}) } catch (_) {}
        }, 800)
    }
}

// Debug logging function
function debugLog(category, message, data) {
    if (window.PHOBIABLOCKER_DEBUG) {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, -1)
        console.log(`[PhobiaBlocker:${category}] ${timestamp} - ${message}`, data !== undefined ? data : '')
    }
}

// Initialize debug mode from storage
window.PHOBIABLOCKER_DEBUG = false

const PB_ANALYZE_TIMEOUT_MS = 3000

function extractUniquePageWords(textChunks) {
    const uniqueWords = new Set()
    textChunks.forEach((chunk) => {
        if (!chunk || typeof chunk !== 'string') return
        const matches = chunk.match(PAGE_WORD_RE)
        if (!matches) return
        matches.forEach((word) => {
            const normalized = word.toLowerCase()
            if (normalized.length > 2) uniqueWords.add(normalized)
        })
    })
    return [...uniqueWords]
}

async function analyzeScopesWithOffscreen(scopes) {
    let timeoutId = null
    try {
        const response = await Promise.race([
            chrome.runtime.sendMessage({
                target: 'background',
                type: 'PB_ANALYZE_SCOPES',
                scopes: Array.isArray(scopes)
                    ? scopes.map((scope) => ({
                        id: scope.id,
                        words: Array.isArray(scope.words) ? scope.words : [],
                    }))
                    : [],
            }),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Analysis timed out')), PB_ANALYZE_TIMEOUT_MS)
            }),
        ])

        const resultMap = new Map()
        if (response && Array.isArray(response.results)) {
            response.results.forEach((result) => {
                if (!result || typeof result.id !== 'number') return
                resultMap.set(result.id, {
                    shouldBlur: typeof result.shouldBlur === 'boolean' ? result.shouldBlur : true,
                    matchedWords: Array.isArray(result.matchedWords)
                        ? [...new Set(result.matchedWords.filter(Boolean))]
                        : [],
                })
            })
        }
        return resultMap
    } catch (error) {
        debugLog('TextAnalysis', 'Offscreen scope analysis failed, keeping blurred', error)
        const fallbackMap = new Map()
        ;(Array.isArray(scopes) ? scopes : []).forEach((scope) => {
            if (scope && typeof scope.id === 'number') {
                fallbackMap.set(scope.id, FAIL_CLOSED_RESULT)
            }
        })
        return fallbackMap
    } finally {
        if (timeoutId !== null) clearTimeout(timeoutId)
    }
}

class ImageNode {
    constructor(imageNode) {
        if (this.constructor == ImageNode) {
            throw new Error('Abstract classes ImageNode.');
        }
        this._imageNode = imageNode
        this.runningTextProcessing = 0
        this._analysisGeneration = 0
        this.isBlured = false
        this.hasBeenAnalyzed = false // Track if this image has been analyzed at least once
        this._container = undefined  // undefined = not yet resolved; null = resolved but none found
        this._boundMouseEnter = null
        this._boundMouseLeave = null
        this._boundMouseMove = null
        this._pendingParentLeaves = null
        this._triggerWords = null   // normalized words that caused blur (from NLP analysis)
        this._init()
    }

    _init(){
        // FAIL-SAFE: Always blur initially - will unblur later if text analysis determines it's safe
        // If blur() fails, the CSS from early injection will keep it blurred
        try {
            this.blur()
        } catch (blurError) {
            console.error('PhobiaBlocker: Failed to blur element, relying on CSS fallback', blurError)
            // Element will remain blurred via CSS - this is the safe default
        }
    }

    getImageNode(){
        return this._imageNode
    }

    // Defensive helper to check if node is still valid for DOM manipulation
    _isNodeValid(){
        return this._imageNode &&
               this._imageNode.classList &&
               this._imageNode.isConnected !== false
    }

    // Walk up the DOM to find the nearest positioned ancestor that still contains only
    // this one media element. Positioned elements (relative/absolute/fixed/sticky) are
    // natural card/component boundaries in CSS — overlay buttons (e.g. "More actions")
    // live inside the same positioned ancestor as the thumbnail, so mouseenter/mouseleave
    // fire correctly without the container growing into a huge static layout parent.
    // Stops early if an ancestor has >1 img/video/iframe (a shelf/grid row).
    // Falls back to the immediate parent if no positioned ancestor is found.
    // Called lazily on first blur() to avoid the getComputedStyle cost for unblurred elements.
    _findHoverContainer() {
        let node = this._imageNode.parentElement
        while (node && node !== document.body) {
            if (node.querySelectorAll('img, video, iframe').length > 1) break
            try {
                const pos = window.getComputedStyle(node).position
                if (pos !== 'static') {
                    this._container = node
                    return
                }
            } catch (_) { /* skip detached nodes */ }
            node = node.parentElement
        }
        // No positioned ancestor found — use immediate parent to avoid giant static containers
        const parent = this._imageNode.parentElement
        this._container = (parent && parent !== document.body) ? parent : null
    }

	    _attachContainerListeners() {
	        if (!this._container || this._boundMouseEnter) return

        const readFullBlurValue = () => {
            const rootStyle = document.documentElement && document.documentElement.style
            if (!rootStyle) return '40px'
            return rootStyle.getPropertyValue(PB_CSS_VARS.blurNs).trim() ||
                rootStyle.getPropertyValue(PB_CSS_VARS.blurLegacy).trim() ||
                '40px'
        }
        const pointInsideElement = (el, event) => {
            if (!el || !event || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return false
            try {
                const rect = el.getBoundingClientRect()
                return rect.width > 0 && rect.height > 0 &&
                    event.clientX >= rect.left && event.clientX <= rect.right &&
                    event.clientY >= rect.top && event.clientY <= rect.bottom
            } catch (_) {
                return false
            }
        }
        const pointInsidePreviewRegion = (event) => {
            if (!event || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return true
            if (pointInsideElement(this._imageNode, event)) return true
            return Boolean(this._overlaySiblings && this._overlaySiblings.some(({ el }) => pointInsideElement(el, event)))
        }
        const relatedTargetIsOverlay = (relatedTarget) => {
            if (!relatedTarget || !this._overlaySiblings) return false
            return this._overlaySiblings.some(({ el }) => el === relatedTarget || el.contains(relatedTarget))
        }

        const addPreview = (event) => {
            if (!this._imageNode || !this._imageNode.classList) return
            if (!pointInsidePreviewRegion(event)) return
            this._imageNode.classList.add('phobia-preview')
            // On disabled sites, html.phobia-disabled overrides CSS preview rules,
            // so force the preview blur via inline style instead.
            if (document.documentElement.classList.contains('phobia-disabled')) {
                const previewVal = previewEnabled ? `${previewBlurStrength}px`
                    : readFullBlurValue()
                this._imageNode.style.setProperty('filter', `blur(${previewVal})`, 'important')
            }
        }
        const removePreview = () => {
            if (!this._imageNode || !this._imageNode.classList) return
            this._imageNode.classList.remove('phobia-preview')
            // Restore full blur inline style only if the element is still force-blurred
            if (document.documentElement.classList.contains('phobia-disabled')
                    && this._imageNode.hasAttribute('data-phobia-blur')) {
                this._imageNode.style.setProperty('filter', `blur(${readFullBlurValue()})`, 'important')
            }
        }
        const scheduleParentLeave = (target) => {
            if (!target || target === document.body) return false
            if (!this._pendingParentLeaves) {
                this._pendingParentLeaves = []
            }
            if (this._pendingParentLeaves.some(entry => entry.el === target)) {
                return true
            }

            const onLeave = () => {
                removePreview()
                if (this._pendingParentLeaves) {
                    this._pendingParentLeaves = this._pendingParentLeaves.filter(
                        entry => !(entry.el === target && entry.leave === onLeave)
                    )
                }
            }

            this._pendingParentLeaves.push({
                el: target,
                type: 'mouseleave',
                leave: onLeave,
            })
            target.addEventListener('mouseleave', onLeave, { once: true })
            return true
        }

        this._boundMouseEnter = addPreview
        this._boundMouseMove = (e) => {
            if (!this._imageNode || !this._imageNode.classList) return
            if (pointInsidePreviewRegion(e)) addPreview(e)
            else removePreview()
        }
        this._boundMouseLeave = (e) => {
            if (!this._imageNode || !this._imageNode.classList) return
            const rt = e.relatedTarget
            const parent = this._container.parentElement
            // Mouse moved to a sibling of the container — keep preview active until
            // mouse leaves the shared parent, but only for verified overlapping overlays.
            if (rt && parent && parent !== document.body &&
                parent.contains(rt) && !this._container.contains(rt) &&
                relatedTargetIsOverlay(rt)) {
                scheduleParentLeave(parent)
                return
            }
            removePreview()
        }

	        this._container.addEventListener('mouseenter', this._boundMouseEnter)
	        this._container.addEventListener('mousemove', this._boundMouseMove)
	        this._container.addEventListener('mouseleave', this._boundMouseLeave)

	        // Attach to overlays that visually cover the media and intercept pointer events.
	        // Many sites keep overlays as absolutely-positioned siblings, but on some (e.g. Instagram)
	        // the overlay can be a sibling of a *higher* ancestor. Walk up a few levels and attach
	        // to overlay siblings that significantly overlap the media rect.
	        const targetRect = (() => {
	            try { return this._imageNode.getBoundingClientRect() } catch (_) { return null }
	        })()
	        const targetArea = (targetRect && targetRect.width > 0 && targetRect.height > 0)
	            ? (targetRect.width * targetRect.height)
	            : 0

	        const overlayCandidates = new Set()
	        this._overlaySiblings = []

	        const rectOverlapRatio = (a, b) => {
	            const left = Math.max(a.left, b.left)
	            const top = Math.max(a.top, b.top)
	            const right = Math.min(a.right, b.right)
	            const bottom = Math.min(a.bottom, b.bottom)
	            const w = right - left
	            const h = bottom - top
	            if (w <= 0 || h <= 0) return 0
	            const overlap = w * h
	            return targetArea > 0 ? (overlap / targetArea) : 0
	        }

	        const attachOverlayListeners = (overlayEl, sharedParent) => {
	            if (!overlayEl || overlayCandidates.has(overlayEl)) return
	            overlayCandidates.add(overlayEl)

	            // Use pointerover/pointerout in capture so we still trigger when the pointer
	            // enters/leaves children inside the overlay (controls, buttons, sliders, etc.).
		            const onEnter = (e) => addPreview(e)
		            const onLeave = (e) => {
		                if (!this._imageNode || !this._imageNode.classList) return
	                const rt = e.relatedTarget
	                if (rt && overlayEl.contains(rt)) return
	                if (rt && sharedParent && sharedParent.contains(rt)) {
	                    if (pointInsidePreviewRegion(e)) {
	                        scheduleParentLeave(sharedParent)
	                        return
	                    }
	                    removePreview()
	                    return
	                }
	                removePreview()
		            }
	            overlayEl.addEventListener('pointerover', onEnter, true)
	            overlayEl.addEventListener('pointerout', onLeave, true)
	            this._overlaySiblings.push({
	                el: overlayEl,
	                enterType: 'pointerover',
	                leaveType: 'pointerout',
	                enter: onEnter,
	                leave: onLeave,
	                capture: true,
	            })
	        }

	        const considerOverlaySibling = (sibling, sharedParent) => {
	            if (!sibling || sibling === this._container) return
	            if (!targetRect || targetArea === 0) return
	            try {
	                const style = window.getComputedStyle(sibling)
	                if (style.pointerEvents === 'none') return
	                if (style.display === 'none' || style.visibility === 'hidden') return
	                // Skip siblings that are (or contain) real media players/frames.
	                if (sibling.querySelector('video, iframe')) return

	                const r = sibling.getBoundingClientRect()
	                if (!r || r.width <= 0 || r.height <= 0) return

	                const siblingArea = r.width * r.height
	                // Reject huge "page overlays" that happen to overlap (modals, headers, etc.).
	                if (siblingArea > targetArea * 6) return

	                const overlapRatio = rectOverlapRatio(targetRect, r)
	                const widthOk = r.width >= targetRect.width * 0.6
	                const heightOk = r.height >= targetRect.height * 0.6
	                if (overlapRatio < 0.25 || !widthOk || !heightOk) return

	                attachOverlayListeners(sibling, sharedParent)
	            } catch (_) { /* skip detached nodes */ }
	        }

	        // First, check direct siblings (original behavior, but more robust).
	        const directParent = this._container.parentElement
	        if (directParent) {
	            for (const sibling of directParent.children) {
	                if (sibling === this._container) continue
	                considerOverlaySibling(sibling, directParent)
	            }
	        }

	        // Then, walk up a few levels and look for overlay siblings of higher ancestors.
	        // Limit levels to avoid attaching too broadly in complex layouts.
	        let child = this._container
	        let level = 0
	        while (child && child.parentElement && child.parentElement !== document.body && level < 8) {
	            const parent = child.parentElement
	            // If the parent is a "multi-media shelf", stop climbing to avoid huge scopes.
	            try {
	                if (parent.querySelectorAll('img, video, iframe').length > 3) break
	            } catch (_) { /* ignore */ }

	            for (const sibling of parent.children) {
	                if (sibling === child) continue
	                considerOverlaySibling(sibling, parent)
	            }

	            child = parent
	            level += 1
	        }
	    }

    _detachContainerListeners() {
        if (!this._container || !this._boundMouseEnter) return
        this._container.removeEventListener('mouseenter', this._boundMouseEnter)
        if (this._boundMouseMove) this._container.removeEventListener('mousemove', this._boundMouseMove)
        this._container.removeEventListener('mouseleave', this._boundMouseLeave)
        if (this._pendingParentLeaves) {
            for (const { el, type, leave } of this._pendingParentLeaves) {
                el.removeEventListener(type || 'mouseleave', leave)
            }
            this._pendingParentLeaves = null
        }
        if (this._overlaySiblings) {
            for (const { el, enterType, leaveType, enter, leave, capture } of this._overlaySiblings) {
                // Back-compat with older stored shapes (if any)
	                const et = enterType || 'mouseenter'
	                const lt = leaveType || 'mouseleave'
	                const cap = Boolean(capture)
	                el.removeEventListener(et, enter, cap)
	                el.removeEventListener(lt, leave, cap)
	            }
	            this._overlaySiblings = null
	        }
        this._boundMouseEnter = null
        this._boundMouseMove = null
        this._boundMouseLeave = null
	    }

    blur() {
        if (!this._isNodeValid()) return
        if (!this._imageNode.classList.contains('phobia-permanent-unblur')){
            markInternalMutationTarget(this._imageNode)
            this._imageNode.classList.remove('phobia-noblur')
            this._imageNode.classList.add('phobia-blur')
            this._imageNode.setAttribute('data-phobia-blur', '1')
            if (this._container === undefined) {
                try {
                    this._findHoverContainer()
                } catch (e) {
                    this._container = null
                }
            }
            if (this._container) {
                this._container.setAttribute('data-phobia-container', '1')
                this._attachContainerListeners()
            }
        }
    }

    unblur() {
        if (!this._isNodeValid()) return
        markInternalMutationTarget(this._imageNode)
        this._imageNode.classList.remove('phobia-blur', 'phobia-preview')
        this._imageNode.classList.add('phobia-noblur')
        this._imageNode.removeAttribute('data-phobia-blur')
        this._imageNode.style.removeProperty('filter')
        this._detachContainerListeners()
        // Remove container marker when no blurred images remain inside it
        if (this._container && !this._container.querySelector(
            'img[data-phobia-blur], video[data-phobia-blur], iframe[data-phobia-blur]'
        )) {
            this._container.removeAttribute('data-phobia-container')
        }
    }

    newTextProcessingStarted(){
        this.runningTextProcessing += 1
        return this._analysisGeneration
    }

    _finalizeBlurStateAfterAnalysis() {
        if (this.runningTextProcessing > 0) return

        if (this.isBlured || blurIsAlwaysOn) {
            try {
                this.blur()
            } catch (blurError) {
                console.error('PhobiaBlocker: Failed to keep element blurred after analysis', blurError)
            }
            return
        }

        try {
            // Unblur immediately - the mutation observer batch delay already handles
            // waiting for dynamic content to stabilize
            this.unblur()
        } catch (unblurError) {
            // FAIL-SAFE: If unblur fails, keep element blurred (safe default)
            console.error('PhobiaBlocker: Failed to unblur element, keeping blurred for safety', unblurError)
        }
    }

    textProcessingFinished(generation){
        if (generation !== undefined && generation !== this._analysisGeneration) return
        this.runningTextProcessing -= 1
        this._finalizeBlurStateAfterAnalysis()
    }

    updateBlurStatus(analysisResult, matchedWords = []){
        this.isBlured = analysisResult
        this._triggerWords = matchedWords.length > 0 ? [...new Set(matchedWords)] : null
        this.hasBeenAnalyzed = true
    }

    same(otherNode){
        return this._imageNode == otherNode
    }

}

/**
 * @extends {ImageNode}
 */
class TagImageNode extends ImageNode {
    constructor(imageNode){
        super(imageNode)
    }

    _init() {
        // Intentionally skip the base-class blur() call.
        // The early-injected CSS already keeps unprocessed images blurred with
        // pointer-events:none — hover is impossible, so no preview flash can occur.
        // The .phobia-blur class is added by textProcessingFinished() only after analysis
        // confirms the image should stay blurred, or by blur() when blurAll is called.
    }
}

class BgImageNode extends ImageNode {
    constructor(imageNode){
        super(imageNode)
        this._overlayHidden = false
        this._prevVisibilityValue = null
        this._prevVisibilityPriority = null
        try {
            this.blur()
        } catch (blurError) {
            console.error('PhobiaBlocker: Failed to blur background element, relying on CSS fallback', blurError)
        }
    }

    _init() {
        // Defer initial blur until constructor fields are initialized.
    }

    _extractCssUrls(cssValue) {
        if (!cssValue || typeof cssValue !== 'string') return []
        const urls = []
        const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi
        let m
        while ((m = re.exec(cssValue)) !== null) {
            const u = (m[2] || '').trim()
            if (u) urls.push(u)
        }
        return urls
    }

    _normalizeResourceUrl(urlLike) {
        if (!urlLike || typeof urlLike !== 'string') return null
        const trimmed = urlLike.trim()
        if (!trimmed) return null
        try {
            return new URL(trimmed, document.baseURI).href
        } catch (_) {
            return trimmed
        }
    }

    _isLikelyOverlayDuplicateOfMedia() {
        if (!this._isNodeValid()) return false
        const el = this._imageNode

        let style
        try {
            style = window.getComputedStyle(el)
        } catch (_) {
            return false
        }
        if (!style) return false

        const pos = style.position
        if (pos !== 'absolute' && pos !== 'fixed') return false

        const bg = style.backgroundImage || ''
        if (!bg || bg === 'none' || !bg.includes('url(')) return false

        const bgUrls = new Set(this._extractCssUrls(bg)
            .map(u => this._normalizeResourceUrl(u))
            .filter(Boolean))
        if (bgUrls.size === 0) return false

        const containers = []
        const picture = el.closest && el.closest('picture')
        if (picture) containers.push(picture)
        if (el.parentElement) containers.push(el.parentElement)

        for (const container of containers) {
            if (!container || !container.querySelectorAll) continue
            const mediaEls = container.querySelectorAll('img, video, iframe')
            if (!mediaEls || mediaEls.length === 0) continue
            for (const media of mediaEls) {
                if (!media || el.contains(media)) continue
                const tag = media.tagName
                const possibleUrls = []
                if (tag === 'IMG') {
                    possibleUrls.push(media.currentSrc || media.getAttribute('src') || '')
                    const srcset = media.getAttribute('srcset') || ''
                    if (srcset) possibleUrls.push(...srcset.split(',').map(s => (s.trim().split(/\s+/)[0] || '').trim()))
                } else if (tag === 'VIDEO') {
                    possibleUrls.push(media.currentSrc || media.getAttribute('src') || '')
                    possibleUrls.push(media.getAttribute('poster') || '')
                } else if (tag === 'IFRAME') {
                    possibleUrls.push(media.getAttribute('src') || '')
                }
                for (const u of possibleUrls) {
                    const norm = this._normalizeResourceUrl(u)
                    if (norm && bgUrls.has(norm)) return true
                }
            }
        }
        return false
    }

    _hideOverlay() {
        if (!this._isNodeValid()) return
        if (this._overlayHidden) return
        this._prevVisibilityValue = this._imageNode.style.getPropertyValue('visibility')
        this._prevVisibilityPriority = this._imageNode.style.getPropertyPriority('visibility')
        this._imageNode.style.setProperty('visibility', 'hidden', 'important')
        this._overlayHidden = true
    }

    _restoreOverlayVisibility() {
        if (!this._isNodeValid()) return
        if (!this._overlayHidden) return
        if (!this._prevVisibilityValue) {
            this._imageNode.style.removeProperty('visibility')
        } else {
            this._imageNode.style.setProperty('visibility', this._prevVisibilityValue, this._prevVisibilityPriority || '')
        }
        this._overlayHidden = false
        this._prevVisibilityValue = null
        this._prevVisibilityPriority = null
    }

    blur() {
        if (!this._isNodeValid()) return
        if (!this._imageNode.classList.contains('phobia-permanent-unblur')){
            markInternalMutationTarget(this._imageNode)
            this._imageNode.classList.remove('phobia-noblur')
            this._imageNode.classList.add('phobia-blur')
            if (this._isLikelyOverlayDuplicateOfMedia()) {
                // Bumble-style: an absolutely-positioned background-image layer covers a real <img>.
                // Hiding it avoids "double blur" and reveals the blurred <img> underneath.
                this._imageNode.style.removeProperty('filter')
                this._hideOverlay()
            } else {
                this._restoreOverlayVisibility()
                // Use !important so the extension's blur wins over site inline-style animations
                this._imageNode.style.setProperty('filter', 'blur(var(--phobiablocker-blurValueAmount, var(--blurValueAmount, 40px)))', 'important')
            }
        }
    }

    unblur() {
        if (!this._isNodeValid()) return
        markInternalMutationTarget(this._imageNode)
        this._imageNode.classList.remove('phobia-blur')
        this._imageNode.classList.add('phobia-noblur')
        this._imageNode.style.removeProperty('filter')
        this._restoreOverlayVisibility()
    }
}

/**
 * @extends {ImageNode}
 * Handles video elements
 */
class VideoNode extends ImageNode {
    constructor(imageNode){
        super(imageNode)
    }

    _init() {
        // Early CSS keeps pending videos blurred. Only confirmed matches or
        // manual blur-all should add phobia-blur/data-phobia-blur markers.
    }
}

/**
 * @extends {ImageNode}
 * Handles iframe elements (YouTube, Vimeo, embedded videos, etc.)
 */
class IframeNode extends ImageNode {
    constructor(imageNode){
        super(imageNode)
    }

    _init() {
        // Early CSS keeps pending iframes blurred. Analysis decides whether
        // to add confirmed blur markers or remove blur entirely.
    }

    _isCrossOrigin() {
        const src = this._imageNode.getAttribute('src') || ''
        // about:blank and empty src are always same-origin
        if (!src || src === 'about:blank') return false
        // Check src URL origin before the iframe finishes loading (before navigation
        // completes, contentDocument may still be the initial about:blank and would
        // appear accessible even for a cross-origin src).
        try {
            const frameOrigin = new URL(src).origin
            if (frameOrigin !== 'null' && frameOrigin !== window.location.origin) return true
        } catch (_) {
            // Relative URL — same origin, fall through
        }
        // Fallback: try contentDocument access (throws SecurityError for cross-origin)
        try {
            const doc = this._imageNode.contentDocument
            if (doc === null) return true
            return false
        } catch (e) {
            return true
        }
    }

    textProcessingFinished(generation) {
        super.textProcessingFinished(generation)
    }
}


class ImageNodeList {
    constructor() {
        this._imageNodeList = []
        this._nodeMap = new WeakMap()  // O(1) DOM-node → ImageNode lookup
    }

    /**
     * Accepts DOM node and checks if it already exists in controlled imageNodeList.
     * @param {Node} nodeToGet Node that is being searched
     * @returns {ImageNode|undefined} ImageNode that already exists in the list or nothing
    */
    getImageNode(nodeToGet){
        return this._nodeMap.get(nodeToGet)
    }

    blurAllImages(){
        this._imageNodeList.forEach((imageNode) => {
            imageNode.blur()
        })
    }

    unBlurAllImages(){
        this._imageNodeList.forEach((imageNode) => {
            imageNode.unblur()
        })
    }

    push(imageNode){
        this._imageNodeList.push(imageNode)
        this._nodeMap.set(imageNode.getImageNode(), imageNode)
    }

    getAllImages(){
        return this._imageNodeList
    }

    /**
     * Remove ImageNodes whose DOM element is no longer in the document.
     * Detaches container listeners before discarding to prevent event listener leaks.
     */
    prune(){
        const removed = []
        this._imageNodeList = this._imageNodeList.filter(node => {
            const el = node.getImageNode()
            if (el && el.isConnected) return true
            try { node._detachContainerListeners() } catch (_) {}
            removed.push(node)
            return false
        })
        return removed
    }

    /**
     * Detach all container listeners before discarding this list.
     * Must be called before replacing _imageNodeList with a new instance.
     */
    teardown(){
        this._imageNodeList.forEach(node => {
            try { node._detachContainerListeners() } catch (_) {}
        })
    }
}
class Controller {
    constructor(){
        this._imageNodeList = new ImageNodeList()
        this._mutationBatch = []
        this._batchTimer = null
        this._batchProcessInterval = 500 // Process batch every 500ms
        this._maxBatchSize = 10 // Or when we collect 10 mutations
        this._editorContainerCache = new WeakSet() // Cache known editor containers for fast lookup
        this._editorCacheHits = 0 // Track cache hits to know when to skip re-checking
        this._postTypingScanTimer = null
        this._postTypingScanDelay = 1200
        this._runningAnalyses = 0
        this._permanentlyUnblurred = false // Set after unblurAll — new images skip NLP and are immediately unblurred
        this._blurToggleGeneration = 0
        this._analysisEpoch = 0
        this._scopeStatesByElement = new Map()
        this._scopeIdCounter = 1
        this._isProcessingMutationBatch = false
        this._shouldRerunMutationBatch = false
        this._deferredDirtyScopes = new Set()
        this._lastPageAnalysisResult = null
        this._manualBlurAllActive = false
    }

    _extractCssUrls(cssValue) {
        // Extract all url(...) occurrences from CSS background-image (handles quotes).
        // Example values:
        //   url("https://a/b.jpg")
        //   linear-gradient(...), url(/img.png)
        //   image-set(url(a.png) 1x, url(b.png) 2x)
        if (!cssValue || typeof cssValue !== 'string') return []
        const urls = []
        const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi
        let m
        while ((m = re.exec(cssValue)) !== null) {
            const u = (m[2] || '').trim()
            if (u) urls.push(u)
        }
        return urls
    }

    _normalizeResourceUrl(urlLike) {
        if (!urlLike || typeof urlLike !== 'string') return null
        const trimmed = urlLike.trim()
        if (!trimmed) return null
        try {
            return new URL(trimmed, document.baseURI).href
        } catch (_) {
            return trimmed
        }
    }

    _shouldSkipBgImageNode(el, bgCssValue) {
        // Skip BgImageNode when the element is likely a "backing layer" for a real
        // <img>/<video>/<iframe> in the same visual container (common on Bumble, etc.)
        // to avoid "double blur".
        if (!el || !el.querySelector) return false

        // Parent-child case (existing behavior)
        if (el.querySelector('img, video, iframe')) return true

        const bgUrlsRaw = this._extractCssUrls(bgCssValue)
        if (bgUrlsRaw.length === 0) return false
        const bgUrls = new Set(bgUrlsRaw
            .map(u => this._normalizeResourceUrl(u))
            .filter(Boolean))

        // If this element is an absolutely-positioned overlay that duplicates a sibling
        // <img>/<video>/<iframe>, do NOT skip it. Instead, BgImageNode.blur() will hide it
        // so the underlying blurred media becomes visible.
        let isAbsoluteOverlay = false
        try {
            const pos = window.getComputedStyle(el).position
            isAbsoluteOverlay = (pos === 'absolute' || pos === 'fixed')
        } catch (_) { /* ignore */ }

        // Candidate containers to look for sibling media:
        // - closest <picture> (Bumble-like DOM)
        // - closest data-phobia-container (already-resolved hover container)
        // - parent / grandparent (generic fallback)
        const candidates = []
        const picture = el.closest('picture')
        if (picture) candidates.push(picture)
        const phobiaContainer = el.closest('[data-phobia-container]')
        if (phobiaContainer && phobiaContainer !== picture) candidates.push(phobiaContainer)
        if (el.parentElement) candidates.push(el.parentElement)
        if (el.parentElement && el.parentElement.parentElement) candidates.push(el.parentElement.parentElement)

        for (const container of candidates) {
            if (!container || !container.querySelectorAll) continue
            const mediaEls = container.querySelectorAll('img, video, iframe')
            if (!mediaEls || mediaEls.length === 0) continue

            for (const media of mediaEls) {
                if (!media || el.contains(media)) continue
                const tag = media.tagName
                const possibleUrls = []
                if (tag === 'IMG') {
                    possibleUrls.push(media.currentSrc || media.getAttribute('src') || '')
                    const srcset = media.getAttribute('srcset') || ''
                    if (srcset) possibleUrls.push(...srcset.split(',').map(s => (s.trim().split(/\s+/)[0] || '').trim()))
                } else if (tag === 'VIDEO') {
                    possibleUrls.push(media.currentSrc || media.getAttribute('src') || '')
                    possibleUrls.push(media.getAttribute('poster') || '')
                } else if (tag === 'IFRAME') {
                    possibleUrls.push(media.getAttribute('src') || '')
                }
                for (const u of possibleUrls) {
                    const norm = this._normalizeResourceUrl(u)
                    if (norm && bgUrls.has(norm)) {
                        // Overlay duplicate: keep BgImageNode so blur() can hide it.
                        if (isAbsoluteOverlay) return false
                        return true
                    }
                }
            }
        }

        return false
    }

    _invalidatePendingAnalysis() {
        this._analysisEpoch++
    }

    _invalidateAllScopeResults() {
        this._lastPageAnalysisResult = null
        this._scopeStatesByElement.forEach((scope) => {
            scope.requestToken++
            scope.inFlight = null
            scope.cachedResult = null
            scope.lastTextHash = null
            scope.dirty = true
        })
    }

    _resetAnalysisScopes() {
        this._imageNodeList.getAllImages().forEach((imageNode) => {
            imageNode._analysisScope = null
        })
        this._scopeStatesByElement.clear()
        this._scopeIdCounter = 1
        this._deferredDirtyScopes.clear()
    }

    _createScopeState(scopeElement) {
        return {
            id: this._scopeIdCounter++,
            element: scopeElement,
            members: new Set(),
            lastTextHash: null,
            cachedResult: null,
            dirty: true,
            inFlight: null,
            requestToken: 0,
        }
    }

    _cleanupScopeState(scope) {
        if (!scope || scope.members.size > 0) return
        this._scopeStatesByElement.delete(scope.element)
    }

    _getAllActiveScopeStates() {
        return [...this._scopeStatesByElement.values()].filter(scope => scope.members.size > 0)
    }

    _getScopeStateForElement(scopeElement) {
        if (!scopeElement) return null
        let scope = this._scopeStatesByElement.get(scopeElement)
        if (!scope) {
            scope = this._createScopeState(scopeElement)
            this._scopeStatesByElement.set(scopeElement, scope)
        }
        return scope
    }

    _buildScopeResolutionSnapshot() {
        const mediaCountByElement = new Map()
        const hasNonTrivialTextByElement = new Map()

        const trackedImages = this._imageNodeList.getAllImages()
        for (let i = 0; i < trackedImages.length; i++) {
            const mediaEl = trackedImages[i]?.getImageNode?.()
            if (!mediaEl || mediaEl.isConnected === false) continue

            let current = mediaEl
            while (current && current !== document.body) {
                const nextCount = Math.min(
                    (mediaCountByElement.get(current) || 0) + 1,
                    FALLBACK_SCOPE_MEDIA_LIMIT + 1
                )
                mediaCountByElement.set(current, nextCount)
                current = current.parentElement
            }
        }

        return {
            mediaCountByElement,
            hasNonTrivialTextByElement,
        }
    }

    _getPageScopeElement() {
        return document.body || document.documentElement
    }

    _getVisiblePageTextForAnalysis() {
        const body = document.body
        if (!body) return ''

        try {
            if (typeof body.innerText === 'string') {
                return body.innerText
            }
        } catch (_) {}

        return body.textContent || ''
    }

    _getFallbackScopeMediaCount(candidate, mediaEl, scopeResolutionSnapshot) {
        if (!candidate) return 0

        const cachedCount = scopeResolutionSnapshot?.mediaCountByElement?.get(candidate)
        if (cachedCount !== undefined) return cachedCount

        if (mediaEl && (candidate === mediaEl || candidate.contains(mediaEl))) {
            return 1
        }

        return 0
    }

    _hasNonTrivialScopeText(candidate, scopeResolutionSnapshot) {
        if (!candidate) return false

        const cachedResult = scopeResolutionSnapshot?.hasNonTrivialTextByElement?.get(candidate)
        if (cachedResult !== undefined) return cachedResult

        const hasNonTrivialText = (candidate.textContent || '').replace(/\s+/g, ' ').trim().length >= MIN_SCOPE_TEXT_LENGTH
        scopeResolutionSnapshot?.hasNonTrivialTextByElement?.set(candidate, hasNonTrivialText)
        return hasNonTrivialText
    }

    _resolveAnalysisScopeElement(mediaEl, scopeResolutionSnapshot) {
        return this._getPageScopeElement()
    }

    _syncImageNodeScope(imageNode, scopeResolutionSnapshot) {
        if (!imageNode || !imageNode.getImageNode) return null
        const mediaEl = imageNode.getImageNode()
        if (!mediaEl || mediaEl.isConnected === false) {
            this._removeImageNodeFromScope(imageNode)
            return null
        }

        const scopeElement = this._resolveAnalysisScopeElement(mediaEl, scopeResolutionSnapshot)
        const nextScope = this._getScopeStateForElement(scopeElement)
        const currentScope = imageNode._analysisScope || null

        if (currentScope && currentScope !== nextScope) {
            currentScope.members.delete(imageNode)
            this._cleanupScopeState(currentScope)
        }

        nextScope.members.add(imageNode)
        imageNode._analysisScope = nextScope
        return nextScope
    }

    _removeImageNodeFromScope(imageNode) {
        if (!imageNode || !imageNode._analysisScope) return
        const scope = imageNode._analysisScope
        scope.members.delete(imageNode)
        imageNode._analysisScope = null
        this._cleanupScopeState(scope)
    }

    _markScopeDirty(scope) {
        if (!scope) return null
        scope.dirty = true
        return scope
    }

    _markAllScopeStatesDirty() {
        const dirtyScopes = []
        this._scopeStatesByElement.forEach((scope) => {
            scope.dirty = true
            dirtyScopes.push(scope)
        })
        return dirtyScopes
    }

    _findExistingScopeStateForNode(node) {
        return this._scopeStatesByElement.get(this._getPageScopeElement()) || null
    }

    _collectAffectedScopesFromMutation(mutation) {
        const dirtyScopes = new Set()
        if (!mutation) return dirtyScopes

        const addScopeForNode = (node) => {
            let element = node?.nodeType === 3 ? node.parentElement : node
            if (!element) return
            if (element.tagName === 'TITLE' || (element.closest && element.closest('head'))) {
                this._markAllScopeStatesDirty().forEach(scope => dirtyScopes.add(scope))
                return
            }
            const scope = this._findExistingScopeStateForNode(element)
            if (!scope) return
            this._markScopeDirty(scope)
            dirtyScopes.add(scope)
        }

        addScopeForNode(mutation.target)
        if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(addScopeForNode)
            mutation.removedNodes.forEach(() => addScopeForNode(mutation.target))
        }

        return dirtyScopes
    }

    _computeScopeTextHash(scopeElement) {
        const words = extractUniquePageWords([
            this._getVisiblePageTextForAnalysis(),
            document.title || '',
        ]).sort()
        return hashStringFNV1a(words.join('\u0000'))
    }

    _extractScopeWords(scopeElement) {
        return extractUniquePageWords([
            this._getVisiblePageTextForAnalysis(),
            document.title || '',
        ])
    }

    _normalizeAnalysisResult(result) {
        return {
            shouldBlur: typeof result?.shouldBlur === 'boolean' ? result.shouldBlur : true,
            matchedWords: Array.isArray(result?.matchedWords)
                ? [...new Set(result.matchedWords.filter(Boolean))]
                : [],
        }
    }

    _getScopeMembers(scope) {
        if (!scope) return []
        const members = []
        const staleMembers = []
        scope.members.forEach((imageNode) => {
            const el = imageNode.getImageNode()
            if (!el || el.isConnected === false || imageNode._analysisScope !== scope) {
                staleMembers.push(imageNode)
                return
            }
            members.push(imageNode)
        })
        staleMembers.forEach((imageNode) => scope.members.delete(imageNode))
        this._cleanupScopeState(scope)
        return members
    }

    _scopeNeedsFreshAnalysis(scope) {
        if (!scope) return false
        if (scope.inFlight) return true
        if (this._getScopeMembers(scope).length === 0) return false
        return !scope.cachedResult || scope.lastTextHash !== this._computeScopeTextHash(scope.element)
    }

    _scopeStatesNeedFreshAnalysis(scopeStates) {
        return (Array.isArray(scopeStates) ? scopeStates : []).some((scope) => this._scopeNeedsFreshAnalysis(scope))
    }

    _getScopeStatesForImageNodes(imageNodes) {
        const uniqueImageNodes = [...new Set(imageNodes.filter(Boolean))]
        if (uniqueImageNodes.length === 0) return []

        const scopeStates = new Set()
        const scopeResolutionSnapshot = this._buildScopeResolutionSnapshot()

        uniqueImageNodes.forEach((imageNode) => {
            const scope = this._syncImageNodeScope(imageNode, scopeResolutionSnapshot)
            if (scope) scopeStates.add(scope)
        })
        return [...scopeStates]
    }

    _resyncAllImageScopes() {
        return this._getScopeStatesForImageNodes(this._imageNodeList.getAllImages())
    }

    _shouldCheckElementForBackground(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE || !node.tagName) return false
        if (!BACKGROUND_SCAN_TAGS.has(node.tagName)) return false
        if (!BACKGROUND_HINTED_SCAN_TAGS.has(node.tagName)) return true

        return Boolean(
            node.id ||
            (node.classList && node.classList.length > 0) ||
            (node.hasAttribute && node.hasAttribute('style'))
        )
    }

    _forEachBackgroundCandidateElement(nodeToCheck, visitCandidate) {
        if (!nodeToCheck || !nodeToCheck.querySelectorAll || typeof visitCandidate !== 'function') return

        const seen = new Set()

        const visit = (candidate) => {
            if (!candidate || seen.has(candidate)) return
            seen.add(candidate)
            visitCandidate(candidate)
        }

        try {
            const inlineCandidates = nodeToCheck.querySelectorAll(BACKGROUND_INLINE_SELECTOR)
            for (let i = 0; i < inlineCandidates.length; i++) {
                visit(inlineCandidates[i])
            }
        } catch (_) {}

        if (!document || !document.createTreeWalker) return

        let walker
        try {
            walker = document.createTreeWalker(nodeToCheck, NodeFilter.SHOW_ELEMENT, {
                acceptNode: (node) => {
                    return this._shouldCheckElementForBackground(node)
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_SKIP
                }
            })
        } catch (_) {
            return
        }

        let current = walker.nextNode()
        while (current) {
            visit(current)
            current = walker.nextNode()
        }
    }

    async _analyzeScopes(scopeStates) {
        const uniqueScopes = [...new Set(scopeStates.filter(Boolean))]
            .filter(scope => this._getScopeMembers(scope).length > 0)

        if (uniqueScopes.length === 0) return new Map()

        const inflightPromises = [...new Set(uniqueScopes.map(scope => scope.inFlight).filter(Boolean))]
        if (inflightPromises.length > 0) {
            await Promise.allSettled(inflightPromises)
        }

        const resultsByScope = new Map()
        const payloads = []
        const payloadStates = []

        uniqueScopes.forEach((scope) => {
            const members = this._getScopeMembers(scope)
            if (members.length === 0) return

            const hash = this._computeScopeTextHash(scope.element)
            if (scope.cachedResult && scope.lastTextHash === hash) {
                scope.dirty = false
                resultsByScope.set(scope, scope.cachedResult)
                return
            }

            payloads.push({
                id: scope.id,
                words: this._extractScopeWords(scope.element),
            })
            payloadStates.push({ scope, hash })
        })

        if (payloads.length === 0) return resultsByScope

        const batchedPromise = analyzeScopesWithOffscreen(payloads)

        const perScopePromises = payloadStates.map(({ scope, hash }) => {
            const requestToken = ++scope.requestToken
            scope.dirty = false

            const perScopePromise = batchedPromise.then((responseMap) => {
                const result = this._normalizeAnalysisResult(responseMap.get(scope.id) || FAIL_CLOSED_RESULT)
                if (scope.requestToken === requestToken) {
                    scope.cachedResult = result
                    scope.lastTextHash = hash
                }
                return result
            }).catch(() => FAIL_CLOSED_RESULT).finally(() => {
                if (scope.requestToken === requestToken) {
                    scope.inFlight = null
                }
            })

            scope.inFlight = perScopePromise
            return perScopePromise.then((result) => {
                resultsByScope.set(scope, this._normalizeAnalysisResult(result))
            })
        })

        await Promise.all(perScopePromises)
        return resultsByScope
    }

    _applyResultToImageNodes(imageNodes, result) {
        const normalizedResult = this._manualBlurAllActive
            ? { shouldBlur: true, matchedWords: [] }
            : this._normalizeAnalysisResult(result)
        const generationByNode = new Map()

        imageNodes.forEach((imageNode) => {
            generationByNode.set(imageNode, imageNode.newTextProcessingStarted())
        })

        imageNodes.forEach((imageNode) => {
            try {
                imageNode.updateBlurStatus(normalizedResult.shouldBlur, normalizedResult.matchedWords)
                imageNode.textProcessingFinished(generationByNode.get(imageNode))
            } catch (nodeError) {
                console.error('PhobiaBlocker: textProcessingFinished failed for node', nodeError)
            }
        })
    }

    _applyScopeResults(scopeResults) {
        scopeResults.forEach((result, scope) => {
            const members = this._getScopeMembers(scope)
            if (members.length === 0) return
            const normalizedResult = this._normalizeAnalysisResult(result)
            if (scope.element === this._getPageScopeElement()) {
                this._lastPageAnalysisResult = normalizedResult
            }
            this._applyResultToImageNodes(members, normalizedResult)
        })
    }

    async _reanalyzeScopes(scopeStates, analysisEpoch) {
        const results = await this._analyzeScopes(scopeStates)
        if (analysisEpoch !== undefined && analysisEpoch !== this._analysisEpoch) return false
        this._applyScopeResults(results)
        return true
    }

    _isTextInputElement(el) {
        if (!el) return false
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
        if (el.isContentEditable) return true
        try {
            const role = el.getAttribute && el.getAttribute('role')
            if (role && role.toLowerCase() === 'textbox') return true
        } catch (_) {}
        return false
    }

    _isTextInputActive() {
        try {
            return this._isTextInputElement(document.activeElement)
        } catch (_) {
            return false
        }
    }

    _nodeHasMediaTags(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false
        const tag = node.tagName
        if (tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME' || tag === 'PICTURE' || tag === 'SOURCE') return true
        try {
            return !!(node.querySelector && node.querySelector('img, video, iframe, picture, source'))
        } catch (_) {
            return false
        }
    }

    _shouldDeferMutationDuringTyping(mutation) {
        if (!mutation) return false
        if (mutation.type === 'attributes') {
            if (mutation.attributeName === 'src') return false
            return mutation.attributeName === 'class' || mutation.attributeName === 'style'
        }
        if (mutation.type === 'characterData') {
            return true
        }
        if (mutation.type === 'childList') {
            for (let i = 0; i < mutation.addedNodes.length; i++) {
                if (this._nodeHasMediaTags(mutation.addedNodes[i])) return false
            }
            return true
        }
        return false
    }

    _schedulePostTypingMediaScan() {
        clearTimeout(this._postTypingScanTimer)
        this._postTypingScanTimer = setTimeout(async () => {
            if (this._isTextInputActive()) return
            let started = false
            try {
                const deferredScopes = [...this._deferredDirtyScopes]
                this._deferredDirtyScopes.clear()

                this.updateImageList(document, { includeBackgrounds: false })
                const scopeStates = new Set([
                    ...deferredScopes,
                    ...this._resyncAllImageScopes(),
                ])
                if (scopeStates.size === 0) return

                if (this._scopeStatesNeedFreshAnalysis([...scopeStates])) {
                    this._analysisStarted()
                    started = true
                }

                const analysisEpoch = this._analysisEpoch
                await this._reanalyzeScopes([...scopeStates], analysisEpoch)
            } catch (_) {
                // Best-effort; do not interfere with typing.
            } finally {
                if (started) this._analysisFinished()
            }
        }, this._postTypingScanDelay)
    }

    _analysisStarted() {
        this._runningAnalyses++
        if (this._runningAnalyses === 1) reportIconStatus('processing')
    }

    _analysisFinished() {
        this._runningAnalyses = Math.max(0, this._runningAnalyses - 1)
        if (this._runningAnalyses === 0) {
            const hasDetections = this._imageNodeList.getAllImages().some(img => {
                const el = img.getImageNode()
                return el &&
                    ((el.hasAttribute && el.hasAttribute('data-phobia-blur')) ||
                    (el.classList && el.classList.contains('phobia-blur')))
            })
            reportIconStatus(hasDetections ? 'detected' : 'idle')
        }
    }

    updateImageList(nodeToCheck, options = {}){
        let newImages = []
        let existingImages = []
        const includeBackgrounds = options.includeBackgrounds !== false
        const selfOnly = options.selfOnly === true

        // Helper function to process a single element
        let checkAndUpdate = (classType, imageNode) => {
            let imageToAnalize = this._imageNodeList.getImageNode(imageNode)
            if (!imageToAnalize){
                imageToAnalize = new classType(imageNode)
                this._imageNodeList.push(imageToAnalize)
                if (this._permanentlyUnblurred) {
                    // unblurAll was previously triggered — immediately permanently unblur
                    // new images so they never reach the hover-preview state
                    imageToAnalize.unblur()
                    imageNode.classList.add('phobia-permanent-unblur')
                } else {
                    newImages.push(imageToAnalize)
                }
            } else {
                existingImages.push(imageToAnalize)
            }
        }

        // Self-element check: querySelectorAll only finds descendants, not nodeToCheck itself.
        // Handles three paths:
        //   - addedNodes with <img>/<video>/<iframe> directly
        //   - attributes mutation where a bg-image container's class/style changed
        //   - addedNodes with a new container element that itself has a background image
        const tag = nodeToCheck.tagName
        const forceBlur = this._manualBlurAllActive || blurIsAlwaysOn || isBlacklisted()
        if (tag === 'IMG') {
            if (forceBlur || !this._isInsideInteractiveControl(nodeToCheck)) checkAndUpdate(TagImageNode, nodeToCheck)
            else { nodeToCheck.classList.add('phobia-noblur'); nodeToCheck.classList.remove('phobia-blur') }
        } else if (tag === 'VIDEO') {
            checkAndUpdate(VideoNode, nodeToCheck)
        } else if (tag === 'IFRAME') {
            if (!this._isEditorIframe(nodeToCheck)) checkAndUpdate(IframeNode, nodeToCheck)
            else { nodeToCheck.classList.add('phobia-noblur'); nodeToCheck.classList.remove('phobia-blur') }
        } else if (tag && includeBackgrounds) {
            try {
                const bg = window.getComputedStyle(nodeToCheck).backgroundImage
                if (bg && bg !== 'none' && bg.includes('url(')) {
                    if (!this._shouldSkipBgImageNode(nodeToCheck, bg)) checkAndUpdate(BgImageNode, nodeToCheck)
                }
            } catch (_) { /* skip detached or hidden elements */ }
        }

        if (selfOnly) return { newImages, existingImages }

        const mediaElements = nodeToCheck.querySelectorAll('img, video, iframe')
        for (let i = 0; i < mediaElements.length; i++) {
            const el = mediaElements[i]
            const elTag = el.tagName
            if (elTag === 'IMG') {
                if (forceBlur || !this._isInsideInteractiveControl(el)) checkAndUpdate(TagImageNode, el)
                else { el.classList.add('phobia-noblur'); el.classList.remove('phobia-blur') }
            } else if (elTag === 'VIDEO') {
                checkAndUpdate(VideoNode, el)
            } else if (elTag === 'IFRAME') {
                if (!this._isEditorIframe(el)) checkAndUpdate(IframeNode, el)
                else { el.classList.add('phobia-noblur'); el.classList.remove('phobia-blur') }
            }
        }

        if (includeBackgrounds) {
            this._forEachBackgroundCandidateElement(nodeToCheck, (el) => {
                try {
                    const bg = window.getComputedStyle(el).backgroundImage
                    if (bg && bg !== 'none' && bg.includes('url(')) {
                        if (!this._shouldSkipBgImageNode(el, bg)) checkAndUpdate(BgImageNode, el)
                    }
                } catch (_) { /* skip detached or hidden elements */ }
            })
        }

        return { newImages, existingImages }
    }

    async onLoad(){
        let started = false
        try {
            this.updateImageList(document)
            const scopeStates = this._resyncAllImageScopes()
            const hasScopes = scopeStates.length > 0
            if (hasScopes && this._scopeStatesNeedFreshAnalysis(scopeStates)) {
                this._analysisStarted()
                started = true
            }

            const analysisEpoch = this._analysisEpoch
            if (hasScopes) {
                await this._reanalyzeScopes(scopeStates, analysisEpoch)
            }

            this._removeEarlyBlurStyle()
            this._observerInit()
        } catch (loadError) {
            // FAIL-SAFE: If onLoad completely fails, images stay blurred via CSS
            console.error('PhobiaBlocker: onLoad failed, images remain blurred via CSS', loadError)
        } finally {
            if (started) this._analysisFinished()
        }
    }

    onLoadBlurAll(){
        try {
            this.updateImageList(document)
            this._resyncAllImageScopes()
            this.blurAll()
            this._observerInit()
            reportIconStatus('detected')
        } catch (blurAllError) {
            // FAIL-SAFE: If blur-all mode fails, CSS blur is still active
            console.error('PhobiaBlocker: onLoadBlurAll failed, relying on CSS blur', blurAllError)
        }
    }

    _removeEarlyBlurStyle(){
        // Keep early blur style while enabled so it stays "last in cascade" and
        // can't be overridden by late-injected site stylesheets.
        // Only remove it on opt-out paths (disabled/whitelisted) to restore
        // normal pointer-events/cursor behavior immediately.
        if (!document.documentElement.classList.contains('phobia-disabled')) return
        const earlyBlurStyle = document.getElementById('phobiablocker-early-blur')
        if (earlyBlurStyle) earlyBlurStyle.remove()
    }

    _shouldIgnoreMutation(target){
        // Simple, fast check for text input areas
        if (!target) return true

        // Handle text nodes - check parent
        let element = target.nodeType === 3 ? target.parentElement : target
        if (!element) return true

        // Fast tagName check
        let tagName = element.tagName ? element.tagName.toLowerCase() : ''
        if (tagName === 'input' || tagName === 'textarea' || tagName === 'script' ||
            tagName === 'style' || tagName === 'noscript') {
            return true
        }

        // Check contenteditable on element itself
        if (element.isContentEditable) {
            return true
        }

        return false
    }

    _isComplexEditor(target) {
        // Generic check for any complex UI with many elements
        if (!target) return false

        // Handle text nodes
        let element = target.nodeType === 3 ? target.parentElement : target
        if (!element) return false

        // Check if we're inside a contenteditable area (rich text editors)
        if (element.isContentEditable) {
            return true
        }

        // Check if parent tree has many siblings (complex UI indicator)
        // Simple heuristic: if parent has > 20 children, likely a complex UI component
        if (element.parentElement && element.parentElement.children.length > 20) {
            return true
        }

        return false
    }

    _isInsideEditorContainer(element) {
        // Check if element is inside an editor/form container (prevents typing lag)
        if (!element || !element.parentElement) return false

        // Handle text nodes - check parent element
        let target = element.nodeType === 3 ? element.parentElement : element
        if (!target) return false

        // OPTIMIZATION: Cache check first (O(1) lookup)
        let current = target
        const visited = []
        let depth = 0
        const maxDepth = 50

        while (current && depth < maxDepth) {
            visited.push(current)
            // Fast path: check if this element is already known to be in an editor
            if (this._editorContainerCache.has(current)) {
                return true
            }

            // Check if current element is contenteditable
            if (current.isContentEditable) {
                visited.forEach(v => this._editorContainerCache.add(v))
                return true
            }

            // Check tagName for form elements
            let tagName = current.tagName ? current.tagName.toLowerCase() : ''
            if (tagName === 'form' || tagName === 'textarea' || tagName === 'input') {
                visited.forEach(v => this._editorContainerCache.add(v))
                return true
            }

            // Check class names for editor patterns (only if className is a string)
            if (typeof current.className === 'string') {
                let className = current.className.toLowerCase()
                if (className.includes('editor') || className.includes('wiki-edit') ||
                    className.includes('rte') || className.includes('ak-editor') ||
                    className.includes('prosemirror') || className.includes('fabric-editor') ||
                    className.includes('rte-container') || className.includes('richeditor') ||
                    className.includes('tox-') || className.includes('cke') ||
                    className.includes('mce') || className.includes('tinymce') ||
                    className.includes('wysiwyg') || className.includes('contenteditable')) {
                    visited.forEach(v => this._editorContainerCache.add(v))
                    return true
                }
            }

            // Check ID for editor patterns
            if (typeof current.id === 'string') {
                let id = current.id.toLowerCase()
                if (id.includes('editor') || id.includes('mce') || id.includes('cke') ||
                    id.includes('rte') || id.includes('content-title')) {
                    visited.forEach(v => this._editorContainerCache.add(v))
                    return true
                }
            }

            // data-testid patterns used by modern editors (including Atlassian)
            try {
                const testId = current.getAttribute && current.getAttribute('data-testid')
                if (testId && typeof testId === 'string') {
                    const v = testId.toLowerCase()
                    if (v.includes('editor') || v.includes('content-title')) {
                        visited.forEach(n => this._editorContainerCache.add(n))
                        return true
                    }
                }
            } catch (_) {}

            // Stop at body element
            if (tagName === 'body' || current === document.documentElement) {
                break
            }

            current = current.parentElement
            depth++
        }

        return false
    }

    _isInsideInteractiveControl(el) {
        // Returns true if the element is inside an interactive UI control such as a
        // button, tab, or menu item. Images inside these controls are UI chrome
        // (e.g. profile avatars in account-switcher buttons) and should not be blurred.
        // Depth limit: only skip if the interactive role is within 2 levels of the image
        // (depth 0 = direct parent, depth 1 = grandparent). Deeper nesting means the
        // image is content inside a clickable card (e.g. Google search result), not UI chrome.
        let node = el.parentElement
        let depth = 0
        while (node && node !== document.body) {
            const tag = node.tagName
            if (tag === 'BUTTON') return true
            const role = node.getAttribute && node.getAttribute('role')
            if (role && INTERACTIVE_ROLES.has(role)) {
                return depth <= 1
            }
            node = node.parentElement
            depth++
        }
        return false
    }

    _isEditorIframe(iframe) {
        // Check if iframe is part of a text editor or form input
        if (!iframe) return false

        // Check iframe title for editor indicators
        let title = (iframe.getAttribute('title') || '').toLowerCase()
        if (title.includes('editor') || title.includes('text area') ||
            title.includes('rich text') || title.includes('input')) {
            return true
        }

        // Check iframe class names for common editor patterns
        let className = (iframe.className || '').toLowerCase()
        if (className.includes('editor') || className.includes('tox-edit') ||
            className.includes('cke') || className.includes('mce') ||
            className.includes('tinymce') || className.includes('richeditor') ||
            className.includes('wysiwyg')) {
            return true
        }

        // Check iframe ID for editor patterns
        let id = (iframe.id || '').toLowerCase()
        if (id.includes('editor') || id.includes('mce_') || id.includes('cke_')) {
            return true
        }

        // Check if iframe is inside a contenteditable container or form
        let parent = iframe.parentElement
        while (parent) {
            // Check if parent is contenteditable
            if (parent.isContentEditable) {
                return true
            }

            // Check if parent is a form or has editor-related classes
            let tagName = parent.tagName ? parent.tagName.toLowerCase() : ''
            if (tagName === 'form') {
                return true
            }

            let parentClass = (parent.className || '').toLowerCase()
            if (parentClass.includes('editor') || parentClass.includes('wiki-edit') ||
                parentClass.includes('rte-container') || parentClass.includes('richeditor')) {
                return true
            }

            // Don't traverse too far up the DOM
            if (tagName === 'body' || parent === document.documentElement) {
                break
            }

            parent = parent.parentElement
        }

        return false
    }

    _isDataTableWithoutImages(target) {
        // Skip text analysis for table cells/rows if the table has no visual content
        if (!target) return false

        // Handle text nodes - check parent element
        let elementToCheck = target.nodeType === 3 ? target.parentElement : target
        if (!elementToCheck || !elementToCheck.closest) return false

        // Quick native check - if target is not in a table, bail early
        let tableElement = elementToCheck.closest('table')
        if (!tableElement) return false

        // Cache check: if we've checked this table recently, use cached result
        if (!this._tableImageCache) {
            this._tableImageCache = new WeakMap()
        }

        let now = Date.now()

        if (this._tableImageCache.has(tableElement)) {
            let cached = this._tableImageCache.get(tableElement)
            // Cache valid for 5 seconds
            if (now - cached.timestamp < 5000) {
                return !cached.hasImages // Return true if table has NO images
            }
        }

        // Use native browser APIs for maximum performance
        // These are HTMLCollections and much faster than jQuery
        let hasImages = (
            tableElement.getElementsByTagName('img').length > 0 ||
            tableElement.getElementsByTagName('video').length > 0 ||
            tableElement.getElementsByTagName('iframe').length > 0
        )

        // Cache the result
        this._tableImageCache.set(tableElement, {
            hasImages: hasImages,
            timestamp: now
        })

        // Return true if table has NO visual content (should skip text analysis)
        return !hasImages
    }

    _requestMutationBatchProcessing(processImmediately = false) {
        if (this._isProcessingMutationBatch) {
            this._shouldRerunMutationBatch = true
            return
        }

        clearTimeout(this._batchTimer)
        if (processImmediately) {
            void this._processMutationBatch()
            return
        }

        this._batchTimer = setTimeout(() => {
            void this._processMutationBatch()
        }, this._batchProcessInterval)
    }

    async _processMutationBatch(){
        if (this._isProcessingMutationBatch) {
            this._shouldRerunMutationBatch = true
            return
        }
        if (this._mutationBatch.length === 0) return

        this._batchTimer = null
        this._isProcessingMutationBatch = true
        this._shouldRerunMutationBatch = false

        const mutations = this._mutationBatch
        this._mutationBatch = []

        const removedNodes = this._imageNodeList.prune()
        removedNodes.forEach((imageNode) => this._removeImageNodeFromScope(imageNode))

        const typingContext = this._isTextInputActive()
        let started = false

        try {
            // If manual blurAll, blurIsAlwaysOn, or blacklist is active, just find and blur
            // new images without text analysis.
            if (this._manualBlurAllActive || blurIsAlwaysOn || isBlacklisted()) {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes') {
                        if (mutation.target.nodeType !== Node.ELEMENT_NODE) return
                        const t = mutation.target
                        const tag = t.tagName
                        if ((tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') && mutation.attributeName === 'src') {
                            const existingNode = this._imageNodeList.getImageNode(t)
                            if (existingNode) {
                                existingNode.blur()
                            } else {
                                this.updateImageList(t)
                            }
                        } else {
                            // Attribute mutations (class/style) are usually about the mutated element itself.
                            // Avoid scanning large subtrees on every UI class flip.
                            this.updateImageList(t, { selfOnly: true })
                        }
                        return
                    }

                    if (mutation.type !== 'childList') return
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            let { newImages } = this.updateImageList(node, { includeBackgrounds: !typingContext })
                            newImages.forEach(img => img.blur())
                        }
                    })
                })
                return
            }

            let touchedImages = []
            const dirtyScopes = new Set()

            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes') {
                    if (mutation.target.nodeType !== Node.ELEMENT_NODE) return
                    const t = mutation.target
                    const tag = t.tagName
                    if ((tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') && mutation.attributeName === 'src') {
                        const existingNode = this._imageNodeList.getImageNode(t)

                        if (existingNode) {
                            existingNode._analysisGeneration++
                            existingNode.runningTextProcessing = 0
                            existingNode.blur()
                            touchedImages.push(existingNode)
                            return
                        }

                        let { newImages, existingImages } = this.updateImageList(t)
                        touchedImages = touchedImages.concat(newImages, existingImages)
                        return
                    }

                    // For class/style mutations, it's almost always sufficient to check the
                    // mutated element itself (background-image changes); scanning descendants
                    // is prohibitively expensive on large apps like Confluence.
                    let { newImages, existingImages } = this.updateImageList(t, { selfOnly: true })
                    touchedImages = touchedImages.concat(newImages, existingImages)
                } else if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType !== Node.ELEMENT_NODE) return
                        let { newImages, existingImages } = this.updateImageList(node, { includeBackgrounds: !typingContext })
                        touchedImages = touchedImages.concat(newImages, existingImages)
                    })
                }

                this._collectAffectedScopesFromMutation(mutation).forEach((scope) => {
                    dirtyScopes.add(scope)
                })
            })

            const scopeStates = new Set([
                ...dirtyScopes,
                ...this._getScopeStatesForImageNodes(touchedImages),
            ])

            if (scopeStates.size === 0) return

            if (this._scopeStatesNeedFreshAnalysis([...scopeStates])) {
                this._analysisStarted()
                started = true
            }
            const analysisEpoch = this._analysisEpoch
            await this._reanalyzeScopes([...scopeStates], analysisEpoch)
        } catch (err) {
            console.error('Error in mutation batch scope analysis:', err)
        } finally {
            if (started) this._analysisFinished()
            this._isProcessingMutationBatch = false

            if (this._mutationBatch.length > 0 || this._shouldRerunMutationBatch) {
                this._shouldRerunMutationBatch = false
                this._requestMutationBatchProcessing(true)
            }
        }
    }

    _observerInit(){
        // Disconnect existing observer if it exists to prevent multiple observers
        if (this.observer) {
            this.observer.disconnect()
        }

        this.observer = new MutationObserver((mutations) => {
            // Defensive: wrap entire observer in try-catch to prevent breaking pages
            try {
                const typingContext = this._isTextInputActive()
                // Aggressively filter mutations before processing
                mutations.forEach((mutation) => {
                    try {
                        let target = mutation.target

                        // Defensive: skip if target is null or undefined
                        if (!target) {
                            return
                        }

                        // Fast path: check if it's a text node's parent that's an input
                        if (target.nodeType === 3) {
                            let parent = target.parentElement
                            if (parent && (parent.tagName === 'INPUT' || parent.tagName === 'TEXTAREA' || parent.isContentEditable)) {
                                return
                            }
                        }

                        // Skip if target is input/textarea/contenteditable (with defensive checks)
                        if (target.tagName && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                            return
                        }

                        // Skip if mutation is inside an editor container (prevents typing lag)
                        // But still exempt editor iframes from blur so they remain clickable.
                        if (this._isInsideEditorContainer(target)) {
                            if (mutation.type === 'childList') {
                                mutation.addedNodes.forEach((node) => {
                                    if (node.nodeType !== Node.ELEMENT_NODE) return
                                    const iframes = node.tagName === 'IFRAME' ? [node]
                                        : (node.querySelectorAll ? [...node.querySelectorAll('iframe')] : [])
                                    iframes.forEach((iframe) => {
                                        if (this._isEditorIframe(iframe)) {
                                            iframe.classList.add('phobia-noblur')
                                            iframe.classList.remove('phobia-blur')
                                        }
                                    })
                                })
                            }
                            return
                        }

                        // Extra guard: while the user is typing, defer most non-media UI churn
                        // (class/style flips and non-media childList updates) to avoid typing lag.
                        if (typingContext && this._shouldDeferMutationDuringTyping(mutation)) {
                            this._collectAffectedScopesFromMutation(mutation).forEach((scope) => {
                                this._deferredDirtyScopes.add(scope)
                            })
                            this._schedulePostTypingMediaScan()
                            return
                        }

                        // Only process childList, characterData, and relevant attributes mutations.
                        // class/style: skip on IMG/VIDEO/IFRAME — the extension itself toggles
                        // those constantly and would create infinite observer loops.
                        // src: always allow on IMG/VIDEO/IFRAME — a src change means new content
                        // that needs re-analysis (element may already have phobia-noblur from a
                        // previous analysis of the placeholder/empty state).
                        if (mutation.type === 'attributes') {
                            const t = mutation.target
                            const tag = t.tagName
                            if ((mutation.attributeName === 'class' || mutation.attributeName === 'style') &&
                                isInternalMutationTarget(t)) return
                            if ((tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') && mutation.attributeName !== 'src') return
                            if (mutation.attributeName === 'style' && t.classList &&
                                (t.classList.contains('phobia-blur') || t.classList.contains('phobia-noblur'))) return
                        } else if (mutation.type !== 'childList' && mutation.type !== 'characterData') {
                            return
                        }

                        // Add to batch for processing
                        this._mutationBatch.push(mutation)
                    } catch (mutationError) {
                        // Silently skip problematic mutations
                        // Don't break the entire observer for one bad mutation
                    }
                })
            } catch (observerError) {
                // Log but don't break the page
                console.error('PhobiaBlocker: MutationObserver error', observerError)
            }

            if (this._mutationBatch.length === 0) return

            // Process immediately on blacklisted sites (no NLP needed, prevents background-image flash)
            if (isBlacklisted()) {
                this._requestMutationBatchProcessing(true)
                return
            }

            // Process immediately if batch is large (for infinite scroll)
            if (this._mutationBatch.length >= this._maxBatchSize) {
                this._requestMutationBatchProcessing(true)
                return
            }

            // Otherwise, debounce with timer
            this._requestMutationBatchProcessing(false)
        })
        this.observer.observe(document, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'src']  // src: re-analyze when lazy-load sets new content on existing elements
        })
    }

    stop(){
        if (this.observer) {
            this.observer.disconnect()
        }
        clearTimeout(this._batchTimer)
        clearTimeout(this._postTypingScanTimer)
        this._mutationBatch = []
        this._runningAnalyses = 0
        this._isProcessingMutationBatch = false
        this._shouldRerunMutationBatch = false
        this._deferredDirtyScopes.clear()
        this.unBlurAll()
        this._imageNodeList.teardown()
        this._resetAnalysisScopes()
        this._imageNodeList = new ImageNodeList()
        reportIconStatus('idle')
    }

    resetImageNodeList(){
        this._imageNodeList.teardown()
        this._resetAnalysisScopes()
        this._imageNodeList = new ImageNodeList()
        this.updateImageList(document)
        this._resyncAllImageScopes()
    }

    blurAll(manual = false){
        if (manual) this._manualBlurAllActive = true
        this._imageNodeList.blurAllImages()
    }

    unBlurAll(){
        this._manualBlurAllActive = false
        this._imageNodeList.unBlurAllImages()
    }
}

/**
 * Check if current site matches a pattern
 * Supports: exact domains, wildcards (*.example.com), paths (example.com/path)
 */
function matchesSitePattern(currentUrl, pattern) {
    try {
        const url = new URL(currentUrl)
        const hostname = url.hostname.toLowerCase()
        pattern = pattern.toLowerCase()
        const [hostPattern, ...pathParts] = pattern.split('/')
        const pathPattern = pathParts.length > 0 ? `/${pathParts.join('/')}` : ''

        const hostMatches = (candidate, rule) => {
            if (rule.startsWith('*.')) {
                const baseDomain = rule.substring(2)
                return candidate === baseDomain || candidate.endsWith(`.${baseDomain}`)
            }
            return candidate === rule || candidate.endsWith(`.${rule}`)
        }

        if (!hostMatches(hostname, hostPattern)) {
            return false
        }

        if (!pathPattern) {
            return true
        }

        return url.pathname === pathPattern || url.pathname.startsWith(`${pathPattern}/`)
    } catch (e) {
        debugLog('SiteRules', 'Error matching pattern', { currentUrl, pattern, error: e.message })
        return false
    }
}

/**
 * Check if current site is whitelisted
 */
function isWhitelisted() {
    const currentUrl = window.location.href
    return whitelistedSites.some(pattern => matchesSitePattern(currentUrl, pattern))
}

/**
 * Check if current site is blacklisted
 */
function isBlacklisted() {
    const currentUrl = window.location.href
    return blacklistedSites.some(pattern => matchesSitePattern(currentUrl, pattern))
}

/**
 * Checks if target words are set, if target words are present in storage -> use those words
 * Target words are words defined by user in the extention
 */
let setSettings = () => {
    return new Promise((resolve) => {
        try {
            chrome.storage.sync.get([
                'phobiaBlockerEnabled',
                'blurIsAlwaysOn',
                'blurValueAmount',
                'debugMode',
                'whitelistedSites',
                'blacklistedSites',
                'previewEnabled',
                'previewBlurStrength'
            ], (storage) => {
                try {
                    if (chrome.runtime.lastError) {
                        // FAIL-SAFE: If storage fails, keep blur enabled
                        console.error('PhobiaBlocker: Storage error, defaulting to blur-all mode', chrome.runtime.lastError)
                        phobiaBlockerEnabled = true
                        blurIsAlwaysOn = true
                        return resolve() // Continue with blur-all mode
                    }

                    if(storage.phobiaBlockerEnabled != undefined){
                        phobiaBlockerEnabled = storage.phobiaBlockerEnabled
                    }
                    if(storage.blurIsAlwaysOn != undefined)
                        blurIsAlwaysOn = storage.blurIsAlwaysOn

                    // Apply blur amount setting with validation
                    let blurVal = storage.blurValueAmount
                    if (blurVal != undefined && typeof blurVal === 'number' && blurVal >= 0 && blurVal <= 100) {
                        let blurPixels = Math.pow(blurVal * 0.09, 1.8) * 2
                        setBlurCssValue(blurPixels + 'px')
                    } else {
                        let defaultBlurPixels = Math.pow(DEFAULT_BLUR_SLIDER_VALUE * 0.09, 1.8) * 2
                        setBlurCssValue(defaultBlurPixels + 'px')
                    }

                    // Load debug mode setting
                    if (storage.debugMode != undefined) {
                        window.PHOBIABLOCKER_DEBUG = storage.debugMode
                    }

                    // Load site rules
                    if (storage.whitelistedSites && Array.isArray(storage.whitelistedSites)) {
                        whitelistedSites = storage.whitelistedSites
                    }
                    if (storage.blacklistedSites && Array.isArray(storage.blacklistedSites)) {
                        blacklistedSites = storage.blacklistedSites
                    }

                    // Load preview settings
                    if (storage.previewEnabled != undefined) {
                        previewEnabled = storage.previewEnabled
                    }
                    if (storage.previewBlurStrength != undefined) {
                        previewBlurStrength = storage.previewBlurStrength
                    }
                    applyPreviewCssVar()

                    debugLog('Storage', 'Settings loaded', {
                        enabled: phobiaBlockerEnabled,
                        blurAlways: blurIsAlwaysOn,
                        debugMode: window.PHOBIABLOCKER_DEBUG,
                        whitelistCount: whitelistedSites.length,
                        blacklistCount: blacklistedSites.length
                    })

                    return resolve()
                } catch (storageError) {
                    // FAIL-SAFE: If anything fails, default to blur-all mode
                    console.error('PhobiaBlocker: Settings error, defaulting to blur-all mode', storageError)
                    phobiaBlockerEnabled = true
                    blurIsAlwaysOn = true
                    return resolve() // Continue with blur-all mode
                }
            })
        } catch (outerError) {
            // FAIL-SAFE: If chrome.storage.sync is unavailable, default to blur-all
            console.error('PhobiaBlocker: Storage API unavailable, defaulting to blur-all mode', outerError)
            phobiaBlockerEnabled = true
            blurIsAlwaysOn = true
            return resolve() // Continue with blur-all mode
        }
    })
}

var controller = new Controller()

// Fast-path: remove early blur immediately if extension is disabled or site is whitelisted.
// main() also handles these cases but fires after DOMContentLoaded — potentially hundreds of
// milliseconds later, during which the early blur IIFE would keep images blurred on opt-out paths.
setSettings().then(() => {
    // Whitelist takes priority - completely disable extension
    if (isWhitelisted()) {
        debugLog('SiteRules', 'Site is whitelisted - disabling blur immediately', { url: window.location.href })
        document.documentElement.classList.add('phobia-disabled')
        setBlurCssValue('0px')
        controller._removeEarlyBlurStyle()
        return
    }

    // Extension disabled - remove blur
    if(!phobiaBlockerEnabled) {
        document.documentElement.classList.add('phobia-disabled')
        setBlurCssValue('0px')
        controller._removeEarlyBlurStyle()
    }
})

let main = async () => {
    try {
        await setSettings()

        // Check site rules (blacklist takes precedence over whitelist)
        if (isBlacklisted()) {
            debugLog('SiteRules', 'Site is blacklisted - forcing blur all', { url: window.location.href })
            controller.onLoadBlurAll()
            return
        }

        if (isWhitelisted()) {
            debugLog('SiteRules', 'Site is whitelisted - disabling extension', { url: window.location.href })
            document.documentElement.classList.add('phobia-disabled')
            setBlurCssValue(0 + 'px')
            controller._removeEarlyBlurStyle()
            reportIconStatus('idle')
            return
        }

        // Normal operation based on user settings
        if(blurIsAlwaysOn){
            controller.onLoadBlurAll()
        }
        else if(phobiaBlockerEnabled){
            controller.onLoad()
        }
        else if(!phobiaBlockerEnabled) {
            document.documentElement.classList.add('phobia-disabled')
            setBlurCssValue(0 + 'px')
            // Remove early blur style if extension is disabled
            controller._removeEarlyBlurStyle()
            reportIconStatus('idle')
        }
    } catch (mainError) {
        // FAIL-SAFE: If main execution fails, blur everything
        console.error('PhobiaBlocker: Main execution failed, defaulting to blur-all mode', mainError)
        try {
            controller.onLoadBlurAll()
        } catch (blurError) {
            // Last resort: CSS blur is already applied from early injection
            console.error('PhobiaBlocker: Could not activate blur-all mode, relying on CSS', blurError)
        }
    }
}

// Apply --previewBlurAmount CSS variable based on current preview settings
function applyPreviewCssVar() {
    if (previewEnabled) {
        setPreviewBlurCssValue(previewBlurStrength + 'px')
    } else {
        // When disabled, set preview amount equal to full blur so hover has no visible effect
        setPreviewBlurCssValue('var(--phobiablocker-blurValueAmount, var(--blurValueAmount, 40px))')
    }
}

// Use native DOMContentLoader
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main)
} else {
    // Document already loaded
    main()
}

document.addEventListener('contextmenu', (event) => {lastElementContext = event.target}, true)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.target && message.target !== 'content') return

    let responded = false
    const respond = (payload) => {
        if (responded) return
        responded = true
        try { sendResponse(payload) } catch (_) { /* ignore */ }
    }
    switch (message.type) {
    case 'getTriggeredWords': {
        if (!isTopFrameContext()) {
            return false
        }

        // If extension is disabled on this site, nothing is visually blurred — report nothing
        if (document.documentElement.classList.contains('phobia-disabled')) {
            respond({ words: [] })
            return true
        }
        // If blur amount is 0px, nothing is visually blurred — report nothing
        const blurAmountStr = document.documentElement.style.getPropertyValue('--blurValueAmount')
        const blurAmount = parseFloat(blurAmountStr)
        if (!isNaN(blurAmount) && blurAmount <= 0) {
            respond({ words: [] })
            return true
        }

        const pageResult = controller._lastPageAnalysisResult
        const matchedWords = Array.isArray(pageResult?.matchedWords)
            ? pageResult.matchedWords.filter(Boolean)
            : []

        if (!pageResult?.shouldBlur || matchedWords.length === 0) {
            respond({ words: [] })
            return true
        }

        const words = [...new Set(matchedWords)]
            .map((word) => ({ word, count: 1 }))
            .sort((a, b) => a.word.localeCompare(b.word))
        respond({ words })
        return true
    }
    case 'blurAll': {
        try {
            controller._invalidatePendingAnalysis()
            controller._permanentlyUnblurred = false
            // Remove permamentUnblur from all elements so blur() can re-apply
            document.querySelectorAll('.phobia-permanent-unblur').forEach(el => {
                el.classList.remove('phobia-permanent-unblur', 'phobia-noblur')
            })
            // Check if user has set blur amount before, if not use maximum
            chrome.storage.sync.get('blurValueAmount', (storage) => {
                try {
                    if (storage && storage.blurValueAmount != undefined) {
                        let blurPixels = Math.pow(storage.blurValueAmount * 0.09, 1.8) * 2
                        setBlurCssValue(blurPixels + 'px')
                    } else {
                        // First time - use most aggressive settings
                        let maxBlurPixels = Math.pow(DEFAULT_BLUR_SLIDER_VALUE * 0.09, 1.8) * 2
                        setBlurCssValue(maxBlurPixels + 'px')
                    }
                    // Populate image list if empty (e.g., if page loaded with extension disabled)
                    if (controller._imageNodeList.getAllImages().length === 0) {
                        controller.updateImageList(document)
                        controller._resyncAllImageScopes()
                    }
                    // Blur after blur amount is set
                    controller.blurAll(true)
                    // On whitelisted/disabled sites, html.phobia-disabled CSS rule
                    // (specificity 0,2,2) overrides class-based blur (0,1,1). Force an
                    // inline style with !important — it beats all stylesheet rules.
                    // Hover preview is handled in _attachContainerListeners, which reads
                    // phobia-disabled at event time and sets inline preview/full blur there.
                    if (document.documentElement.classList.contains('phobia-disabled')) {
                        const blurValueStr = document.documentElement.style.getPropertyValue('--blurValueAmount')
                        document.querySelectorAll('[data-phobia-blur]').forEach(el => {
                            el.style.setProperty('filter', `blur(${blurValueStr})`, 'important')
                        })
                    }
                    reportIconStatus('detected')
                    respond({ ok: true })
                } catch (e) {
                    console.error('PhobiaBlocker: blurAll handler failed', e)
                    respond({ ok: false })
                }
            })
        } catch (e) {
            console.error('PhobiaBlocker: blurAll handler failed (sync)', e)
            respond({ ok: false })
        }
        return true
    }
    case 'unblurAll': {
        try {
            controller._invalidatePendingAnalysis()
            // Populate image list if empty (e.g., if page loaded with extension disabled)
            if (controller._imageNodeList.getAllImages().length === 0) {
                controller.updateImageList(document)
                controller._resyncAllImageScopes()
            }
            // Collect ALL visual elements BEFORE controller.unBlurAll() removes the phobia-blur
            // class. BgImageNode divs are identified only by .phobia-blur — if we query after
            // unBlurAll() the class is gone and the selector misses them.
            const toMarkPermanent = [...document.querySelectorAll('img, video, iframe, .phobia-blur')]
            controller.unBlurAll()
            // Mark ALL collected elements as permanently unblurred so that:
            // 1. Subsequent NLP analysis cannot re-blur them (blur() checks phobia-permanent-unblur)
            // 2. Hover preview does not apply (CSS rules exclude .phobia-permanent-unblur)
            toMarkPermanent.forEach(el => {
                el.classList.remove('phobia-blur')
                el.classList.add('phobia-noblur', 'phobia-permanent-unblur')
                el.removeAttribute('data-phobia-blur')
                el.style.removeProperty('filter')
            })
            // Any new images that appear after this point (lazy-load, infinite scroll)
            // should also be immediately unblurred without going through NLP analysis.
            controller._permanentlyUnblurred = true
            controller._lastPageAnalysisResult = null
            reportIconStatus('idle')
            respond({ ok: true })
        } catch (e) {
            console.error('PhobiaBlocker: unblurAll handler failed', e)
            respond({ ok: false })
        }
        return true
    }
    case 'setBlurAmount':
        // Check if site is whitelisted - if so, keep blur at 0
        if (isWhitelisted()) {
            debugLog('SiteRules', 'Site is whitelisted - ignoring blur amount change', { url: window.location.href })
            setBlurCssValue('0px')
            return
        }
        let blurValueAmount = message.value
        if (blurValueAmount != undefined) {
            // Value provided in message (real-time update while dragging)
            let blurPixels = Math.pow(blurValueAmount * 0.09, 1.8) * 2
            setBlurCssValue(blurPixels + 'px')
        } else {
            // Get from storage (for other scenarios)
            chrome.storage.sync.get('blurValueAmount', (storage) => {
                let storedValue = storage['blurValueAmount']
                if (storedValue != undefined) {
                    let blurPixels = Math.pow(storedValue * 0.09, 1.8) * 2
                    setBlurCssValue(blurPixels + 'px')
                } else {
                    let defaultBlurPixels = Math.pow(DEFAULT_BLUR_SLIDER_VALUE * 0.09, 1.8) * 2
                    setBlurCssValue(defaultBlurPixels + 'px')
                }
            })
        }
        break
    case 'unblur':
        if (lastElementContext) {
            let blured = null

            // Check if the clicked element itself is blurred
            if (lastElementContext.classList && lastElementContext.classList.contains('phobia-blur')) {
                blured = lastElementContext
            }
            // Check children with blur class
            else {
                blured = lastElementContext.querySelector('.phobia-blur')
            }
            // Check siblings if nothing found
            if (!blured && lastElementContext.parentElement) {
                const siblings = Array.from(lastElementContext.parentElement.children)
                blured = siblings.find(sibling =>
                    sibling !== lastElementContext &&
                    sibling.classList &&
                    sibling.classList.contains('phobia-blur')
                )
            }
            // Check parent if still nothing found
            if (!blured && lastElementContext.parentElement) {
                const parent = lastElementContext.parentElement
                if (parent.classList && parent.classList.contains('phobia-blur')) {
                    blured = parent
                }
            }
            // Check if parent has blurred children
            if (!blured && lastElementContext.parentElement) {
                blured = lastElementContext.parentElement.querySelector('.phobia-blur')
            }

            // Last resort: element may be CSS-blurred without a .blur class (image hasn't been
            // analyzed yet, or pointer-events:none caused the click to land on a parent).
            // Walk up to grandparent looking for any img/video/iframe that isn't already unblurred.
            if (!blured) {
                const CSS_BLURRED = 'img:not(.phobia-noblur):not(.phobia-permanent-unblur), video:not(.phobia-noblur):not(.phobia-permanent-unblur), iframe:not(.phobia-noblur):not(.phobia-permanent-unblur)'
                const TAGS = ['IMG', 'VIDEO', 'IFRAME']
                let node = lastElementContext
                for (; node; node = node.parentElement) {
                    if (TAGS.includes(node.nodeName) && !node.classList.contains('phobia-noblur') && !node.classList.contains('phobia-permanent-unblur')) {
                        blured = node
                        break
                    }
                    const found = node.querySelector ? node.querySelector(CSS_BLURRED) : null
                    if (found) { blured = found; break }
                }
            }

            if (blured) {
                blured.classList.remove('phobia-blur')
                blured.classList.add('phobia-noblur', 'phobia-permanent-unblur')
                blured.removeAttribute('data-phobia-blur')
                blured.style.removeProperty('filter')
                const hasRemainingBlurred = document.querySelector('[data-phobia-blur], .phobia-blur')
                reportIconStatus(hasRemainingBlurred ? 'detected' : 'idle')
            }
        }
        break
    case 'phobiaBlockerEnabled':
        phobiaBlockerEnabled = message.value
        if(!phobiaBlockerEnabled){
            document.documentElement.classList.add('phobia-disabled')
            controller.stop()
            // Remove early blur style when disabling extension
            controller._removeEarlyBlurStyle()
        }
        else {
            document.documentElement.classList.remove('phobia-disabled')
            // Check site rules before enabling
            if (isWhitelisted()) {
                debugLog('SiteRules', 'Site is whitelisted - not enabling extension', { url: window.location.href })
                return
            }
            if (isBlacklisted()) {
                debugLog('SiteRules', 'Site is blacklisted - forcing blur all', { url: window.location.href })
                controller.onLoadBlurAll()
                return
            }
            // Normal operation
            if(blurIsAlwaysOn){
                controller.onLoadBlurAll()
            } else {
                controller.onLoad()
            }
        }
        break
    case 'blurIsAlwaysOn':
        blurIsAlwaysOn = message.value
        controller._invalidatePendingAnalysis()
        controller._permanentlyUnblurred = false
        // Check site rules first
        if (isWhitelisted()) {
            debugLog('SiteRules', 'Site is whitelisted - ignoring blurIsAlwaysOn change', { url: window.location.href })
            return
        }
        if(blurIsAlwaysOn){
            // Blacklist or normal operation: blur everything
            // Check if user has set blur amount before, if not use maximum
            const blurGen = ++controller._blurToggleGeneration
            chrome.storage.sync.get('blurValueAmount', (storage) => {
                if (blurGen !== controller._blurToggleGeneration) return
                if (storage.blurValueAmount != undefined) {
                    let blurPixels = Math.pow(storage.blurValueAmount * 0.09, 1.8) * 2
                    setBlurCssValue(blurPixels + 'px')
                } else {
                    // First time - use most aggressive settings
                    let maxBlurPixels = Math.pow(DEFAULT_BLUR_SLIDER_VALUE * 0.09, 1.8) * 2
                    setBlurCssValue(maxBlurPixels + 'px')
                }
                // Execute after blur amount is set
                if (controller.observer) {
                    controller.observer.disconnect()
                }
                clearTimeout(controller._batchTimer)
                clearTimeout(controller._postTypingScanTimer)
                controller._batchTimer = null
                controller._postTypingScanTimer = null
                controller._mutationBatch = []
                controller._isProcessingMutationBatch = false
                controller._shouldRerunMutationBatch = false
                controller._deferredDirtyScopes.clear()
                // Clear classes but preserve permamentUnblur
                const elementsToReset = document.querySelectorAll('.phobia-blur:not(.phobia-permanent-unblur), .phobia-noblur:not(.phobia-permanent-unblur)')
                elementsToReset.forEach(el => {
                    el.classList.remove('phobia-blur', 'phobia-noblur')
                })
                controller._imageNodeList.teardown()
                controller._resetAnalysisScopes()
                controller._imageNodeList = new ImageNodeList()
                controller.updateImageList(document)
                controller.blurAll()
                controller._observerInit()
            })
        }
        else {
            // Disabling blurIsAlwaysOn
            ++controller._blurToggleGeneration
            if (isBlacklisted()) {
                debugLog('SiteRules', 'Site is blacklisted - keeping blur despite blurIsAlwaysOn=false', { url: window.location.href })
                return
            }
            // Normal operation: re-analyze
            if (controller.observer) {
                controller.observer.disconnect()
            }
            clearTimeout(controller._batchTimer)
            clearTimeout(controller._postTypingScanTimer)
            controller._batchTimer = null
            controller._postTypingScanTimer = null
            controller._mutationBatch = []
            controller._isProcessingMutationBatch = false
            controller._shouldRerunMutationBatch = false
            controller._deferredDirtyScopes.clear()
            // Clear classes but preserve permamentUnblur
            const elementsToReset = document.querySelectorAll('.phobia-blur:not(.phobia-permanent-unblur), .phobia-noblur:not(.phobia-permanent-unblur)')
            elementsToReset.forEach(el => {
                el.classList.remove('phobia-blur', 'phobia-noblur')
            })
            controller._imageNodeList.teardown()
            controller._resetAnalysisScopes()
            controller._imageNodeList = new ImageNodeList()
            controller.onLoad()
        }
        break
    case 'targetWordsChanged':
        controller._invalidatePendingAnalysis()
        controller._invalidateAllScopeResults()
        controller._permanentlyUnblurred = false
        if (isWhitelisted()) {
            debugLog('SiteRules', 'Site is whitelisted - ignoring target words change', { url: window.location.href })
            return
        }
        if (isBlacklisted()) {
            debugLog('SiteRules', 'Site is blacklisted - keeping all content blurred', { url: window.location.href })
            return
        }
        {
            const noblurElements = document.querySelectorAll('.phobia-noblur:not(.phobia-permanent-unblur)')
            noblurElements.forEach(el => {
                el.classList.remove('phobia-noblur')
                el.classList.add('phobia-blur')
            })

            controller._deferredDirtyScopes.clear()

            if (phobiaBlockerEnabled && !blurIsAlwaysOn) {
                if (controller._imageNodeList.getAllImages().length === 0) {
                    controller.updateImageList(document)
                    controller._resyncAllImageScopes()
                }

                const scopeStates = controller._getAllActiveScopeStates()
                if (scopeStates.length === 0) {
                    reportIconStatus('idle')
                    break
                }

                const analysisEpoch = controller._analysisEpoch
                const shouldShowProcessing = controller._scopeStatesNeedFreshAnalysis(scopeStates)
                if (shouldShowProcessing) {
                    controller._analysisStarted()
                }
                controller._reanalyzeScopes(scopeStates, analysisEpoch).catch(err => {
                    console.error('Error in targetWordsChanged analysis:', err)
                }).finally(() => {
                    if (shouldShowProcessing) {
                        controller._analysisFinished()
                    }
                })
            }
        }
        break
    case 'debugModeChanged':
        // Debug mode changed from settings page
        window.PHOBIABLOCKER_DEBUG = message.value
        debugLog('MessagePassing', 'Debug mode changed', { debugMode: message.value })
        break
    case 'siteRulesChanged':
        // Site rules changed from settings page - reload page to apply new rules
        debugLog('MessagePassing', 'Site rules changed - reloading page', { url: window.location.href })
        window.location.reload()
        break
    case 'previewSettingsChanged':
        if (message.previewEnabled != undefined) previewEnabled = message.previewEnabled
        if (message.previewBlurStrength != undefined) previewBlurStrength = message.previewBlurStrength
        applyPreviewCssVar()
        debugLog('MessagePassing', 'Preview settings changed', { previewEnabled, previewBlurStrength })
        break
    default:
        console.warn('PhobiaBlocker: Unknown message type', message.type)
    }
})
