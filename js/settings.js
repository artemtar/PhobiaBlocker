// Settings Page Logic - PhobiaBlur

const settingsPolicy = globalThis.PhobiaBlockerPolicy
const settingsStorage = globalThis.PhobiaBlockerStorage
const settingsUi = globalThis.PhobiaBlockerSettingsUi

if (!settingsPolicy || !settingsStorage || !settingsUi) {
    throw new Error('Shared policy, storage and settings-ui scripts must load before settings.js')
}

const SETTINGS_KEYS = settingsPolicy.STORAGE_KEYS
// Edit locks mirror the popup: settingsWritesPending (write in flight),
// settingsRefreshRequired (changed in storage, not yet re-read) and
// settingsKeyRevisions (bumped per change so a late write callback cannot
// paint a stale value). settingsLoadGeneration is bumped by every (re)load so
// refresh callbacks started before a retry are ignored; the retry re-reads all.
let settingsState = {}
let settingsLoaded = false
let settingsLoading = false
let settingsLoadGeneration = 0
let settingsErrorSource = null
const settingsReader = settingsUi.createRevisionedReader(settingsStorage)
const settingsRefreshRequired = new Set()
const settingsWritesPending = new Set()
const settingsKeyRevisions = new Map()
const debugSettings = settingsPolicy.createDebugLogger('settings', () => settingsState.debugMode === true)
const MODE_KEYS = [SETTINGS_KEYS.enabled, SETTINGS_KEYS.alwaysBlur]
const CHECKBOX_CONTROLS = Object.freeze({
    [SETTINGS_KEYS.wordCover]: 'word-cover-switch',
    [SETTINGS_KEYS.debugMode]: 'debug-switch',
    [SETTINGS_KEYS.previewEnabled]: 'preview-switch',
    [SETTINGS_KEYS.keepCrossOriginIframesBlurred]: 'cross-origin-iframe-switch',
})
const SLIDER_CONTROLS = Object.freeze({
    [SETTINGS_KEYS.blurAmount]: 'blur-strength-slider',
    [SETTINGS_KEYS.previewStrength]: 'preview-strength-slider',
})
const SETTINGS_SECTIONS = Object.freeze({
    protection: 'Protection & preview',
    words: 'Trigger words',
    'site-rules': 'Site rules',
    shortcuts: 'Keyboard shortcuts',
    help: 'Help & diagnostics',
})

// Each key uses the same renderer for initial load, writes and live refreshes.
const SETTINGS_RENDERERS = Object.freeze({
    [SETTINGS_KEYS.enabled]: renderProtectionMode,
    [SETTINGS_KEYS.alwaysBlur]: renderProtectionMode,
    [SETTINGS_KEYS.wordCover]: value => { document.getElementById('word-cover-switch').checked = value },
    [SETTINGS_KEYS.debugMode]: value => { document.getElementById('debug-switch').checked = value },
    [SETTINGS_KEYS.previewEnabled]: value => {
        document.getElementById('preview-switch').checked = value
        document.getElementById('preview-strength-item').hidden = !value
    },
    [SETTINGS_KEYS.blurAmount]: value => updateBlurDemo(SETTINGS_KEYS.blurAmount, value),
    [SETTINGS_KEYS.previewStrength]: value => updateBlurDemo(SETTINGS_KEYS.previewStrength, value),
    [SETTINGS_KEYS.keepCrossOriginIframesBlurred]: value => {
        document.getElementById('cross-origin-iframe-switch').checked = value
    },
    [SETTINGS_KEYS.targetWords]: renderTargetWords,
    [SETTINGS_KEYS.whitelist]: () => renderSiteList('whitelist'),
    [SETTINGS_KEYS.blacklist]: () => renderSiteList('blacklist'),
})
const SETTINGS_PAGE_KEYS = Object.keys(SETTINGS_RENDERERS)

document.addEventListener('DOMContentLoaded', () => {
    void initializeSettingsPage()
})

async function initializeSettingsPage() {
    initializeNavigation()
    initializeEventListeners()
    loadKeyboardShortcuts()
    displayVersion()
    await loadSettings()
}

