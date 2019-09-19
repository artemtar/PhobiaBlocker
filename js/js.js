//To-DO:
//run on images that are bigger than 10x10
//analyze title(Done)
//new element is analyzed, not whole body
//store targets localy
//interface for targets
//able to control ammount of blur
//concurency for analysis
//intersection counts only one word per dict
//workers for parral
//add stringh of blur

// }
//     var backImg;
//     if (toCheck.is('img')) {
//         toCheck.addClass("blur");
//     }
//     else {
//         backImg = toCheck.css('background-image');
//         if (backImg != 'none'){
//         console.log("back");
//         toCheck.addClass("blur")
//         }
//     }
// }

const tokenizer = new natural.WordTokenizer();
// target = ["user", "have", 'jump'];
const target = ["rodent", "mice", "rat", "beaver", "squirrel"];

chrome.runtime.sendMessage({
    target: target
});

var imageList = [];
var score = 0;
var inAnalizes = 0;

var blurAll = function() {
    imageList.forEach(function(element) {
        $(element).removeClass("noblur");
        $(element).addClass("blur");
    });
}
var updateScore = function(val) {
    score += parseInt(val);
    if (score >= 40) {
        blurAll();
    }
}
var analizeText = function(text, target) {
    var tokens = tokenizer.tokenize(text)
    var cleanWords = tokens
        .map(word => word.toLowerCase())
        .filter(word => word.length > 2 && word.length < 16)
        .filter(word => !stopWords.includes(word));
    var uniqueWords = [...new Set(cleanWords)];
    var createDictToAnalize = function(target, words) {
        toAnalize = []
        target.forEach(function(t) {
            words.forEach(function(word) {
                if (word[0] == t[0] && word[1] == t[1]) {
                    toAnalize.push(word);
                }
            })
        })
        return toAnalize;
    }
    wordsToCheck = nlp(createDictToAnalize(target, uniqueWords))
        .normalize()
        .nouns()
        .out('array');
    targetWords = nlp(target)
        .normalize()
        .out('array');
    console.log("TARGETS:  " + targetWords.join(" ") +
        "  TOCHECK:  " + wordsToCheck.join(" "));
    const intersection = wordsToCheck
        .filter(element => targetWords.includes(element))
        .filter(n => n);
    if (intersection.length > 0) {
        console.log("intersection: " + intersection.join(" "))
    }
    return intersection.length;
}

function checkIfImg(toCheck) {
    let images = toCheck.find('img');
    let tempImgList = [];
    for (let image of images) {
        let imageSource = $(image).attr('src');
        if (!imageList.includes(image)) {
            imageList.push(image);
            tempImgList.push(image);
            console.log("pushed: ");
            console.log(image);
        }
    }
    return tempImgList;
};

checkIfImg($(document));

function promiseAnalizer(t, tar) {
    inAnalizes += 1;
    console.log("inanalysis " + inAnalizes);
    return new Promise(function(resolve) {
        resolve(analizeText(t, tar))
    });
};

async function checkTextForTarget(text) {
    let result = await promiseAnalizer(text, target);
    inAnalizes -= 1;
    console.log("analys finished " + inAnalizes);
    return result * 10;
}

var checkLandingPage = async function() {
    var text = $('body').text();
    var title = $('title').text();

    var checkTitle = await checkTextForTarget(title, target);
    if (checkTitle != 0) {
        updateScore(40);
    }
    var countTargetWords = await checkTextForTarget(text);
    if (countTargetWords == 0 && score < 40) {
        console.log('landing page');
        console.log(imageList);
        imageList.forEach(function(element) {
            $(element).addClass("noblur");
        });
    }
}();

var observer = new MutationObserver(async function(mutations) {
    var newTextMutation = [];
    var newImgList = [];
    mutations.forEach(function(mutation) {
        newImgList = newImgList.concat(checkIfImg($(mutation.target)));
        newTextMutation.push($(mutation.target).text());
    });
    console.log(newTextMutation);
    if (newImgList) {
        var countTargetWordsMutation = await checkTextForTarget(newTextMutation.join(" "));
        console.log(countTargetWordsMutation + "new one")
        if (countTargetWordsMutation == 0 && score < 40) {
            newImgList.forEach(function(element) {
                $(element).addClass("noblur");
            });
        }
    }
});
observer.observe(document, { childList: true, subtree: true });

var lastElementContext;
document.addEventListener('contextmenu', function(event) {
    lastElementContext = event.target;
}, true);

chrome.runtime.onMessage.addListener(
    function(message, sender, sendResponse) {
        switch (message.type) {
            case "getTarget":
                sendResponse(target);
                break;
            case "blurAll":
                blurAll();
                break;
            case "unblurAll":
                imageList.forEach(function(element) {
                    $(element).removeClass("blur");
                    $(element).addClass("noblur");
                });
                break;
            case "setBlur":
                chrome.storage.sync.get("blurVar", function(el) {
                    blurVar = el['blurVar'];
                    document.documentElement.style
                        .setProperty('--filterStrength', blur(blurVar));
                    console.log('blur')
                    console.log(blurVar);
                });
                imageList.forEach(function(element) {

                    let a = getComputedStyle(document.documentElement).getPropertyValue('--filterStrength');
                    console.log(a);
                });
                break;
            case "unblur":
                if (lastElementContext) {
                    $(lastElementContext).removeClass("blur");
                    $(lastElementContext).addClass("noblur");
                }
                // default:
                //     console.error("Unrecognised message: ", message);
        }
    }
);