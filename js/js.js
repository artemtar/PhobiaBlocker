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

    let targetWordsNormalized =[...new Set(nlp(targetWords)
        .normalize()
        .out('array'))]

    let wordsToCheckNormalized = nlp(compareTargetsToTextWords(targetWordsNormalized, cleanWordsSet))
        .normalize()
        .out('array')

    const match = wordsToCheckNormalized
        .filter(element => targetWords.includes(element))
        .filter(n => n)
    console.log('match')
    console.log(match.length)
    return match.length
}

/**
 * Accepts DOME node and checks if it has image in it. All images are kept in imageList for blur all and unblur all functions,
 * While newImageList hold only newly added images, this list is used to check new dynamicly incomming elements.
 * @param {Node} nodeToCheck Text that will be checked for target words
 * @returns {list} Amount of words in the text that match target words
 */
let updateImgList = (nodeToCheck) => {
    let images = nodeToCheck.find('img')
    let backgroud = nodeToCheck.find('background-image')

    images = $.merge(images, backgroud)
    let newImgList = []
    for (let image of images) {
        if (!imageList.includes(image)) {
            imageList.push(image)
            newImgList.push(image)
        }
    }
    return newImgList
}

/**
 * Check if newly added images to the web page could hold any target words
 * @param {list} imageList List of new images dynamicly added to the page
 * @returns {string} The text that had been added with images
 */
let checkNewAddedImages = (imageList, text) => {
    var countTargetWordsMutation = analizeText( text )
    imageList.forEach((element) => {
        if (countTargetWordsMutation == 0)
            $(element).addClass('noblur')
        else
            $(element).addClass('blur')
    })
}

/**
 * Check if newly added images to the webpage could hold any target words
 * @param {list} imageList List of new images dynamicly added to the page
 * @returns {string} The text that had been added with images
 */
let startObserver = () => {
    var observer = new MutationObserver((mutations) => {
        var newTextMutation = []
        var newImgList = []
        mutations.forEach(async (mutation) => {
            newImgList = newImgList.concat(updateImgList($(mutation.target)))
            console.log(mutation)
            newTextMutation.push($(mutation.target).text())
        })
        checkNewAddedImages(imageList, newTextMutation.join(' '))
    })
    observer.observe(document, { childList: true, subtree: true })
}

let main = async() => {
    await setTargetWords()
    startObserver()
    document.addEventListener('contextmenu',
        (event) => {lastElementContext = event.target},
        true)
}
main()



let blurAll = () => {
    imageList.forEach((img) => {
        $(img).removeClass('noblur')
        $(img).addClass('blur')
        // let p = $(img).parent()
        // $(img).remove()
        // let z = $('<div class="unblurButtonContainer"></div>')
        // $(img).appendTo(z)
        // $(z).appendTo(p)

        // $('<button/>')
        //     .val('Unblur')
        //     .addClass('unblurBtn')
        //     .css({'width': $(img).width(), 'height': $(img).height()})
        //     .appendTo($(z))
        //     .click((event) => {
        //         event.preventDefault()
        //         event.stopPropagation()
        //         console.log(img)
        //         $(img).parent().remove('.unblurBtn')
        //         $(img).unwrap()
        //     })
        // $('<button class="unblurBtn">Unblur</button>').appendTo($(img).parent())

    })
}

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

let updateTargetWords = () => {
    setTargetWords()
    let title = $('title').text()
    let checkTitle = analizeText(title, targetWords)
    if (checkTitle != 0) {
        blurAll()
        return
    }
    let body = $('body').text()
    let checkBody = analizeText(body, targetWords)
    if (checkBody != 0) {
        blurAll()
        return
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
    case 'getTarget':
        sendResponse(targetWords)
        break
    case 'blurAll':
        updateBlur()
        blurAll()
        break
    case 'unblurAll':
        imageList.forEach((image) => {
            $(image).removeClass('blur')
            $(image).addClass('noblur')
        })
        break
    case 'setBlurAmount':
        updateBlur()
        break
    case 'unblur':
        console.log('ublur')
        if (lastElementContext) {
            $(lastElementContext).removeClass('blur')
            $(lastElementContext).addClass('noblur')
        }
        break
    case 'updateTargetWords':
        // updateTargetWords()
        break
    default:
        console.log('Unrecognised message: ', message)
    }
})