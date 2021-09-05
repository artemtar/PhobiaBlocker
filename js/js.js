const tokenizer = new natural.WordTokenizer();
let targetWords = [];
let lastElementContext;

/**
 * Checks if target words are set, if target words are not set -> sets default
 * If target words are present in storage -> use those words
 */
let setTargetWords = () => {
  let defaultTargetWords = ["clown", "mice", "spider"];
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get('targetWords', (storage) => {
    if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
    }
    if (!storage['targetWords']) {
        console.log("settings")
        chrome.storage.sync.set({ 'targetWords': defaultTargetWords });
        targetWords = defaultTargetWords;
    } else {
        targetWords = storage['targetWords']
    }
    resolve();
    });
  });
}

var imageList = [];
// var score = 0;
var inAnalizes = 0;

/**
 * Search text for any target words
 * @param {string} text Text that will be checked for target words
 * @returns {number} Amount of words in the text that match target words
 */
let analizeText = (text) => {
    let cleanWords = tokenizer.tokenize(text)
        .map(word => word.toLowerCase())
        .filter(word => word.length > 2)
        // .filter(word => !stopWords.includes(word));
    let uniqueWords = [...new Set(cleanWords)];
    let createDictToAnalize = (target, words) => {
        toAnalize = [];
        target.forEach(function(t) {
            words.forEach(function(word) {
                if (word[0] == t[0] && word[1] == t[1]) {
                    toAnalize.push(word);
                }
            });
        });
        return toAnalize;
    };

    // console.time('doSomething')
    // console.timeEnd('doSomething')

    targetWordsNormalized = nlp(targetWords)
        .normalize()
        .out('array');

    wordsToCheck = nlp(createDictToAnalize(targetWordsNormalized, uniqueWords))
        .normalize()
        // .nouns()
        .out('array');

    const intersection = wordsToCheck
        .filter(element => targetWords.includes(element))
        .filter(n => n);
    return intersection.length;
};

function updateImgList(nodeToCheck) {
    let images = nodeToCheck.find('img');
    let backgroud = nodeToCheck.find('background-image');

    // var img_collect_massiv = []; //array for element page 
    // for (var childItem in nodeToCheck.childNodes)
    //     if (nodeToCheck.childNodes[childItem].style['background-image'] != null)
    //         img_collect_massiv.push(nodeToCheck.childNodes[childItem]);


    // if (img_collect_massiv.length > 0) {}


    images = $.merge(images, backgroud);
    let tempImgList = [];
    for (let image of images) {
        let imageSource = $(image).attr("src");
        if (!imageList.includes(image)) {
            imageList.push(image);
            tempImgList.push(image);
        }
    }
    return tempImgList;
}

let analizeLandingPage = async () => {
        // get only text, no html tags
        let text = $("body").text();
        let title = $("title").text();
        let checkTitle = await analizeText(title, targetWords);
        if (checkTitle != 0) {
            blurAll();
            return;
        }
        var countTargetWords = await analizeText(text, targetWords);
        if (countTargetWords == 0) {
            // console.log(imageList);
            imageList.forEach((element) => {
                $(element).addClass("noblur");
            });
        }
    };

let main = async() => {
    await setTargetWords();
    updateImgList($(document));

    // function promiseAnalizer(t, tar) {
    //     inAnalizes += 1;
    //     return new Promise(function(resolve) {
    //         resolve(analizeText(t, tar));
    //     });
    // }

    // async function checkTextForTarget(text) {
    //     let result = await promiseAnalizer(text, targetWords);
    //     inAnalizes -= 1;
    //     return result * 10;
    // }



    // check landing page for target words
    // (async () => {
    //     // get only text, no html tags
    //     let text = $("body").text();
    //     let title = $("title").text();
    //     // console.log(text);
    //     let checkTitle = await checkTextForTarget(title, targetWords);
    //     if (checkTitle != 0) {
    //         blurAll();
    //         return;
    //     }
    //     var countTargetWords = await checkTextForTarget(text);
    //     if (countTargetWords == 0) {
    //         // console.log(imageList);
    //         imageList.forEach((element) => {
    //             $(element).addClass("noblur");
    //         });
    //     }
    // })();


    analizeLandingPage();

    // if the page has infinit scroll -> check every new elemnt
    var observer = new MutationObserver(async function(mutations) {
        var newTextMutation = [];
        var newImgList = [];
        mutations.forEach(function(mutation) {
            newImgList = newImgList.concat(updateImgList($(mutation.target)));
            newTextMutation.push($(mutation.target).text());
        });
        if (newImgList) {
            var countTargetWordsMutation = await analizeText(
                newTextMutation.join(' ')
            );
            if (countTargetWordsMutation == 0) {
                newImgList.forEach(function(element) {
                    $(element).addClass("noblur");
                });
            }
        }
    });
    observer.observe(document, { childList: true, subtree: true });

    document.addEventListener("contextmenu",
                              (event) => {lastElementContext = event.target;},
                              true);
};

let blurAll = () => {
    imageList.forEach(function(element) {
        $(element).removeClass("noblur");
        $(element).addClass("blur");
    });
};

let updateBlur = () => {
    chrome.storage.sync.get("blurValueAmount", (storage) => {
        let blurValueAmount = storage["blurValueAmount"];
        if (blurValueAmount) {
            document.documentElement.style.setProperty(
                "--blurValueAmount",
                5 * blurValueAmount + "px"
            );
        } else {
            document.documentElement.style.setProperty("--blurValueAmount", 15 + "px");
        }
    });
}

let updateTargetWords = () => {
    chrome.storage.sync.get('target', (storage) => {
        if (storage) {
            target = storage['target'];
            console.log(
                'new taerget'
            );
            console.log(target);
        } else {
        }
    });
}

main()

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    switch (message.type) {
        case "getTarget":
            sendResponse(target);
            break;
        case "blurAll":
            updateBlur();
            blurAll();
            break;
        case "unblurAll":
            imageList.forEach((image) => {
                $(image).removeClass("blur");
                $(image).addClass("noblur");
            });
            break;
        case "setBlurAmount":
            updateBlur();
            break;
        case "unblur":
            console.log("ublur")
            if (lastElementContext) {
                $(lastElementContext).removeClass("blur");
                $(lastElementContext).addClass("noblur");
            };
            break;
        case 'updateTargetWords':
            break;
        default:
            console.log("Unrecognised message: ", message);
    }
});