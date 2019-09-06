const tokenizer = new natural.WordTokenizer();
// target = ["user", "have", 'jump'];
const target = ["rodent", "mice", "rat", "beaver", "squirrel"];
var imageList = [];
var score = 0;
const myWorker = new Worker("textAnalizer.js");
myWorker.postMessage("hello");

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


//To-DO:
//run on images that are bigger than 10x10
//analyze title
//new element is analyzed, not whole body
//store targets localy
//interface for targets
//concurency for analysis

function checkIfImg(toCheck) {
    let images = toCheck.find('img');
    let tempImgList = [];
    for (let image of images) {
        let imageSource = $(image).attr('src');
        tempImgList.push(image);
        if (!imageList.includes(image)) {
            imageList.push(image);
            console.log("pushed: " + imageSource)
        }
    }
    return tempImgList;
};

checkIfImg($(document));

var text = $('body').text();
var title = $('title').text();

var checkTitle = analizeText(title, target);
if (checkTitle != 0) {
    updateScore(40);
}
var countTargetWords = analizeText(text, target);
if (countTargetWords == 0 && score < 40) {
    console.log(imageList);
    imageList.forEach(function(element) {
        $(element).addClass("noblur")
    });
}
console.log(countTargetWords + " count ocurences")

var observer = new MutationObserver(function(mutations) {
    var newTextMutation = [];
    var newImgList = [];
    mutations.forEach(function(mutation) {
        newImgList.concat(checkIfImg($(mutation.target)));
        newTextMutation.push($(mutation.target).text());
    });
    console.log("new imgList: ");
    console.log(newImgList);
    var countTargetWordsMutation = analizeText(newTextMutation.join(" "), target);
    console.log(countTargetWordsMutation + "newone")
    if (countTargetWordsMutation == 0 && score < 40) {
        newImgList.forEach(function(element) {
            $(element).addClass("noblur");
        });
    }
    //some imges are slow to load, that might help if no target detected
    // if (countTargetWordsMutation == 0 && score == 0) {
    //     imageList.forEach(function(element) {
    //         $(element).addClass("noblur");
    //     });
    // }
});
observer.observe(document, { childList: true, subtree: true });

var lastElementContext;
document.addEventListener('contextmenu', function(event) {
    lastElementContext = event.target;
}, true);
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (lastElementContext && message == "unblur") {
        $(lastElementContext).removeClass("blur");
        $(lastElementContext).addClass("noblur");
    }
});

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message == "unblurAll") {
        imageList.forEach(function(element) {
            $(element).removeClass("blur");
            $(element).addClass("noblur");
        });
    }
});


chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message == "blurAll") {
        blurAll();
    }
});