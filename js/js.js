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
        // Always blur initially - will unblur later if text analysis determines it's safe
        this.blur()
    }

    getImageNode(){
        return this._imageNode
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

        // If all text processing is complete and image should not be blurred, unblur it
        if (this.runningTextProcessing <= 0 && !this.isBlured && !blurIsAlwaysOn) {
            // Unblur immediately - the mutation observer batch delay already handles
            // waiting for dynamic content to stabilize
            this.unblur()
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
        if (!$(this._imageNode).hasClass('permamentUnblur')){
            $(this._imageNode).removeClass('noblur')
            $(this._imageNode).addClass('blur')
        }
    }

    unblur() {
        $(this._imageNode).addClass('noblur')
        $(this._imageNode).removeClass('blur')
    }
}

class BgImageNode extends ImageNode {
    constructor(imageNode){
        super(imageNode)
    }

    blur() {
        if (!$(this._imageNode).hasClass('permamentUnblur')){
            $(this._imageNode).removeClass('noblur')
            $(this._imageNode).addClass('blur')
            $(this._imageNode).css('filter', 'blur(10px)')
        }
    }

    unblur() {
        $(this._imageNode).addClass('noblur')
        $(this._imageNode).removeClass('blur')
        $(this._imageNode).css('filter', 'blur(0px)')
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
        if (!$(this._imageNode).hasClass('permamentUnblur')){
            $(this._imageNode).removeClass('noblur')
            $(this._imageNode).addClass('blur')
        }
    }

    unblur() {
        $(this._imageNode).addClass('noblur')
        $(this._imageNode).removeClass('blur')
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
        if (!$(this._imageNode).hasClass('permamentUnblur')){
            $(this._imageNode).removeClass('noblur')
            $(this._imageNode).addClass('blur')
        }
    }

    unblur() {
        $(this._imageNode).addClass('noblur')
        $(this._imageNode).removeClass('blur')
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
        let r_embededScripts = /<script.*?>([\s\S]*?)<\/script>/gis
        let r_embededStyle = /<style.*?>([\s\S]*?)<\/style>/gis
        let r_embededTags = /(<([^>]+)>)/ig
        let r_greadySearchForPossibleJSFunction = /\(.*?\)[\s|=>| => ]?{[\s\S]*}/gis
        let r_variables = /.*?\s?=.*?[;|,]?/gis
        return text.replace(r_embededScripts, '')
            .replace(r_embededStyle, '')
            .replace(r_embededTags, '')
            // .replace(r_greadySearchForPossibleJSFunction, '')
            // .replace(r_variables, '')
    }
}

class Controller {
    constructor(){
        this._imageNodeList = new ImageNodeList()
        this._mutationBatch = []
        this._batchTimer = null
        this._batchProcessInterval = 500 // Process batch every 500ms
        this._maxBatchSize = 10 // Or when we collect 10 mutations
    }

    updateImageList(nodeToCheck){
        let tagImageNodes = $(nodeToCheck).find('img')
        let videoNodes = $(nodeToCheck).find('video')
        let iframeNodes = $(nodeToCheck).find('iframe')
        let newImages = []
        let existingImages = []

        let r_bgUrl = /url/gi
        let bgImageNodes = $(nodeToCheck).find('*').filter(function() {
            return $(this).css('background').match(r_bgUrl)
        })
        let checkAndUpdate = (classType, _, imageNode) => {
            let imageToAnalize = this._imageNodeList.getImageNode(imageNode)
            if (!imageToAnalize){
                imageToAnalize = new classType(imageNode)
                this._imageNodeList.push(imageToAnalize)
                newImages.push(imageToAnalize)
            } else {
                existingImages.push(imageToAnalize)
            }
        }
        bgImageNodes.each((_, bgImage) => {
            checkAndUpdate(BgImageNode, _, bgImage)
        })
        tagImageNodes.each((_, tagImageNode) => {
            checkAndUpdate(TagImageNode, _, tagImageNode)
        })
        videoNodes.each((_, videoNode) => {
            checkAndUpdate(VideoNode, _, videoNode)
        })
        iframeNodes.each((_, iframeNode) => {
            checkAndUpdate(IframeNode, _, iframeNode)
        })
        return { newImages, existingImages }
    }

