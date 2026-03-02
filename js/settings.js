// Settings Page Logic - PhobiaBlocker
// Handles: Debug mode toggle, keyboard shortcuts link, navigation, version display

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    loadDebugMode()
    initializeEventListeners()
    initializeNavigation()
    displayVersion()
})

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

    // Configure shortcuts button
    document.getElementById('configure-shortcuts-btn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
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

// Listen for storage changes from other sources
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        if (changes.debugMode) {
            document.getElementById('debug-switch').checked = changes.debugMode.newValue || false
        }
    }
})
