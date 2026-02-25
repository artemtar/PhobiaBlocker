// Create context menu and initialize storage on extension install/update
chrome.runtime.onInstalled.addListener((details) => {
    // Create context menu
    chrome.contextMenus.create({
        id: 'phobia-blocker-unblur',
        title: 'Unblur',
        contexts: ['all']
    })

    // Only initialize storage on FIRST install, never on update
    if (details.reason === 'install') {
        // Set default values only if they don't already exist
        chrome.storage.sync.get([
            'targetWords',
            'phobiaBlockerEnabled',
            'blurIsAlwaysOn'
        ], (storage) => {
            const defaults = {}

            // Only set defaults for values that don't exist
            if (storage.targetWords === undefined) {
                defaults.targetWords = ['clown', 'mice', 'spider']
            }
            if (storage.phobiaBlockerEnabled === undefined) {
                defaults.phobiaBlockerEnabled = true
            }
            if (storage.blurIsAlwaysOn === undefined) {
                defaults.blurIsAlwaysOn = false
            }

            // Only write if there are defaults to set
            if (Object.keys(defaults).length > 0) {
                chrome.storage.sync.set(defaults)
            }
        })
    }
    // On 'update' or 'chrome_update', do NOT modify storage - preserve user data
})

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'phobia-blocker-unblur') {
        chrome.tabs.sendMessage(tab.id, { type: 'unblur' }).catch(() => {
            // Silently ignore - content script not available on this page
        })
    }
})

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
            if (command === 'blur-all') {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'blurAll' }, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            } else if (command === 'unblur-all') {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'unblurAll' }, () => {
                    if (chrome.runtime.lastError) {
                        // Silently ignore - content script not available on this page
                    }
                })
            }
        }
    })
})