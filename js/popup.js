const DEFAULT_BLUR_SLIDER_VALUE = 50 // Matches js.js DEFAULT_BLUR_SLIDER_VALUE
const ARROW_RIGHT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-caret-right" viewBox="0 0 16 16"><path d="M6 12.796V3.204L11.481 8 6 12.796zm.659.753 5.48-4.796a1 1 0 0 0 0-1.506L6.66 2.451C6.011 1.885 5 2.345 5 3.204v9.592a1 1 0 0 0 1.659.753z"/></svg>'
const ARROW_DOWN_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-caret-down" viewBox="0 0 16 16"><path d="M3.204 5h9.592L8 10.481 3.204 5zm-.753.659 4.796 5.48a1 1 0 0 0 1.506 0l4.796-5.48c.566-.647.106-1.659-.753-1.659H3.204a1 1 0 0 0-.753 1.659z"/></svg>'

document.addEventListener('DOMContentLoaded', () => {
    let targetWords = []
    let tooltipElement = null

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
        chrome.tabs.query({}, (tabs) => {
            for (let i = 0; i < tabs.length; ++i) {
                try {
                    chrome.tabs.sendMessage(tabs[i].id, { type: 'targetWordsChanged' })
                } catch (e) {
                    // Tab closed - ignore
                }
            }
        })
    }

    function initIcons() {
        const btnDetectedWords = document.getElementById('btn-detected-words')
        const detectedWordsArea = document.getElementById('detected-words-area')
        const btnSupportedWords = document.getElementById('btn-supported-words')
        const supportedWordsArea = document.getElementById('supported-words-area')

        btnDetectedWords.innerHTML = ARROW_RIGHT_ICON
        btnSupportedWords.innerHTML = ARROW_RIGHT_ICON

        return { btnDetectedWords, detectedWordsArea, btnSupportedWords, supportedWordsArea }
    }

    function toggleDetectedWords(collapsed) {
        const btnDetectedWords = document.getElementById('btn-detected-words')
        const detectedWordsArea = document.getElementById('detected-words-area')

        if (collapsed) {
            btnDetectedWords.innerHTML = ARROW_RIGHT_ICON
            detectedWordsArea.classList.remove('show')
        } else {
            btnDetectedWords.innerHTML = ARROW_DOWN_ICON
            detectedWordsArea.classList.remove('collapsed')
            detectedWordsArea.classList.add('collapse', 'show')
        }
    }

    function toggleSupportedWords(collapsed) {
        const btnSupportedWords = document.getElementById('btn-supported-words')
        const supportedWordsArea = document.getElementById('supported-words-area')

        if (collapsed) {
            btnSupportedWords.innerHTML = ARROW_RIGHT_ICON
            supportedWordsArea.classList.remove('show')
        } else {
            btnSupportedWords.innerHTML = ARROW_DOWN_ICON
            supportedWordsArea.classList.remove('collapsed')
            supportedWordsArea.classList.add('collapse', 'show')
        }
    }

    function createTooltip() {
        tooltipElement = document.createElement('div')
        tooltipElement.className = 'tooltip'
        document.body.appendChild(tooltipElement)
    }

    function setupTooltip() {
        document.querySelectorAll('.info-icon').forEach(icon => {
            icon.addEventListener('mouseenter', (e) => {
                const target = e.currentTarget
                const text = target.getAttribute('data-tooltip')
                if (!text || !tooltipElement) return

                tooltipElement.textContent = text
                tooltipElement.classList.add('show')

                const rect = target.getBoundingClientRect()
                const tooltipRect = tooltipElement.getBoundingClientRect()

                let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2)
                let top = rect.bottom + 8

                if (left < 10) left = 10
                if (left + tooltipRect.width > window.innerWidth - 10) {
                    left = window.innerWidth - tooltipRect.width - 10
                }

                tooltipElement.style.left = left + 'px'
                tooltipElement.style.top = top + 'px'
            })

            icon.addEventListener('mouseleave', () => {
                if (tooltipElement) tooltipElement.classList.remove('show')
            })
        })
    }

    function setupEventListeners() {
        document.getElementById('addTagBtn').addEventListener('click', () => {
            const word = document.getElementById('word-input').value
            addTag(word)
        })

        document.getElementById('word-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const word = document.getElementById('word-input').value
                addTag(word)
            }
        })

        document.getElementById('unblurBtn').addEventListener('click', () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs && tabs[0]) {
                    try {
                        chrome.tabs.sendMessage(tabs[0].id, { type: 'unblurAll' })
                    } catch (e) {}
                }
            })
        })

        document.getElementById('blurBtn').addEventListener('click', () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs && tabs[0]) {
                    try {
                        chrome.tabs.sendMessage(tabs[0].id, { type: 'blurAll' })
                    } catch (e) {}
                }
            })
        })

        document.getElementById('blurRange').addEventListener('input', () => {
            let blurValueAmount = document.getElementById('blurRange').value
            chrome.tabs.query({}, (tabs) => {
                let message = { type: 'setBlurAmount', value: blurValueAmount }
                for (let i = 0; i < tabs.length; ++i) {
                    try {
                        chrome.tabs.sendMessage(tabs[i].id, message)
                    } catch (e) {}
                }
            })
        })

        document.getElementById('blurRange').addEventListener('change', () => {
            let blurValueAmount = document.getElementById('blurRange').value
            chrome.storage.sync.set({ 'blurValueAmount': blurValueAmount })
        })

        document.getElementById('enabled-switch').addEventListener('click', () => {
            const enabledSwitch = document.getElementById('enabled-switch')
            chrome.tabs.query({}, (tabs) => {
                for (let i = 0; i < tabs.length; ++i) {
                    try {
                        chrome.tabs.sendMessage(tabs[i].id, { type: 'phobiaBlockerEnabled', value: enabledSwitch.checked })
                    } catch (e) {}
                }
            })
            chrome.storage.sync.set({ 'phobiaBlockerEnabled': enabledSwitch.checked })
        })

        document.getElementById('blurIsAlwaysOn-switch').addEventListener('click', () => {
            const blurSwitch = document.getElementById('blurIsAlwaysOn-switch')
            chrome.tabs.query({}, (tabs) => {
                for (let i = 0; i < tabs.length; ++i) {
                    try {
                        chrome.tabs.sendMessage(tabs[i].id, { type: 'blurIsAlwaysOn', value: blurSwitch.checked })
                    } catch (e) {}
                }
            })
            chrome.storage.sync.set({ 'blurIsAlwaysOn': blurSwitch.checked })
        })

        document.getElementById('btn-detected-words').addEventListener('click', () => {
            const btn = document.getElementById('btn-detected-words')
            const isExpanded = btn.getAttribute('aria-expanded') === 'true'
            toggleDetectedWords(isExpanded)
            chrome.storage.sync.set({ 'detectedWordsCollapsed': isExpanded })
        })

        document.getElementById('btn-supported-words').addEventListener('click', () => {
            const btn = document.getElementById('btn-supported-words')
            const isExpanded = btn.getAttribute('aria-expanded') === 'true'
            toggleSupportedWords(isExpanded)
            chrome.storage.sync.set({ 'supportedWordsCollapsed': isExpanded })
        })

        document.getElementById('open-settings-btn').addEventListener('click', () => {
            chrome.runtime.openOptionsPage()
        })
    }

    function queryActiveTab() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || !tabs[0]) return
            try {
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
                        row.appendChild(cnt)
                        row.appendChild(name)
                        list.appendChild(row)
                    })
                })
            } catch (e) {}
        })
    }

    const defaultTarget = ['clown', 'mice', 'spider']

    chrome.storage.sync.get([
        'targetWords',
        'phobiaBlockerEnabled',
        'blurIsAlwaysOn',
        'blurValueAmount',
        'detectedWordsCollapsed',
        'supportedWordsCollapsed'
    ], (storage) => {
        if (chrome.runtime.lastError) {
            console.error('PhobiaBlocker: Storage error', chrome.runtime.lastError)
            return
        }

        if (storage.targetWords === undefined) {
            chrome.storage.sync.set({ 'targetWords': defaultTarget })
            targetWords = defaultTarget
        } else if (Array.isArray(storage.targetWords)) {
            targetWords = storage.targetWords
        }
        renderTags()

        document.getElementById('enabled-switch').checked = storage.phobiaBlockerEnabled !== false
        document.getElementById('blurIsAlwaysOn-switch').checked = storage.blurIsAlwaysOn === true

        let blurValue = storage.blurValueAmount ?? DEFAULT_BLUR_SLIDER_VALUE
        document.getElementById('blurRange').value = blurValue
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs[0]) {
                try {
                    chrome.tabs.sendMessage(tabs[0].id, { type: 'setBlurAmount', value: blurValue })
                } catch (e) {}
            }
        })

        initIcons()
        toggleDetectedWords(storage.detectedWordsCollapsed)
        toggleSupportedWords(storage.supportedWordsCollapsed)

        createTooltip()
        setupTooltip()
        setupEventListeners()
        queryActiveTab()
    })
})