async function loadSettings() {
    // A reload during a write would race that write's callback. The retry button
    // is disabled in that state too; this guard is the backstop.
    if (settingsLoading || settingsWritesPending.size > 0) return
    settingsLoading = true
    // Dropping settingsLoaded disables every control until the full read lands.
    settingsLoaded = false
    settingsLoadGeneration += 1
    clearSettingsError(true)
    updateSettingsControls()
    try {
        const values = await settingsReader.loadAll(SETTINGS_PAGE_KEYS)
        // A complete read supersedes every pending per-key refresh; their late
        // callbacks are also dropped by the generation check.
        settingsRefreshRequired.clear()
        settingsLoaded = true
        applySettings(values)
        debugSettings('settings.loaded', () => ({ keys: SETTINGS_PAGE_KEYS }))
    } catch (error) {
        showSettingsError('Could not read settings. Editing is paused. Retry loading to continue.')
        console.error('PhobiaBlur: settings read failed', error)
    } finally {
        settingsLoading = false
        updateSettingsControls()
    }
}

function showSettingsError(message, source = 'action') {
    settingsErrorSource = source
    const element = document.getElementById('settings-error')
    element.textContent = message
    element.hidden = false
    updateSaveStatus()
}

function clearSettingsError(force = false) {
    // A successful unrelated edit must not hide a failed refresh warning.
    if (!force && settingsRefreshRequired.size > 0) return
    settingsErrorSource = null
    const element = document.getElementById('settings-error')
    element.textContent = ''
    element.hidden = true
    updateSaveStatus()
}

function updateSaveStatus() {
    document.getElementById('settings-save-status').textContent = !settingsLoaded
        ? (settingsLoading ? 'Loading…' : 'Unavailable')
        : settingsWritesPending.size > 0 ? 'Saving…'
            : !document.getElementById('settings-error').hidden ? 'Needs attention'
                : settingsRefreshRequired.size > 0 ? 'Updating…' : 'Saved'
}

function canEditSettings(keys) {
    return settingsLoaded && keys.every(key => !settingsRefreshRequired.has(key) && !settingsWritesPending.has(key))
}

// Both site lists share one input and type selector, so a write to either
// list locks the whole site-rule editor, not just the list being written.
function siteWritePending() {
    return settingsWritesPending.has(SETTINGS_KEYS.whitelist) || settingsWritesPending.has(SETTINGS_KEYS.blacklist)
}

function updateSettingsControls() {
    for (const [key, id] of Object.entries({ ...CHECKBOX_CONTROLS, ...SLIDER_CONTROLS })) {
        document.getElementById(id).disabled = !canEditSettings([key])
    }
    document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = !canEditSettings(MODE_KEYS) })
    const selectedList = getSiteListConfig(document.getElementById('site-rule-type').value)
    const siteDisabled = siteWritePending() || !canEditSettings([selectedList.storageKey])
    document.getElementById('site-rule-input').disabled = siteDisabled
    document.getElementById('add-site-rule-btn').disabled = siteDisabled
    document.getElementById('site-rule-type').disabled = !settingsLoaded || siteWritePending()
    renderSiteList('whitelist')
    renderSiteList('blacklist')
    document.getElementById('site-rules-empty').hidden = !settingsLoaded ||
        (settingsState[SETTINGS_KEYS.whitelist]?.length || 0) + (settingsState[SETTINGS_KEYS.blacklist]?.length || 0) > 0
    renderTargetWords()
    const retry = document.getElementById('retry-settings-btn')
    retry.hidden = settingsLoading || (settingsLoaded && settingsRefreshRequired.size === 0)
    retry.disabled = settingsLoading || settingsWritesPending.size > 0
    updateSaveStatus()
}

function applySettings(values) {
    Object.assign(settingsState, values)
    Object.entries(values).forEach(([key, value]) => SETTINGS_RENDERERS[key](value))
    updateSettingsControls()
}

function renderProtectionMode() {
    const mode = settingsState[SETTINGS_KEYS.enabled] === false ? 'off'
        : settingsState[SETTINGS_KEYS.alwaysBlur] ? 'always' : 'smart'
    document.querySelectorAll('[data-mode]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
    })
    document.getElementById('default-mode-note').textContent = {
        smart: 'Blur media when page text matches your trigger words. Site rules override this choice.',
        always: 'Apply your blur setting even without matching words. Site rules override this choice.',
        off: 'Site rules can still keep media blurred.',
    }[mode]
}

function updateBlurDemo(key, value) {
    const preview = key === SETTINGS_KEYS.previewStrength
    const slider = document.getElementById(SLIDER_CONTROLS[key])
    slider.value = value
    settingsUi.setSliderProgress(slider, value)
    document.getElementById(preview ? 'preview-strength-value' : 'blur-strength-value').textContent =
        preview ? `${value} px` : `${value} / 100`
    document.getElementById(preview ? 'preview-blur-demo' : 'blur-demo').style.filter =
        `blur(${preview ? value : settingsPolicy.computeBlurPixels(value)}px)`
}

