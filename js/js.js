const tokenizer = new natural.WordTokenizer()
let targetWords = []
let lastElementContext
let imageList = []
let phobiaBlockerEnabled = false
let blurIsAlwaysOn = false

/**
 * Search text for any target words, using NLP normalization to compare words
 * @param {string} text Text that will be checked for target words
 * @returns {number} Amount of words in the text that match target words
 */
let analizeText = (text) => {
    let r_wordInAnyLanguage = /^(\b(\p{L})*\b)$/gmiu
    let cleanWords = tokenizer.tokenize(text)
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
    return match.length
}

/**
 * Accepts DOME node and checks if it has image in it. All images are kept in imageList for blur all and unblur all functions,
 * While newImageList hold only newly added images, this list is used to check new dynamicly incomming elements.
 * @param {Node} nodeToCheck Text that will be checked for target words
 * @returns {list} Amount of words in the text that match target words
*/
let updateImgList = (nodeToCheck) => {
    let images = nodeToCheck.find('img, IMG')
    // if (nodeToCheck.css('background-image') != 'none' && !nodeToCheck.css('background-image')){
    //     console.log('found b', nodeToCheck)
    //     console.log("styule", typeof nodeToCheck.css('background-image'), nodeToCheck.css('background-image'), !nodeToCheck.css('background-image'))
    //     console.log('images', images)
    //     images = $.merge(nodeToCheck, images)
    // }
    let newImgList = []
    for (let image of images) {
        if (!imageList.includes(image))
            imageList.push(image)
        newImgList.push(image)
    }
    return newImgList
}

/**
 * Check if newly added images to the web page could hold any target words
 * @param {list} imageList List of new images dynamicly added to the page
 * @returns {string} The text that had been added with images
 */
let checkNewAddedImages = (imageList, text) => {
    let countTargetWordsMutation = analizeText(regexTextCleanUp(text))
    imageList.forEach((image) => {
        if (countTargetWordsMutation == 0)
            // wait for more elements to load alongside the image
            // necessary for dynamic loads since we do not know what will be fetched.
            setInterval(async () => {
                if (!$(image).hasClass('blur'))
                    $(image).addClass('noblur')}, 2000)
        else
        if (! $(image).hasClass('permamentUnblur'))
            $(image).addClass('blur')
    })
}

let regexTextCleanUp = (text) => {
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

/**
 * Check if newly added images to the webpage could hold any target words
 * @param {list} imageList List of new images dynamicly added to the page
 * @returns {string} The text that had been added with images
 */
let startObserver = () => {
    let observer = new MutationObserver((mutations) => {
        let newTextMutation = []
        let newImgList = []
        mutations.forEach(async (mutation) => {
            console.log('mutation', mutation.target, $(mutation.target).is('head'), $(mutation.target).title, $(mutation.target).find('title'))
            newImgList = newImgList.concat(updateImgList($(mutation.target)))
            if(!($(mutation.target).is('body') || $(mutation.target).is('script') || $(mutation.target).is('head') || $(mutation.target).is('style')) || !mutation.target){
                let l = $(mutation.target).text()
                newTextMutation.push(l)
            }
        })
        checkNewAddedImages(newImgList, newTextMutation.join(' '))
    })
    observer.observe(document, { childList: true, subtree: true })
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
            if (!storage['targetWords']) {
                chrome.storage.sync.set({ 'targetWords': [] })
                targetWords = []
            } else {
                targetWords = storage['targetWords']
            }
            if(storage.phobiaBlockerEnabled){
                phobiaBlockerEnabled = storage.phobiaBlockerEnabled
                $('#enabled-switch').attr('checked', phobiaBlockerEnabled) 
            }
            if(storage.blurIsAlwaysOn)
                blurIsAlwaysOn = storage.blurIsAlwaysOn
            return resolve()
        })
    })
}

// function loadCSS(file) {
//   var link = document.createElement("link");
//   link.href = chrome.extension.getURL('./css/style.css');
//   link.id = file;
//   link.type = "text/css";
//   link.rel = "stylesheet";
//   document.getElementsByTagName("head")[0].appendChild(link);
// }

