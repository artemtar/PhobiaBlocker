// Offscreen document management
const OFFSCREEN_PATH = 'offscreen.html'
let _offscreenCreatePromise = null
let _cachedTargetWords = null
const FAIL_CLOSED_ANALYSIS_RESULT = Object.freeze({ shouldBlur: true, matchedWords: [] })

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

function loadTargetWordsFromStorage() {
    return new Promise((resolve) => {
        chrome.storage.sync.get('targetWords', (storage) => {
            _cachedTargetWords = Array.isArray(storage?.targetWords)
                ? storage.targetWords
                : []
            resolve(_cachedTargetWords)
        })
    })
}

// Warm cache on startup
void loadTargetWordsFromStorage()

// Keep cache fresh
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes.targetWords) return
    _cachedTargetWords = Array.isArray(changes.targetWords.newValue)
        ? changes.targetWords.newValue
        : []
})

// Create context menu and initialize storage on extension install/update
chrome.runtime.onInstalled.addListener((details) => {
    chrome.contextMenus.create({
        id: 'phobia-blocker-unblur',
        title: 'Unblur',
        contexts: ['all']
    })

    if (details.reason === 'install') {
        chrome.storage.sync.get([
            'targetWords',
            'phobiaBlockerEnabled',
            'blurIsAlwaysOn'
        ], (storage) => {
            const defaults = {}

            if (storage.targetWords === undefined) {
                defaults.targetWords = ['clown', 'mice', 'spider']
            }
            if (storage.phobiaBlockerEnabled === undefined) {
                defaults.phobiaBlockerEnabled = true
            }
            if (storage.blurIsAlwaysOn === undefined) {
                defaults.blurIsAlwaysOn = false
            }

            if (Object.keys(defaults).length > 0) {
                chrome.storage.sync.set(defaults)
            }
        })
    }
})

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'phobia-blocker-unblur') {
        chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'unblur' }).catch(() => {})
    }
})

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

    const normalizeWords = (words) => {
        if (!Array.isArray(words)) return []
        return words.filter((word) => typeof word === 'string')
    }

    const normalizeMatchedWords = (matchedWords) => {
        if (!Array.isArray(matchedWords)) return []
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
                words: normalizeWords(scope.words),
            }))
    }

    const normalizeAnalysisResult = (result, id) => ({
        ...(typeof id === 'number' ? { id } : {}),
        shouldBlur: typeof result?.shouldBlur === 'boolean'
            ? result.shouldBlur
            : FAIL_CLOSED_ANALYSIS_RESULT.shouldBlur,
        matchedWords: normalizeMatchedWords(result?.matchedWords),
    })

    const analyzeScopes = async (scopes) => {
        if (_cachedTargetWords === null) {
            await loadTargetWordsFromStorage()
        }

        const requestedScopes = normalizeScopeRequest(scopes)
        if (requestedScopes.length === 0) {
            return { results: [] }
        }

        await ensureOffscreenDocument()

        const response = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'PB_ANALYZE_SCOPES',
            scopes: requestedScopes,
            targetWords: _cachedTargetWords,
        })

        const requestedIds = new Set(requestedScopes.map((scope) => scope.id))
        const resultsById = new Map()

        if (response && Array.isArray(response.results)) {
            response.results.forEach((result) => {
                if (!result || typeof result.id !== 'number' || !requestedIds.has(result.id)) return
                resultsById.set(result.id, normalizeAnalysisResult(result, result.id))
            })
        }

        return {
            results: requestedScopes.map((scope) =>
                resultsById.get(scope.id) || normalizeAnalysisResult(FAIL_CLOSED_ANALYSIS_RESULT, scope.id)
            ),
        }
    }

    if (message.type !== 'PB_ANALYZE_WORDS' && message.type !== 'PB_ANALYZE_SCOPES') return

    ;(async () => {
        try {
            if (message.type === 'PB_ANALYZE_SCOPES') {
                sendResponse(await analyzeScopes(message.scopes))
                return
            }

            const response = await analyzeScopes([{
                id: 0,
                words: normalizeWords(message.words),
            }])
            const result = response.results[0]

            if (result && typeof result.shouldBlur === 'boolean') {
                sendResponse({
                    shouldBlur: result.shouldBlur,
                    matchedWords: result.matchedWords,
                })
            } else {
                sendResponse({ ...FAIL_CLOSED_ANALYSIS_RESULT })
            }
        } catch (error) {
            console.error('PhobiaBlocker: Offscreen analysis failed', error)
            if (message.type === 'PB_ANALYZE_SCOPES') {
                const requestedScopes = normalizeScopeRequest(message.scopes)
                sendResponse({
                    results: requestedScopes.map((scope) =>
                        normalizeAnalysisResult(FAIL_CLOSED_ANALYSIS_RESULT, scope.id)
                    ),
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
                    if (chrome.runtime.lastError) {}
                })
            } else if (command === 'unblur-all') {
                chrome.tabs.sendMessage(tabs[0].id, { target: 'content', type: 'unblurAll' }, () => {
                    if (chrome.runtime.lastError) {}
                })
            }
        }
    })
})