async function persistSettings(values) {
    const keys = Object.keys(values)
    if (!canEditSettings(keys)) return false
    const revisions = new Map(keys.map(key => [key, settingsKeyRevisions.get(key) || 0]))
    clearSettingsError()
    keys.forEach(key => settingsWritesPending.add(key))
    updateSettingsControls()
    try {
        const saved = await settingsStorage.set(values)
        // A newer storage change owns its key, even if its read completed
        // before this write callback. Never paint an older write over it.
        const current = Object.fromEntries(keys
            .filter(key => (settingsKeyRevisions.get(key) || 0) === revisions.get(key))
            .map(key => [key, saved[key]]))
        applySettings(current)
        debugSettings('settings.saved', () => ({ keys }))
        return true
    } catch (error) {
        // The control already shows the attempted value (checkbox ticked, slider
        // moved); repaint the committed state so the UI does not claim a change
        // that was never saved.
        keys.forEach(key => SETTINGS_RENDERERS[key](settingsState[key]))
        showSettingsError('Could not save this change. Your previous settings are still active.')
        console.error('PhobiaBlur: settings write failed', error)
        return false
    } finally {
        keys.forEach(key => settingsWritesPending.delete(key))
        updateSettingsControls()
    }
}

function initializeEventListeners() {
    for (const [key, id] of Object.entries(CHECKBOX_CONTROLS)) {
        document.getElementById(id).addEventListener('change', event => {
            if (!canEditSettings([key])) return
            if (key === SETTINGS_KEYS.previewEnabled) {
                document.getElementById('preview-strength-item').hidden = !event.target.checked
            }
            void persistSettings({ [key]: event.target.checked })
        })
    }
    for (const [key, id] of Object.entries(SLIDER_CONTROLS)) {
        const slider = document.getElementById(id)
        // input previews the strength live while dragging; only change (release)
        // writes, keeping storage.sync inside its per-minute write quota.
        slider.addEventListener('input', () => {
            if (canEditSettings([key])) updateBlurDemo(key, Number(slider.value))
        })
        slider.addEventListener('change', () => void persistSettings({ [key]: Number(slider.value) }))
    }
    document.querySelectorAll('[data-mode]').forEach(button => {
        button.addEventListener('click', () => {
            void persistSettings({
                [SETTINGS_KEYS.enabled]: button.dataset.mode !== 'off',
                [SETTINGS_KEYS.alwaysBlur]: button.dataset.mode === 'always',
            })
        })
    })
    // Extensions cannot rebind their own shortcuts, and chrome:// URLs cannot
    // be opened from a link, so hand the user to Chrome's page via tabs.create.
    document.getElementById('configure-shortcuts-btn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
    })
    document.getElementById('retry-settings-btn').addEventListener('click', () => void loadSettings())
    document.getElementById('site-rule-type').addEventListener('change', updateSettingsControls)
    document.getElementById('add-site-rule-btn').addEventListener('click', () => {
        void addToSiteList(document.getElementById('site-rule-type').value)
    })
    document.getElementById('site-rule-input').addEventListener('keydown', event => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        void addToSiteList(document.getElementById('site-rule-type').value)
    })
    document.getElementById('add-word-btn').addEventListener('click', () => void addTargetWord())
    document.getElementById('word-input').addEventListener('keydown', event => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        void addTargetWord()
    })
}

function getSiteListConfig(listType) {
    const storageKey = listType === 'blacklist' ? SETTINGS_KEYS.blacklist : SETTINGS_KEYS.whitelist
    return {
        storageKey,
        list: settingsState[storageKey] || [],
        label: listType === 'blacklist' ? 'Always blur media' : 'Pause automatic protection',
    }
}

// Stored lists are validated only as string arrays, so an entry an older
// parser accepted may be invalid today. Compare on the normalized form and
// fall back to the raw string so such an entry is compared literally (never
// as undefined) and still renders so the user can remove it.
function normalizedSiteRule(rule) {
    const parsed = settingsPolicy.parseSiteRule(rule)
    return parsed.valid ? parsed.normalized : String(rule)
}

