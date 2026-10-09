const popupPolicy = globalThis.PhobiaBlockerPolicy
const popupStorage = globalThis.PhobiaBlockerStorage
const popupUi = globalThis.PhobiaBlockerSettingsUi

if (!popupPolicy || !popupStorage || !popupUi) {
    throw new Error('Shared policy, storage and settings-ui scripts must load before popup.js')
}

const POPUP_KEYS = popupPolicy.STORAGE_KEYS
const MODE_KEYS = [POPUP_KEYS.enabled, POPUP_KEYS.alwaysBlur]
const RULE_KEYS = [POPUP_KEYS.whitelist, POPUP_KEYS.blacklist]
const EDITABLE_KEYS = [...MODE_KEYS, ...RULE_KEYS, POPUP_KEYS.targetWords, POPUP_KEYS.wordCover, POPUP_KEYS.previewEnabled]
const MODE_VALUES = {
    smart: { phobiaBlockerEnabled: true, blurIsAlwaysOn: false },
    always: { phobiaBlockerEnabled: true, blurIsAlwaysOn: true },
    off: { phobiaBlockerEnabled: false, blurIsAlwaysOn: false },
}
const ANALYSIS_REFRESH_INTERVAL_MS = 1000
const ANALYSIS_RESPONSE_TIMEOUT_MS = 3000
const popupReader = popupUi.createRevisionedReader(popupStorage)
const pendingWrites = new Set()
const refreshRequired = new Set()
const keyVersions = new Map()
let popupSettings = {}
let targetWords = []
let popupSettingsLoaded = false
let popupStatusRevision = 0
let popupAnalysisRevision = 0
let popupAnalysisRefreshTimer = null
let popupClosed = false
let activeTab = null
let statusSettings = null
let analysisResponse = null
let detectedWordsSignature
let pageActionPending = false
let popupError = ''
let refreshFailed = false

const byId = id => document.getElementById(id)
const canEdit = keys => popupSettingsLoaded && keys.every(key => !pendingWrites.has(key) && !refreshRequired.has(key))

document.addEventListener('DOMContentLoaded', () => {
    window.addEventListener('pagehide', () => {
        popupClosed = true
        popupAnalysisRevision += 1
        clearTimeout(popupAnalysisRefreshTimer)
    }, { once: true })
    void initializePopup().then(() => {
        if (popupSettingsLoaded) scheduleAnalysisRefresh()
    })
})

function queryTabs(query) {
    return new Promise(resolve => chrome.tabs.query(query, tabs => {
        const error = chrome.runtime.lastError
        resolve(error ? null : tabs)
    }))
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

function supportedPage(url) {
    try {
        const parsed = new URL(url)
        return ['http:', 'https:'].includes(parsed.protocol) &&
            parsed.hostname !== 'chromewebstore.google.com' &&
            !(parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))
    } catch (_) { return false }
}

function currentDomain() {
    return supportedPage(activeTab?.url) ? new URL(activeTab.url).hostname : ''
}

function showWordError(message) {
    popupError = message
    renderError()
}

function renderError() {
    const refreshError = refreshFailed ? 'Some settings could not refresh and remain locked. Close and reopen the popup to retry.' : ''
    const message = [popupError, refreshError].filter(Boolean).join(' ')
    byId('word-error').textContent = message
    byId('word-error').hidden = !message
}

function updateCountBadge(badgeId, count) {
    byId(badgeId).textContent = String(count)
    byId(badgeId).hidden = !count
}

function renderTags() {
    const disabled = !canEdit([POPUP_KEYS.targetWords])
    byId('addTagBtn').disabled = disabled
    byId('word-input').disabled = disabled
    const container = byId('tags-container')
    container.innerHTML = ''
    targetWords.forEach((word, index) => {
        const validation = popupPolicy.validateTargetWord(word)
        const tag = document.createElement('span')
        tag.className = validation.valid ? 'tag' : 'tag tag-invalid'
        tag.title = validation.valid ? '' : `Invalid trigger: ${validation.reason}`
        tag.appendChild(document.createTextNode(String(word)))
        tag.appendChild(popupUi.createRemoveButton({
            className: 'tag-remove', label: word, disabled,
            onClick: () => void removeTag(index),
        }))
        container.appendChild(tag)
    })
    updateCountBadge('trigger-count-badge', targetWords.length)
}

