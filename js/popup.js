document.addEventListener('DOMContentLoaded', () => {
    let targetWords = []

    function renderTags() {
        const container = document.getElementById('tags-container')
        container.innerHTML = ''

        targetWords.forEach((word, index) => {
            const tag = document.createElement('span')
            tag.classList.add('tag')
            tag.textContent = word

            const removeBtn = document.createElement('button')
            removeBtn.classList.add('tag-remove')
            removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
            removeBtn.setAttribute('data-index', index)
            removeBtn.addEventListener('click', function() {
                removeTag(this.getAttribute('data-index'))
            })

            tag.appendChild(removeBtn)
            container.appendChild(tag)
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
        document.getElementById('word-input').value = ''
    }

    function removeTag(index) {
        targetWords.splice(index, 1)
        updateStorage()
        renderTags()
    }

    function updateStorage() {
        chrome.storage.sync.set({ targetWords: targetWords })
        // Notify all tabs that target words changed - they should re-analyze
        chrome.tabs.query({}, (tabs) => {
            for (let i = 0; i < tabs.length; ++i) {
                chrome.tabs.sendMessage(tabs[i].id, { type: 'targetWordsChanged' }, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            }
        })
    }

    chrome.storage.sync.get('targetWords', (storage) => {
        if (storage.targetWords) {
            targetWords = storage.targetWords
            renderTags()
        }
    })

    // Add button click
    document.getElementById('addTagBtn').addEventListener('click', () => {
        const word = document.getElementById('word-input').value
        addTag(word)
    })

    // Enter key to add
    document.getElementById('word-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const word = document.getElementById('word-input').value
            addTag(word)
        }
    })

    document.getElementById('unblurBtn').parentElement.addEventListener('click', () => {
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

    document.getElementById('blurBtn').parentElement.addEventListener('click', () => {
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

    document.getElementById('blurRange').addEventListener('input', () => {
        let blurValueAmount = document.getElementById('blurRange').value
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

    document.getElementById('blurRange').addEventListener('change', () => {
        let blurValueAmount = document.getElementById('blurRange').value
        chrome.storage.sync.set({ 'blurValueAmount': blurValueAmount })
    })

    document.getElementById('enabled-switch').addEventListener('click', () => {
        const enabledSwitch = document.getElementById('enabled-switch')
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'phobiaBlockerEnabled', value: enabledSwitch.checked}, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            })
        chrome.storage.sync.set({ 'phobiaBlockerEnabled': enabledSwitch.checked})
    })

    document.getElementById('blurIsAlwaysOn-switch').addEventListener('click', () => {
        const blurSwitch = document.getElementById('blurIsAlwaysOn-switch')
        chrome.tabs.query({ active: true, currentWindow: true },
            (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'blurIsAlwaysOn', value: blurSwitch.checked}, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            })
        chrome.storage.sync.set({ 'blurIsAlwaysOn': blurSwitch.checked})
    })

    chrome.storage.sync.get('blurValueAmount', (storage) => {
        let blurValue = storage.blurValueAmount || 50
        document.getElementById('blurRange').value = blurValue
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

    const arrorRightIcon = document.createRange().createContextualFragment('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-caret-right" viewBox="0 0 16 16"><path d="M6 12.796V3.204L11.481 8 6 12.796zm.659.753 5.48-4.796a1 1 0 0 0 0-1.506L6.66 2.451C6.011 1.885 5 2.345 5 3.204v9.592a1 1 0 0 0 1.659.753z"/></svg>').firstElementChild
    const arrorDownIcon = document.createRange().createContextualFragment('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-caret-down" viewBox="0 0 16 16"><path d="M3.204 5h9.592L8 10.481 3.204 5zm-.753.659 4.796 5.48a1 1 0 0 0 1.506 0l4.796-5.48c.566-.647.106-1.659-.753-1.659H3.204a1 1 0 0 0-.753 1.659z"/></svg>').firstElementChild

    chrome.storage.sync.get('supportedWordsCollapsed', (storage) => {
        const btnSupportedWords = document.getElementById('btn-supported-words')
        const supportedWordsArea = document.getElementById('supported-words-area')

        if (storage.supportedWordsCollapsed) {
            btnSupportedWords.innerHTML = ''
            btnSupportedWords.appendChild(arrorRightIcon.cloneNode(true))
        }
        else {
            btnSupportedWords.innerHTML = ''
            btnSupportedWords.appendChild(arrorDownIcon.cloneNode(true))
            supportedWordsArea.classList.remove('collapsed')
            supportedWordsArea.classList.add('collapse', 'show')
        }
    })

    document.getElementById('btn-supported-words').addEventListener('click', () => {
        const btnSupportedWords = document.getElementById('btn-supported-words')

        if (btnSupportedWords.getAttribute('aria-expanded') !== 'true') {
            btnSupportedWords.innerHTML = ''
            btnSupportedWords.appendChild(arrorRightIcon.cloneNode(true))
            chrome.storage.sync.set({ 'supportedWordsCollapsed': true })
        }
        else {
            btnSupportedWords.innerHTML = ''
            btnSupportedWords.appendChild(arrorDownIcon.cloneNode(true))
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
        // Only set defaults if targetWords is undefined (not just empty array)
        // Empty array [] is a valid user choice (no phobia words)
        if (storage.targetWords === undefined) {
            // Fallback initialization (background.js should handle this on install)
            chrome.storage.sync.set({ 'targetWords': defaultTarget })
            targetWords = defaultTarget
            renderTags()
        } else if (Array.isArray(storage.targetWords)) {
            // Use existing words from storage
            targetWords = storage.targetWords
            renderTags()
        }
        // Explicitly set toggle states (handles both true and false)
        document.getElementById('enabled-switch').checked = storage.phobiaBlockerEnabled !== false
        document.getElementById('blurIsAlwaysOn-switch').checked = storage.blurIsAlwaysOn === true
    })

    // Set keyboard shortcuts (same for all platforms)
    document.querySelector('#blur-shortcut i').textContent = 'Alt + Shift + B'
    document.querySelector('#unblur-shortcut i').textContent = 'Alt + Shift + U'
})
