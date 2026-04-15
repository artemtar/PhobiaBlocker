// Settings Page Logic - PhobiaBlocker
// Handles: Debug mode toggle, keyboard shortcuts link, navigation, version display, site rules

// State
let whitelistedSites = []
let blacklistedSites = []
const DEFAULT_PREVIEW_BLUR_STRENGTH = 5

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    loadDebugMode()
    loadPreviewSettings()
    loadSiteRules()
    loadKeyboardShortcuts()
    initializeEventListeners()
    initializeNavigation()
    displayVersion()
})

// Update the live preview demo box and slider fill to reflect the given blur strength
function updatePreviewBlurDemo(strength) {
    const demo = document.getElementById('preview-blur-demo')
    if (demo) demo.style.filter = `blur(${strength}px)`

    const slider = document.getElementById('preview-strength-slider')
    if (slider) {
        const pct = (strength / parseInt(slider.max)) * 100
        slider.style.background = `linear-gradient(to right, #1976d2 ${pct}%, #e0e0e0 ${pct}%)`
    }
}

// Load preview settings
function loadPreviewSettings() {
    chrome.storage.sync.get(['previewEnabled', 'previewBlurStrength'], (storage) => {
        const previewSwitch = document.getElementById('preview-switch')
        const previewSlider = document.getElementById('preview-strength-slider')
        const previewStrengthItem = document.getElementById('preview-strength-item')

        const enabled = storage.previewEnabled !== undefined ? storage.previewEnabled : true
        const strength = storage.previewBlurStrength !== undefined ? storage.previewBlurStrength : DEFAULT_PREVIEW_BLUR_STRENGTH

        previewSwitch.checked = enabled
        previewSlider.value = strength
        previewStrengthItem.style.display = enabled ? '' : 'none'
        updatePreviewBlurDemo(strength)
    })
}

// Load debug mode setting
function loadDebugMode() {
    chrome.storage.sync.get('debugMode', (storage) => {
        const debugSwitch = document.getElementById('debug-switch')
        debugSwitch.checked = storage.debugMode || false
    })
}

// Initialize all event listeners
function initializeEventListeners() {
    // Debug mode switch
    document.getElementById('debug-switch').addEventListener('change', (e) => {
        const debugMode = e.target.checked
        chrome.storage.sync.set({ debugMode: debugMode })

        // Notify all tabs to enable/disable debug logging
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    type: 'debugModeChanged',
                    value: debugMode
                }, () => {
                    // Ignore errors for tabs without content script
                    if (chrome.runtime.lastError) {}
                })
            })
        })
    })

    // Preview toggle switch
    document.getElementById('preview-switch').addEventListener('change', (e) => {
        const previewEnabled = e.target.checked
        const previewStrengthItem = document.getElementById('preview-strength-item')
        previewStrengthItem.style.display = previewEnabled ? '' : 'none'
        chrome.storage.sync.set({ previewEnabled }, () => {
            notifyPreviewSettingsChanged({ previewEnabled })
        })
    })

    // Preview blur strength slider
    document.getElementById('preview-strength-slider').addEventListener('input', (e) => {
        const strength = parseInt(e.target.value, 10)
        updatePreviewBlurDemo(strength)
        chrome.storage.sync.set({ previewBlurStrength: strength }, () => {
            notifyPreviewSettingsChanged({ previewBlurStrength: strength })
        })
    })

    // Configure shortcuts button
    document.getElementById('configure-shortcuts-btn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
    })

    // Whitelist add button
    document.getElementById('add-whitelist-btn').addEventListener('click', addToWhitelist)

    // Whitelist Enter key
    document.getElementById('whitelist-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            addToWhitelist()
        }
    })

    // Blacklist add button
    document.getElementById('add-blacklist-btn').addEventListener('click', addToBlacklist)

    // Blacklist Enter key
    document.getElementById('blacklist-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            addToBlacklist()
        }
    })
}