function renderControls() {
    const selected = !popupSettings.phobiaBlockerEnabled ? 'off' : popupSettings.blurIsAlwaysOn ? 'always' : 'smart'
    for (const mode of Object.keys(MODE_VALUES)) {
        byId(`mode-${mode}`).setAttribute('aria-pressed', String(popupSettingsLoaded && selected === mode))
        byId(`mode-${mode}`).disabled = !canEdit(MODE_KEYS)
    }
    for (const [name, key] of [['cover', POPUP_KEYS.wordCover], ['preview', POPUP_KEYS.previewEnabled]]) {
        const enabled = popupSettings[key] === true
        byId(`${name}-toggle`).setAttribute('aria-pressed', String(enabled))
        byId(`${name}-toggle`).disabled = !canEdit([key])
        byId(`${name}-state`).textContent = enabled ? 'On ✓' : 'Off −'
    }
    const domain = currentDomain()
    const canEditRule = popupPolicy.parseSiteRule(domain).valid && canEdit(RULE_KEYS)
    byId('change-site-rule').disabled = !canEditRule
    byId('site-rule-select').disabled = !canEditRule
    byId('site-rule-label').textContent = domain ? `Rule for ${domain}` : 'Rule for this domain'
    const hasExactRule = key => popupSettings[key]?.some(rule => popupPolicy.parseSiteRule(rule).normalized === domain)
    byId('site-rule-select').value = hasExactRule(POPUP_KEYS.blacklist) ? 'always' : hasExactRule(POPUP_KEYS.whitelist) ? 'off' : 'default'
    const actionsDisabled = !popupSettingsLoaded || !supportedPage(activeTab?.url) || pageActionPending
    byId('blurBtn').disabled = actionsDisabled
    byId('unblurBtn').disabled = actionsDisabled
}

function applySettings(values) {
    Object.assign(popupSettings, values)
    if (values.targetWords) {
        targetWords = [...values.targetWords]
        renderTags()
    }
    renderControls()
}

// A newer storage notification owns its keys, even if a prior write's callback
// arrives afterwards. Failed refreshes keep only their affected controls locked.
async function saveSettings(values) {
    const keys = Object.keys(values)
    if (!canEdit(keys)) return false
    const versions = new Map(keys.map(key => [key, keyVersions.get(key)]))
    keys.forEach(key => pendingWrites.add(key))
    showWordError('')
    renderControls()
    if (keys.includes(POPUP_KEYS.targetWords)) renderTags()
    try {
        const saved = await popupStorage.set(values)
        applySettings(Object.fromEntries(keys
            .filter(key => versions.get(key) === keyVersions.get(key))
            .map(key => [key, saved[key]])))
        if (keys.some(key => key !== POPUP_KEYS.previewEnabled)) {
            popupAnalysisRevision += 1
            void updateSiteStatus()
            void queryActiveTabAnalysis()
        }
        return true
    } catch (error) {
        showWordError('Could not save your change. Please try again.')
        console.error('PhobiaBlur: popup save failed', error)
        return false
    } finally {
        keys.forEach(key => pendingWrites.delete(key))
        renderControls()
        if (keys.includes(POPUP_KEYS.targetWords)) renderTags()
    }
}

async function addTag(rawWord) {
    if (!canEdit([POPUP_KEYS.targetWords])) return
    showWordError('')
    const validation = popupPolicy.validateTargetWord(rawWord)
    if (!validation.valid) return showWordError(validation.reason)
    if (targetWords.length >= 20) return showWordError('You can store up to 20 trigger words.')
    if (targetWords.some(word => popupPolicy.validateTargetWord(word).normalized === validation.normalized)) {
        return showWordError('That trigger word is already in your list.')
    }
    if (await saveSettings({ targetWords: [...targetWords, validation.normalized] })) byId('word-input').value = ''
}

async function removeTag(index) {
    if (!canEdit([POPUP_KEYS.targetWords])) return
    await saveSettings({ targetWords: targetWords.filter((_, wordIndex) => wordIndex !== index) })
}

async function saveSiteRule(value) {
    const domain = currentDomain()
    if (!popupPolicy.parseSiteRule(domain).valid || !canEdit(RULE_KEYS) || !['default', 'always', 'off'].includes(value)) return
    const keepOtherRules = rules => rules.filter(rule => popupPolicy.parseSiteRule(rule).normalized !== domain)
    const blacklistedSites = keepOtherRules(popupSettings.blacklistedSites)
    const whitelistedSites = keepOtherRules(popupSettings.whitelistedSites)
    if (value === 'always') blacklistedSites.push(domain)
    if (value === 'off') whitelistedSites.push(domain)
    await saveSettings({ blacklistedSites, whitelistedSites })
}

function setStatus(className, title, reason) {
    const bar = byId('site-status-bar')
    const nextClass = `site-status-bar ${className}`
    if (bar.className !== nextClass) bar.className = nextClass
    // This live region is checked by polling; announce actual changes only.
    if (byId('site-status-title').textContent !== title) byId('site-status-title').textContent = title
    if (byId('site-status-reason').textContent !== reason) byId('site-status-reason').textContent = reason
}