    onLoad(){
        let textAnalizer = new TextAnalizer()
        let { newImages, existingImages } = this.updateImageList(document)
        textAnalizer.addText($('body').text())
        textAnalizer.addText($('title').text())
        textAnalizer.startAnalysis(newImages).catch(err => {
            console.error('Error in onLoad text analysis:', err)
        })
        this._observerInit()
    }

    onLoadBlurAll(){
        this.updateImageList(document)
        this.blurAll()
        this._observerInit()
    }

    _shouldIgnoreMutation(target){
        // Ignore mutations in form fields to prevent typing freezes
        if (!target) return true
        let $target = $(target)

        // Check if target itself is a form element
        if ($target.is('input, textarea') || $target.attr('contenteditable') === 'true') {
            return true
        }

        // Check if target is inside a form element
        if ($target.closest('input, textarea, [contenteditable="true"]').length > 0) {
            return true
        }

        // Ignore script, head, style tags
        if ($target.is('script') || $target.is('head') || $target.is('style')) {
            return true
        }

        return false
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

            if (!this._shouldIgnoreMutation(mutation.target)) {
                textAnalizer.addText($(mutation.target).text())
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
            // Filter and add mutations to batch
            mutations.forEach((mutation) => {
                // Still add mutation even if we ignore text, as we need to check for images
                this._mutationBatch.push(mutation)
            })

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
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get([
            'targetWords',
            'phobiaBlockerEnabled',
            'blurIsAlwaysOn',
            'blurValueAmount'
        ], (storage) => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError)
            }
            if (!storage.targetWords) {
                chrome.storage.sync.set({ 'targetWords': [] })
                targetWords = []
            } else {
                // Expand target words to include variations (plurals, verb forms, etc.)
                targetWords = expandTargetWords(storage.targetWords)
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
        })
    })
}

var controller = new Controller()

// Check settings early to disable blur immediately if extension is off
setSettings().then(() => {
    if(!phobiaBlockerEnabled) {
        document.documentElement.style.setProperty('--blurValueAmount', 0 + 'px')
    }
})

let main = async () => {
    await setSettings()

    if(blurIsAlwaysOn){
        controller.onLoadBlurAll()
    }
    else if(phobiaBlockerEnabled){
        controller.onLoad()
    }
    else if(!phobiaBlockerEnabled) {
        document.documentElement.style.setProperty('--blurValueAmount', 0 + 'px')
    }
}
$(document).ready(main)

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
            // Blur after blur amount is set
            controller.blurAll()
        })
        break
    case 'unblurAll':
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
            if ($(lastElementContext).hasClass('blur')) {
                blured = $(lastElementContext)
            }
            // Check children with blur class
            else {
                blured = $(lastElementContext).find('.blur')
            }
            // Check siblings if nothing found
            if (!blured || blured.length === 0) {
                blured = $(lastElementContext).siblings('.blur')
            }
            // Check parent if still nothing found
            if (!blured || blured.length === 0) {
                blured = $(lastElementContext).parent('.blur')
            }
            // Check if parent has blurred children
            if (!blured || blured.length === 0) {
                blured = $(lastElementContext).parent().find('.blur')
            }

            if (blured && blured.length > 0) {
                blured.removeClass('blur')
                blured.addClass('noblur permamentUnblur')
            }
        }
        break
    case 'phobiaBlockerEnabled':
        phobiaBlockerEnabled = message.value
        if(!phobiaBlockerEnabled){
            controller.stop()
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
                $('.blur').removeClass('blur').removeClass('noblur').removeClass('permamentUnblur')
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
            $('.blur').removeClass('blur').removeClass('noblur').removeClass('permamentUnblur')
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
            $('.noblur').not('.permamentUnblur').removeClass('noblur').addClass('blur')
            // Re-analyze if extension is enabled
            if (phobiaBlockerEnabled && !blurIsAlwaysOn) {
                let textAnalizer = new TextAnalizer()
                textAnalizer.addText($('body').text())
                textAnalizer.addText($('title').text())
                let allImages = controller._imageNodeList._imageNodeList
                textAnalizer.startAnalysis(allImages).catch(err => {
                    console.error('Error in targetWordsChanged analysis:', err)
                })
            }
        })
        break
    }
})
