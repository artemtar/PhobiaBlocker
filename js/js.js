const tokenizer = new natural.WordTokenizer()
let targetWords = []
let lastElementContext
let imageList = []

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

/**
 * Checks if target words are set, if target words are present in storage -> use those words
 * Target words are words defined by user in the extention
 */
let setTargetWords = () => {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get('targetWords', (storage) => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError)
            }
            if (!storage['targetWords']) {
                chrome.storage.sync.set({ 'targetWords': [] })
                targetWords = []
            } else {
                targetWords = storage['targetWords']
            }
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
}
let unBlurAll = () => {
    imageList.forEach((image) => {
        $(image).removeClass('blur')
        $(image).addClass('noblur')
    })
}

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
        // controller.unBlurAll()
        console.log(imageList)
        unBlurAll()
        break
    case 'setBlurAmount':
        updateBlur()
        break
    // unblur on mouse right click
    case 'unblur':
        if (lastElementContext) {
            let blured = $(lastElementContext).find('.blur')
            console.log('--- bluredd', blured)
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
        event.preventDefault()
    }
    else if (event.ctrlKey && event.altKey && event.which === 85) {
        unBlurAll()
        event.preventDefault()
    }
})


class ImageNode {
    constructor(_imageNode) {
        this.imageNode = _imageNode
        this.runningTextProcessing = 0
        this.isBlured = false
        this._startUnvielInterval()
    }

    same(nodeToCheck) {
        return $(nodeToCheck).attr('src') == $(this.imageNode).attr('src') &&
            true
    }

    blur() {
        if (!$(this.imageNode).hasClass('permamentUnblur')){
            $(this.imageNode).removeClass('noblur')
            $(this.imageNode).addClass('blur')
        }
    }

    unblur() {
        $(this.imageNode).addClass('noblur')
        $(this.imageNode).removeClass('blur')
        console.log('unblur')
    }

    _startUnvielInterval(){
        // wait for more elements to load alongside the image
        // necessary for dynamic loads since we do not know what will be fetched.
        this.unveilTimer = setTimeout(async () => {
            if (this.isBlur) {this.blur(); clearTimeout(this.unveilTimer); console.log('detected')}
            else if (!this.isBlured && this.runningTextProcessing < 1) this.unblur()
            // else if(!this.isBlured && this.runningTextProcessing > 0) this._startUnvielInterval()
            console.log('int finised', this.runningTextProcessing)
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

}

class TextAnalizer {
    constructor(){
        this.text = []
    }

    addText(_text){
        this.text.push(_text)
    }

    async startAnalysis (dependentImageNodes){
        dependentImageNodes.forEach((imageNode) => {
            imageNode.newTextProcessingStarted()
        })

        let r_wordInAnyLanguage = /^(\b(\p{L})*\b)$/gmiu
        let cleanWords = tokenizer.tokenize(this._regexTextCleanUp(this.text.join(' ')))
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
        this.imageNodeList = []
    }

    getImageNodeForAnalysis(nodeToCheck){
        let nodeToReturn = this.getImageNode(nodeToCheck)
        if (!nodeToReturn){
            nodeToReturn = new ImageNode(nodeToCheck)
            this.imageNodeList.push(nodeToReturn)
        }
        return nodeToReturn
    }

    getImageNode(nodeToGet){
        this.imageNodeList.forEach(node => {
            if (node.imageNode.isSameNode(nodeToGet))
                return node
        })
    }

    blurAllImages(){
        this.imageNodeList.forEach((imageNode) => {
            imageNode.blur()
        })
        // this.imageNodeList.forEach(n => {
        //     console.log(n.imageNode)
        // })
    }

    unBlurAllImages(){
        this.imageNodeList.forEach((imageNode) => {
            imageNode.unblur()
        })
    }



    // isInNodeImageList(node){
    //     this.imageNodeList.forEach((imageNode) => {
    //         if (imageNode.same(node))
    //             return true
    //     })
    //     return false
    // }


}

class Controller {
    constructor(_imageNodeList){
        this.imageNodeList = _imageNodeList
    }

    updateImageList(nodeToCheck){
        let imageNodes = $(nodeToCheck).find('img')
        let imagesToAnalyze = []
        imageNodes.each((_, imageNode) => {
            imagesToAnalyze.push(this.imageNodeList.getImageNodeForAnalysis(imageNode))
        })
        return imagesToAnalyze
    }

    observerInit(){
        this.observer = new MutationObserver((mutations) => {
            let textAnalizer = new TextAnalizer()
            let imagesToAnalyze = []
            mutations.forEach((mutation) => {
                imagesToAnalyze = imagesToAnalyze.concat(this.updateImageList(mutation.target))
                console.log('mutation')
                // check for tittle
                // if($(mutation.target).is('head'))
                // newTextMutation.push($(mutation.target).text())
                if(!($(mutation.target).is('body') || $(mutation.target).is('script') || $(mutation.target).is('head') || $(mutation.target).is('style')) || !mutation.target){
                    let l = $(mutation.target).text()
                    textAnalizer.addText(l)
                }
            })
            textAnalizer.startAnalysis(imagesToAnalyze)
        })
        this.observer.observe(document, { childList: true, subtree: true })
    }

    blurAll(){
        this.imageNodeList.blurAllImages()
        console.log(this.imageNodeList)
    }

    unBlurAll(){
        this.imageNodeList.unBlurAllImages()
    }
}

var controller = new Controller(new ImageNodeList)
console.log('iam reloaded')
let main = async() => {
    // await setTargetWords()
    $( document ).ready(() => {
        // let newImgList = updateImgList($(document))
        // checkNewAddedImages(newImgList, $(document).text())
        controller.observerInit()
    })
    // startObserver()

}
main()