function renderSiteStatus() {
    if (!supportedPage(activeTab?.url) || !statusSettings) return
    const settings = statusSettings
    const mode = popupPolicy.resolveProtectionMode(settings, activeTab.url)
    const alwaysRule = settings.blacklistedSites.find(rule => popupPolicy.matchesSiteRule(activeTab.url, rule))
    const offRule = settings.whitelistedSites.find(rule => popupPolicy.matchesSiteRule(activeTab.url, rule))
    byId('site-rule-summary').textContent = alwaysRule ? `Site rule: always blur · ${alwaysRule}` :
        offRule ? `Site rule: automatic protection paused · ${offRule}` : 'Site rule: uses default protection'
    const off = mode === popupPolicy.PROTECTION_MODE.DISABLED
    byId('preference-note').hidden = !off
    byId('preference-note').textContent = 'Preferences are saved. Word covering and hover preview are inactive on this page while automatic protection is off.'
    if (off) {
        setStatus('', 'Automatic protection off', 'Manual page actions are still available below.')
    } else if (mode === popupPolicy.PROTECTION_MODE.ALWAYS_BLUR) {
        setStatus('', 'Always blur is on', 'Media is set to blur without waiting for a text match.')
    } else if (!popupPolicy.normalizeTargetWords(settings.targetWords).valid.length) {
        setStatus('status-unavailable', 'Add a trigger word', 'Smart mode needs a valid trigger word to check page text.')
    } else {
        const words = analysisResponse?.words
        const reason = words?.length ? `${words.length} trigger ${words.length === 1 ? 'word' : 'words'} reported in page text. View matched words below.` :
            words ? 'No page-text matches reported.' :
                'Page analysis unavailable. Reload the page to reconnect.'
        setStatus('', 'Automatic protection on', reason)
    }
    byId('detected-words-container').hidden = off || !analysisResponse?.words?.length
}

async function updateSiteStatus() {
    const revision = ++popupStatusRevision
    const settingsRevision = popupReader.revision
    const isCurrent = () => revision === popupStatusRevision && settingsRevision === popupReader.revision
    const tabs = await queryTabs({ active: true, currentWindow: true })
    if (!isCurrent()) return
    activeTab = tabs?.[0] ?? null
    byId('site-domain').textContent = currentDomain() || 'Current page'
    renderControls()
    if (!supportedPage(activeTab?.url)) {
        statusSettings = null
        byId('detected-words-container').hidden = true
        byId('site-rule-summary').textContent = 'Site rules unavailable here'
        setStatus('status-unavailable', 'Unavailable here', 'Open a regular website to use page controls. Saved preferences remain editable.')
        return
    }
    try {
        const settings = await popupStorage.getWithDefaults(Object.keys(popupPolicy.DEFAULTS))
        if (!isCurrent()) return
        // Status reads are separate from the editable snapshot: a delayed status
        // response must never reset the value used by a subsequent edit.
        statusSettings = settings
        renderSiteStatus()
    } catch (error) {
        if (!isCurrent()) return
        statusSettings = null
        byId('detected-words-container').hidden = true
        byId('site-rule-summary').textContent = 'Site rule unavailable'
        setStatus('status-unavailable', 'Status unavailable', 'Could not read the current protection settings. Reopen the popup to retry.')
        console.error('PhobiaBlur: popup status read failed', error)
    }
}

function toggleWordPanel(panel, collapsed) {
    byId(`btn-${panel}-words`).setAttribute('aria-expanded', String(!collapsed))
    byId(`${panel}-words-area`).classList.toggle('show', !collapsed)
}

