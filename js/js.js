// Inject CSS to blur all images on page load to prevent flash
// Uses requestAnimationFrame to avoid disrupting framework initialization
// while still being early enough to prevent unblurred image flash
(function injectEarlyBlur() {
    const injectStyle = () => {
        try {
            // Check if already injected
            if (document.getElementById('phobiablocker-early-blur')) {
                return
            }

            const style = document.createElement('style')
            style.id = 'phobiablocker-early-blur'
            style.textContent = `
                /* CRITICAL: Blur ALL unprocessed visual content immediately to prevent flash */
                img:not(.phobia-noblur):not(.phobia-permanent-unblur):not(.phobia-blur),
                video:not(.phobia-noblur):not(.phobia-permanent-unblur):not(.phobia-blur),
                iframe:not(.phobia-noblur):not(.phobia-permanent-unblur):not(.phobia-blur) {
                    filter: blur(var(--blurValueAmount, 40px)) !important;
                    -webkit-filter: blur(var(--blurValueAmount, 40px)) !important;
                    pointer-events: none !important;
                    cursor: default !important;
                }
                /* Extension-blurred elements — pointer-events and hover only for elements
                   explicitly marked by the extension via data-phobia-blur. Using a data
                   attribute instead of the .blur class prevents false matches on sites
                   that use "blur" as their own CSS class (e.g. IMDB, Gemini). */
                img[data-phobia-blur]:not(.phobia-permanent-unblur),
                video[data-phobia-blur]:not(.phobia-permanent-unblur),
                iframe[data-phobia-blur]:not(.phobia-permanent-unblur) {
                    pointer-events: auto !important;
                    cursor: pointer !important;
                    transition: filter 0.2s ease !important;
                }
                /* Hover preview — CSS :hover fallback + JS-driven .phobia-preview class */
                img[data-phobia-blur]:not(.phobia-permanent-unblur):hover,
                img.phobia-preview:not(.phobia-permanent-unblur),
                video[data-phobia-blur]:not(.phobia-permanent-unblur):hover,
                iframe[data-phobia-blur]:not(.phobia-permanent-unblur):hover {
                    filter: blur(var(--previewBlurAmount, 4px)) !important;
                    -webkit-filter: blur(var(--previewBlurAmount, 4px)) !important;
                }
            `

            // Defensive: Ensure document and documentElement exist
            if (!document || !document.documentElement) {
                return
            }

            // Inject into body if available (less disruptive than head for frameworks)
            // Otherwise fall back to head
            const targetParent = document.body || document.head

            if (targetParent) {
                targetParent.appendChild(style)
            } else if (document.documentElement) {
                // Last resort: append directly to html element
                document.documentElement.appendChild(style)
            }
        } catch (error) {
            // Silently fail - don't break the page if blur injection fails
            // The CSS file loaded via manifest will still apply blur as fallback
            console.error('PhobiaBlocker: Failed to inject early blur CSS', error)
        }
    }

    // Try immediate injection first for fastest blur
    injectStyle()

    // Also try after a microtask to ensure it works if first attempt was too early
    // This gives frameworks a chance to initialize their head management
    if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(injectStyle)
    } else {
        setTimeout(injectStyle, 0)
    }
})()

const tokenizer = new natural.WordTokenizer()
const DEFAULT_BLUR_SLIDER_VALUE = 50 // Matches popup.js slider default
const DEFAULT_PREVIEW_BLUR_STRENGTH = 5 // Matches settings.js default
const INTERACTIVE_ROLES = new Set(['button', 'tab', 'menuitem', 'option', 'treeitem', 'link'])
const NORMALIZE_PARAMS = {
    whitespace: true,
    unicode: true,
    contractions: true,
    acronyms: true,
    possessives: true,
    plurals: true,
    verbs: true,
}

let targetWords = []
let targetWordsNormalized = []
let lastElementContext
let phobiaBlockerEnabled = true
let blurIsAlwaysOn = false
let whitelistedSites = []
let blacklistedSites = []
let previewEnabled = true
let previewBlurStrength = DEFAULT_PREVIEW_BLUR_STRENGTH

