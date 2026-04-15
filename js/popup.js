const DEFAULT_BLUR_SLIDER_VALUE = 50 // Matches js.js DEFAULT_BLUR_SLIDER_VALUE

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

    document.getElementById('unblurBtn').addEventListener('click', () => {
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

    document.getElementById('blurBtn').addEventListener('click', () => {
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
        let blurValue = storage.blurValueAmount ?? DEFAULT_BLUR_SLIDER_VALUE
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

    chrome.storage.sync.get('detectedWordsCollapsed', (storage) => {
        const btnDetectedWords = document.getElementById('btn-detected-words')
        const detectedWordsArea = document.getElementById('detected-words-area')

        if (storage.detectedWordsCollapsed) {
            btnDetectedWords.innerHTML = ''
            btnDetectedWords.appendChild(arrorRightIcon.cloneNode(true))
        }
        else {
            btnDetectedWords.innerHTML = ''
            btnDetectedWords.appendChild(arrorDownIcon.cloneNode(true))
            detectedWordsArea.classList.remove('collapsed')
            detectedWordsArea.classList.add('collapse', 'show')
        }
    })

    document.getElementById('btn-detected-words').addEventListener('click', () => {
        const btnDetectedWords = document.getElementById('btn-detected-words')

        if (btnDetectedWords.getAttribute('aria-expanded') !== 'true') {
            btnDetectedWords.innerHTML = ''
            btnDetectedWords.appendChild(arrorRightIcon.cloneNode(true))
            chrome.storage.sync.set({ 'detectedWordsCollapsed': true })
        }
        else {
            btnDetectedWords.innerHTML = ''
            btnDetectedWords.appendChild(arrorDownIcon.cloneNode(true))
            chrome.storage.sync.set({ 'detectedWordsCollapsed': false })
        }
    })

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

    // Settings button click handler
    document.getElementById('open-settings-btn').addEventListener('click', () => {
        chrome.runtime.openOptionsPage()
    })

    // Query active tab for which words triggered blur on this page
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]) return
        chrome.tabs.sendMessage(tabs[0].id, { type: 'getTriggeredWords' }, (response) => {
            const list = document.getElementById('detected-words-list')
            list.innerHTML = ''
            if (chrome.runtime.lastError || !response || !response.words.length) {
                const empty = document.createElement('span')
                empty.className = 'detected-words-empty'
                empty.textContent = 'Nothing found on this page'
                list.appendChild(empty)
                return
            }
            response.words.forEach(({ word, count }) => {
                const row = document.createElement('div')
                row.className = 'detected-word-row'
                const name = document.createElement('span')
                name.className = 'detected-word-name'
                name.textContent = word
                const cnt = document.createElement('span')
                cnt.className = 'detected-word-count'
                cnt.textContent = `${count} item${count !== 1 ? 's' : ''}`
                row.appendChild(name)
                row.appendChild(cnt)
                list.appendChild(row)
            })
        })
    })

    // Tooltip functionality
    const tooltipElement = document.createElement('div')
    tooltipElement.className = 'tooltip'
    document.body.appendChild(tooltipElement)

    document.querySelectorAll('.info-icon').forEach(icon => {
        icon.addEventListener('mouseenter', (e) => {
            const target = e.currentTarget
            const text = target.getAttribute('data-tooltip')
            if (!text) return

            tooltipElement.textContent = text
            tooltipElement.classList.add('show')

            // Position tooltip
            const rect = target.getBoundingClientRect()
            const tooltipRect = tooltipElement.getBoundingClientRect()

            let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2)
            let top = rect.bottom + 8

            // Keep tooltip within viewport
            if (left < 10) left = 10
            if (left + tooltipRect.width > window.innerWidth - 10) {
                left = window.innerWidth - tooltipRect.width - 10
            }

            tooltipElement.style.left = left + 'px'
            tooltipElement.style.top = top + 'px'
        })

        icon.addEventListener('mouseleave', () => {
            tooltipElement.classList.remove('show')
        })
    })
})