function setupEventListeners() {
    byId('addTagBtn').addEventListener('click', () => void addTag(byId('word-input').value))
    byId('word-input').addEventListener('keydown', event => {
        if (event.key === 'Enter') void addTag(event.currentTarget.value)
    })
    for (const mode of Object.keys(MODE_VALUES)) {
        byId(`mode-${mode}`).addEventListener('click', () => void saveSettings(MODE_VALUES[mode]))
    }
    for (const [name, key] of [['cover', POPUP_KEYS.wordCover], ['preview', POPUP_KEYS.previewEnabled]]) {
        byId(`${name}-toggle`).addEventListener('click', () => void saveSettings({ [key]: !popupSettings[key] }))
    }
    byId('change-site-rule').addEventListener('click', () => {
        const panel = byId('site-rule-panel')
        panel.hidden = !panel.hidden
        byId('change-site-rule').setAttribute('aria-expanded', String(!panel.hidden))
    })
    byId('site-rule-select').addEventListener('change', event => void saveSiteRule(event.currentTarget.value))
    for (const panel of ['detected', 'supported']) {
        byId(`btn-${panel}-words`).addEventListener('click', () => {
            toggleWordPanel(panel, byId(`${panel}-words-area`).classList.contains('show'))
        })
    }
    byId('unblurBtn').addEventListener('click', () => void runActiveTabCommand('unblurAll'))
    byId('blurBtn').addEventListener('click', () => void runActiveTabCommand('blurAll'))
    byId('open-settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage())
}

async function runActiveTabCommand(type) {
    if (!popupSettingsLoaded || pageActionPending || !supportedPage(activeTab?.url)) return
    pageActionPending = true
    renderControls()
    const result = byId('action-result')
    result.hidden = false
    result.textContent = 'Applying to this page…'
    try {
        const tabs = await queryTabs({ active: true, currentWindow: true })
        const tab = tabs?.[0]
        if (!supportedPage(tab?.url)) throw new Error('Unsupported page')
        const response = await popupPolicy.withTimeout(sendTabMessage(tab.id, { target: 'content', type }), ANALYSIS_RESPONSE_TIMEOUT_MS, 'Page action')
        result.textContent = response?.ok ?
            (type === 'blurAll' ? 'Media blur applied. Saved preferences are unchanged.' : 'Current content revealed. New or changed content may be protected again.') :
            'Could not reach this page. Reload it and try again.'
    } catch (error) {
        result.textContent = 'Could not apply this page action. Reload the page and try again.'
        console.error('PhobiaBlur: page action failed', error)
    } finally {
        pageActionPending = false
        renderControls()
    }
}

function scheduleAnalysisRefresh() {
    if (popupClosed) return
    popupAnalysisRefreshTimer = setTimeout(async () => {
        popupAnalysisRefreshTimer = null
        await queryActiveTabAnalysis()
        scheduleAnalysisRefresh()
    }, ANALYSIS_REFRESH_INTERVAL_MS)
}

async function queryActiveTabAnalysis() {
    const revision = ++popupAnalysisRevision
    let requestPending = true
    let timeoutId
    const isCurrent = () => requestPending && !popupClosed && revision === popupAnalysisRevision
    try {
        const request = queryTabs({ active: true, currentWindow: true }).then(tabs => {
            if (!isCurrent() || !supportedPage(tabs?.[0]?.url)) return null
            return sendTabMessage(tabs[0].id, { target: 'content', type: 'getTriggeredWords' }, { frameId: 0 })
        })
        const timeout = new Promise(resolve => {
            timeoutId = setTimeout(() => resolve(null), ANALYSIS_RESPONSE_TIMEOUT_MS)
        })
        const response = await Promise.race([request, timeout])
        if (isCurrent()) renderDetectedWords(response)
    } catch (error) {
        if (isCurrent()) renderDetectedWords(null)
        console.error('PhobiaBlur: failed to refresh page analysis', error)
    } finally {
        requestPending = false
        clearTimeout(timeoutId)
    }
}

function renderDetectedWords(response) {
    analysisResponse = response
    renderSiteStatus()
    const signature = JSON.stringify(response?.words ?? null)
    if (signature === detectedWordsSignature) return
    detectedWordsSignature = signature
    const list = byId('detected-words-list')
    list.innerHTML = ''
    updateCountBadge('detected-count-badge', response?.words?.length ?? 0)
    for (const { word } of response?.words ?? []) {
        const row = document.createElement('span')
        row.className = 'detected-word-row'
        row.textContent = word
        list.appendChild(row)
    }
}

async function initializePopup() {
    renderTags()
    renderControls()
    setupEventListeners()
    toggleWordPanel('detected', true)
    toggleWordPanel('supported', true)
    try {
        const values = await popupReader.loadAll(EDITABLE_KEYS)
        popupSettingsLoaded = true
        applySettings(values)
        await Promise.all([updateSiteStatus(), queryActiveTabAnalysis()])
    } catch (error) {
        setStatus('status-unavailable', 'Settings unavailable', 'Close and reopen the popup to retry.')
        showWordError('Could not read your settings. Close and reopen the popup to retry.')
        console.error('PhobiaBlur: popup initialization failed', error)
    }
}

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') return
    const keys = EDITABLE_KEYS.filter(key => changes[key])
    if (!keys.length) return
    popupAnalysisRevision += 1
    keys.forEach(key => keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1))
    if (!popupSettingsLoaded) {
        popupReader.invalidate()
        return
    }
    keys.forEach(key => refreshRequired.add(key))
    renderControls()
    if (keys.includes(POPUP_KEYS.targetWords)) renderTags()
    void popupReader.refresh(keys, values => {
        Object.keys(values).forEach(key => refreshRequired.delete(key))
        if (refreshFailed && refreshRequired.size === 0) {
            refreshFailed = false
            renderError()
        }
        applySettings(values)
        void updateSiteStatus()
        void queryActiveTabAnalysis()
    }, error => {
        refreshFailed = true
        renderError()
        console.error('PhobiaBlur: popup storage refresh failed', error)
    })
})
