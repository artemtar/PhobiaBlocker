$(() => {

    chrome.storage.sync.get('blurValueAmount', (storage) => {
        if (storage['blurValueAmount']) {
            $('#blurRange').val(storage['blurValueAmount'])
        } else { $('#blurRange').val(3) }
    })

    let newTargetWord = document.querySelector('.addedWordArea'),
        tagify = new Tagify(newTargetWord, {
            pattern: /^.{0,30}$/,
            maxTags: 20,
        })

    let updateTargetWords = () => {
        let newTargetWords = tagify.value.map(wordElement => wordElement['value'])
        chrome.storage.sync.set({ targetWords: newTargetWords })
    }

    tagify.on('edit', updateTargetWords)
        .on('remove', updateTargetWords)
        .on('add', updateTargetWords)

    $('#addTagBtn').click(() => {
        tagify.addEmptyTag()
    })

    chrome.storage.sync.get('targetWords', (storage) => {
        tagify.addTags(storage['targetWords'])
    })

    $('#unblurBtn').click(() => {
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'unblurAll' })
            })
    })

    $('#blurBtn').click(() => {
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'blurAll' })
            })
    })

    $(document).on('input', '#blurRange', () => {
        let blurValueAmount = $('#blurRange').val()
        chrome.storage.sync.set({ 'blurValueAmount': blurValueAmount })
        chrome.tabs.query({}, (tabs) => {
            let message = { type: 'setBlurAmount' }
            for (let i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, message)
            }
        })
    })

    $('#btn-supported-words').click(function () {
        if (this.innerHTML == '\u25BA') {
            $('#div-supported-words').css({
                'display': 'block'
            })
            this.innerHTML = '&#x25bc;'
        } else if (this.innerHTML == '\u25BC') {
            $('#div-supported-words').css({
                'display': 'none'
            })
            this.innerHTML = '&#x25ba;'
        }
    })

    // on first start this words will be used as example
    const defaultTarget = ['clown', 'mice', 'spider']
    chrome.storage.sync.get('targetWords', (storage) => {
        if (!storage['targetWords'])
            chrome.storage.sync.set({ 'targetWords': defaultTarget })
    })
})