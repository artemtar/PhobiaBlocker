// Settings Page Logic - PhobiaBlocker

const settingsPolicy = globalThis.PhobiaBlockerPolicy
const settingsStorage = globalThis.PhobiaBlockerStorage

if (!settingsPolicy || !settingsStorage) {
    throw new Error('Shared policy and storage scripts must load before settings.js')
}

const SETTINGS_KEYS = settingsPolicy.STORAGE_KEYS
let settingsState = {}
let whitelistedSites = []
let blacklistedSites = []
let siteListWritePending = false

document.addEventListener('DOMContentLoaded', () => {
    void initializeSettingsPage()
})

async function initializeSettingsPage() {
    initializeNavigation()
    initializeEventListeners()
    loadKeyboardShortcuts()
    displayVersion()

    try {
        settingsState = await settingsStorage.getWithDefaults([
            SETTINGS_KEYS.debugMode,
            SETTINGS_KEYS.previewEnabled,
            SETTINGS_KEYS.previewStrength,
            SETTINGS_KEYS.whitelist,
            SETTINGS_KEYS.blacklist,
            SETTINGS_KEYS.keepCrossOriginIframesBlurred,
        ])
        whitelistedSites = [...settingsState.whitelistedSites]
        blacklistedSites = [...settingsState.blacklistedSites]
        renderSettingsState()
    } catch (error) {
        showSettingsError('Could not read settings. Protection will remain in its fail-safe state.')
        console.error('PhobiaBlocker: settings read failed', error)
        setSettingsControlsDisabled(true)
    }
}

function showSettingsError(message) {
    const errorElement = document.getElementById('settings-error')
    if (!errorElement) return
    errorElement.textContent = message
    errorElement.hidden = false
}

function clearSettingsError() {
    const errorElement = document.getElementById('settings-error')
    if (!errorElement) return
    errorElement.textContent = ''
    errorElement.hidden = true
}

function setSettingsControlsDisabled(disabled) {
    document.querySelectorAll('input, button').forEach(element => {
        if (element.id === 'configure-shortcuts-btn') return
        element.disabled = disabled
    })
}

function renderSettingsState() {
    const debugSwitch = document.getElementById('debug-switch')
    const previewSwitch = document.getElementById('preview-switch')
    const previewSlider = document.getElementById('preview-strength-slider')
    const previewStrengthItem = document.getElementById('preview-strength-item')
    const crossOriginSwitch = document.getElementById('cross-origin-iframe-switch')

    debugSwitch.checked = settingsState.debugMode
    previewSwitch.checked = settingsState.previewEnabled
    previewSlider.value = settingsState.previewBlurStrength
    previewStrengthItem.style.display = settingsState.previewEnabled ? '' : 'none'
    crossOriginSwitch.checked = settingsState.keepCrossOriginIframesBlurred
    updatePreviewBlurDemo(settingsState.previewBlurStrength)
    renderWhitelist()
    renderBlacklist()
}

function updatePreviewBlurDemo(strength) {
    const demo = document.getElementById('preview-blur-demo')
    if (demo) demo.style.filter = `blur(${strength}px)`

    const slider = document.getElementById('preview-strength-slider')
    if (!slider) return
    // The stylesheet owns the colours; only the fill position comes from here,
    // so the track stays correct in both light and dark mode.
    const pct = (strength / parseInt(slider.max, 10)) * 100
    slider.style.setProperty('--pb-progress', `${pct}%`)
}

async function persistCheckbox(element, storageKey) {
    const previous = settingsState[storageKey]
    const next = element.checked
    clearSettingsError()
    element.disabled = true

    try {
        const saved = await settingsStorage.set({ [storageKey]: next })
        settingsState[storageKey] = saved[storageKey]
        element.checked = saved[storageKey]
        return true
    } catch (error) {
        element.checked = previous
        showSettingsError('Could not save this setting. Your previous setting is still active.')
        console.error(`PhobiaBlocker: failed to save ${storageKey}`, error)
        return false
    } finally {
        element.disabled = false
    }
}

