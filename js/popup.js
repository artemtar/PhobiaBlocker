const popupPolicy = globalThis.PhobiaBlockerPolicy
const popupStorage = globalThis.PhobiaBlockerStorage

if (!popupPolicy || !popupStorage) {
    throw new Error('Shared policy and storage scripts must load before popup.js')
}

const POPUP_KEYS = popupPolicy.STORAGE_KEYS
const ARROW_RIGHT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-caret-right" viewBox="0 0 16 16"><path d="M6 12.796V3.204L11.481 8 6 12.796zm.659.753 5.48-4.796a1 1 0 0 0 0-1.506L6.66 2.451C6.011 1.885 5 2.345 5 3.204v9.592a1 1 0 0 0 1.659.753z"/></svg>'
const ARROW_DOWN_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-caret-down" viewBox="0 0 16 16"><path d="M3.204 5h9.592L8 10.481 3.204 5zm-.753.659 4.796 5.48a1 1 0 0 0 1.506 0l4.796-5.48c.566-.647.106-1.659-.753-1.659H3.204a1 1 0 0 0-.753 1.659z"/></svg>'

document.addEventListener('DOMContentLoaded', () => {
    void initializePopup()
})

let popupSettings = {}
let targetWords = []
let tooltipElement = null
let targetWordsWritePending = false

function queryTabs(query) {
    return new Promise(resolve => chrome.tabs.query(query, resolve))
}

function sendTabMessage(tabId, message, options) {
    return new Promise(resolve => {
        const callback = response => {
            const error = chrome.runtime.lastError
            resolve(error ? null : response)
        }
        if (options) chrome.tabs.sendMessage(tabId, message, options, callback)
        else chrome.tabs.sendMessage(tabId, message, callback)
    })
}

function showWordError(message) {
    const errorElement = document.getElementById('word-error')
    errorElement.textContent = message
    errorElement.hidden = !message
}

function updateTriggerCountBadge() {
    const badge = document.getElementById('trigger-count-badge')
    if (targetWords.length === 0) {
        badge.style.display = 'none'
        return
    }
    badge.textContent = `(${targetWords.length})`
    badge.style.display = ''
}

function renderTags() {
    const container = document.getElementById('tags-container')
    container.innerHTML = ''

    targetWords.forEach((word, index) => {
        const validation = popupPolicy.validateTargetWord(word)
        const tag = document.createElement('span')
        tag.className = validation.valid ? 'tag' : 'tag tag-invalid'
        tag.title = validation.valid ? '' : `Invalid trigger: ${validation.reason}`
        tag.appendChild(document.createTextNode(String(word)))

        const removeButton = document.createElement('button')
        removeButton.className = 'tag-remove'
        removeButton.disabled = targetWordsWritePending
        removeButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
        removeButton.title = `Remove ${word}`
        removeButton.addEventListener('click', () => void removeTag(index))

        tag.appendChild(removeButton)
        container.appendChild(tag)
    })

    updateTriggerCountBadge()
}

async function addTag(rawWord) {
    if (targetWordsWritePending) return
    showWordError('')
    const validation = popupPolicy.validateTargetWord(rawWord)
    if (!validation.valid) {
        showWordError(validation.reason)
        return
    }

    if (targetWords.length >= 20) {
        showWordError('You can store up to 20 trigger words.')
        return
    }

    const duplicate = targetWords.some(word => (
        popupPolicy.validateTargetWord(word).normalized === validation.normalized
    ))
    if (duplicate) {
        showWordError('That trigger word is already in your list.')
        return
    }

    const candidate = [...targetWords, validation.normalized]
    const button = document.getElementById('addTagBtn')
    const input = document.getElementById('word-input')
    targetWordsWritePending = true
    button.disabled = true
    input.disabled = true
    renderTags()

    try {
        await popupStorage.set({ targetWords: candidate })
        targetWords = candidate
        popupSettings.targetWords = [...candidate]
        input.value = ''
        renderTags()
    } catch (error) {
        showWordError('Could not save this trigger word. Your list was not changed.')
        console.error('PhobiaBlocker: failed to save target words', error)
    } finally {
        targetWordsWritePending = false
        button.disabled = false
        input.disabled = false
        renderTags()
    }
}

