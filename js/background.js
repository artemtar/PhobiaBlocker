/* global importScripts */

// Offscreen document management
importScripts('shared-policy.js', 'storage.js')

const OFFSCREEN_PATH = 'offscreen.html'
const OFFSCREEN_ANALYSIS_TIMEOUT_MS = 3500
const KEYBOARD_TOGGLE_DEBOUNCE_MS = 350
const {
    DEFAULTS,
    STORAGE_KEYS,
    normalizeTargetWords,
} = globalThis.PhobiaBlockerPolicy
const storageApi = globalThis.PhobiaBlockerStorage
let _offscreenCreatePromise = null
let _cachedTargetWords = null
let _targetWordsLoadPromise = null
let _targetWordsGeneration = 0
let _targetWordsLoadGeneration = -1
let _lastKeyboardWordCoverToggleAt = 0
const FAIL_CLOSED_ANALYSIS_RESULT = Object.freeze({
    shouldBlur: true,
    matchedWords: [],
    matchedInputWords: [],
})

async function ensureOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH)
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl],
    })

    if (existingContexts.length > 0) return

    if (!_offscreenCreatePromise) {
        _offscreenCreatePromise = chrome.offscreen.createDocument({
            url: OFFSCREEN_PATH,
            reasons: ['DOM_PARSER'],
            justification: 'Run NLP text analysis in a single shared document instead of every frame.',
        }).finally(() => {
            _offscreenCreatePromise = null
        })
    }

    await _offscreenCreatePromise
}

async function loadTargetWordsFromStorage() {
    const generation = _targetWordsGeneration
    if (_targetWordsLoadPromise && _targetWordsLoadGeneration === generation) {
        return _targetWordsLoadPromise
    }

    const loadPromise = (async () => {
        try {
            const values = await storageApi.getRaw(STORAGE_KEYS.targetWords)
            const rawWords = values.targetWords === undefined ? DEFAULTS.targetWords : values.targetWords
            const validWords = normalizeTargetWords(rawWords).valid
            if (generation === _targetWordsGeneration) _cachedTargetWords = validWords
            return validWords
        } catch (error) {
            if (generation === _targetWordsGeneration) _cachedTargetWords = null
            console.error('PhobiaBlocker: target-word storage read failed', error)
            throw error
        } finally {
            if (_targetWordsLoadPromise === loadPromise) {
                _targetWordsLoadPromise = null
                _targetWordsLoadGeneration = -1
            }
        }
    })()

    _targetWordsLoadPromise = loadPromise
    _targetWordsLoadGeneration = generation
    return loadPromise
}

// Warm cache on startup
void loadTargetWordsFromStorage().catch(() => {})

// Keep cache fresh
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes[STORAGE_KEYS.targetWords]) return
    _targetWordsGeneration++
    _cachedTargetWords = null
    _targetWordsLoadPromise = null
    _targetWordsLoadGeneration = -1
    void loadTargetWordsFromStorage().catch(() => {})
})

// Create context menu and initialize storage on extension install/update
chrome.runtime.onInstalled.addListener((details) => {
    chrome.contextMenus.create({
        id: 'phobia-blocker-unblur',
        title: 'Unblur',
        contexts: ['all']
    })

    if (details.reason !== 'install') return

    void storageApi.initializeMissingDefaults(Object.keys(DEFAULTS)).then(() => {
        _cachedTargetWords = null
        return loadTargetWordsFromStorage()
    }).catch(error => {
        _cachedTargetWords = null
        console.error('PhobiaBlocker: default settings initialization failed', error)
    })
})

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'phobia-blocker-unblur' && tab && tab.id !== undefined) {
        const options = typeof info.frameId === 'number' ? { frameId: info.frameId } : undefined
        chrome.tabs.sendMessage(
            tab.id,
            { target: 'content', type: 'unblur' },
            options,
            () => {
                if (chrome.runtime.lastError) {
                    // The target tab may have navigated before the context-menu click arrived.
                }
            }
        )
    }
})

