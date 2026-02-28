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
                /* CRITICAL: Blur ALL visual content immediately to prevent flash */
                /* Covers both unprocessed images AND images with .blur class */
                /* This ensures no gap in coverage while manifest CSS loads */
                img:not(.noblur):not(.permamentUnblur),
                img.blur:not(.permamentUnblur),
                video:not(.noblur):not(.permamentUnblur),
                video.blur:not(.permamentUnblur),
                iframe:not(.noblur):not(.permamentUnblur),
                iframe.blur:not(.permamentUnblur) {
                    filter: blur(var(--blurValueAmount, 40px)) !important;
                    -webkit-filter: blur(var(--blurValueAmount, 40px)) !important;
                    pointer-events: none !important;
                    cursor: default !important;
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
let targetWords = []
let lastElementContext
let phobiaBlockerEnabled = true
let blurIsAlwaysOn = false

class ImageNode {
    constructor(imageNode) {
        if (this.constructor == ImageNode) {
            throw new Error('Abstract classes ImageNode.');
        }
        this._imageNode = imageNode
        this.runningTextProcessing = 0
        this.isBlured = false
        this.hasBeenAnalyzed = false // Track if this image has been analyzed at least once
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

    blur() {
        throw new Error('Method must be implemented.')
    }

    unblur() {
        throw new Error('Method must be implemented.')
    }

    newTextProcessingStarted(){
        this.runningTextProcessing += 1
    }

    textProcessingFinished(){
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

    updateBlurStatus(analysisResult){
        if(!this.isBlured) this.isBlured = analysisResult
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

    blur() {
        if (!this._isNodeValid()) return
        if (!this._imageNode.classList.contains('permamentUnblur')){
            this._imageNode.classList.remove('noblur')
            this._imageNode.classList.add('blur')
        }
    }

    unblur() {
        if (!this._isNodeValid()) return
        this._imageNode.classList.add('noblur')
        this._imageNode.classList.remove('blur')
    }
}

class BgImageNode extends ImageNode {
    constructor(imageNode){
        super(imageNode)
    }

    blur() {
        if (!this._isNodeValid()) return
        if (!this._imageNode.classList.contains('permamentUnblur')){
            this._imageNode.classList.remove('noblur')
            this._imageNode.classList.add('blur')
            this._imageNode.style.filter = 'blur(10px)'
        }
    }

    unblur() {
        if (!this._isNodeValid()) return
        this._imageNode.classList.add('noblur')
        this._imageNode.classList.remove('blur')
        this._imageNode.style.filter = 'blur(0px)'
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

    blur() {
        if (!this._isNodeValid()) return
        // Use native classList API
        if (!this._imageNode.classList.contains('permamentUnblur')){
            this._imageNode.classList.remove('noblur')
            this._imageNode.classList.add('blur')
        }
    }

    unblur() {
        if (!this._isNodeValid()) return
        this._imageNode.classList.add('noblur')
        this._imageNode.classList.remove('blur')
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

    blur() {
        if (!this._isNodeValid()) return
        if (!this._imageNode.classList.contains('permamentUnblur')){
            this._imageNode.classList.remove('noblur')
            this._imageNode.classList.add('blur')
        }
    }

    unblur() {
        if (!this._isNodeValid()) return
        this._imageNode.classList.add('noblur')
        this._imageNode.classList.remove('blur')
    }
}


class ImageNodeList {
    constructor() {
        this._imageNodeList = []
    }

    /**
     * Accepts DOM node and checks if it already exists in controlled imageNodeList.
     * @param {Node} nodeToGet Node that is being searched
     * @returns {Node|undefined} Node that already exists in the list or nothing
    */
    getImageNode(nodeToGet){
        for(let idx in this._imageNodeList){
            if (this._imageNodeList[idx].same(nodeToGet))
                return this._imageNodeList[idx]
        }
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
    }

    getAllImages(){
        return this._imageNodeList
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
            dependentImageNodes.forEach((imageNode) => {
                imageNode.newTextProcessingStarted()
            })

            let r_wordInAnyLanguage = /^(\b(\p{L}|-)*\b)|$/gmiu // no numbers in the word, common for class names
            let cleanWords = tokenizer.tokenize(this._text.join(' '))
                .map(word => word.toLowerCase())
                .filter(word => word.length > 2)
                .filter(word => r_wordInAnyLanguage.test(word))
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

            const normalizeParams = {
                whitespace: true,
                unicode: true,
                contractions: true,
                acronyms:true,
                possessives: true,
                plurals: true,
                verbs: true,
            }

            let targetWordsNormalized =[...new Set(nlp(targetWords)
                .normalize(normalizeParams)
                .out('array'))]

            let wordsToCheckNormalized = nlp(compareTargetsToTextWords(targetWordsNormalized, cleanWordsSet))
                .normalize(normalizeParams)
                .out('array')

            const match = wordsToCheckNormalized
                .filter(element => targetWordsNormalized.includes(element))
                .filter(n => n)

            let analysisResult = match.length > 0

            dependentImageNodes.forEach((imageNode) => {
                imageNode.updateBlurStatus(analysisResult)
                imageNode.textProcessingFinished()
            })
        } catch (error) {
            console.error('Error in startAnalysis:', error)
            // If analysis fails, mark images as finished processing so they can unveil
            dependentImageNodes.forEach((imageNode) => {
                imageNode.textProcessingFinished()
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
                newImages.push(imageToAnalize)
            } else {
                existingImages.push(imageToAnalize)
            }
        }

        // Use native browser APIs for maximum performance
        // HTMLCollections are live and much faster than jQuery

        // Find all <img> tags
        let tagImageNodes = nodeToCheck.getElementsByTagName('img')
        for (let i = 0; i < tagImageNodes.length; i++) {
            checkAndUpdate(TagImageNode, tagImageNodes[i])
        }

        // Find all <video> tags
        let videoNodes = nodeToCheck.getElementsByTagName('video')
        for (let i = 0; i < videoNodes.length; i++) {
            checkAndUpdate(VideoNode, videoNodes[i])
        }

        // Find all <iframe> tags (detect and immediately unblur editor/form iframes)
        let iframeNodes = nodeToCheck.getElementsByTagName('iframe')
        for (let i = 0; i < iframeNodes.length; i++) {
            let iframe = iframeNodes[i]
            // If iframe is part of a text editor or form input, immediately unblur it
            if (this._isEditorIframe(iframe)) {
                // Unblur editor iframes immediately to prevent blocking text input
                iframe.classList.add('noblur')
                iframe.classList.remove('blur')
                continue
            }
            checkAndUpdate(IframeNode, iframe)
        }

        // Find elements with background images
        // This is slower but necessary - use querySelectorAll with a more specific selector
        // Only check divs, spans, sections, articles, and common containers
        let r_bgUrl = /url/gi
        let potentialBgElements = nodeToCheck.querySelectorAll('div, span, section, article, aside, header, footer, main, figure')
        for (let i = 0; i < potentialBgElements.length; i++) {
            let element = potentialBgElements[i]
            try {
                // Use getComputedStyle for accurate background detection
                // Defensive: getComputedStyle can return null for detached elements
                let computedStyle = window.getComputedStyle(element)
                if (!computedStyle) continue

                let bgImage = computedStyle.backgroundImage
                if (bgImage && bgImage !== 'none' && r_bgUrl.test(bgImage)) {
                    checkAndUpdate(BgImageNode, element)
                }
            } catch (styleError) {
                // Skip elements that cause style computation errors
                // This can happen with detached nodes or elements in unusual states
                continue
            }
        }

        return { newImages, existingImages }
    }

    onLoad(){
        try {
            let textAnalizer = new TextAnalizer()
            let { newImages, existingImages } = this.updateImageList(document)
            // Use native textContent for much faster text extraction (10-50x faster than jQuery)
            textAnalizer.addText(document.body.textContent)
            textAnalizer.addText(document.title)
            textAnalizer.startAnalysis(newImages).catch(err => {
                // FAIL-SAFE: If text analysis fails, images stay blurred (safe default)
                console.error('PhobiaBlocker: Text analysis failed, images remain blurred', err)
            }).finally(() => {
                // Remove early blur style after initial analysis completes
                this._removeEarlyBlurStyle()
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
            // Early blur style can stay since we're blurring everything anyway
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
            this._tableImageCache = new Map()
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

        // Clean up old cache entries (keep cache under 100 entries)
        if (this._tableImageCache.size > 100) {
            let entriesToDelete = []
            for (let [key, value] of this._tableImageCache.entries()) {
                if (now - value.timestamp > 5000) {
                    entriesToDelete.push(key)
                }
            }
            entriesToDelete.forEach(key => this._tableImageCache.delete(key))
        }

        // Return true if table has NO visual content (should skip text analysis)
        return !hasImages
    }

    _processMutationBatch(){
        if (this._mutationBatch.length === 0) return

        // If blurIsAlwaysOn mode, just find and blur new images without text analysis
        if (blurIsAlwaysOn) {
            this._mutationBatch.forEach((mutation) => {
                this.updateImageList(mutation.target)
                // New images are already blurred by their _init() method when blurIsAlwaysOn is true
                // No need to do anything else
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
            let { newImages, existingImages } = this.updateImageList(mutation.target)
            allNewImages = allNewImages.concat(newImages)
            allExistingImages = allExistingImages.concat(existingImages)

            // Skip text extraction for:
            // 1. Form fields and editors (to prevent typing lag)
            // 2. Data tables without images (no visual content to blur)
            // BUT we still checked for images above, so images in tables will be found
            if (!this._shouldIgnoreMutation(mutation.target) &&
                !this._isComplexEditor(mutation.target) &&
                !this._isDataTableWithoutImages(mutation.target)) {
                // Use native textContent (much faster than jQuery .text())
                textAnalizer.addText(mutation.target.textContent || '')
            }
        })

        // Check which existing images haven't been analyzed yet
        unanalyzedExistingImages = allExistingImages.filter(img => !img.hasBeenAnalyzed)

        // Analyze NEW images AND existing images that haven't been analyzed yet
        let imagesToAnalyze = allNewImages.concat(unanalyzedExistingImages)
        textAnalizer.startAnalysis(imagesToAnalyze).catch(err => {
            console.error('Error in mutation batch text analysis:', err)
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

                        // Only process childList mutations (new elements added/removed)
                        // Ignore attribute and characterData
                        if (mutation.type !== 'childList') {
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
        this.observer.observe(document, { childList: true, subtree: true })
    }

    stop(){
        this.observer.disconnect()
        clearTimeout(this._batchTimer)
        this._mutationBatch = []
        this.unBlurAll()
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
                'blurValueAmount'
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
                    } else {
                        // No targetWords in storage - use empty array in memory
                        // Don't persist this to storage (popup.js handles initialization)
                        targetWords = []
                    }

                    if(storage.phobiaBlockerEnabled != undefined){
                        phobiaBlockerEnabled = storage.phobiaBlockerEnabled
                    }
                    if(storage.blurIsAlwaysOn != undefined)
                        blurIsAlwaysOn = storage.blurIsAlwaysOn

                    // Apply blur amount setting
                    if (storage.blurValueAmount != undefined) {
                        let blurPixels = Math.pow(storage.blurValueAmount * 0.09, 1.8) * 2
                        document.documentElement.style.setProperty('--blurValueAmount', blurPixels + 'px')
                    } else if (blurIsAlwaysOn) {
                        // First time using blur always on - use most aggressive settings
                        let maxBlurPixels = Math.pow(100 * 0.09, 1.8) * 2
                        document.documentElement.style.setProperty('--blurValueAmount', maxBlurPixels + 'px')
                    }

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

// Check settings early to disable blur immediately if extension is off
setSettings().then(() => {
    if(!phobiaBlockerEnabled) {
        document.documentElement.style.setProperty('--blurValueAmount', 0 + 'px')
        // Remove early blur style if extension is disabled
        let earlyBlurStyle = document.getElementById('phobiablocker-early-blur')
        if (earlyBlurStyle) {
            earlyBlurStyle.remove()
        }
    }
})

let main = async () => {
    try {
        await setSettings()

        if(blurIsAlwaysOn){
            controller.onLoadBlurAll()
        }
        else if(phobiaBlockerEnabled){
            controller.onLoad()
        }
        else if(!phobiaBlockerEnabled) {
            document.documentElement.style.setProperty('--blurValueAmount', 0 + 'px')
            // Remove early blur style if extension is disabled
            controller._removeEarlyBlurStyle()
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
    case 'blurAll':
        // Check if user has set blur amount before, if not use maximum
        chrome.storage.sync.get('blurValueAmount', (storage) => {
            if (storage.blurValueAmount != undefined) {
                let blurPixels = Math.pow(storage.blurValueAmount * 0.09, 1.8) * 2
                document.documentElement.style.setProperty('--blurValueAmount', blurPixels + 'px')
            } else {
                // First time - use most aggressive settings
                let maxBlurPixels = Math.pow(100 * 0.09, 1.8) * 2
                document.documentElement.style.setProperty('--blurValueAmount', maxBlurPixels + 'px')
            }
            // Populate image list if empty (e.g., if page loaded with extension disabled)
            if (controller._imageNodeList.getAllImages().length === 0) {
                controller.updateImageList(document)
            }
            // Blur after blur amount is set
            controller.blurAll()
        })
        break
    case 'unblurAll':
        // Populate image list if empty (e.g., if page loaded with extension disabled)
        if (controller._imageNodeList.getAllImages().length === 0) {
            controller.updateImageList(document)
        }
        controller.unBlurAll()
        break
    case 'setBlurAmount':
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
                    document.documentElement.style.setProperty('--blurValueAmount', 40 + 'px')
                }
            })
        }
        break
    case 'unblur':
        if (lastElementContext) {
            let blured = null

            // Check if the clicked element itself is blurred
            if (lastElementContext.classList && lastElementContext.classList.contains('blur')) {
                blured = lastElementContext
            }
            // Check children with blur class
            else {
                blured = lastElementContext.querySelector('.blur')
            }
            // Check siblings if nothing found
            if (!blured && lastElementContext.parentElement) {
                const siblings = Array.from(lastElementContext.parentElement.children)
                blured = siblings.find(sibling =>
                    sibling !== lastElementContext &&
                    sibling.classList &&
                    sibling.classList.contains('blur')
                )
            }
            // Check parent if still nothing found
            if (!blured && lastElementContext.parentElement) {
                const parent = lastElementContext.parentElement
                if (parent.classList && parent.classList.contains('blur')) {
                    blured = parent
                }
            }
            // Check if parent has blurred children
            if (!blured && lastElementContext.parentElement) {
                blured = lastElementContext.parentElement.querySelector('.blur')
            }

            if (blured) {
                blured.classList.remove('blur')
                blured.classList.add('noblur', 'permamentUnblur')
            }
        }
        break
    case 'phobiaBlockerEnabled':
        phobiaBlockerEnabled = message.value
        if(!phobiaBlockerEnabled){
            controller.stop()
            // Remove early blur style when disabling extension
            controller._removeEarlyBlurStyle()
        }
        else {
            if(blurIsAlwaysOn){
                controller.onLoadBlurAll()
            } else {
                controller.onLoad()
            }
        }
        break
    case 'blurIsAlwaysOn':
        blurIsAlwaysOn = message.value
        if(blurIsAlwaysOn){
            // Check if user has set blur amount before, if not use maximum
            chrome.storage.sync.get('blurValueAmount', (storage) => {
                if (storage.blurValueAmount != undefined) {
                    let blurPixels = Math.pow(storage.blurValueAmount * 0.09, 1.8) * 2
                    document.documentElement.style.setProperty('--blurValueAmount', blurPixels + 'px')
                } else {
                    // First time - use most aggressive settings
                    let maxBlurPixels = Math.pow(100 * 0.09, 1.8) * 2
                    document.documentElement.style.setProperty('--blurValueAmount', maxBlurPixels + 'px')
                }
                // Execute after blur amount is set
                if (controller.observer) {
                    controller.observer.disconnect()
                }
                clearTimeout(controller._batchTimer)
                controller._mutationBatch = []
                // Clear classes but preserve permamentUnblur
                const elementsToReset = document.querySelectorAll('.blur:not(.permamentUnblur), .noblur:not(.permamentUnblur)')
                elementsToReset.forEach(el => {
                    el.classList.remove('blur', 'noblur')
                })
                controller._imageNodeList = new ImageNodeList()
                controller.updateImageList(document)
                controller.blurAll()
                controller._observerInit()
            })
        }
        else {
            if (controller.observer) {
                controller.observer.disconnect()
            }
            clearTimeout(controller._batchTimer)
            controller._mutationBatch = []
            // Clear classes but preserve permamentUnblur
            const elementsToReset = document.querySelectorAll('.blur:not(.permamentUnblur), .noblur:not(.permamentUnblur)')
            elementsToReset.forEach(el => {
                el.classList.remove('blur', 'noblur')
            })
            controller._imageNodeList = new ImageNodeList()
            controller.onLoad()
        }
        break
    case 'targetWordsChanged':
        // Target words changed - reload and re-analyze
        chrome.storage.sync.get('targetWords', (storage) => {
            if (storage.targetWords) {
                targetWords = expandTargetWords(storage.targetWords)
            } else {
                targetWords = []
            }
            // Clear all noblur classes except permamentUnblur
            const noblurElements = document.querySelectorAll('.noblur:not(.permamentUnblur)')
            noblurElements.forEach(el => {
                el.classList.remove('noblur')
                el.classList.add('blur')
            })
            // Re-analyze if extension is enabled
            if (phobiaBlockerEnabled && !blurIsAlwaysOn) {
                let textAnalizer = new TextAnalizer()
                // Use native textContent (much faster than jQuery)
                textAnalizer.addText(document.body.textContent)
                textAnalizer.addText(document.title)
                let allImages = controller._imageNodeList._imageNodeList
                textAnalizer.startAnalysis(allImages).catch(err => {
                    console.error('Error in targetWordsChanged analysis:', err)
                })
            }
        })
        break
    }
})