async function removeTag(index) {
    if (targetWordsWritePending) return
    showWordError('')
    const candidate = targetWords.filter((word, wordIndex) => wordIndex !== index)
    targetWordsWritePending = true
    renderTags()
    try {
        await popupStorage.set({ targetWords: candidate })
        targetWords = candidate
        popupSettings.targetWords = [...candidate]
        renderTags()
    } catch (error) {
        showWordError('Could not remove this trigger word. Your list was not changed.')
        console.error('PhobiaBlocker: failed to update target words', error)
    } finally {
        targetWordsWritePending = false
        renderTags()
    }
}

function updateDetectedCountBadge(count) {
    const badge = document.getElementById('detected-count-badge')
    if (!count) {
        badge.style.display = 'none'
        return
    }
    badge.textContent = `(${count})`
    badge.style.display = ''
}

function updateBlurValueDisplay(value) {
    const display = document.getElementById('blurRangeValue')
    display.textContent = `${value}%`

    // The stylesheet owns the track colours; only the fill position comes from
    // here, so the slider reads correctly in both light and dark mode.
    const slider = document.getElementById('blurRange')
    if (!slider) return
    const max = parseInt(slider.max, 10) || 100
    slider.style.setProperty('--pb-progress', `${(Number(value) / max) * 100}%`)
}

function showButtonSuccess(button) {
    const label = button.querySelector('span')
    const originalText = label ? label.textContent : ''
    button.classList.add('btn-success')
    if (label) label.textContent = 'Done!'
    setTimeout(() => {
        button.classList.remove('btn-success')
        if (label) label.textContent = originalText
    }, 1500)
}

function setStatus(className, text) {
    const bar = document.getElementById('site-status-bar')
    bar.className = `site-status-bar ${className}`
    bar.textContent = text
}

async function updateSiteStatus() {
    const tabs = await queryTabs({ active: true, currentWindow: true })
    const url = tabs?.[0]?.url
    if (!url || /^(chrome|chrome-extension|about):/.test(url)) {
        setStatus('status-unsupported', 'Unsupported page')
        return
    }

    let settings
    try {
        settings = await popupStorage.getWithDefaults(Object.keys(popupPolicy.DEFAULTS))
    } catch (error) {
        setStatus('status-blacklisted', 'Settings unavailable — protection stays blurred')
        console.error('PhobiaBlocker: popup status read failed', error)
        return
    }

    popupSettings = { ...popupSettings, ...settings }
    const isBlacklisted = settings.blacklistedSites.some(rule => popupPolicy.matchesSiteRule(url, rule))
    const isWhitelisted = settings.whitelistedSites.some(rule => popupPolicy.matchesSiteRule(url, rule))
    const mode = popupPolicy.resolveProtectionMode(settings, url)
    const hasTriggers = popupPolicy.normalizeTargetWords(settings.targetWords).valid.length > 0
    if (isBlacklisted) {
        setStatus('status-blacklisted', 'Blacklisted — always blurred')
    } else if (isWhitelisted) {
        setStatus('status-whitelisted', 'Whitelisted — auto protection paused')
    } else if (mode === popupPolicy.PROTECTION_MODE.DISABLED) {
        setStatus('status-disabled', 'Protection off')
    } else if (mode === popupPolicy.PROTECTION_MODE.ANALYZE && !hasTriggers) {
        // Without triggers there is nothing to match, so nothing gets blurred.
        // Say so plainly rather than claiming protection is active.
        setStatus('status-disabled', 'No trigger words — nothing will be blurred')
    } else if (mode === popupPolicy.PROTECTION_MODE.ALWAYS_BLUR) {
        setStatus('status-active', 'Protection active — always blurred')
    } else {
        setStatus('status-active', 'Protection active')
    }
}

function initIcons() {
    document.getElementById('btn-detected-words').innerHTML = ARROW_RIGHT_ICON
    document.getElementById('btn-supported-words').innerHTML = ARROW_RIGHT_ICON
}

function toggleDetectedWords(collapsed) {
    const button = document.getElementById('btn-detected-words')
    const area = document.getElementById('detected-words-area')
    button.innerHTML = collapsed ? ARROW_RIGHT_ICON : ARROW_DOWN_ICON
    area.classList.toggle('show', !collapsed)
    area.classList.add('collapse')
}

function toggleSupportedWords(collapsed) {
    const button = document.getElementById('btn-supported-words')
    const area = document.getElementById('supported-words-area')
    button.innerHTML = collapsed ? ARROW_RIGHT_ICON : ARROW_DOWN_ICON
    area.classList.toggle('show', !collapsed)
    area.classList.add('collapse')
}