function initializeEventListeners() {
    document.getElementById('debug-switch').addEventListener('change', event => {
        void persistCheckbox(event.target, SETTINGS_KEYS.debugMode)
    })

    document.getElementById('preview-switch').addEventListener('change', event => {
        const previewStrengthItem = document.getElementById('preview-strength-item')
        const previousDisplay = previewStrengthItem.style.display
        previewStrengthItem.style.display = event.target.checked ? '' : 'none'
        void persistCheckbox(event.target, SETTINGS_KEYS.previewEnabled).then(saved => {
            if (!saved) previewStrengthItem.style.display = previousDisplay
        })
    })

    document.getElementById('preview-strength-slider').addEventListener('input', event => {
        updatePreviewBlurDemo(parseInt(event.target.value, 10))
    })

    document.getElementById('preview-strength-slider').addEventListener('change', event => {
        void persistPreviewStrength(event.target)
    })

    document.getElementById('cross-origin-iframe-switch').addEventListener('change', event => {
        void persistCheckbox(event.target, SETTINGS_KEYS.keepCrossOriginIframesBlurred)
    })

    document.getElementById('configure-shortcuts-btn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
    })

    document.getElementById('add-whitelist-btn').addEventListener('click', () => {
        void addToSiteList('whitelist')
    })
    document.getElementById('whitelist-input').addEventListener('keydown', event => {
        if (event.key === 'Enter') void addToSiteList('whitelist')
    })

    document.getElementById('add-blacklist-btn').addEventListener('click', () => {
        void addToSiteList('blacklist')
    })
    document.getElementById('blacklist-input').addEventListener('keydown', event => {
        if (event.key === 'Enter') void addToSiteList('blacklist')
    })
}

async function persistPreviewStrength(slider) {
    const previous = settingsState.previewBlurStrength
    const next = parseInt(slider.value, 10)
    clearSettingsError()
    slider.disabled = true

    try {
        const saved = await settingsStorage.set({ previewBlurStrength: next })
        settingsState.previewBlurStrength = saved.previewBlurStrength
        slider.value = saved.previewBlurStrength
        updatePreviewBlurDemo(saved.previewBlurStrength)
    } catch (error) {
        slider.value = previous
        updatePreviewBlurDemo(previous)
        showSettingsError('Could not save the preview strength. Your previous setting is still active.')
        console.error('PhobiaBlocker: failed to save preview strength', error)
    } finally {
        slider.disabled = false
    }
}

function getSiteListConfig(listType) {
    if (listType === 'blacklist') {
        return {
            storageKey: SETTINGS_KEYS.blacklist,
            input: document.getElementById('blacklist-input'),
            button: document.getElementById('add-blacklist-btn'),
            list: blacklistedSites,
            setList: value => { blacklistedSites = value },
            label: 'blacklist',
        }
    }

    return {
        storageKey: SETTINGS_KEYS.whitelist,
        input: document.getElementById('whitelist-input'),
        button: document.getElementById('add-whitelist-btn'),
        list: whitelistedSites,
        setList: value => { whitelistedSites = value },
        label: 'whitelist',
    }
}

function normalizedSiteRule(rule) {
    const parsed = settingsPolicy.parseSiteRule(rule)
    return parsed.valid ? parsed.normalized : String(rule)
}

async function addToSiteList(listType) {
    if (siteListWritePending) return
    const config = getSiteListConfig(listType)
    const parsed = settingsPolicy.parseSiteRule(config.input.value)
    clearSettingsError()

    if (!parsed.valid) {
        showSettingsError(parsed.reason)
        return
    }
    if (config.list.some(rule => normalizedSiteRule(rule) === parsed.normalized)) {
        showSettingsError(`This site is already in the ${config.label}.`)
        return
    }

    const candidate = [...config.list, parsed.normalized]
    siteListWritePending = true
    config.button.disabled = true
    config.input.disabled = true
    renderWhitelist()
    renderBlacklist()
    try {
        await settingsStorage.set({ [config.storageKey]: candidate })
        config.setList(candidate)
        config.input.value = ''
        renderSiteList(listType)
    } catch (error) {
        showSettingsError(`Could not save the ${config.label}. Nothing was changed.`)
        console.error(`PhobiaBlocker: failed to save ${config.label}`, error)
    } finally {
        siteListWritePending = false
        config.button.disabled = false
        config.input.disabled = false
        renderWhitelist()
        renderBlacklist()
    }
}

async function removeSiteFromList(index, listType) {
    if (siteListWritePending) return
    const config = getSiteListConfig(listType)
    const candidate = config.list.filter((site, siteIndex) => siteIndex !== index)
    clearSettingsError()
    siteListWritePending = true
    renderWhitelist()
    renderBlacklist()

    try {
        await settingsStorage.set({ [config.storageKey]: candidate })
        config.setList(candidate)
        renderSiteList(listType)
    } catch (error) {
        showSettingsError(`Could not update the ${config.label}. Nothing was changed.`)
        console.error(`PhobiaBlocker: failed to update ${config.label}`, error)
    } finally {
        siteListWritePending = false
        renderWhitelist()
        renderBlacklist()
    }
}

function renderSiteList(listType) {
    const config = getSiteListConfig(listType)
    const container = document.getElementById(`${listType}-container`)
    container.innerHTML = ''

    config.list.forEach((site, index) => {
        const item = document.createElement('div')
        item.className = 'site-item'
        item.textContent = site

        const removeButton = document.createElement('button')
        removeButton.className = 'site-item-remove'
        removeButton.disabled = siteListWritePending
        removeButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
        removeButton.title = `Remove ${site}`
        removeButton.addEventListener('click', () => {
            void removeSiteFromList(index, listType)
        })

        item.appendChild(removeButton)
        container.appendChild(item)
    })
}