// Initialize navigation highlighting
function initializeNavigation() {
    const navLinks = document.querySelectorAll('.nav-link')
    const sections = document.querySelectorAll('.settings-section')

    // Smooth scroll to sections
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault()
            const targetId = link.getAttribute('href').substring(1)
            const targetSection = document.getElementById(targetId)

            if (targetSection) {
                targetSection.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                })

                // Update active state
                updateActiveNavLink(link)
            }
        })
    })

    // Highlight current section on scroll
    const observerOptions = {
        root: null,
        rootMargin: '-100px 0px -80% 0px',
        threshold: 0
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const id = entry.target.getAttribute('id')
                const correspondingLink = document.querySelector(`.nav-link[href="#${id}"]`)
                if (correspondingLink) {
                    updateActiveNavLink(correspondingLink)
                }
            }
        })
    }, observerOptions)

    sections.forEach(section => {
        observer.observe(section)
    })

    // Handle hash navigation on page load
    if (window.location.hash) {
        const targetLink = document.querySelector(`.nav-link[href="${window.location.hash}"]`)
        if (targetLink) {
            setTimeout(() => {
                targetLink.click()
            }, 100)
        }
    }
}

// Update active navigation link
function updateActiveNavLink(activeLink) {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active')
    })
    activeLink.classList.add('active')
}

// Display version from manifest
function displayVersion() {
    const manifestData = chrome.runtime.getManifest()
    const versionSpan = document.getElementById('version-number')
    if (versionSpan) {
        versionSpan.textContent = manifestData.version
    }
}

// Convert keyboard shortcut symbols to readable text
function formatShortcutText(shortcut) {
    if (!shortcut) return ''

    // Convert macOS symbols to readable text
    return shortcut
        .replace(/⌘/g, 'Command+')
        .replace(/⌥/g, 'Alt+')
        .replace(/⇧/g, 'Shift+')
        .replace(/⌃/g, 'Ctrl+')
        // Remove trailing + if present
        .replace(/\+$/, '')
}

// Load keyboard shortcuts from Chrome
function loadKeyboardShortcuts() {
    chrome.commands.getAll((commands) => {
        const shortcutsList = document.getElementById('shortcuts-list')

        if (!shortcutsList) return

        // Clear loading message
        shortcutsList.innerHTML = ''

        if (commands.length === 0) {
            // No commands defined
            shortcutsList.innerHTML = '<div class="shortcut-item"><span class="shortcut-label">No shortcuts configured</span></div>'
            return
        }

        // User-friendly names for commands
        const commandLabels = {
            '_execute_action': 'Open PhobiaBlocker Popup',
            'blur-all': 'Blur All Visual Content',
            'unblur-all': 'Unblur All Visual Content'
        }

        // Display each command with its current shortcut
        commands.forEach(command => {
            const shortcutItem = document.createElement('div')
            shortcutItem.className = 'shortcut-item'

            // Create label with user-friendly name
            const label = document.createElement('span')
            label.className = 'shortcut-label'

            // Use custom label if available, otherwise use description or name
            const displayName = commandLabels[command.name] || command.description || command.name
            label.textContent = displayName

            // Create shortcut keys display
            const keys = document.createElement('span')
            keys.className = 'shortcut-keys'

            if (command.shortcut) {
                // Shortcut is set - convert symbols to readable text
                keys.textContent = formatShortcutText(command.shortcut)
            } else {
                // No shortcut set - show "Not set" with gray styling
                keys.textContent = 'Not set'
                keys.style.opacity = '0.5'
                keys.style.fontStyle = 'italic'
            }

            shortcutItem.appendChild(label)
            shortcutItem.appendChild(keys)
            shortcutsList.appendChild(shortcutItem)
        })
    })
}

// Load site rules from storage
function loadSiteRules() {
    chrome.storage.sync.get(['whitelistedSites', 'blacklistedSites'], (storage) => {
        whitelistedSites = storage.whitelistedSites || []
        blacklistedSites = storage.blacklistedSites || []
        renderWhitelist()
        renderBlacklist()
    })
}

// Render whitelist
function renderWhitelist() {
    const container = document.getElementById('whitelist-container')
    container.innerHTML = ''

    whitelistedSites.forEach((site, index) => {
        const siteItem = createSiteItem(site, index, 'whitelist')
        container.appendChild(siteItem)
    })
}

// Render blacklist
function renderBlacklist() {
    const container = document.getElementById('blacklist-container')
    container.innerHTML = ''

    blacklistedSites.forEach((site, index) => {
        const siteItem = createSiteItem(site, index, 'blacklist')
        container.appendChild(siteItem)
    })
}