function createTooltip() {
    tooltipElement = document.createElement('div')
    tooltipElement.className = 'tooltip'
    document.body.appendChild(tooltipElement)
}

function setupTooltip() {
    document.querySelectorAll('.info-icon').forEach(icon => {
        icon.addEventListener('mouseenter', event => {
            const text = event.currentTarget.getAttribute('data-tooltip')
            if (!text) return
            tooltipElement.textContent = text
            tooltipElement.classList.add('show')

            const rect = event.currentTarget.getBoundingClientRect()
            const tooltipRect = tooltipElement.getBoundingClientRect()
            let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2)
            if (left < 10) left = 10
            if (left + tooltipRect.width > window.innerWidth - 10) {
                left = window.innerWidth - tooltipRect.width - 10
            }
            tooltipElement.style.left = `${left}px`
            tooltipElement.style.top = `${rect.bottom + 8}px`
        })
        icon.addEventListener('mouseleave', () => tooltipElement.classList.remove('show'))
    })
}

async function persistToggle(element, storageKey) {
    const previous = popupSettings[storageKey]
    const next = element.checked
    element.disabled = true
    showWordError('')

    try {
        const saved = await popupStorage.set({ [storageKey]: next })
        popupSettings[storageKey] = saved[storageKey]
        element.checked = saved[storageKey]
        await updateSiteStatus()
    } catch (error) {
        element.checked = previous
        showWordError('Could not save this setting. Your previous setting is still active.')
        console.error(`PhobiaBlocker: failed to save ${storageKey}`, error)
    } finally {
        element.disabled = false
    }
}

async function persistBlurAmount(slider) {
    const previous = popupSettings.blurValueAmount
    const next = Number(slider.value)
    slider.disabled = true
    try {
        const saved = await popupStorage.set({ blurValueAmount: next })
        popupSettings.blurValueAmount = saved.blurValueAmount
    } catch (error) {
        slider.value = previous
        updateBlurValueDisplay(previous)
        showWordError('Could not save the blur amount. Your previous setting is still active.')
        console.error('PhobiaBlocker: failed to save blur amount', error)
    } finally {
        slider.disabled = false
    }
}

function setupEventListeners() {
    document.getElementById('addTagBtn').addEventListener('click', () => {
        void addTag(document.getElementById('word-input').value)
    })
    document.getElementById('word-input').addEventListener('keydown', event => {
        if (event.key === 'Enter') void addTag(event.currentTarget.value)
    })

    document.getElementById('unblurBtn').addEventListener('click', event => {
        void runActiveTabCommand('unblurAll', event.currentTarget)
    })
    document.getElementById('blurBtn').addEventListener('click', event => {
        void runActiveTabCommand('blurAll', event.currentTarget)
    })

    document.getElementById('blurRange').addEventListener('input', event => {
        updateBlurValueDisplay(event.currentTarget.value)
    })
    document.getElementById('blurRange').addEventListener('change', event => {
        void persistBlurAmount(event.currentTarget)
    })

    document.getElementById('enabled-switch').addEventListener('change', event => {
        void persistToggle(event.currentTarget, POPUP_KEYS.enabled)
    })
    document.getElementById('blurIsAlwaysOn-switch').addEventListener('change', event => {
        void persistToggle(event.currentTarget, POPUP_KEYS.alwaysBlur)
    })
    document.getElementById('wordCoverEnabled-switch').addEventListener('change', event => {
        void persistToggle(event.currentTarget, POPUP_KEYS.wordCover)
    })

    document.getElementById('btn-detected-words').addEventListener('click', () => {
        const area = document.getElementById('detected-words-area')
        const collapsed = area.classList.contains('show')
        toggleDetectedWords(collapsed)
        void popupStorage.set({ detectedWordsCollapsed: collapsed }).catch(error => {
            console.error('PhobiaBlocker: failed to save detected words panel state', error)
        })
    })

    document.getElementById('btn-supported-words').addEventListener('click', () => {
        const area = document.getElementById('supported-words-area')
        const collapsed = area.classList.contains('show')
        toggleSupportedWords(collapsed)
        void popupStorage.set({ supportedWordsCollapsed: collapsed }).catch(error => {
            console.error('PhobiaBlocker: failed to save trigger words panel state', error)
        })
    })

    document.getElementById('open-settings-btn').addEventListener('click', () => {
        chrome.runtime.openOptionsPage()
    })
}