async function addToSiteList(listType) {
    const config = getSiteListConfig(listType)
    if (siteWritePending() || !canEditSettings([config.storageKey])) return
    const input = document.getElementById('site-rule-input')
    const parsed = settingsPolicy.parseSiteRule(input.value)
    clearSettingsError()
    if (!parsed.valid) {
        showSettingsError(parsed.reason)
        return
    }
    if (config.list.some(rule => normalizedSiteRule(rule) === parsed.normalized)) {
        showSettingsError('This site rule is already saved.')
        return
    }
    if (await persistSettings({ [config.storageKey]: [...config.list, parsed.normalized] })) {
        input.value = ''
        input.focus()
    }
}

async function removeSiteFromList(index, listType) {
    const config = getSiteListConfig(listType)
    if (siteWritePending() || !canEditSettings([config.storageKey])) return
    const candidate = config.list.filter((site, siteIndex) => siteIndex !== index)
    if (await persistSettings({ [config.storageKey]: candidate })) {
        document.getElementById('site-rule-input').focus()
    }
}

function renderSiteList(listType) {
    const config = getSiteListConfig(listType)
    const container = document.getElementById(`${listType}-container`)
    container.innerHTML = ''
    config.list.forEach((site, index) => {
        const row = document.createElement('div')
        row.className = 'site-rule'
        const name = document.createElement('span')
        name.className = 'site-rule-name'
        name.textContent = site
        const mode = document.createElement('span')
        mode.className = 'site-rule-mode'
        mode.textContent = config.label
        row.append(name, mode, settingsUi.createRemoveButton({
            className: 'site-item-remove',
            label: `${site} (${config.label})`,
            disabled: siteWritePending() || !canEditSettings([config.storageKey]),
            onClick: () => void removeSiteFromList(index, listType),
        }))
        container.appendChild(row)
    })
}

function showWordError(message) {
    const element = document.getElementById('word-error')
    element.textContent = message
    element.hidden = !message
}

function renderTargetWords() {
    const words = settingsState[SETTINGS_KEYS.targetWords] || []
    const disabled = !canEditSettings([SETTINGS_KEYS.targetWords])
    document.getElementById('word-input').disabled = disabled
    document.getElementById('add-word-btn').disabled = disabled
    document.getElementById('word-count').textContent = settingsLoaded ? `${words.length} / 20` : '— / 20'
    const list = document.getElementById('word-list')
    list.innerHTML = ''
    words.forEach((word, index) => {
        const validation = settingsPolicy.validateTargetWord(word)
        const tag = document.createElement('span')
        tag.className = validation.valid ? 'tag' : 'tag tag-invalid'
        tag.title = validation.valid ? '' : `Invalid trigger: ${validation.reason}`
        tag.appendChild(document.createTextNode(String(word)))
        tag.appendChild(settingsUi.createRemoveButton({
            className: 'tag-remove',
            label: word,
            disabled,
            onClick: () => void removeTargetWord(index),
        }))
        list.appendChild(tag)
    })
    if (settingsLoaded && words.length === 0) list.textContent = 'No trigger words saved.'
}

async function addTargetWord() {
    if (!canEditSettings([SETTINGS_KEYS.targetWords])) return
    showWordError('')
    const input = document.getElementById('word-input')
    const validation = settingsPolicy.validateTargetWord(input.value)
    const words = settingsState[SETTINGS_KEYS.targetWords]
    if (!validation.valid) return showWordError(validation.reason)
    // The 20-word cap is a product limit inherited from the original Tagify
    // maxTags setting and documented in README.md; it is not a storage-quota
    // bound. The popup, README and settings-races test enforce the same number;
    // change them together.
    if (words.length >= 20) return showWordError('You can store up to 20 trigger words.')
    if (words.some(word => settingsPolicy.validateTargetWord(word).normalized === validation.normalized)) {
        return showWordError('That trigger word is already in your list.')
    }
    if (await persistSettings({ [SETTINGS_KEYS.targetWords]: [...words, validation.normalized] })) {
        input.value = ''
        input.focus()
    }
}

async function removeTargetWord(index) {
    if (!canEditSettings([SETTINGS_KEYS.targetWords])) return
    showWordError('')
    const words = settingsState[SETTINGS_KEYS.targetWords].filter((word, wordIndex) => wordIndex !== index)
    if (await persistSettings({ [SETTINGS_KEYS.targetWords]: words })) document.getElementById('word-input').focus()
}

