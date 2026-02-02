$(() => {
    let targetWords = []

    function renderTags() {
        const container = $('#tags-container')
        container.empty()

        targetWords.forEach((word, index) => {
            const tag = $('<span>')
                .addClass('tag')
                .text(word)

            const removeBtn = $('<button>')
                .addClass('tag-remove')
                .html('<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>')
                .attr('data-index', index)
                .click(function() {
                    removeTag($(this).attr('data-index'))
                })

            tag.append(removeBtn)
            container.append(tag)
        })
    }

    function addTag(word) {
        word = word.trim()
        if (!word || word.length > 30) return
        if (targetWords.includes(word)) return
        if (targetWords.length >= 20) return

        targetWords.push(word)
        updateStorage()
        renderTags()
        $('#word-input').val('')
    }

    function removeTag(index) {
        targetWords.splice(index, 1)
        updateStorage()
        renderTags()
    }

    function updateStorage() {
        chrome.storage.sync.set({ targetWords: targetWords })
    }

    chrome.storage.sync.get('targetWords', (storage) => {
        if (storage.targetWords) {
            targetWords = storage.targetWords
            renderTags()
        }
    })

    // Add button click
    $('#addTagBtn').click(() => {
        const word = $('#word-input').val()
        addTag(word)
    })

    // Enter key to add
    $('#word-input').keypress((e) => {
        if (e.which === 13) {
            const word = $('#word-input').val()
            addTag(word)
        }
    })

    $('#unblurBtn').parent().click(() => {
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                if (tabs && tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { type: 'unblurAll' }, () => {
                        if (chrome.runtime.lastError) {
                            // Silently ignore - content script not available on this page
                        }
                    })
                }
            })
    })

    $('#blurBtn').parent().click(() => {
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                if (tabs && tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { type: 'blurAll' }, () => {
                        if (chrome.runtime.lastError) {
                            // Silently ignore - content script not available on this page
                        }
                    })
                }
            })
    })

    $(document).on('input', '#blurRange', () => {
        let blurValueAmount = $('#blurRange').val()
        chrome.tabs.query({}, (tabs) => {
            let message = { type: 'setBlurAmount', value: blurValueAmount }
            for (let i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, message, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            }
        })
    })

    $(document).on('change', '#blurRange', () => {
        let blurValueAmount = $('#blurRange').val()
        chrome.storage.sync.set({ 'blurValueAmount': blurValueAmount })
    })

    $('#enabled-switch').click(() => {
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

    $('#blurIsAlwaysOn-switch').click(() => {
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
        let blurValue = storage.blurValueAmount || 50
        $('#blurRange').val(blurValue)
        // Sync blur amount with all tabs on popup open
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'setBlurAmount', value: blurValue }, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            }
        })
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
        if (!storage.targetWords) {
            chrome.storage.sync.set({ 'targetWords': defaultTarget })
            targetWords = defaultTarget
            renderTags()
        }
        // Explicitly set toggle states (handles both true and false)
        $('#enabled-switch').prop('checked', storage.phobiaBlockerEnabled !== false)
        $('#blurIsAlwaysOn-switch').prop('checked', storage.blurIsAlwaysOn === true)
    })

    // Set keyboard shortcuts (same for all platforms)
    $('#blur-shortcut i').text('Alt + Shift + B')
    $('#unblur-shortcut i').text('Alt + Shift + U')
})
