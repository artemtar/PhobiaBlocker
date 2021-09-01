const tokenizer = new natural.WordTokenizer();
var target = [];
var lastElementContext;

var blurAll = function() {
    imageList.forEach(function(element) {
        $(element).removeClass("noblur");
        $(element).addClass("blur");
    });
};
var updateScore = function(val) {
    score += parseInt(val);
    if (score >= 40) {
        blurAll();
    }
};

(async() => {
    await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'retriveTarget' }, function(response) {
            if (response) {
                resolve();
            } else {
                reject('Something wrong');
            }
        });
    });
    await new Promise((resolve, reject) => {
        chrome.storage.sync.get('target', function(el) {
            if (el) {
                target = el['target'];
                resolve();
            } else {
                reject('Something wrong');
            }
        });
    });
    // await new Promise((resolve, reject) => {
    //   updateBlur();
    // });
    main();
})()

// (function(){
//   retriveTarget().then(console.log("too long"));
// })();

var imageList = [];
var score = 0;
var inAnalizes = 0;

function main() {
    var analizeText = function(text, target) {
        var tokens = tokenizer.tokenize(text);
        var cleanWords = tokens
            .map(word => word.toLowerCase())
            .filter(word => word.length > 2 && word.length < 16)
            .filter(word => !stopWords.includes(word));
        var uniqueWords = [...new Set(cleanWords)];
        var createDictToAnalize = function(target, words) {
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
        wordsToCheck = nlp(createDictToAnalize(target, uniqueWords))
            .normalize()
            .nouns()
            .out("array");
        targetWords = nlp(target)
            .normalize()
            .out("array");

        const intersection = wordsToCheck
            .filter(element => targetWords.includes(element))
            .filter(n => n);
        return intersection.length;
    };

    function checkIfImg(toCheck) {
        let images = toCheck.find("img");
        let backgroud = toCheck.find("background-image");

        var img_collect_massiv = []; //array for element page 
        for (var childItem in toCheck.childNodes)
            if (toCheck.childNodes[childItem].style['background-image'] != null)
                img_collect_massiv.push(toCheck.childNodes[childItem]);


        if (img_collect_massiv.length > 0) {}


        // if (backgroud){
        //     console.log('I am backgr');
        //     console.log(backgroud);
        //     console.log('ture?');
        //     for (let b of backgroud){
        //         console.log(b)
        //     }
        // }
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

    checkIfImg($(document));

    function promiseAnalizer(t, tar) {
        inAnalizes += 1;
        return new Promise(function(resolve) {
            resolve(analizeText(t, tar));
        });
    }

    async function checkTextForTarget(text) {
        let result = await promiseAnalizer(text, target);
        inAnalizes -= 1;
        return result * 10;
    }

    var checkLandingPage = (async function() {
        var text = $("body").text();
        var title = $("title").text();

        var checkTitle = await checkTextForTarget(title, target);
        if (checkTitle != 0) {
            updateScore(40);
        }
        var countTargetWords = await checkTextForTarget(text);
        if (countTargetWords == 0 && score < 40) {
            console.log(imageList);
            imageList.forEach(function(element) {
                $(element).addClass("noblur");
            });
        }
    })();

    var observer = new MutationObserver(async function(mutations) {
        var newTextMutation = [];
        var newImgList = [];
        mutations.forEach(function(mutation) {
            newImgList = newImgList.concat(checkIfImg($(mutation.target)));
            newTextMutation.push($(mutation.target).text());
        });
        if (newImgList) {
            var countTargetWordsMutation = await checkTextForTarget(
                newTextMutation.join(" ")
            );
            if (countTargetWordsMutation == 0 && score < 40) {
                newImgList.forEach(function(element) {
                    $(element).addClass("noblur");
                });
            }
        }
    });
    observer.observe(document, { childList: true, subtree: true });

    document.addEventListener(
        "contextmenu",
        function(event) {
            lastElementContext = event.target;
        },
        true
    );
};

function updateBlur() {
    chrome.storage.sync.get("blurValueAmount", function(el) {
        blurValueAmount = el["blurValueAmount"];
        if (blurValueAmount) {
            document.documentElement.style.setProperty(
                "--blurValueAmount",
                6 * blurValueAmount + "px"
            );
        } else {
            document.documentElement.style.setProperty("--blurValueAmount", 12 + "px");
        }
    });
}

function updateTarget() {
    chrome.storage.sync.get('target', function(el) {
        if (el) {
            target = el['target'];
            console.log(
                'new taerget'
            );
            console.log(target);
        } else {
            reject('Something wrong');
        }
    });
}

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
            imageList.forEach(function(element) {
                $(element).removeClass("blur");
                $(element).addClass("noblur");
            });
            break;
        case "setBlur":
            updateBlur();
            imageList.forEach(function(element) {
                // let a = getComputedStyle(document.documentElement).getPropertyValue('--filterStrength');
                // console.log(a);
            });
            break;
        case "unblur":
            if (lastElementContext) {
                $(lastElementContext).removeClass("blur");
                $(lastElementContext).addClass("noblur");
            };
            break;
        case 'updateTarget':
            break;
            // default:
            //     console.error("Unrecognised message: ", message);
    }
});