// function unloadCSS(file) {
//   var cssNode = document.getElementById('./css/style.css');
//   console.log(cssNode)
//   cssNode && cssNode.parentNode.removeChild(cssNode);
// }

// $('img').css("filter", "");

// (function(){
 
//     var loc = document.location.href;
//     if( /* ---- Perform your test here ---- */ /www\.google/.test(loc)){
 
//         document.addEventListener('DOMSubtreeModified', injectCSS, false);
 
//         function injectCSS(){
//             if(document.head){
//                 document.removeEventListener('DOMSubtreeModified', injectCSS, false);
 
//                 var style = document.createElement("style");
//                 style.innerHTML = "background: red";
//                 // document.head.appendChild(style);
//                 // loadCSS()
//             }
//         }
//     }
 
// })()



let blurAll = () => {
    imageList.forEach((img) => {
        $(img).removeClass('noblur')
        $(img).addClass('blur')
    })
    console.log(imageList)
}
let unBlurAll = () => {
    imageList.forEach((image) => {
        $(image).removeClass('blur')
        $(image).addClass('noblur')
    })
    console.log(imageList)
}

class ImageNode {
    constructor(imageNode) {
        this._imageNode = imageNode
        this.runningTextProcessing = 0
        this.isBlured = false
        this._startUnvielInterval()
        this.blur()
    }

