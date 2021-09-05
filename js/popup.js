//TODO
//Tags not loading on first run
$(() => {
    chrome.storage.sync.get("blurValueAmount", (storage) => {
        if (storage['blurValueAmount']) {
            $('#blurRange').val(storage['blurValueAmount']);
        } else { $('#blurRange').val(2); }
    });

    let newTargetWord = document.querySelector('.addedWordArea'),
        button = document.querySelector('.addWordBtn'),
        tagify = new Tagify(newTargetWord, {
            pattern: /^.{0,30}$/,
            maxTags: 20,
        });

    let updateTargetWords = () => {
        let newTargetWords = tagify.value.map(wordElement => wordElement['value']);
        chrome.storage.sync.set({ targetWords: newTargetWords });
        chrome.tabs.query({}, (tabs) => {
            let message = { type: "updateTargetWords" };
            for (let i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, message);
            }
        });
    }

    tagify.on('edit', updateTargetWords)
          .on('remove', updateTargetWords)
          .on('add', updateTargetWords);

    button.addEventListener("click", onAddButtonClick)
    function onAddButtonClick () {
        tagify.addEmptyTag()
    }

    chrome.storage.sync.get('targetWords', (storage) => {
        tagify.addTags(storage['targetWords']);
    });

    $('#unblurBtn').click(() => {
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { type: "unblurAll" });
            });
    });

    $('#blurBtn').click(() => {
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { type: "blurAll" });
            });
    });
    
    $(document).on('input', '#blurRange', () => {
        let blurValueAmount = $('#blurRange').val();
        chrome.storage.sync.set({ "blurValueAmount": blurValueAmount });
        chrome.tabs.query({}, (tabs) => {
            let message = { type: "setBlurAmount" };
            for (let i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, message);
            }
        });
    });


});