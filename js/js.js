const tokenizer = new natural.WordTokenizer()
let targetWords = []
let lastElementContext
let imageList = []
const defaultTargetWords = ['clown', 'mice', 'spider'] // targets are words defined by user to block

/**
 * Checks if target words are set, if target words are not set -> sets default
 * If target words are present in storage -> use those words
 */
let setTargetWords = () => {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get('targetWords', (storage) => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError)
            }
            if (!storage['targetWords']) {
                chrome.storage.sync.set({ 'targetWords': defaultTargetWords })
                targetWords = defaultTargetWords
            } else {
                targetWords = storage['targetWords']
            }
            resolve()
        })
    })
}

/**
 * Search text for any target words, using NLP normalization to compare words
 * @param {string} text Text that will be checked for target words
 * @returns {number} Amount of words in the text that match target words
 */
let analizeText = (text) => {
    let cleanWords = tokenizer.tokenize(text)
        .map(word => word.toLowerCase())
        .filter(word => word.length > 2)
    let cleanWordsSet = [...new Set(cleanWords)]
    // .filter(word => !stopWords.includes(word))

    // NLP function is very expensive, therefore analyze only words
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
        .filter(element => targetWords.includes(element))
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
    let images = nodeToCheck.find('img, background-image')
    // let backgroud = nodeToCheck.find('background-image')
    let newImgList = []
    // images = $.merge(images, backgroud)
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
    let countTargetWordsMutation = analizeText(regexCleanUp(text))
    imageList.forEach((image) => {
        if (countTargetWordsMutation == 0)
            // wait for more alements to load alongside the image
            // nessesary for dynamic loads since we do not know what will be fetch.
            setInterval(async () => {
                if (!$(image).hasClass('blur'))
                    $(image).addClass('noblur')}, 2000)
        else
        if (! $(image).hasClass('permamentUnblur'))
            $(image).addClass('blur')
    })
}

let regexCleanUp = (text) => {
    let r_embededScripts = /<script.*?>([\s\S]*?)<\/script>/gis
    let r_embededStyle = /<style.*?>([\s\S]*?)<\/style>/gis
    let r_embededTags = /(<([^>]+)>)/ig
    let r_greadySearchForPossibleJSbrakets = /\{([\s\S]*)\}/gis
    return text.replace(r_embededScripts, '').replace(r_embededStyle, '')
        .replace(r_embededTags, '').replace(r_greadySearchForPossibleJSbrakets, '')
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
            newImgList = newImgList.concat(updateImgList($(mutation.target)))
            if(!($(mutation.target).is('body') || $(mutation.target).is('script') || $(mutation.target).is('header') || $(mutation.target).is('style')) || $(mutation.target)){
                newTextMutation.push($(mutation.target).text())
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

let main = async() => {
    await setTargetWords()
    $( document ).ready(() => {
        let newImgList = updateImgList($(document))
        checkNewAddedImages(newImgList, $(document).text())
    })
    startObserver()
}
main()

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
        console.log(imageList)
        blurAll()
        break
    case 'unblurAll':
        unBlurAll()
        break
    case 'setBlurAmount':
        updateBlur()
        break
    // unblur on mouse right click
    case 'unblur':
        if (lastElementContext) {
            let img = $(lastElementContext).find('.blur')
            if(img){
                img.removeClass('blur')
                img.addClass('noblur permamentUnblur')
            }
        }
        break
    default:
        console.log('Unrecognised message: ', message)
    }
})