    getImageNode(){
        return this._imageNode
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

    async _startUnvielInterval(){
        // wait for more elements to load alongside the image
        // necessary for dynamic loads since we do not know what will be fetched.
        this.unveilTimer = setTimeout(async () => {
            // if (this.isBlur) {this.blur(); clearTimeout(this.unveilTimer); console.log('detected')}
            if(!this.isBlured && this.runningTexProcessing > 0) {clearTimeout(this.unveilTimer); this._startUnvielInterval(); console.log('STILL')}
            else if (!this.isBlured && this.runningTextProcessing < 1) {this.unblur(); console.log('artem')}
            else {console.log("whay are you herejll", this.isBlured, this.runningTextProcessing); this.blur()}
            // console.log('int finised', this.runningTextProcessing)
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

class TextAnalizer {
    constructor(){
        this.text = []
    }

    addText(_text){
        this.text.push(this._regexTextCleanUp(_text))
    }

    async startAnalysis (dependentImageNodes){
        if(!dependentImageNodes) return
        dependentImageNodes.forEach((imageNode) => {
            imageNode.newTextProcessingStarted()
        })

        let r_wordInAnyLanguage = /^(\b(\p{L}|-)*\b)|$/gmiu // no numbers in the word, common for class names
        console.log('text', this.text)
        let cleanWords = tokenizer.tokenize(this.text.join(' '))
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

        console.log(targetWordsNormalized)
        console.log(match)
        console.log(wordsToCheckNormalized)
        console.log('targets')

        if(analysisResult){
            console.log('detected')
            console.log(dependentImageNodes)
        }
        
        dependentImageNodes.forEach((imageNode) => {
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

class ImageNodeList {
    constructor() {
        this._imageNodeList = []
    }

    updateImageNodeList(nodeToCheck){

        let nodeToReturn = this.getImageNode(nodeToCheck)
        if (!nodeToReturn){
            nodeToReturn = new ImageNode(nodeToCheck)
            this._imageNodeList.push(nodeToReturn)
            if(this._imageNodeList.length == 35)
                console.log('elo')
        }
        return nodeToReturn
    }

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
        // this.imageNodeList.forEach(n => {
        //     console.log(n.imageNode)
        // })
    }

    unBlurAllImages(){
        this._imageNodeList.forEach((imageNode) => {
            imageNode.unblur()
        })
    }
}

class Controller {
    constructor(imageNodeList){
        this._imageNodeList = imageNodeList
    }

    updateImageList(nodeToCheck){
        let imageNodes = $(nodeToCheck).find('img')
        let imagesToAnalyze = []
        // if(nodeToCheck.style.backgroundImage && nodeToCheck.style.backgroundImage.indexOf('url(') > -1){
        //     let l = new ImageNode(nodeToCheck)
        //     this._imageNodeList.push(l)
        //     imagesToAnalyze.push(l)
        // }

        imageNodes.each((_, imageNode) => {
            let imageNodeForAnalysis = this._imageNodeList.updateImageNodeList(imageNode)
            if(imageNodeForAnalysis)
                imagesToAnalyze.push(imageNodeForAnalysis)
        })
        return imagesToAnalyze
    }

    onFirstLoad(){
        let textAnalizer = new TextAnalizer()
        let imagesToAnalyze = (this.updateImageList(document))
        textAnalizer.addText($('body').text())
        textAnalizer.addText($('title').text())
        console.log($('title'), 'title')
        textAnalizer.startAnalysis(imagesToAnalyze)
    //     let regexp = /url/gi
    //     let test = $(document).find('*').filter(() => {
    //         if($(this).css('background').match(regexp)) $(this).css('filter', 'blur(10px)')
    //         return $(this).css('background').match(regexp)
    //     })
    }

    observerInit(){
        this.observer = new MutationObserver((mutations) => {
            let textAnalizer = new TextAnalizer()
            let imagesToAnalyze = []
            mutations.forEach((mutation) => {
                imagesToAnalyze = imagesToAnalyze.concat(this.updateImageList(mutation.target))
                console.log('mutation')
                // let regexp = /url/gi
                // let test = $(mutation.target).find('*').filter(function() {
                //     if($(this).css('background').match(regexp)) $(this).css('filter', 'blur(10px)')
                //     return $(this).css('background').match(regexp)
                // })
                // check for tittle
                // if($(mutation.target).is('head'))
                // newTextMutation.push($(mutation.target).text())
                // if(!($(mutation.target).is('body') || $(mutation.target).is('script') || $(mutation.target).is('head') || $(mutation.target).is('style')) || !mutation.target){
                if(!($(mutation.target).is('script') || $(mutation.target).is('head') || $(mutation.target).is('style')) || !mutation.target){
                    let l = $(mutation.target).text()
                    console.log("to add", l)
                    textAnalizer.addText(l)
                }
            })
            textAnalizer.startAnalysis(imagesToAnalyze)
        })
        this.observer.observe(document, { childList: true, subtree: true })
    }

    blurAll(){
        this._imageNodeList.blurAllImages()
        console.log(this._imageNodeList)
    }

    unBlurAll(){
        this._imageNodeList.unBlurAllImages()
    }
}
var controller = new Controller(new ImageNodeList)

let main = async () => {
    await setSettings()
    controller.onFirstLoad()
    // window.addEventListener('DOMContentLoaded', function () { controller.onFirstLoad });
    // $(window).ready(() => {
    controller.observerInit()
    // })
    // startObserver()

}
main()

document.addEventListener('contextmenu', (event) => {lastElementContext = event.target}, true)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
    case 'getTarget':
        sendResponse(targetWords)
        break
    case 'blurAll':
        controller.blurAll()
        blurAll()
        break
    case 'unblurAll':
        controller.unBlurAll()
        unBlurAll()
        break
    case 'setBlurAmount':
        updateBlur()
        break
    // unblur on mouse right click
    case 'unblur':
        if (lastElementContext) {
            // check how to do other way
            let blured = $(lastElementContext).find('.blur')
            if(!blured.hasClass('blur')){
                console.log('mot bluredd')
                blured = $(lastElementContext).siblings('.blur')
            }
            if (blured){
                console.log('blured', blured)
                blured.removeClass('blur')
                blured.addClass('noblur permamentUnblur')
            }
        }
        break
    case 'phobiaBlockerEnabled':
        setSettings()
        break
    case 'blurIsAlwaysOn':
        setSettings()
        break
    default:
        console.log('Unrecognised message: ', message)
    }
})

/**
 * hotkeys to Blur All (CTRL + ALT + B), and Unblur All (CTRL + ALT + U):
 **/
$(document).keydown((event) => {
    if (event.ctrlKey && event.altKey && event.which === 66) {
        blurAll()
        console.log(imageList)
        controller.blurAll()
        event.preventDefault()
    }
    else if (event.ctrlKey && event.altKey && event.which === 85) {
        // unBlurAll()
        controller.unBlurAll()
        event.preventDefault()
    }
})

/**
 * Recives updated blur amount value from popup.js and sets it to the page
 */
let updateBlur = () => {
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
}