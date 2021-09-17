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

    let arrorRightIcon = $('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-caret-right" viewBox="0 0 16 16"><path d="M6 12.796V3.204L11.481 8 6 12.796zm.659.753 5.48-4.796a1 1 0 0 0 0-1.506L6.66 2.451C6.011 1.885 5 2.345 5 3.204v9.592a1 1 0 0 0 1.659.753z"/></svg>')
    let arrorDownIcon = $('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-caret-down" viewBox="0 0 16 16"><path d="M3.204 5h9.592L8 10.481 3.204 5zm-.753.659 4.796 5.48a1 1 0 0 0 1.506 0l4.796-5.48c.566-.647.106-1.659-.753-1.659H3.204a1 1 0 0 0-.753 1.659z"/></svg>')
    let settingsIcon = $('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-gear" viewBox="0 0 16 16"><path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/></svg>')
    
    chrome.storage.sync.get('sportedWordsCollapsed', (storage) => {
        if (storage.sportedWordsCollapsed) {
            $('#btn-supported-words').html(arrorRightIcon)
        }
        else {
            $('#btn-supported-words').html(arrorDownIcon)
            $('#supported-words-area').removeClass('collapsed').addClass('collapse show')
        }
    })

    $('#btn-supported-words').click(() => {
        if ($('#btn-supported-words').prop('ariaExpanded') != 'true') {
            $('#btn-supported-words').html(arrorRightIcon)
            chrome.storage.sync.set({ 'sportedWordsCollapsed': true })
        }
        else {
            $('#btn-supported-words').html(arrorDownIcon)
            chrome.storage.sync.set({ 'sportedWordsCollapsed': false })
        }
    })
    
    /**
     * on first start this words will be used as example
    **/
    const defaultTarget = ['clown', 'mice', 'spider']
    chrome.storage.sync.get('targetWords', (storage) => {
        if (!storage['targetWords'])
            chrome.storage.sync.set({ 'targetWords': defaultTarget })
    })

})