function renderWhitelist() {
    renderSiteList('whitelist')
}

function renderBlacklist() {
    renderSiteList('blacklist')
}

function initializeNavigation() {
    const navLinks = document.querySelectorAll('.nav-link')
    const sections = document.querySelectorAll('.settings-section')

    navLinks.forEach(link => {
        link.addEventListener('click', event => {
            event.preventDefault()
            const targetSection = document.getElementById(link.getAttribute('href').substring(1))
            if (!targetSection) return
            targetSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
            updateActiveNavLink(link)
        })
    })

    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return
            const matchingLink = document.querySelector(`.nav-link[href="#${entry.target.id}"]`)
            if (matchingLink) updateActiveNavLink(matchingLink)
        })
    }, {
        root: null,
        rootMargin: '-100px 0px -80% 0px',
        threshold: 0,
    })

    sections.forEach(section => observer.observe(section))
    if (!window.location.hash) return
    const targetLink = document.querySelector(`.nav-link[href="${window.location.hash}"]`)
    if (targetLink) setTimeout(() => targetLink.click(), 100)
}

function updateActiveNavLink(activeLink) {
    document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'))
    activeLink.classList.add('active')
}

function displayVersion() {
    const versionSpan = document.getElementById('version-number')
    if (versionSpan) versionSpan.textContent = chrome.runtime.getManifest().version
}

function formatShortcutText(shortcut) {
    if (!shortcut) return ''
    return shortcut
        .replace(/⌘/g, 'Command+')
        .replace(/⌥/g, 'Alt+')
        .replace(/⇧/g, 'Shift+')
        .replace(/⌃/g, 'Ctrl+')
        .replace(/\+$/, '')
}

function loadKeyboardShortcuts() {
    chrome.commands.getAll(commands => {
        const shortcutsList = document.getElementById('shortcuts-list')
        shortcutsList.innerHTML = ''

        if (commands.length === 0) {
            shortcutsList.innerHTML = '<div class="shortcut-item"><span class="shortcut-label">No shortcuts configured</span></div>'
            return
        }

        const commandLabels = {
            '_execute_action': 'Open PhobiaBlocker Popup',
            'blur-all': 'Blur All Visual Content',
            'unblur-all': 'Unblur All Visual Content',
            'toggle-word-cover': 'Toggle Target Word Covers',
        }

        commands.forEach(command => {
            const item = document.createElement('div')
            item.className = 'shortcut-item'

            const label = document.createElement('span')
            label.className = 'shortcut-label'
            label.textContent = commandLabels[command.name] || command.description || command.name

            const keys = document.createElement('span')
            keys.className = 'shortcut-keys'
            keys.textContent = command.shortcut ? formatShortcutText(command.shortcut) : 'Not set'
            if (!command.shortcut) {
                keys.style.opacity = '0.5'
                keys.style.fontStyle = 'italic'
            }

            item.append(label, keys)
            shortcutsList.appendChild(item)
        })
    })
}

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') return

    const applyChange = (storageKey, callback) => {
        if (!changes[storageKey]) return
        const rawValue = changes[storageKey].newValue
        const value = rawValue === undefined ? settingsPolicy.DEFAULTS[storageKey] : rawValue
        if (!settingsPolicy.isValidStoredValue(storageKey, value)) {
            showSettingsError(`Stored ${storageKey} value is invalid. The previous value remains displayed.`)
            return
        }
        const storedValue = Array.isArray(value) ? [...value] : value
        settingsState[storageKey] = storedValue
        callback(storedValue)
    }

    applyChange(SETTINGS_KEYS.debugMode, value => {
        document.getElementById('debug-switch').checked = value
    })
    applyChange(SETTINGS_KEYS.previewEnabled, value => {
        document.getElementById('preview-switch').checked = value
        document.getElementById('preview-strength-item').style.display = value ? '' : 'none'
    })
    applyChange(SETTINGS_KEYS.previewStrength, value => {
        document.getElementById('preview-strength-slider').value = value
        updatePreviewBlurDemo(value)
    })
    applyChange(SETTINGS_KEYS.keepCrossOriginIframesBlurred, value => {
        document.getElementById('cross-origin-iframe-switch').checked = value
    })
    applyChange(SETTINGS_KEYS.whitelist, value => {
        whitelistedSites = [...value]
        renderWhitelist()
    })
    applyChange(SETTINGS_KEYS.blacklist, value => {
        blacklistedSites = [...value]
        renderBlacklist()
    })
})
