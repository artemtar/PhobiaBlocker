const tokenizer = new natural.WordTokenizer()
let targetWords = []
let lastElementContext
let phobiaBlockerEnabled = true 
let blurIsAlwaysOn = false


// mobilenet.load({
//     version: 2,
//     modelUrl: './mobilenet'
// })
// const loadModel = async path => {
//   const mn = new mobilenet.MobileNet(1, 1);
//   mn.path = 'file://./mobilenet/mobilenet_v2_1.0_224_frozen.pb'
//   await mn.load()
//   return mn
// }
// async function loadm(){
//   let handler =  tf.io.IOHandler
// const path = "model.json"
// let paths = `file://${path}`
// const pathx = "./mobilenet/model.json"
// mobilenet.load({
//     version: 2,
//     modelUrl: paths
// })
// }

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
        this._init()
    }

    _init(){
        if(!blurIsAlwaysOn){
            this._startUnvielInterval()
            this.blur()
        } else this.blur()
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

    async _startUnvielInterval(){
        // wait for more elements to load alongside the image
        // necessary for dynamic loads since we do not know what will be fetched.
        this.unveilTimer = setTimeout(async () => {
            if(!this.isBlured && this.runningTexProcessing > 0) {clearTimeout(this.unveilTimer); this._startUnvielInterval(); console.log('STILL')}
            else if (!this.isBlured && this.runningTextProcessing <= 0) {this.unblur(); console.log('artem')}
            else {console.log("check", this.isBlured, this.runningTextProcessing); this.blur()}
        }, 2000)
    }

    newTextProcessingStarted(){
        this.runningTextProcessing += 1
    }

    textProcessingFinished(){
        this.runningTextProcessing -= 1
    }

    _updateUnveilTimer(){
        if (!this.runningTextProcessing < 1 && !this.isBlured){
            clearInterval(this.unveilTimer)
            this._startUnvielInterval()
        }
    }

    updateBlurStatus(analysisResult){
        if(!this.isBlured) this.isBlured = analysisResult
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
        if(!dependentImageNodes) return
        dependentImageNodes.forEach((imageNode) => {
            imageNode.newTextProcessingStarted()
        })

        let r_wordInAnyLanguage = /^(\b(\p{L}|-)*\b)|$/gmiu // no numbers in the word, common for class names
        console.log('text', this._text)
        let cleanWords = tokenizer.tokenize(this._text.join(' '))
            .map(word => word.toLowerCase())
            .filter(word => word.length > 2)
            .filter(word => r_wordInAnyLanguage.test(word))
            // .filter(word => !stopWords.includes(word))
        let cleanWordsSet = [...new Set(cleanWords)]
        console.log('clean words set', cleanWordsSet)

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

        console.log('target', targetWordsNormalized)
        console.log('match', match)
        console.log('words to check', wordsToCheckNormalized)

        dependentImageNodes.forEach((imageNode) => {
            // check
            $(imageNode._imageNode).attr('blurResult', match)
            imageNode.updateBlurStatus(analysisResult)
            imageNode.textProcessingFinished()
        })
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
    }

    updateImageList(nodeToCheck){
        let tagImageNodes = $(nodeToCheck).find('img')
        let imagesToAnalyze = []

        let r_bgUrl = /url/gi
        let bgImageNodes = $(nodeToCheck).find('*').filter(function() {
            return $(this).css('background').match(r_bgUrl)
        })
        let checkAndUpdate = (classType, _, imageNode) => {
            let imageToAnalize = this._imageNodeList.getImageNode(imageNode)
            if (!imageToAnalize){
                imageToAnalize = new classType(imageNode)
                this._imageNodeList.push(imageToAnalize)
            }
            imagesToAnalyze.push(imageToAnalize)
        }
        bgImageNodes.each((_, bgImage) => {
            checkAndUpdate(BgImageNode, _, bgImage)
        })
        tagImageNodes.each((_, tagImageNode) => {
            checkAndUpdate(TagImageNode, _, tagImageNode)
        })
        return imagesToAnalyze
    }

    onLoad(){
        let textAnalizer = new TextAnalizer()
        let imagesToAnalyze = (this.updateImageList(document))
        textAnalizer.addText($('body').text())
        textAnalizer.addText($('title').text())
        console.log($('title'), 'title')
        textAnalizer.startAnalysis(imagesToAnalyze)
        this._observerInit()
    }

    _observerInit(){
        this.observer = new MutationObserver((mutations) => {
            let textAnalizer = new TextAnalizer()
            let imagesToAnalyze = []
            mutations.forEach((mutation) => {
                imagesToAnalyze = imagesToAnalyze.concat(this.updateImageList(mutation.target))
                console.log('mutation')
                // check for tittle
                // if($(mutation.target).is('head'))
                // newTextMutation.push($(mutation.target).text())
                // if(!($(mutation.target).is('body') || $(mutation.target).is('script') || $(mutation.target).is('head') || $(mutation.target).is('style')) || !mutation.target){
                if(!($(mutation.target).is('script') || $(mutation.target).is('head') || $(mutation.target).is('style')) || !mutation.target){
                    let l = $(mutation.target).text()
                    console.log('to add', l)
                    textAnalizer.addText(l)
                }
            })
            textAnalizer.startAnalysis(imagesToAnalyze)
        })
        this.observer.observe(document, { childList: true, subtree: true })
    }

    stop(){
        this.observer.disconnect()
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
                targetWords = storage.targetWords
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
    let aaa = await fetchPromise('model.json')
    console.log('model', aaa)
    // mobilenet.load(aaa.body)
    // mobilenet.load({modelUrl: 'file://js/model.json'})
    const model = await tf.loadLayersModel('localstorage://my-model-1')



    // targetWords = ['cat']
    console.log('settings', 'enabled', phobiaBlockerEnabled, blurIsAlwaysOn)
    if(blurIsAlwaysOn) return
    if(phobiaBlockerEnabled){
        controller.onLoad()
    }
    else if(!phobiaBlockerEnabled) {
        console.log('artem ena')
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
        if(!phobiaBlockerEnabled)
            controller.stop()
        else if(!blurIsAlwaysOn){
            controller.onLoad()
        }
        break
    case 'blurIsAlwaysOn':
        blurIsAlwaysOn = message.value
        if(blurIsAlwaysOn){
            controller.stop()
            controller.blurAll()
        }
        else {
            controller.onLoad()
        }
        // else if(!phobiaBlockerEnabled && !blurIsAlwaysOn){
        //     controller.unBlurAll()
        // }
        break
    default:
        console.log('Unrecognised message: ', message)
    }
})
