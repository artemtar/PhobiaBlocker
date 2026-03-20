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

// Pre-render all tinted icon variants at service worker startup.
// Storing ImageData objects means the message handler can call setIcon synchronously
// without any async work (which risks the service worker being killed mid-operation).
// Exposed on globalThis so tests can inspect preloaded ImageData via swWorker.evaluate()
globalThis._tintedIcons = {}
const _tintedIcons = globalThis._tintedIcons   // local alias for all code below

async function _preloadTintedIcons() {
    const VARIANTS = [
        { status: 'processing', color: '#F5A623' },   // amber/yellow
        { status: 'detected',   color: '#E53935' },   // red
    ]
    for (const size of [16, 48, 128]) {
        const resp = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))
        const blob = await resp.blob()
        const bitmap = await createImageBitmap(blob)
        // Store original icon as imageData for idle state (path-based setIcon fails in service workers)
        const origCanvas = new OffscreenCanvas(size, size)
        origCanvas.getContext('2d').drawImage(bitmap, 0, 0, size, size)
        _tintedIcons[`idle_${size}`] = origCanvas.getContext('2d').getImageData(0, 0, size, size)
        for (const { status, color } of VARIANTS) {
            const canvas = new OffscreenCanvas(size, size)
            const ctx = canvas.getContext('2d')
            // Draw the original icon first
            ctx.drawImage(bitmap, 0, 0, size, size)
            // "color" blend: takes hue+saturation from fill, keeps luminosity from icon.
            // This preserves the eye/shield detail as luminosity contrast while tinting the hue.
            ctx.globalCompositeOperation = 'color'
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
            ctx.fill()
            _tintedIcons[`${status}_${size}`] = ctx.getImageData(0, 0, size, size)
        }
    }
}

// Start preloading immediately. Keep the promise so the message handler can
// await it when the service worker was just restarted by an incoming message
// (race: preload is still in flight when the handler fires).
const _preloadPromise = _preloadTintedIcons().catch(() => {})

// Update the toolbar icon for the sending tab based on analysis status
chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type !== 'iconStatus') return
    const tabId = sender.tab?.id
    if (!tabId) return

    _preloadPromise.then(() => {
        const i16  = _tintedIcons[`${message.status}_16`]
        const i48  = _tintedIcons[`${message.status}_48`]
        const i128 = _tintedIcons[`${message.status}_128`]
        if (!i16 || !i48 || !i128) return   // unknown status; skip

        chrome.action.setIcon({
            imageData: { 16: i16, 48: i48, 128: i128 },
            tabId
        }).catch(() => {})
    })
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
