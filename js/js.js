const tokenizer = new natural.WordTokenizer()
let targetWords = []
let lastElementContext
var imageList = []
let counter = 0
// var score = 0;

/**
 * Checks if target words are set, if target words are not set -> sets default
 * If target words are present in storage -> use those words
 */
let setTargetWords = () => {
    let defaultTargetWords = ['clown', 'mice', 'spider']
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get('targetWords', (storage) => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError)
            }
            if (!storage['targetWords']) {
                console.log('settings')
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
 * Search text for any target words, using nlp normalization to compare words which are a
 * @param {string} text Text that will be checked for target words
 * @returns {number} Amount of words in the text that match target words
 */
let analizeText = (text) => {

    let cleanWords = tokenizer.tokenize(text)
        .map(word => word.toLowerCase())
        .filter(word => word.length > 2)
    let cleanWordsSet = [...new Set(cleanWords)]
    // .filter(word => !stopWords.includes(word))
    

    // nlp function is very expensive, therefore analize only words
    // that have two first letters in common with target words
    let compareTargetsToTextWords = (targets, wordsToAnalize) => {
        let probableMatchingTargetWords = []
        targets.forEach(function(t) {
            wordsToAnalize.forEach(function(word) {
                if (word[0] == t[0] && word[1] == t[1]) {
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
    return match.length
}

/**
 * Accepts DOME node and checks if it has image in it. All images are kept in imageList for blur and unblur functions,
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

let analizeLandingPage = async () => {
    // get only text, no html tags
    let text = $('body').text()
    let title = $('title').text()
    let checkTitle = await analizeText(title, targetWords)
    if (checkTitle != 0) {
        blurAll()
        return
    }
    let countTargetWords = await analizeText(text, targetWords)
    if (countTargetWords == 0) {
        // console.log(imageList);
        imageList.forEach((element) => {
            $(element).addClass('noblur')
        })
    }
}

let checkNewAddedImges = (imageList, text) => {
    var countTargetWordsMutation = analizeText( text )
    if (countTargetWordsMutation == 0) {
        imageList.forEach(function(element) {
            $(element).addClass('noblur')
        })
    }
}

let startObserver = () => {
    var observer = new MutationObserver((mutations) => {
        var newTextMutation = []
        var newImgList = []
        mutations.forEach(async (mutation) => {
            newImgList = newImgList.concat(updateImgList($(mutation.target)))
            console.log(mutation)
            newTextMutation.push($(mutation.target).text())
        })
        checkNewAddedImges(imageList, newTextMutation.join(' '))
    })
    observer.observe(document, { childList: true, subtree: true })
}

let main = async() => {
    await setTargetWords()
    updateImgList($(document))
    // analizeLandingPage()
    startObserver()
    document.addEventListener('contextmenu',
        (event) => {lastElementContext = event.target},
        true)
}
main()

let blurAll = () => {
    imageList.forEach(function(element) {
        $(element).removeClass('noblur')
        $(element).addClass('blur')
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
    chrome.storage.sync.get('target', (storage) => {
        if (storage) {
            target = storage['target']
            console.log(
                'new taerget'
            )
            console.log(target)
        } else {
        }
    })
}

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
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
        break
    default:
        console.log('Unrecognised message: ', message)
    }
})