function toggleWordCover(sendResponse, options = {}) {
    const respond = payload => {
        if (sendResponse) sendResponse(payload)
    }

    if (options.source === 'keyboard') {
        const now = Date.now()
        if (now - _lastKeyboardWordCoverToggleAt < KEYBOARD_TOGGLE_DEBOUNCE_MS) {
            void storageApi.getWithDefaults(STORAGE_KEYS.wordCover).then(values => {
                respond({ ok: true, wordCoverEnabled: values.wordCoverEnabled })
            }).catch(() => respond({ ok: false }))
            return
        }
        _lastKeyboardWordCoverToggleAt = now
    }

    void storageApi.getWithDefaults(STORAGE_KEYS.wordCover).then(values => {
        const wordCoverEnabled = !values.wordCoverEnabled
        return storageApi.set({ wordCoverEnabled }).then(() => wordCoverEnabled)
    }).then(wordCoverEnabled => {
        respond({ ok: true, wordCoverEnabled })
    }).catch(error => {
        console.error('PhobiaBlocker: word-cover setting update failed', error)
        respond({ ok: false })
    })
}

// Pre-render all tinted icon variants at service worker startup.
globalThis._tintedIcons = {}
const _tintedIcons = globalThis._tintedIcons

async function _preloadTintedIcons() {
    const VARIANTS = [
        { status: 'processing', color: '#F5A623' },
        { status: 'detected',   color: '#E53935' },
    ]
    for (const size of [16, 48, 128]) {
        const resp = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))
        const blob = await resp.blob()
        const bitmap = await createImageBitmap(blob)
        const origCanvas = new OffscreenCanvas(size, size)
        origCanvas.getContext('2d').drawImage(bitmap, 0, 0, size, size)
        _tintedIcons[`idle_${size}`] = origCanvas.getContext('2d').getImageData(0, 0, size, size)
        for (const { status, color } of VARIANTS) {
            const canvas = new OffscreenCanvas(size, size)
            const ctx = canvas.getContext('2d')
            ctx.drawImage(bitmap, 0, 0, size, size)
            ctx.globalCompositeOperation = 'color'
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
            ctx.fill()
            _tintedIcons[`${status}_${size}`] = ctx.getImageData(0, 0, size, size)
        }
    }
}

const _preloadPromise = _preloadTintedIcons().catch(() => {})

// Handle icon status updates from content script (soft filter for cross-version compat)
chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== 'iconStatus') return
    if (message.target && message.target !== 'background') return

    const tabId = sender.tab?.id
    if (!tabId) return

    _preloadPromise.then(() => {
        const i16  = _tintedIcons[`${message.status}_16`]
        const i48  = _tintedIcons[`${message.status}_48`]
        const i128 = _tintedIcons[`${message.status}_128`]
        if (!i16 || !i48 || !i128) return

        chrome.action.setIcon({
            imageData: { 16: i16, 48: i48, 128: i128 },
            tabId
        }).catch(() => {})
    })
})