function initializeNavigation() {
    const showSection = (hash, focus = false) => {
        // Hashes from the pre-1.3.1 layout (separate hover-preview, about and debug
        // sections) still land on the section that absorbed them, so old bookmarks
        // keep working; no page in the repo links to them. Unknown hashes fall back
        // to the site-rules landing page.
        const aliases = { 'hover-preview': 'protection', about: 'help', debug: 'help' }
        const requested = hash.replace(/^#/, '')
        const section = aliases[requested] || requested
        const selected = Object.hasOwn(SETTINGS_SECTIONS, section) ? section : 'site-rules'
        for (const name of Object.keys(SETTINGS_SECTIONS)) document.getElementById(name).hidden = name !== selected
        document.getElementById('settings-title').textContent = SETTINGS_SECTIONS[selected]
        document.querySelectorAll('.nav-link').forEach(link => {
            const active = link.getAttribute('href') === `#${selected}`
            link.classList.toggle('active', active)
            if (active) link.setAttribute('aria-current', 'page')
            else link.removeAttribute('aria-current')
        })
        if (focus) document.getElementById('settings-title').focus()
    }
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', event => {
            event.preventDefault()
            const hash = link.getAttribute('href')
            // Setting the hash also fires hashchange, which re-renders without
            // moving focus; the direct call focuses the heading for keyboard users.
            window.location.hash = hash
            showSection(hash, true)
        })
    })
    window.addEventListener('hashchange', () => showSection(window.location.hash))
    showSection(window.location.hash)
}

function displayVersion() {
    document.getElementById('version-number').textContent = chrome.runtime.getManifest().version
}

// chrome.commands reports macOS shortcuts with modifier glyphs; spell them out
// so the list reads the same on every platform.
function formatShortcutText(shortcut) {
    return shortcut.replace(/⌘/g, 'Command+').replace(/⌥/g, 'Alt+')
        .replace(/⇧/g, 'Shift+').replace(/⌃/g, 'Ctrl+').replace(/\+$/, '')
}

function loadKeyboardShortcuts() {
    chrome.commands.getAll(commands => {
        const list = document.getElementById('shortcuts-list')
        list.innerHTML = ''
        if (commands.length === 0) {
            list.textContent = 'No shortcuts configured.'
            return
        }
        const labels = {
            '_execute_action': 'Open PhobiaBlur popup',
            'blur-all': 'Blur media on the current page',
            'unblur-all': 'Reveal current content',
            'toggle-word-cover': 'Toggle saved word-cover preference',
        }
        commands.forEach(command => {
            const row = document.createElement('div')
            row.className = 'shortcut-item'
            const label = document.createElement('span')
            label.textContent = labels[command.name] || command.description || command.name
            const keys = document.createElement(command.shortcut ? 'kbd' : 'span')
            keys.className = command.shortcut ? 'shortcut-keys' : 'setting-description'
            keys.textContent = command.shortcut ? formatShortcutText(command.shortcut) : 'Not set'
            row.append(label, keys)
            list.appendChild(row)
        })
    })
}

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') return
    const changedKeys = SETTINGS_PAGE_KEYS.filter(key => changes[key])
    if (changedKeys.length === 0) return
    changedKeys.forEach(key => settingsKeyRevisions.set(key, (settingsKeyRevisions.get(key) || 0) + 1))
    if (!settingsLoaded) {
        settingsReader.invalidate()
        return
    }
    changedKeys.forEach(key => settingsRefreshRequired.add(key))
    updateSettingsControls()
    const loadGeneration = settingsLoadGeneration
    // Read defaults and legacy values through storage, and leave failed keys
    // locked until a current read succeeds or the user retries loading.
    void settingsReader.refresh(changedKeys, values => {
        if (loadGeneration !== settingsLoadGeneration) return
        Object.keys(values).forEach(key => settingsRefreshRequired.delete(key))
        // Only a refresh-caused alert clears itself once every affected key has
        // a current value; an action error stays until the user acts again.
        if (settingsRefreshRequired.size === 0 && settingsErrorSource === 'refresh') clearSettingsError()
        applySettings(values)
        debugSettings('settings.refreshed', () => ({ keys: Object.keys(values) }))
    }, error => {
        if (loadGeneration !== settingsLoadGeneration) return
        showSettingsError('Could not refresh settings. Affected controls stay locked. Retry loading to continue.', 'refresh')
        updateSettingsControls()
        console.error('PhobiaBlur: settings storage refresh failed', error)
    })
})
