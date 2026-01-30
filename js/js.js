const tokenizer = new natural.WordTokenizer()
let targetWords = []
let lastElementContext
let phobiaBlockerEnabled = true 
let blurIsAlwaysOn = false

let fetchPromise = async function(url,p1,p2,) {
    return new Promise(function(resolve, reject) {
        console.log('mypath',chrome.runtime.getURL('js/model.json'))
        fetch(chrome.runtime.getURL('js/model.json'))
            .then(response => {
                console.log('model', response)
                resolve(response)
            }).catch(err =>{
                console.log('myerr',err)
                reject()
            })
    })
}

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

    cleanup(){
        // Reserved for future cleanup needs (e.g., event listeners, observers)
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


class ImageNodeList {
    constructor() {
        this._imageNodeList = []
    }

    /**
     * Accepts DOM node and inserts it imageNodeList or create a new ImageNode and pushs it in the list.
     * All images are kept in imageNodeList for blur all and unblur all functions.
     * @param {Node} nodeToCheck Node that will be used to update the list
     * @returns {list[Node]} Amount of words in the text that match target words
    */
    // updateImageNodeList(nodeToCheck){
    //     let nodeToReturn = this.getImageNode(nodeToCheck)
    //     if (!nodeToReturn){
    //         nodeToReturn = new ImageNode(nodeToCheck)
    //         this._imageNodeList.push(nodeToReturn)
    //     }
    //     return nodeToReturn
    // }

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
                    wordsToAnalize.forEach((word) => {
                        if (word[0] == target[0] && word[1] == target[1]) {
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
                // check
                $(imageNode._imageNode).attr('blurResult', match)
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
        this._isStoped = false
        this._mutationBatch = []
        this._batchTimer = null
        this._batchProcessInterval = 500 // Process batch every 500ms
        this._maxBatchSize = 10 // Or when we collect 10 mutations
    }

    updateImageList(nodeToCheck){
        let tagImageNodes = $(nodeToCheck).find('img')
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
        return { newImages, existingImages }
    }

    onLoad(){
        let textAnalizer = new TextAnalizer()
        let { newImages, existingImages } = this.updateImageList(document)
        // On initial load, all images are new, so only analyze newImages
        textAnalizer.addText($('body').text())
        textAnalizer.addText($('title').text())
        textAnalizer.startAnalysis(newImages).catch(err => {
            console.error('Error in onLoad text analysis:', err)
        })
        this._observerInit()
    }

    onLoadBlurAll(){
        // Populate image list and blur everything without text analysis
        // Used when blurIsAlwaysOn mode is enabled
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
        // Clean up all image node timers
        this._imageNodeList.getAllImages().forEach(img => img.cleanup())
        this.unBlurAll()
        this._isStoped = true
    }

    resetImageNodeList(){
        this._imageNodeList = new ImageNodeList()
        this.updateImageList(document)
    }

    blurAll(){
        this._imageNodeList.blurAllImages()
        console.log(this._imageNodeList)
    }

    unBlurAll(){
        this._imageNodeList.unBlurAllImages()
    }

    isStoped(){
        return this._isStoped
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
            'blurIsAlwaysOn'
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
                console.log('Original target words:', storage.targetWords)
                console.log('Expanded target words:', targetWords)
            }
            if(storage.phobiaBlockerEnabled != undefined){
                phobiaBlockerEnabled = storage.phobiaBlockerEnabled
            }
            if(storage.blurIsAlwaysOn != undefined)
                blurIsAlwaysOn = storage.blurIsAlwaysOn
            return resolve()
        })
    })
}

var controller = new Controller()
let main = async () => {
    await setSettings()
    // Commented out experimental TensorFlow model loading (not implemented)
    // let aaa = await fetchPromise('model.json')
    // console.log('model', aaa)
    // mobilenet.load(aaa.body)
    // mobilenet.load({modelUrl: 'file://js/model.json'})
    // const model = await tf.loadLayersModel('localstorage://my-model-1')

    // targetWords = ['cat']
    console.log('settings', 'enabled', phobiaBlockerEnabled, blurIsAlwaysOn)

    if(blurIsAlwaysOn){
        // When "blur is always on", populate images and blur everything
        controller.onLoadBlurAll()
    }
    else if(phobiaBlockerEnabled){
        controller.onLoad()
    }
    else if(!phobiaBlockerEnabled) {
        document.documentElement.style.setProperty('--blurValueAmount', 0 + 'px')
    }
}
// main()
$(document).ready(main)
// document.addEventListener('DOMContentLoaded', main)

document.addEventListener('contextmenu', (event) => {lastElementContext = event.target}, true)

/**
 * hotkeys to Blur All (CTRL + ALT + B), and Unblur All (CTRL + ALT + U):
 **/
$(document).keydown((event) => {
    if (event.ctrlKey && event.altKey && event.which === 66) {
        controller.blurAll()
        event.preventDefault()
    }
    else if (event.ctrlKey && event.altKey && event.which === 85) {
        controller.unBlurAll()
        event.preventDefault()
    }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
    case 'blurAll':
        controller.blurAll()
        break
    case 'unblurAll':
        controller.unBlurAll()
        break
    // Recives updated blur amount value from popup.js and sets it to the page
    case 'setBlurAmount':
        chrome.storage.sync.get('blurValueAmount', (storage) => {
            let blurValueAmount = storage['blurValueAmount']
            if (blurValueAmount) {
                document.documentElement.style.setProperty(
                    '--blurValueAmount',
                    5 * blurValueAmount + 'px'
                )
            } else {
                document.documentElement.style.setProperty('--blurValueAmount', 15 + 'px')
            }
        })
        break
    // unblur on mouse right click
    case 'unblur':
        if (lastElementContext) {
            // check how to do other way
            let blured = $(lastElementContext).find('.blur')
            if(!blured.hasClass('blur')){
                blured = $(lastElementContext).siblings('.blur')
            }
            if (blured){
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
            // Extension is being enabled
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
            // Switching TO "blur is always on" mode
            if (controller.observer) {
                controller.observer.disconnect()
            }
            clearTimeout(controller._batchTimer)
            controller._mutationBatch = []
            controller._isStoped = true
            // Clean up old image node timers
            controller._imageNodeList.getAllImages().forEach(img => img.cleanup())
            // Clear all blur/noblur classes from DOM
            $('.blur').removeClass('blur').removeClass('noblur').removeClass('permamentUnblur')
            // Reset the list and repopulate with all images
            controller._imageNodeList = new ImageNodeList()
            controller.updateImageList(document)
            // Now blur all images
            controller.blurAll()
            // Restart observer to catch new images
            controller._observerInit()
        }
        else {
            // Switching FROM "blur is always on" to normal mode
            if (controller.observer) {
                controller.observer.disconnect()
            }
            clearTimeout(controller._batchTimer)
            controller._mutationBatch = []
            // Clean up old image node timers
            controller._imageNodeList.getAllImages().forEach(img => img.cleanup())
            // Clear all blur/noblur classes from DOM before resetting
            $('.blur').removeClass('blur').removeClass('noblur').removeClass('permamentUnblur')
            controller._imageNodeList = new ImageNodeList()
            controller._isStoped = false
            controller.onLoad()
        }
        break
    default:
        console.log('Unrecognised message: ', message)
    }
})
