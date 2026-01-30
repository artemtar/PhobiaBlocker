// Create context menu on extension install/update
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'phobia-blocker-unblur',
        title: 'Unblur',
        contexts: ['all']
    })
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