async function runActiveTabCommand(type, button) {
    const tabs = await queryTabs({ active: true, currentWindow: true })
    if (!tabs?.[0]) return
    const response = await sendTabMessage(tabs[0].id, { target: 'content', type })
    if (response?.ok) showButtonSuccess(button)
}

async function queryActiveTabAnalysis() {
    const tabs = await queryTabs({ active: true, currentWindow: true })
    if (!tabs?.[0]) return
    const response = await sendTabMessage(
        tabs[0].id,
        { target: 'content', type: 'getTriggeredWords' },
        { frameId: 0 }
    )
    const list = document.getElementById('detected-words-list')
    list.innerHTML = ''

    if (!response?.words?.length) {
        const empty = document.createElement('span')
        empty.className = 'detected-words-empty'
        empty.textContent = 'Nothing found on this page'
        list.appendChild(empty)
        updateDetectedCountBadge(0)
        return
    }

    updateDetectedCountBadge(response.words.length)
    response.words.forEach(({ word }) => {
        const row = document.createElement('div')
        row.className = 'detected-word-row'
        const name = document.createElement('span')
        name.className = 'detected-word-name'
        name.textContent = word
        row.appendChild(name)
        list.appendChild(row)
    })
}

async function initializePopup() {
    initIcons()
    createTooltip()
    setupTooltip()
    setupEventListeners()

    try {
        popupSettings = await popupStorage.getWithDefaults([
            POPUP_KEYS.targetWords,
            POPUP_KEYS.enabled,
            POPUP_KEYS.alwaysBlur,
            POPUP_KEYS.wordCover,
            POPUP_KEYS.blurAmount,
            POPUP_KEYS.detectedWordsCollapsed,
            POPUP_KEYS.supportedWordsCollapsed,
            POPUP_KEYS.whitelist,
            POPUP_KEYS.blacklist,
        ])
        targetWords = [...popupSettings.targetWords]
        renderTags()

        document.getElementById('enabled-switch').checked = popupSettings.phobiaBlockerEnabled
        document.getElementById('blurIsAlwaysOn-switch').checked = popupSettings.blurIsAlwaysOn
        document.getElementById('wordCoverEnabled-switch').checked = popupSettings.wordCoverEnabled
        document.getElementById('blurRange').value = popupSettings.blurValueAmount
        updateBlurValueDisplay(popupSettings.blurValueAmount)
        toggleDetectedWords(popupSettings.detectedWordsCollapsed)
        toggleSupportedWords(popupSettings.supportedWordsCollapsed)

        await Promise.all([updateSiteStatus(), queryActiveTabAnalysis()])
    } catch (error) {
        setStatus('status-blacklisted', 'Settings unavailable — protection stays blurred')
        showWordError('Could not read your settings. Close and reopen the popup to retry.')
        console.error('PhobiaBlocker: popup initialization failed', error)
    }
}

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') return
    const relevantKeys = [
        'targetWords',
        'phobiaBlockerEnabled',
        'blurIsAlwaysOn',
        'wordCoverEnabled',
    ].filter(key => changes[key])
    if (relevantKeys.length === 0) {
        if (changes.whitelistedSites || changes.blacklistedSites) void updateSiteStatus()
        return
    }

    void popupStorage.getWithDefaults(relevantKeys).then((values) => {
        popupSettings = { ...popupSettings, ...values }
        if (values.targetWords) {
            targetWords = [...values.targetWords]
            renderTags()
        }
        if (values.phobiaBlockerEnabled !== undefined) {
            document.getElementById('enabled-switch').checked = values.phobiaBlockerEnabled
        }
        if (values.blurIsAlwaysOn !== undefined) {
            document.getElementById('blurIsAlwaysOn-switch').checked = values.blurIsAlwaysOn
        }
        if (values.wordCoverEnabled !== undefined) {
            document.getElementById('wordCoverEnabled-switch').checked = values.wordCoverEnabled
        }
        void updateSiteStatus()
    }).catch((error) => {
        showWordError('Could not refresh committed settings. Close and reopen the popup to retry.')
        console.error('PhobiaBlocker: popup storage refresh failed', error)
    })
})
