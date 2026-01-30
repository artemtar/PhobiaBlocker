$(() => {

    let newTargetWord = document.querySelector('.addedWordArea'),
        tagify = new Tagify(newTargetWord, {
            pattern: /^.{0,30}$/,
            maxTags: 20,
        })

    $('#addTagBtn').click(() => {
        tagify.addEmptyTag()
    })

    $('#unblurBtn').click(() => {
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'unblurAll' }, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            })
    })

    $('#blurBtn').click(() => {
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'blurAll' }, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            })
    })

    let addButton = $('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="#00447c" class="bi bi-plus-circle" viewBox="0 0 16 16"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>')
    $('#addTagBtn').html(addButton)

    chrome.storage.sync.get('targetWords', (storage) => {
        tagify.addTags(storage['targetWords'])
    })


    let updateTargetWords = () => {
        let newTargetWords = tagify.value.map(wordElement => wordElement['value'])
        chrome.storage.sync.set({ targetWords: newTargetWords })
    }

    tagify.on('edit', updateTargetWords)
        .on('remove', updateTargetWords)
        .on('add', updateTargetWords)

    $(document).on('input', '#blurRange', () => {
        let blurValueAmount = $('#blurRange').val()
        chrome.storage.sync.set({ 'blurValueAmount': blurValueAmount })
        chrome.tabs.query({}, (tabs) => {
            let message = { type: 'setBlurAmount' }
            for (let i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, message, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            }
        })
    })

    $('#enabled-switch').click('changed', () => {
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'phobiaBlockerEnabled', value: $('#enabled-switch').prop('checked')}, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            })
        chrome.storage.sync.set({ 'phobiaBlockerEnabled': $('#enabled-switch').prop('checked')})
    })

    $('#blurIsAlwaysOn-switch').click('changed', () => {
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'blurIsAlwaysOn', value: $('#blurIsAlwaysOn-switch').prop('checked')}, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            })
        chrome.storage.sync.set({ 'blurIsAlwaysOn': $('#blurIsAlwaysOn-switch').prop('checked')})
    })
    
    chrome.storage.sync.get('blurValueAmount', (storage) => {
        if (storage.blurValueAmount) {
            $('#blurRange').val(storage.blurValueAmount)
        } else { $('#blurRange').val(3) }
    })

    let arrorRightIcon = $('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-caret-right" viewBox="0 0 16 16"><path d="M6 12.796V3.204L11.481 8 6 12.796zm.659.753 5.48-4.796a1 1 0 0 0 0-1.506L6.66 2.451C6.011 1.885 5 2.345 5 3.204v9.592a1 1 0 0 0 1.659.753z"/></svg>')
    let arrorDownIcon = $('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-caret-down" viewBox="0 0 16 16"><path d="M3.204 5h9.592L8 10.481 3.204 5zm-.753.659 4.796 5.48a1 1 0 0 0 1.506 0l4.796-5.48c.566-.647.106-1.659-.753-1.659H3.204a1 1 0 0 0-.753 1.659z"/></svg>')
    
    chrome.storage.sync.get('supportedWordsCollapsed', (storage) => {
        if (storage.supportedWordsCollapsed) {
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
            chrome.storage.sync.set({ 'supportedWordsCollapsed': true })
        }
        else {
            $('#btn-supported-words').html(arrorDownIcon)
            chrome.storage.sync.set({ 'supportedWordsCollapsed': false })
        }
    })
    
    /**
     * on first start these words will be used as example
    **/
    const defaultTarget = ['clown', 'mice', 'spider']

    chrome.storage.sync.get([
        'targetWords',
        'phobiaBlockerEnabled',
        'blurIsAlwaysOn'
    ], (storage) => {
        if (!storage.targetWords)
            chrome.storage.sync.set({ 'targetWords': defaultTarget })
        if (storage.phobiaBlockerEnabled)
            $('#enabled-switch').prop('checked', storage.phobiaBlockerEnabled)
        if (storage.blurIsAlwaysOn)
            $('#blurIsAlwaysOn-switch').prop('checked', storage.blurIsAlwaysOn)
    })
})
