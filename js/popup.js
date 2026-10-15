// Toolbar popup: edits the shared settings, shows the active tab's protection
// status and matched words, and sends manual blur/reveal actions to every
// frame of the active tab. It never reveals anything itself; only the content
// script does.
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
// The content script re-analyses as the page mutates but never pushes results
// to the popup, so matched words are polled. The timeout bounds a content
// script that keeps the reply channel open but never answers (a missing
// script fails fast through lastError; a suspended frame does not).
const ANALYSIS_REFRESH_INTERVAL_MS = 1000
const ANALYSIS_RESPONSE_TIMEOUT_MS = 3000
const popupReader = popupUi.createRevisionedReader(popupStorage)
// Three per-key locks guard edits. pendingWrites: a write is in flight.
// refreshRequired: storage.onChanged reported a change not yet re-read.
// keyVersions: bumped on every onChanged, including the popup's own writes,
// so a write callback only paints its value if nothing newer landed (see
// saveSettings).
const pendingWrites = new Set()
const refreshRequired = new Set()
const keyVersions = new Map()
let popupSettings = {}
let targetWords = []
let popupSettingsLoaded = false
// Monotonic tokens: an async status or analysis request renders its result
// only if no newer request started while it was in flight.
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
// Editing waits for the initial read and for every involved key to settle, so
// a write never overwrites a value this popup has not seen yet.
const canEdit = keys => popupSettingsLoaded && keys.every(key => !pendingWrites.has(key) && !refreshRequired.has(key))

document.addEventListener('DOMContentLoaded', () => {
    // Chrome tears the popup document down on close; stop the poll and drop
    // any in-flight analysis reply so nothing renders into a dying document.
    window.addEventListener('pagehide', () => {
        popupClosed = true
        popupAnalysisRevision += 1
        clearTimeout(popupAnalysisRefreshTimer)
    }, { once: true })
    void initializePopup().then(() => {
        // No settings, no poll: status and matched words would be meaningless and
        // the only recovery from a failed initial read is reopening the popup.
        if (popupSettingsLoaded) scheduleAnalysisRefresh()
    })
})

// Both wrappers resolve null instead of rejecting. Reading lastError inside
// the callback also marks it handled; otherwise Chrome logs an
// "Unchecked runtime.lastError" for every tab without a content script.
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

// Page actions and site rules are offered only on http(s) pages, the one
// scheme where a content script is guaranteed (chrome://, extension pages and
// the Web Store never get one; file:// only with the optional file-access
// grant). Preferences stay editable everywhere.
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
    // No tile is pressed before the first read, so defaults are never shown
    // as if they were the user's saved choice.
    for (const mode of Object.keys(MODE_VALUES)) {
        byId(`mode-${mode}`).setAttribute('aria-pressed', String(popupSettingsLoaded && selected === mode))
        byId(`mode-${mode}`).disabled = !canEdit(MODE_KEYS)
    }
    // A two-state switch has no neutral rendering; it shows Off until the first
    // read but stays disabled, so the user cannot act on the placeholder.
    for (const [name, key] of [['cover', POPUP_KEYS.wordCover], ['preview', POPUP_KEYS.previewEnabled]]) {
        const enabled = popupSettings[key] === true
        byId(`${name}-toggle`).setAttribute('aria-pressed', String(enabled))
        byId(`${name}-toggle`).disabled = !canEdit([key])
        byId(`${name}-state`).textContent = enabled ? 'On ✓' : 'Off −'
    }
    const domain = currentDomain()
    // Hosts the rule parser rejects (e.g. 'localhost', no dot) get no rule
    // editor even though page actions still work there.
    const canEditRule = popupPolicy.parseSiteRule(domain).valid && canEdit(RULE_KEYS)
    byId('change-site-rule').disabled = !canEditRule
    byId('site-rule-select').disabled = !canEditRule
    byId('site-rule-label').textContent = domain ? `Rule for ${domain}` : 'Rule for this domain'
    // The select edits only a rule for exactly this host. A parent-domain or
    // path rule that also applies is reported by renderSiteStatus, not here.
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
        // A hover-preview change only restyles media the content script has already
        // decided about, so it is the one save that skips the status and matched-word
        // re-read; everything else may change what the page reports.
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
    // The 20-word cap is a product limit inherited from the original Tagify
    // maxTags setting and documented in README.md; it is not a storage-quota
    // bound. The settings page, README and settings-races test enforce the same
    // number; change them together.
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
    // Replace only the rule for exactly this host so parent-domain, path and
    // other-host rules survive. Both lists are written in one call so a host
    // can never end up on both at once.
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
    // Also abandon the result if any settings read started meanwhile: the
    // status must describe the newest settings, not the ones at call time.
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

// Manual page actions act on the active tab only and never touch stored
// preferences; unlike a mode or site-rule change they do not survive a reload
// and do not affect other tabs. Revealing is still done by the content script.
async function runActiveTabCommand(type) {
    if (!popupSettingsLoaded || pageActionPending || !supportedPage(activeTab?.url)) return
    pageActionPending = true
    renderControls()
    const result = byId('action-result')
    result.hidden = false
    result.textContent = 'Applying to this page…'
    try {
        // Re-query rather than trust activeTab: the user may have switched tabs
        // since the last status read, and the action must hit the tab they see.
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

// Re-arms only after the previous query settles, so polls never overlap.
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
            // Only the top frame answers getTriggeredWords (js.js returns false
            // elsewhere). Without frameId Chrome delivers to every frame and the
            // first reply wins. Words found only inside an iframe are not listed.
            return sendTabMessage(tabs[0].id, { target: 'content', type: 'getTriggeredWords' }, { frameId: 0 })
        })
        // A timeout resolves to null ("analysis unavailable") instead of
        // rejecting, so a slow tab does not log an error on every poll.
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
    // This runs every poll; rebuild the list only when the words changed so
    // the DOM is not churned under the user's pointer or screen reader.
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
    // Both disclosures start collapsed; the legacy *Collapsed storage keys
    // are no longer read or written.
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
    // A mode, word, cover or rule change makes the content script re-resolve
    // protection, so an analysis reply already in flight may describe the old
    // settings; drop it. (A preview-only change just restyles; the bump is cheap.)
    popupAnalysisRevision += 1
    keys.forEach(key => keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1))
    if (!popupSettingsLoaded) {
        popupReader.invalidate()
        return
    }
    // Lock the changed keys until a fresh read of them lands; an edit based on
    // the old value would overwrite what the other page just saved.
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