// Handle offscreen ready + analysis requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== 'background') return

    if (message.type === 'PB_OFFSCREEN_READY') {
        sendResponse({ ok: true })
        return
    }

    if (message.type === 'toggleWordCover') {
        toggleWordCover(sendResponse, { source: message.source })
        return true
    }

    const isStringArray = (words) => {
        return Array.isArray(words) && words.every(word => typeof word === 'string')
    }

    const normalizeMatchedWords = (matchedWords) => {
        return [...new Set(
            matchedWords
                .filter((word) => typeof word === 'string')
                .map((word) => word.trim())
                .filter(Boolean)
        )]
    }

    const normalizeScopeRequest = (scopes) => {
        if (!Array.isArray(scopes)) return []
        return scopes
            .filter((scope) => scope && typeof scope.id === 'number')
            .map((scope) => ({
                id: scope.id,
                words: isStringArray(scope.words) ? [...scope.words] : null,
            }))
    }

    const normalizeAnalysisResult = (result, id) => {
        if (!result || typeof result.shouldBlur !== 'boolean' ||
            !isStringArray(result.matchedWords) || !isStringArray(result.matchedInputWords)) {
            return null
        }
        if (typeof id === 'number' && result.id !== id) return null
        return {
            ...(typeof id === 'number' ? { id } : {}),
            shouldBlur: result.shouldBlur,
            matchedWords: normalizeMatchedWords(result.matchedWords),
            matchedInputWords: normalizeMatchedWords(result.matchedInputWords),
        }
    }

    const failClosedResult = (id) => ({
        ...(typeof id === 'number' ? { id } : {}),
        ...FAIL_CLOSED_ANALYSIS_RESULT,
    })

    const sendOffscreenMessage = async (payload) => {
        let timeoutId = null
        try {
            return await Promise.race([
                (async () => {
                    await ensureOffscreenDocument()
                    return chrome.runtime.sendMessage(payload)
                })(),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(
                        () => reject(new Error('Offscreen analysis timed out')),
                        OFFSCREEN_ANALYSIS_TIMEOUT_MS
                    )
                }),
            ])
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId)
        }
    }

    const analyzeScopes = async (scopes) => {
        const requestedScopes = normalizeScopeRequest(scopes)
        const requestIds = requestedScopes.map(scope => scope.id)
        const requestIsValid = Array.isArray(scopes) && scopes.length > 0 &&
            requestedScopes.length === scopes.length &&
            requestedScopes.every(scope => Array.isArray(scope.words)) &&
            new Set(requestIds).size === requestIds.length
        if (!requestIsValid) {
            return { results: requestedScopes.map(scope => failClosedResult(scope.id)) }
        }

        if (_cachedTargetWords === null) {
            try {
                await loadTargetWordsFromStorage()
            } catch (_) {
                return {
                    results: requestedScopes.map(scope => failClosedResult(scope.id)),
                }
            }
        }

        if (!Array.isArray(_cachedTargetWords) || _cachedTargetWords.length === 0) {
            return { results: requestedScopes.map(scope => failClosedResult(scope.id)) }
        }

        const response = await sendOffscreenMessage({
            target: 'offscreen',
            type: 'PB_ANALYZE_SCOPES',
            scopes: requestedScopes,
            targetWords: _cachedTargetWords,
        })

        const requestedIds = new Set(requestIds)
        const resultsById = new Map()
        let responseIsValid = Boolean(
            response && Array.isArray(response.results) &&
            response.results.length === requestedScopes.length
        )

        if (responseIsValid) {
            for (const result of response.results) {
                if (!result || typeof result.id !== 'number' || !requestedIds.has(result.id) ||
                    resultsById.has(result.id)) {
                    responseIsValid = false
                    break
                }
                const normalized = normalizeAnalysisResult(result, result.id)
                if (!normalized) {
                    responseIsValid = false
                    break
                }
                resultsById.set(result.id, normalized)
            }
        }

        if (!responseIsValid || resultsById.size !== requestedScopes.length) {
            return { results: requestedScopes.map(scope => failClosedResult(scope.id)) }
        }

        return {
            results: requestedScopes.map(scope => resultsById.get(scope.id)),
        }
    }

    if (message.type !== 'PB_ANALYZE_WORDS' && message.type !== 'PB_ANALYZE_SCOPES') return

    ;(async () => {
        try {
            if (message.type === 'PB_ANALYZE_SCOPES') {
                sendResponse(await analyzeScopes(message.scopes))
                return
            }

            if (!isStringArray(message.words)) {
                sendResponse({ ...FAIL_CLOSED_ANALYSIS_RESULT })
                return
            }

            const response = await analyzeScopes([{
                id: 0,
                words: [...message.words],
            }])
            const result = response.results[0]

            if (result && typeof result.shouldBlur === 'boolean') {
                sendResponse({
                    shouldBlur: result.shouldBlur,
                    matchedWords: result.matchedWords,
                    matchedInputWords: result.matchedInputWords,
                })
            } else {
                sendResponse({ ...FAIL_CLOSED_ANALYSIS_RESULT })
            }
        } catch (error) {
            console.error('PhobiaBlocker: Offscreen analysis failed', error)
            if (message.type === 'PB_ANALYZE_SCOPES') {
                const requestedScopes = normalizeScopeRequest(message.scopes)
                sendResponse({
                    results: requestedScopes.map(scope => failClosedResult(scope.id)),
                })
                return
            }
            sendResponse({ ...FAIL_CLOSED_ANALYSIS_RESULT })
        }
    })()

    return true
})

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
            if (command === 'blur-all') {
                chrome.tabs.sendMessage(tabs[0].id, { target: 'content', type: 'blurAll' }, () => {
                    if (chrome.runtime.lastError) {
                        // The active tab may not accept content-script messages.
                    }
                })
            } else if (command === 'unblur-all') {
                chrome.tabs.sendMessage(tabs[0].id, { target: 'content', type: 'unblurAll' }, () => {
                    if (chrome.runtime.lastError) {
                        // The active tab may not accept content-script messages.
                    }
                })
            } else if (command === 'toggle-word-cover') {
                toggleWordCover(null, { source: 'keyboard' })
            }
        }
    })
})