let _iconStatusTimer = null
function reportIconStatus(status) {
    if (status === 'processing') {
        // Show immediately — cancel any pending idle/detected so it doesn't fire after us
        clearTimeout(_iconStatusTimer)
        _iconStatusTimer = null
        try { chrome.runtime.sendMessage({ type: 'iconStatus', status }).catch(() => {}) } catch (_) {}
    } else {
        // Debounce idle/detected: only fire after 800 ms with no new processing cycle.
        // Prevents rapid yellow→normal→yellow flicker from repeated MutationObserver batches.
        clearTimeout(_iconStatusTimer)
        _iconStatusTimer = setTimeout(() => {
            try { chrome.runtime.sendMessage({ type: 'iconStatus', status }).catch(() => {}) } catch (_) {}
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

        const addPreview = () => {
            if (!this._imageNode || !this._imageNode.classList) return
            this._imageNode.classList.add('phobia-preview')
            // On disabled sites, html.phobia-disabled overrides CSS preview rules,
            // so force the preview blur via inline style instead.
            if (document.documentElement.classList.contains('phobia-disabled')) {
                const previewVal = previewEnabled ? `${previewBlurStrength}px`
                    : document.documentElement.style.getPropertyValue('--blurValueAmount')
                this._imageNode.style.setProperty('filter', `blur(${previewVal})`, 'important')
            }
        }
        const removePreview = () => {
            if (!this._imageNode || !this._imageNode.classList) return
            this._imageNode.classList.remove('phobia-preview')
            // Restore full blur inline style only if the element is still force-blurred
            if (document.documentElement.classList.contains('phobia-disabled')
                    && this._imageNode.hasAttribute('data-phobia-blur')) {
                const blurVal = document.documentElement.style.getPropertyValue('--blurValueAmount')
                this._imageNode.style.setProperty('filter', `blur(${blurVal})`, 'important')
            }
        }

        this._boundMouseEnter = addPreview
        this._boundMouseLeave = (e) => {
            if (!this._imageNode || !this._imageNode.classList) return
            const rt = e.relatedTarget
            const parent = this._container.parentElement
            // Mouse moved to a sibling of the container — keep preview active until
            // mouse leaves the shared parent.
            if (rt && parent && parent !== document.body &&
                parent.contains(rt) && !this._container.contains(rt)) {
                parent.addEventListener('mouseleave', removePreview, { once: true })
                return
            }
            removePreview()
        }

        this._container.addEventListener('mouseenter', this._boundMouseEnter)
        this._container.addEventListener('mouseleave', this._boundMouseLeave)

        // Attach to absolutely-positioned siblings that
        // visually cover the container and intercept pointer events before they reach it.
        const parent = this._container.parentElement
        if (parent) {
            this._overlaySiblings = []
            for (const sibling of parent.children) {
                if (sibling === this._container) continue
                try {
                    const pos = window.getComputedStyle(sibling).position
                    if (pos === 'absolute' && sibling.querySelectorAll('img, video, iframe').length === 0) {
                        // For overlay mouseleave: if mouse stays inside parent, keep preview
                        // and wait for parent to lose focus; otherwise remove immediately.
                        const overlayLeave = (e) => {
                            if (!this._imageNode || !this._imageNode.classList) return
                            const rt = e.relatedTarget
                            if (rt && parent.contains(rt)) {
                                // Still inside the card — keep preview; container/parent handles cleanup
                                parent.addEventListener('mouseleave', removePreview, { once: true })
                                return
                            }
                            removePreview()
                        }
                        sibling.addEventListener('mouseenter', addPreview)
                        sibling.addEventListener('mouseleave', overlayLeave)
                        this._overlaySiblings.push({ el: sibling, enter: addPreview, leave: overlayLeave })
                    }
                } catch (_) { /* skip detached nodes */ }
            }
        }
    }

    _detachContainerListeners() {
        if (!this._container || !this._boundMouseEnter) return
        this._container.removeEventListener('mouseenter', this._boundMouseEnter)
        this._container.removeEventListener('mouseleave', this._boundMouseLeave)
        if (this._overlaySiblings) {
            for (const { el, enter, leave } of this._overlaySiblings) {
                el.removeEventListener('mouseenter', enter)
                el.removeEventListener('mouseleave', leave)
            }
            this._overlaySiblings = null
        }
        this._boundMouseEnter = null
        this._boundMouseLeave = null
    }

    blur() {
        if (!this._isNodeValid()) return
        if (!this._imageNode.classList.contains('phobia-permanent-unblur')){
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

    textProcessingFinished(generation){
        if (generation !== undefined && generation !== this._analysisGeneration) return
        this.runningTextProcessing -= 1

        // FAIL-SAFE: Only unblur if we're absolutely certain it's safe
        // If all text processing is complete and image should not be blurred, unblur it
        if (this.runningTextProcessing <= 0 && !this.isBlured && !blurIsAlwaysOn) {
            try {
                // Unblur immediately - the mutation observer batch delay already handles
                // waiting for dynamic content to stabilize
                this.unblur()
            } catch (unblurError) {
                // FAIL-SAFE: If unblur fails, keep element blurred (safe default)
                console.error('PhobiaBlocker: Failed to unblur element, keeping blurred for safety', unblurError)
            }
        }
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

    textProcessingFinished(generation) {
        super.textProcessingFinished(generation)
        // Analysis complete: if image should stay blurred, add .phobia-blur class now.
        // This is the earliest point at which hover preview becomes active.
        if (this.runningTextProcessing <= 0 && (this.isBlured || blurIsAlwaysOn)) {
            this.blur()
        }
    }
}

class BgImageNode extends ImageNode {
    constructor(imageNode){
        super(imageNode)
    }

    blur() {
        if (!this._isNodeValid()) return
        if (!this._imageNode.classList.contains('phobia-permanent-unblur')){
            this._imageNode.classList.remove('phobia-noblur')
            this._imageNode.classList.add('phobia-blur')
            // Use !important so the extension's blur wins over site inline-style animations
            this._imageNode.style.setProperty('filter', 'blur(var(--blurValueAmount, 40px))', 'important')
        }
    }

    unblur() {
        if (!this._isNodeValid()) return
        this._imageNode.classList.remove('phobia-blur')
        this._imageNode.classList.add('phobia-noblur')
        this._imageNode.style.removeProperty('filter')
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
}

/**
 * @extends {ImageNode}
 * Handles iframe elements (YouTube, Vimeo, embedded videos, etc.)
 */
class IframeNode extends ImageNode {
    constructor(imageNode){
        super(imageNode)
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
        if (generation !== undefined && generation !== this._analysisGeneration) return
        this.runningTextProcessing -= 1
        if (this._isCrossOrigin() && !this.hasBeenAnalyzed) return
        if (this.runningTextProcessing <= 0 && !this.isBlured && !blurIsAlwaysOn) {
            try {
                this.unblur()
            } catch (unblurError) {
                console.error('PhobiaBlocker: Failed to unblur iframe, keeping blurred for safety', unblurError)
            }
        }
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
        this._imageNodeList = this._imageNodeList.filter(node => {
            const el = node.getImageNode()
            if (el && el.isConnected) return true
            try { node._detachContainerListeners() } catch (_) {}
            return false
        })
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


class TextAnalizer {
    constructor(){
        this._text = []
    }

    addText(text){
        this._text.push(this._regexTextCleanUp(text))
    }

    /**
     * Search text for any target words, using NLP normalization to compare words
     * @param {list[ImageNode]} dependentImageNodes Images that will be blured/unblured with this text
     */
    async startAnalysis (dependentImageNodes){
        try {
            if(!dependentImageNodes || dependentImageNodes.length === 0) return

            debugLog('TextAnalysis', 'Starting text analysis', {
                imageCount: dependentImageNodes.length,
                targetWordsCount: targetWords.length
            })

            const generationByNode = new Map()
            dependentImageNodes.forEach((imageNode) => {
                generationByNode.set(imageNode, imageNode.newTextProcessingStarted())
            })

            const rWordInAnyLanguage = /^[-\p{L}]+$/u // no numbers in the word, common for class names
            let cleanWords = tokenizer.tokenize(this._text.join(' '))
                .map(word => word.toLowerCase())
                .filter(word => word.length > 2)
                .filter(word => rWordInAnyLanguage.test(word))
                // .filter(word => !stopWords.includes(word))
            let cleanWordsSet = [...new Set(cleanWords)]

            // NLP noramlization function is very expensive, therefore analyze only words
            // that have two first letters in common with target words
            let compareTargetsToTextWords = (targets, wordsToAnalize) => {
                let probableMatchingTargetWords = []
                targets.forEach((target) => {
                    // Skip if target doesn't have at least 2 characters
                    if (target.length < 2) return

                    wordsToAnalize.forEach((word) => {
                        if (word.length >= 2 && word[0] == target[0] && word[1] == target[1]) {
                            probableMatchingTargetWords.push(word)
                        }
                    })
                })
                return probableMatchingTargetWords
            }

            let wordsToCheckNormalized = nlp(compareTargetsToTextWords(targetWords, cleanWordsSet))
                .normalize(NORMALIZE_PARAMS)
                .out('array')

            const match = wordsToCheckNormalized
                .filter(element => targetWordsNormalized.includes(element))
                .filter(n => n)

            let analysisResult = match.length > 0

            debugLog('TextAnalysis', 'Analysis complete', {
                targetWords: targetWords.slice(0, 10),
                textWordsChecked: wordsToCheckNormalized.length,
                matches: match,
                shouldBlur: analysisResult,
                imageCount: dependentImageNodes.length
            })

            dependentImageNodes.forEach((imageNode) => {
                try {
                    imageNode.updateBlurStatus(analysisResult, match)
                    imageNode.textProcessingFinished(generationByNode.get(imageNode))
                } catch (nodeError) {
                    console.error('PhobiaBlocker: textProcessingFinished failed for node', nodeError)
                }
            })

        } catch (error) {
            console.error('Error in startAnalysis:', error)
            // If analysis fails, mark images as finished processing so they can unveil
            dependentImageNodes.forEach((imageNode) => {
                try {
                    imageNode.textProcessingFinished()
                } catch (nodeError) {
                    console.error('PhobiaBlocker: textProcessingFinished failed in fallback', nodeError)
                }
            })
        }
    }

    _regexTextCleanUp(text){
        // Since we now use textContent (not innerHTML), text is already plain text
        // Just normalize whitespace and return
        if (!text) return ''

        // Replace multiple spaces/newlines/tabs with single space
        return text.replace(/\s+/g, ' ').trim()
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
        this._runningAnalyses = 0
        this._permanentlyUnblurred = false // Set after unblurAll — new images skip NLP and are immediately unblurred
        this._blurToggleGeneration = 0
    }

    _getSemanticContainer(el) {
        const SEMANTIC_TAGS = new Set(['FIGURE', 'ARTICLE', 'SECTION', 'MAIN', 'ASIDE',
            'HEADER', 'FOOTER', 'NAV', 'LI', 'BLOCKQUOTE'])
        let node = el.parentElement
        while (node && node !== document.body && node !== document.documentElement) {
            if (SEMANTIC_TAGS.has(node.tagName)) return node
            node = node.parentElement
        }
        return null
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

    updateImageList(nodeToCheck){
        let newImages = []
        let existingImages = []

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
        const forceBlur = blurIsAlwaysOn || isBlacklisted()
        if (tag === 'IMG') {
            if (forceBlur || !this._isInsideInteractiveControl(nodeToCheck)) checkAndUpdate(TagImageNode, nodeToCheck)
            else { nodeToCheck.classList.add('phobia-noblur'); nodeToCheck.classList.remove('phobia-blur') }
        } else if (tag === 'VIDEO') {
            checkAndUpdate(VideoNode, nodeToCheck)
        } else if (tag === 'IFRAME') {
            if (!this._isEditorIframe(nodeToCheck)) checkAndUpdate(IframeNode, nodeToCheck)
            else { nodeToCheck.classList.add('phobia-noblur'); nodeToCheck.classList.remove('phobia-blur') }
        } else if (tag) {
            // Check if nodeToCheck itself is a background-image container
            try {
                const bg = window.getComputedStyle(nodeToCheck).backgroundImage
                if (bg && bg !== 'none' && bg.includes('url(')) checkAndUpdate(BgImageNode, nodeToCheck)
            } catch (_) { /* skip detached or hidden elements */ }
        }

        // Single pass for ALL visual content — replaces four separate loops.
        // img/video/iframe: found by tag name directly.
        // div/span/etc: checked via getComputedStyle for background-image.
        // getComputedStyle is the only way to detect CSS-class-applied background images.
        const elements = nodeToCheck.querySelectorAll('img, video, iframe, div, span, section, article, aside, header, footer, main, figure')
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i]
            const elTag = el.tagName
            if (elTag === 'IMG') {
                if (forceBlur || !this._isInsideInteractiveControl(el)) checkAndUpdate(TagImageNode, el)
                else { el.classList.add('phobia-noblur'); el.classList.remove('phobia-blur') }
            } else if (elTag === 'VIDEO') {
                checkAndUpdate(VideoNode, el)
            } else if (elTag === 'IFRAME') {
                if (!this._isEditorIframe(el)) checkAndUpdate(IframeNode, el)
                else { el.classList.add('phobia-noblur'); el.classList.remove('phobia-blur') }
            } else {
                try {
                    const bg = window.getComputedStyle(el).backgroundImage
                    if (bg && bg !== 'none' && bg.includes('url(')) checkAndUpdate(BgImageNode, el)
                } catch (_) { /* skip detached or hidden elements */ }
            }
        }

        return { newImages, existingImages }
    }

    onLoad(){
        try {
            let { newImages, existingImages } = this.updateImageList(document)
            const hasImages = newImages.length > 0
            if (hasImages) this._analysisStarted()

            // Group images by their nearest semantic container so each group is
            // analyzed against only the text that is visually relevant to it —
            // not the entire page body. Images without a semantic ancestor fall
            // into a single '__page__' group that uses the full visible body text.
            const groups = new Map()
            for (const imageNode of newImages) {
                const el = imageNode.getImageNode()
                const container = this._getSemanticContainer(el)
                const key = container || '__page__'
                if (!groups.has(key)) groups.set(key, { container, images: [] })
                groups.get(key).images.push(imageNode)
            }

            const analyses = []
            for (const { container, images } of groups.values()) {
                const ta = new TextAnalizer()
                if (container) {
                    // innerText skips hidden (display:none / visibility:hidden) text
                    ta.addText(container.innerText || container.textContent || '')
                } else {
                    ta.addText(document.body.innerText || document.body.textContent || '')
                    ta.addText(document.title)
                }
                analyses.push(ta.startAnalysis(images))
            }

            Promise.all(analyses).catch(err => {
                // FAIL-SAFE: If text analysis fails, images stay blurred (safe default)
                console.error('PhobiaBlocker: Text analysis failed, images remain blurred', err)
            }).finally(() => {
                // Remove early blur style after initial analysis completes
                this._removeEarlyBlurStyle()
                if (hasImages) this._analysisFinished()
            })
            this._observerInit()
        } catch (loadError) {
            // FAIL-SAFE: If onLoad completely fails, images stay blurred via CSS
            console.error('PhobiaBlocker: onLoad failed, images remain blurred via CSS', loadError)
        }
    }

    onLoadBlurAll(){
        try {
            this.updateImageList(document)
            this.blurAll()
            this._observerInit()
            reportIconStatus('detected')
        } catch (blurAllError) {
            // FAIL-SAFE: If blur-all mode fails, CSS blur is still active
            console.error('PhobiaBlocker: onLoadBlurAll failed, relying on CSS blur', blurAllError)
        }
    }

    _removeEarlyBlurStyle(){
        // Remove the early blur CSS once initial analysis is complete
        // Images now have proper blur/noblur classes from analysis
        let earlyBlurStyle = document.getElementById('phobiablocker-early-blur')
        if (earlyBlurStyle) {
            earlyBlurStyle.remove()
        }
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
        let depth = 0
        const maxDepth = 10

        while (current && depth < maxDepth) {
            // Fast path: check if this element is already known to be in an editor
            if (this._editorContainerCache.has(current)) {
                return true
            }

            // Check if current element is contenteditable
            if (current.isContentEditable) {
                this._editorContainerCache.add(current)
                return true
            }

            // Check tagName for form elements
            let tagName = current.tagName ? current.tagName.toLowerCase() : ''
            if (tagName === 'form' || tagName === 'textarea' || tagName === 'input') {
                this._editorContainerCache.add(current)
                return true
            }

            // Check class names for editor patterns (only if className is a string)
            if (typeof current.className === 'string') {
                let className = current.className.toLowerCase()
                if (className.includes('editor') || className.includes('wiki-edit') ||
                    className.includes('rte-container') || className.includes('richeditor') ||
                    className.includes('tox-') || className.includes('cke') ||
                    className.includes('mce') || className.includes('tinymce') ||
                    className.includes('wysiwyg') || className.includes('contenteditable')) {
                    this._editorContainerCache.add(current)
                    return true
                }
            }

            // Check ID for editor patterns
            if (typeof current.id === 'string') {
                let id = current.id.toLowerCase()
                if (id.includes('editor') || id.includes('mce') || id.includes('cke')) {
                    this._editorContainerCache.add(current)
                    return true
                }
            }

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

    _processMutationBatch(){
        if (this._mutationBatch.length === 0) return

        this._imageNodeList.prune()

        // If blurIsAlwaysOn or blacklisted, just find and blur new images without text analysis
        if (blurIsAlwaysOn || isBlacklisted()) {
            this._mutationBatch.forEach((mutation) => {
                if (mutation.type === 'attributes') {
                    if (mutation.target.nodeType !== Node.ELEMENT_NODE) return
                    const t = mutation.target
                    const tag = t.tagName
                    if ((tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') && mutation.attributeName === 'src') {
                        // src changed: immediately re-blur to prevent flash of already-cleared element
                        const existingNode = this._imageNodeList.getImageNode(t)
                        if (existingNode) existingNode.blur()
                        else this.updateImageList(t)
                    } else {
                        // class/style changed on existing bg-image container — re-check
                        this.updateImageList(t)
                    }
                    return
                }
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        let { newImages } = this.updateImageList(node)
                        newImages.forEach(img => img.blur())
                    }
                })
            })
            this._mutationBatch = []
            return
        }

        // Normal mode: do text analysis
        let textAnalizer = new TextAnalizer()
        let allNewImages = []
        let allExistingImages = []
        let unanalyzedExistingImages = []

        this._mutationBatch.forEach((mutation) => {
            if (mutation.type === 'attributes') {
                if (mutation.target.nodeType !== Node.ELEMENT_NODE) return
                const t = mutation.target
                const tag = t.tagName
                if ((tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') && mutation.attributeName === 'src') {
                    // src changed: new content on an existing element. Re-blur immediately to
                    // prevent a flash from a previously-cleared element, then re-analyze.
                    const existingNode = this._imageNodeList.getImageNode(t)
                    if (existingNode) {
                        existingNode.isBlured = false
                        existingNode.hasBeenAnalyzed = false
                        existingNode._analysisGeneration++
                        existingNode.runningTextProcessing = 0
                        existingNode.blur()
                        allNewImages.push(existingNode)
                    } else {
                        let { newImages } = this.updateImageList(t)
                        allNewImages = allNewImages.concat(newImages)
                    }
                    // Use full visible body text (innerText skips hidden elements).
                    if (document.body) textAnalizer.addText(document.body.innerText || document.body.textContent || '')
                } else {
                    // class/style changed on existing element — check if it now has a background image.
                    // Use the parent's text as context since bg-image containers rarely have text children.
                    let { newImages, existingImages } = this.updateImageList(t)
                    allNewImages = allNewImages.concat(newImages)
                    allExistingImages = allExistingImages.concat(existingImages)
                    const textContext = t.parentElement
                        ? (t.parentElement.innerText || t.parentElement.textContent || '')
                        : (t.innerText || t.textContent || '')
                    if (textContext) textAnalizer.addText(textContext)
                }
                return
            }

            mutation.addedNodes.forEach((node) => {
                if (node.nodeType !== Node.ELEMENT_NODE) return
                let { newImages, existingImages } = this.updateImageList(node)
                allNewImages = allNewImages.concat(newImages)
                allExistingImages = allExistingImages.concat(existingImages)
            })

            // Skip text extraction for:
            // 1. Form fields and editors (to prevent typing lag)
            // 2. Data tables without images (no visual content to blur)
            // BUT we still checked for images above, so images in tables will be found
            if (!this._shouldIgnoreMutation(mutation.target) &&
                !this._isComplexEditor(mutation.target) &&
                !this._isDataTableWithoutImages(mutation.target)) {
                // Use native textContent (much faster than jQuery .text())
                textAnalizer.addText(mutation.target.innerText || mutation.target.textContent || '')
            }
        })

        // Check which existing images haven't been analyzed yet
        unanalyzedExistingImages = allExistingImages.filter(img => !img.hasBeenAnalyzed)

        // Analyze NEW images AND existing images that haven't been analyzed yet.
        let imagesToAnalyze = allNewImages.concat(unanalyzedExistingImages)
        if (imagesToAnalyze.length > 0) this._analysisStarted()
        textAnalizer.startAnalysis(imagesToAnalyze).catch(err => {
            console.error('Error in mutation batch text analysis:', err)
        }).finally(() => {
            if (imagesToAnalyze.length > 0) this._analysisFinished()
        })
        this._mutationBatch = []
    }

    _observerInit(){
        // Disconnect existing observer if it exists to prevent multiple observers
        if (this.observer) {
            this.observer.disconnect()
        }

        this.observer = new MutationObserver((mutations) => {
            // Defensive: wrap entire observer in try-catch to prevent breaking pages
            try {
                // Aggressively filter mutations before processing
                mutations.forEach((mutation) => {
                    try {
                        // Drop character data mutations immediately (text changes in inputs)
                        if (mutation.type === 'characterData') {
                            return
                        }

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
                        // Check for common editor container patterns
                        if (this._isInsideEditorContainer(target)) {
                            return
                        }

                        // Only process childList and relevant attributes mutations.
                        // class/style: skip on IMG/VIDEO/IFRAME — the extension itself toggles
                        // those constantly and would create infinite observer loops.
                        // src: always allow on IMG/VIDEO/IFRAME — a src change means new content
                        // that needs re-analysis (element may already have phobia-noblur from a
                        // previous analysis of the placeholder/empty state).
                        if (mutation.type === 'attributes') {
                            const t = mutation.target
                            const tag = t.tagName
                            if ((tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') && mutation.attributeName !== 'src') return
                            if (mutation.attributeName === 'style' && t.classList &&
                                (t.classList.contains('phobia-blur') || t.classList.contains('phobia-noblur'))) return
                        } else if (mutation.type !== 'childList') {
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

            // Process immediately on blacklisted sites (no NLP needed, prevents background-image flash)
            if (isBlacklisted()) {
                clearTimeout(this._batchTimer)
                this._processMutationBatch()
                return
            }

            // Process immediately if batch is large (for infinite scroll)
            if (this._mutationBatch.length >= this._maxBatchSize) {
                clearTimeout(this._batchTimer)
                this._processMutationBatch()
                return
            }

            // Otherwise, debounce with timer
            clearTimeout(this._batchTimer)
            this._batchTimer = setTimeout(() => {
                this._processMutationBatch()
            }, this._batchProcessInterval)
        })
        this.observer.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'src']  // src: re-analyze when lazy-load sets new content on existing elements
        })
    }

    stop(){
        if (this.observer) {
            this.observer.disconnect()
        }
        clearTimeout(this._batchTimer)
        this._mutationBatch = []
        this._runningAnalyses = 0
        this.unBlurAll()
        reportIconStatus('idle')
    }

    resetImageNodeList(){
        this._imageNodeList = new ImageNodeList()
        this.updateImageList(document)
    }

    blurAll(){
        this._imageNodeList.blurAllImages()
    }

    unBlurAll(){
        this._imageNodeList.unBlurAllImages()
    }
}

/**
 * Expands target words to include variations (plurals, verb forms) to work with first-two-letter optimization
 * For example: "mouse" -> ["mouse", "mice"], "run" -> ["run", "running", "ran"]
 */
let expandTargetWords = (words) => {
    let expandedWords = []
    words.forEach((word) => {
        // Add original word
        expandedWords.push(word.toLowerCase())

        // Use NLP to generate variations
        let nlpWord = nlp(word)

        // Add plural form (for nouns)
        let plural = nlpWord.nouns().toPlural().text()
        if (plural && plural !== word) {
            expandedWords.push(plural.toLowerCase())
        }

        // Add singular form (in case user entered plural)
        let singular = nlpWord.nouns().toSingular().text()
        if (singular && singular !== word) {
            expandedWords.push(singular.toLowerCase())
        }

        // Add verb forms (past, present participle, etc.)
        let pastTense = nlpWord.verbs().toPastTense().text()
        if (pastTense && pastTense !== word) {
            expandedWords.push(pastTense.toLowerCase())
        }

        let presentTense = nlpWord.verbs().toPresentTense().text()
        if (presentTense && presentTense !== word) {
            expandedWords.push(presentTense.toLowerCase())
        }

        let gerund = nlpWord.verbs().toGerund().text()
        if (gerund && gerund !== word) {
            expandedWords.push(gerund.toLowerCase())
        }
    })

    // Remove duplicates and empty strings
    return [...new Set(expandedWords)].filter(w => w && w.length > 0)
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
                'targetWords',
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

                    // IMPORTANT: Never initialize storage in content script - only read from it
                    // Storage should only be initialized by popup.js on first install
                    // This prevents overwriting user data during updates or sync delays
                    if (storage.targetWords && Array.isArray(storage.targetWords)) {
                        try {
                            // Expand target words to include variations (plurals, verb forms, etc.)
                            targetWords = expandTargetWords(storage.targetWords)
                        } catch (expandError) {
                            // FAIL-SAFE: If expansion fails, use original words
                            console.error('PhobiaBlocker: Word expansion failed, using original words', expandError)
                            targetWords = storage.targetWords.map(w => w.toLowerCase())
                        }
                        targetWordsNormalized = [...new Set(nlp(targetWords).normalize(NORMALIZE_PARAMS).out('array'))]
                    } else {
                        // No targetWords in storage - use empty array in memory
                        // Don't persist this to storage (popup.js handles initialization)
                        targetWords = []
                        targetWordsNormalized = []
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
                        document.documentElement.style.setProperty('--blurValueAmount', blurPixels + 'px')
                    } else {
                        let defaultBlurPixels = Math.pow(DEFAULT_BLUR_SLIDER_VALUE * 0.09, 1.8) * 2
                        document.documentElement.style.setProperty('--blurValueAmount', defaultBlurPixels + 'px')
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
                        targetWordsCount: targetWords.length,
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
        document.documentElement.style.setProperty('--blurValueAmount', '0px')
        let earlyBlurStyle = document.getElementById('phobiablocker-early-blur')
        if (earlyBlurStyle) {
            earlyBlurStyle.remove()
        }
        return
    }

    // Extension disabled - remove blur
    if(!phobiaBlockerEnabled) {
        document.documentElement.style.setProperty('--blurValueAmount', '0px')
        let earlyBlurStyle = document.getElementById('phobiablocker-early-blur')
        if (earlyBlurStyle) {
            earlyBlurStyle.remove()
        }
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
            document.documentElement.style.setProperty('--blurValueAmount', 0 + 'px')
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
            document.documentElement.style.setProperty('--blurValueAmount', 0 + 'px')
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
        document.documentElement.style.setProperty('--previewBlurAmount', previewBlurStrength + 'px')
    } else {
        // When disabled, set preview amount equal to full blur so hover has no visible effect
        document.documentElement.style.setProperty('--previewBlurAmount', 'var(--blurValueAmount, 40px)')
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
    switch (message.type) {
    case 'getTriggeredWords': {
        // If extension is disabled on this site, nothing is visually blurred — report nothing
        if (document.documentElement.classList.contains('phobia-disabled')) {
            sendResponse({ words: [] })
            return true
        }
        // If blur amount is 0px, nothing is visually blurred — report nothing
        const blurAmountStr = document.documentElement.style.getPropertyValue('--blurValueAmount')
        const blurAmount = parseFloat(blurAmountStr)
        if (!isNaN(blurAmount) && blurAmount <= 0) {
            sendResponse({ words: [] })
            return true
        }
        const wordCounts = new Map()
        controller._imageNodeList.getAllImages().forEach(node => {
            if (!node._triggerWords) return
            const el = node.getImageNode()
            if (!el) return
            // Check actual current DOM state: img/video/iframe use data-phobia-blur attribute,
            // BgImageNode elements use .phobia-blur class (no data attribute on them).
            const isCurrentlyBlurred = el.hasAttribute('data-phobia-blur') ||
                el.classList.contains('phobia-blur')
            if (isCurrentlyBlurred) {
                node._triggerWords.forEach(word => {
                    wordCounts.set(word, (wordCounts.get(word) || 0) + 1)
                })
            }
        })
        const words = [...wordCounts.entries()]
            .map(([word, count]) => ({ word, count }))
            .sort((a, b) => b.count - a.count)
        sendResponse({ words })
        return true
    }
    case 'blurAll':
        controller._permanentlyUnblurred = false
        // Remove permamentUnblur from all elements so blur() can re-apply
        document.querySelectorAll('.phobia-permanent-unblur').forEach(el => {
            el.classList.remove('phobia-permanent-unblur', 'phobia-noblur')
        })
        // Check if user has set blur amount before, if not use maximum
        chrome.storage.sync.get('blurValueAmount', (storage) => {
            if (storage.blurValueAmount != undefined) {
                let blurPixels = Math.pow(storage.blurValueAmount * 0.09, 1.8) * 2
                document.documentElement.style.setProperty('--blurValueAmount', blurPixels + 'px')
            } else {
                // First time - use most aggressive settings
                let maxBlurPixels = Math.pow(DEFAULT_BLUR_SLIDER_VALUE * 0.09, 1.8) * 2
                document.documentElement.style.setProperty('--blurValueAmount', maxBlurPixels + 'px')
            }
            // Populate image list if empty (e.g., if page loaded with extension disabled)
            if (controller._imageNodeList.getAllImages().length === 0) {
                controller.updateImageList(document)
            }
            // Blur after blur amount is set
            controller.blurAll()
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
        })
        break
    case 'unblurAll': {
        // Populate image list if empty (e.g., if page loaded with extension disabled)
        if (controller._imageNodeList.getAllImages().length === 0) {
            controller.updateImageList(document)
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
        reportIconStatus('idle')
        break
    }
    case 'setBlurAmount':
        // Check if site is whitelisted - if so, keep blur at 0
        if (isWhitelisted()) {
            debugLog('SiteRules', 'Site is whitelisted - ignoring blur amount change', { url: window.location.href })
            document.documentElement.style.setProperty('--blurValueAmount', '0px')
            return
        }
        let blurValueAmount = message.value
        if (blurValueAmount != undefined) {
            // Value provided in message (real-time update while dragging)
            let blurPixels = Math.pow(blurValueAmount * 0.09, 1.8) * 2
            document.documentElement.style.setProperty(
                '--blurValueAmount',
                blurPixels + 'px'
            )
        } else {
            // Get from storage (for other scenarios)
            chrome.storage.sync.get('blurValueAmount', (storage) => {
                let storedValue = storage['blurValueAmount']
                if (storedValue != undefined) {
                    let blurPixels = Math.pow(storedValue * 0.09, 1.8) * 2
                    document.documentElement.style.setProperty(
                        '--blurValueAmount',
                        blurPixels + 'px'
                    )
                } else {
                    let defaultBlurPixels = Math.pow(DEFAULT_BLUR_SLIDER_VALUE * 0.09, 1.8) * 2
                    document.documentElement.style.setProperty('--blurValueAmount', defaultBlurPixels + 'px')
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
                    document.documentElement.style.setProperty('--blurValueAmount', blurPixels + 'px')
                } else {
                    // First time - use most aggressive settings
                    let maxBlurPixels = Math.pow(DEFAULT_BLUR_SLIDER_VALUE * 0.09, 1.8) * 2
                    document.documentElement.style.setProperty('--blurValueAmount', maxBlurPixels + 'px')
                }
                // Execute after blur amount is set
                if (controller.observer) {
                    controller.observer.disconnect()
                }
                clearTimeout(controller._batchTimer)
                controller._mutationBatch = []
                // Clear classes but preserve permamentUnblur
                const elementsToReset = document.querySelectorAll('.phobia-blur:not(.phobia-permanent-unblur), .phobia-noblur:not(.phobia-permanent-unblur)')
                elementsToReset.forEach(el => {
                    el.classList.remove('phobia-blur', 'phobia-noblur')
                })
                controller._imageNodeList.teardown()
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
            controller._mutationBatch = []
            // Clear classes but preserve permamentUnblur
            const elementsToReset = document.querySelectorAll('.phobia-blur:not(.phobia-permanent-unblur), .phobia-noblur:not(.phobia-permanent-unblur)')
            elementsToReset.forEach(el => {
                el.classList.remove('phobia-blur', 'phobia-noblur')
            })
            controller._imageNodeList.teardown()
            controller._imageNodeList = new ImageNodeList()
            controller.onLoad()
        }
        break
    case 'targetWordsChanged':
        controller._permanentlyUnblurred = false
        // Target words changed - reload and re-analyze
        // Check site rules first
        if (isWhitelisted()) {
            debugLog('SiteRules', 'Site is whitelisted - ignoring target words change', { url: window.location.href })
            return
        }
        chrome.storage.sync.get('targetWords', (storage) => {
            if (storage.targetWords) {
                targetWords = expandTargetWords(storage.targetWords)
                targetWordsNormalized = [...new Set(nlp(targetWords).normalize(NORMALIZE_PARAMS).out('array'))]
            } else {
                targetWords = []
                targetWordsNormalized = []
            }
            // If blacklisted, keep everything blurred regardless of words
            if (isBlacklisted()) {
                debugLog('SiteRules', 'Site is blacklisted - keeping all content blurred', { url: window.location.href })
                return
            }
            // Clear all noblur classes except permamentUnblur
            const noblurElements = document.querySelectorAll('.phobia-noblur:not(.phobia-permanent-unblur)')
            noblurElements.forEach(el => {
                el.classList.remove('phobia-noblur')
                el.classList.add('phobia-blur')
            })
            // Re-analyze if extension is enabled
            if (phobiaBlockerEnabled && !blurIsAlwaysOn) {
                let textAnalizer = new TextAnalizer()
                // Use native textContent (much faster than jQuery)
                textAnalizer.addText(document.body.textContent)
                textAnalizer.addText(document.title)
                let allImages = controller._imageNodeList.getAllImages()
                controller._analysisStarted()
                textAnalizer.startAnalysis(allImages).catch(err => {
                    console.error('Error in targetWordsChanged analysis:', err)
                }).finally(() => {
                    controller._analysisFinished()
                })
            }
        })
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
