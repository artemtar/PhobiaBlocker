const tokenizer = new natural.WordTokenizer()
let targetWords = []
let lastElementContext
let imageList = []

function isImg(el) { return el.tagName == 'IMG' }


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
    console.log('is image', nodeToCheck.tagName)
    console.log(nodeToCheck)

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
            newImgList = newImgList.concat(updateImgList($(mutation.target)))
            if(!($(mutation.target).is('body') || $(mutation.target).is('script') || $(mutation.target).is('header') || $(mutation.target).is('style')) || !mutation.target){
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