// Create site item element
function createSiteItem(site, index, listType) {
    const div = document.createElement('div')
    div.className = 'site-item'
    div.textContent = site

    const removeBtn = document.createElement('button')
    removeBtn.className = 'site-item-remove'
    removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    removeBtn.title = `Remove ${site}`
    removeBtn.addEventListener('click', () => {
        removeSiteFromList(index, listType)
    })

    div.appendChild(removeBtn)
    return div
}

// Add site to whitelist
function addToWhitelist() {
    const input = document.getElementById('whitelist-input')
    const site = input.value.trim().toLowerCase()

    if (!site) return
    if (whitelistedSites.includes(site)) {
        alert('This site is already in the whitelist')
        return
    }
    if (!isValidSitePattern(site)) {
        alert('Please enter a valid domain or URL pattern (e.g., example.com, *.example.com)')
        return
    }

    whitelistedSites.push(site)
    chrome.storage.sync.set({ whitelistedSites: whitelistedSites })
    renderWhitelist()
    input.value = ''
    notifyTabsToReload()
}

// Add site to blacklist
function addToBlacklist() {
    const input = document.getElementById('blacklist-input')
    const site = input.value.trim().toLowerCase()

    if (!site) return
    if (blacklistedSites.includes(site)) {
        alert('This site is already in the blacklist')
        return
    }
    if (!isValidSitePattern(site)) {
        alert('Please enter a valid domain or URL pattern (e.g., example.com, *.example.com)')
        return
    }

    blacklistedSites.push(site)
    chrome.storage.sync.set({ blacklistedSites: blacklistedSites })
    renderBlacklist()
    input.value = ''
    notifyTabsToReload()
}

// Remove site from list
function removeSiteFromList(index, listType) {
    if (listType === 'whitelist') {
        whitelistedSites.splice(index, 1)
        chrome.storage.sync.set({ whitelistedSites: whitelistedSites })
        renderWhitelist()
    } else if (listType === 'blacklist') {
        blacklistedSites.splice(index, 1)
        chrome.storage.sync.set({ blacklistedSites: blacklistedSites })
        renderBlacklist()
    }
    notifyTabsToReload()
}

// Validate site pattern
function isValidSitePattern(pattern) {
    // Allow patterns like: example.com, *.example.com, example.com/path
    const domainRegex = /^(\*\.)?[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,}(\/.*)?$/i
    return domainRegex.test(pattern)
}

// Notify all tabs that preview settings changed
function notifyPreviewSettingsChanged(overrides = {}) {
    chrome.storage.sync.get(['previewEnabled', 'previewBlurStrength'], (storage) => {
        const previewEnabled = overrides.previewEnabled !== undefined
            ? overrides.previewEnabled
            : (storage.previewEnabled !== undefined ? storage.previewEnabled : true)
        const previewBlurStrength = overrides.previewBlurStrength !== undefined
            ? overrides.previewBlurStrength
            : (storage.previewBlurStrength !== undefined ? storage.previewBlurStrength : DEFAULT_PREVIEW_BLUR_STRENGTH)
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    type: 'previewSettingsChanged',
                    previewEnabled,
                    previewBlurStrength
                }, () => {
                    if (chrome.runtime.lastError) {}
                })
            })
        })
    })
}

// Notify all tabs to reload/recheck site rules
function notifyTabsToReload() {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
                type: 'siteRulesChanged'
            }, () => {
                if (chrome.runtime.lastError) {}
            })
        })
    })
}

// Listen for storage changes from other sources
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        if (changes.debugMode) {
            document.getElementById('debug-switch').checked = changes.debugMode.newValue || false
        }
        if (changes.previewEnabled !== undefined) {
            const enabled = changes.previewEnabled.newValue !== undefined ? changes.previewEnabled.newValue : true
            document.getElementById('preview-switch').checked = enabled
            document.getElementById('preview-strength-item').style.display = enabled ? '' : 'none'
        }
        if (changes.previewBlurStrength !== undefined) {
            const strength = changes.previewBlurStrength.newValue !== undefined
                ? changes.previewBlurStrength.newValue
                : DEFAULT_PREVIEW_BLUR_STRENGTH
            document.getElementById('preview-strength-slider').value = strength
            updatePreviewBlurDemo(strength)
        }
        if (changes.whitelistedSites) {
            whitelistedSites = changes.whitelistedSites.newValue || []
            renderWhitelist()
        }
        if (changes.blacklistedSites) {
            blacklistedSites = changes.blacklistedSites.newValue || []
            renderBlacklist()
        }
    }
})
