const puppeteer = require('puppeteer')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { threadId } = require('worker_threads')

const EXTENSION_PATH = path.resolve(__dirname, '..')
const TEST_PAGES_PATH = path.resolve(__dirname, 'test-pages')
// Per-thread Chrome profile dir — Node's --test runner executes each test file in a
// separate worker thread (same process, different threadId). Using only process.pid
// would cause all concurrent test files to share the same profile dir, leading to
// Chrome profile locking and cross-test interference.
const TEST_USER_DATA_DIR = path.join(os.tmpdir(), `phobiablocker-test-${process.pid}-${threadId}`)

// Cached extension ID - MV3 service workers get killed between tests,
// so we cache the ID to avoid re-discovering it on every storage call
let _cachedExtensionId = null

/**
 * Read the extension ID from Chrome's user data directory on the filesystem.
 * When the MV3 service worker starts and dies before Puppeteer can observe it,
 * this is the fallback ID source.
 */
function findExtensionIdFromFilesystem(userDataDir) {
    // Strategy A: Default/Preferences JSON
    // Chrome registers --load-extension (unpacked) extensions in Preferences, NOT in
    // Default/Extensions/. Each entry has a "path" field pointing to the extension dir
    // and optionally a "manifest" dict. Match by path first (always present for
    // --load-extension), then fall back to manifest.name.
    const prefsPath = path.join(userDataDir, 'Default', 'Preferences')
    if (fs.existsSync(prefsPath)) {
        try {
            const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))
            const settings = prefs && prefs.extensions && prefs.extensions.settings
            if (settings) {
                for (const [id, ext] of Object.entries(settings)) {
                    if (!/^[a-z]{32}$/.test(id)) continue
                    if (ext && ext.path) {
                        // Read manifest.json directly from the path Chrome stored.
                        // More reliable than string comparison (avoids symlink, casing,
                        // and trailing-slash mismatches between our path and Chrome's).
                        try {
                            const m = JSON.parse(
                                fs.readFileSync(path.join(ext.path, 'manifest.json'), 'utf8')
                            )
                            if (m.name === 'PhobiaBlocker') return id
                        } catch (_) { /* path not accessible or not JSON */ }
                    }
                    // Fallback: manifest fields cached inside Preferences
                    if (ext && ext.manifest && ext.manifest.name === 'PhobiaBlocker') return id
                }
            }
        } catch (_) { /* file may still be written or contain invalid JSON */ }
    }

    // Strategy B: Sync Extension Settings directory
    // Chrome stores chrome.storage.sync data in Default/Sync Extension Settings/<id>/.
    // background.js writes to chrome.storage.sync on install, so this directory is
    // created on first run of a fresh profile — even when Preferences is never written.
    // Since we launch with --disable-extensions-except, the only user extension running
    // is PhobiaBlocker, so the only 32-letter entry here is ours.
    const syncDir = path.join(userDataDir, 'Default', 'Sync Extension Settings')
    if (fs.existsSync(syncDir)) {
        try {
            const ids = fs.readdirSync(syncDir).filter(d => /^[a-z]{32}$/.test(d))
            if (ids.length === 1) return ids[0]
            // Multiple entries: verify by reading the manifest from the stored ext path
            // (fall through to further strategies if needed)
        } catch (_) { /* skip if unreadable */ }
    }

    // Strategy C: Local Extension Settings / Extension State directory
    // Fallback: check other per-extension storage directories for 32-letter IDs.
    for (const dirName of ['Local Extension Settings', 'Extension State']) {
        const stateDir = path.join(userDataDir, 'Default', dirName)
        if (!fs.existsSync(stateDir)) continue
        try {
            const ids = fs.readdirSync(stateDir).filter(d => /^[a-z]{32}$/.test(d))
            if (ids.length === 1) return ids[0]
        } catch (_) { /* skip */ }
    }

    // Strategy D: Default/Extensions/ directory (packed/installed extensions)
    const extDir = path.join(userDataDir, 'Default', 'Extensions')
    if (!fs.existsSync(extDir)) return null
    try {
        for (const id of fs.readdirSync(extDir)) {
            // Extension IDs are exactly 32 lowercase letters
            if (!/^[a-z]{32}$/.test(id)) continue
            const idPath = path.join(extDir, id)
            for (const ver of fs.readdirSync(idPath)) {
                const manifestPath = path.join(idPath, ver, 'manifest.json')
                if (!fs.existsSync(manifestPath)) continue
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
                    if (manifest.name === 'PhobiaBlocker') return id
                } catch (_) { /* skip unreadable manifest */ }
            }
        }
    } catch (_) { /* skip if directory structure is unexpected */ }
    return null
}

/**
 * Launch Chrome with the PhobiaBlocker extension loaded
 * @param {Object} options - Puppeteer launch options
 * @returns {Promise<Browser>} Puppeteer browser instance
 */
async function launchBrowserWithExtension(options = {}) {
    // Extract args/userDataDir separately so we can merge them safely without
    // options.args overwriting our required extension flags.
    const { args: extraArgs, userDataDir: optUserDataDir, ...restOptions } = options
    const userDataDir = optUserDataDir || TEST_USER_DATA_DIR

    const browser = await puppeteer.launch({
        headless: false, // Extensions don't work in headless mode
        userDataDir,
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--no-first-run',
            '--disable-default-apps',
            ...(extraArgs || [])
        ],
        ...restOptions
    })

    // Strategy 1: scan targets that exist RIGHT NOW.
    // The MV3 service worker may have started and already been killed by Chrome's
    // 5-second idle timer before puppeteer.launch() returned, so waitForTarget()
    // (which only catches *new* target events) would miss it entirely.
    const immediateExt = browser.targets().find(t => {
        const url = t.url()
        return url.startsWith('chrome-extension://') && url.length > 30
    })
    if (immediateExt) {
        const m = immediateExt.url().match(/chrome-extension:\/\/([a-z]+)/)
        if (m) _cachedExtensionId = m[1]
        return browser
    }

    // Strategy 2: wait a short time for a new target event (e.g. Chrome is still
    // finishing its startup and the SW fires just after we checked).
    try {
        const target = await browser.waitForTarget(
            t => t.url().startsWith('chrome-extension://') && t.url().length > 30,
            { timeout: 3000 }
        )
        const m = target.url().match(/chrome-extension:\/\/([a-z]+)/)
        if (m) _cachedExtensionId = m[1]
        return browser
    } catch (_) { /* SW already dead — fall through to filesystem */ }

    // Strategy 3: read the extension ID from Chrome's user data directory.
    // For --load-extension (unpacked) extensions, Chrome writes the ID into
    // Default/Preferences rather than Default/Extensions/. Poll with retries
    // because Chrome may still be writing the file when we first check.
    let fsId = null
    for (let attempt = 0; attempt < 6 && !fsId; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 500))
        fsId = findExtensionIdFromFilesystem(userDataDir)
    }
    if (fsId) {
        _cachedExtensionId = fsId
    } else {
        // Log what Preferences actually contains to diagnose the failure
        try {
            const dirExists = fs.existsSync(userDataDir)
            const defaultExists = fs.existsSync(path.join(userDataDir, 'Default'))
            console.warn('[extId debug] userDataDir:', userDataDir)
            console.warn('[extId debug] userDataDir exists:', dirExists)
            console.warn('[extId debug] Default/ exists:', defaultExists)
            // Show extension-related directory contents to identify the correct ID source
            for (const d of ['Sync Extension Settings', 'Local Extension Settings',
                'Extension State', 'Extension Scripts', 'Extension Rules']) {
                const dp = path.join(userDataDir, 'Default', d)
                if (fs.existsSync(dp)) {
                    try {
                        console.warn(`[extId debug] Default/${d}:`,
                            fs.readdirSync(dp).filter(f => /^[a-z]{32}$/.test(f)))
                    } catch (e) { console.warn(`[extId debug] Default/${d} error:`, e.message) }
                }
            }
            const prefsPath = path.join(userDataDir, 'Default', 'Preferences')
            if (fs.existsSync(prefsPath)) {
                const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))
                const settings = prefs && prefs.extensions && prefs.extensions.settings
                const entries = settings
                    ? Object.keys(settings).filter(k => /^[a-z]{32}$/.test(k)).map(k => ({
                        id: k,
                        path: settings[k] && settings[k].path,
                        manifestName: settings[k] && settings[k].manifest && settings[k].manifest.name
                    }))
                    : '(extensions.settings missing)'
                console.warn('[extId debug] Preferences entries:', JSON.stringify(entries))
            } else {
                console.warn('[extId debug] Preferences file missing')
            }
        } catch (e) {
            console.warn('[extId debug] error:', e.message)
        }
        console.warn('Warning: Could not determine extension ID from targets or filesystem')
    }

    return browser
}

/**
 * Get the extension's service worker (background script) target
 * @param {Browser} browser - Puppeteer browser instance
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<Target>} The service worker target
 */
async function getExtensionServiceWorker(browser, timeout = 10000) {
    // Check if already active
    const existing = browser.targets().find(target =>
        target.type() === 'service_worker' &&
        target.url().includes('chrome-extension://')
    )
    if (existing) return existing

    // If we have no cached ID, try extracting one from any visible extension target
    // (e.g. a popup page that was opened earlier) before attempting wakeup.
    if (!_cachedExtensionId) {
        const anyExt = browser.targets().find(t => /chrome-extension:\/\/([a-z]+)/.test(t.url()))
        if (anyExt) {
            const m = anyExt.url().match(/chrome-extension:\/\/([a-z]+)/)
            if (m) _cachedExtensionId = m[1]
        }
    }

    // MV3 service workers get killed by Chrome when idle.
    // Start listening FIRST (before waking), so we don't miss the target
    // creation event if the service worker restarts between the check above
    // and the wakeup below.
    const waitPromise = browser.waitForTarget(
        target => target.type() === 'service_worker' && target.url().includes('chrome-extension://'),
        { timeout }
    ).catch(() => null)

    // Now wake the service worker by opening the popup
    if (_cachedExtensionId) {
        const wakeupPage = await browser.newPage()
        try {
            await wakeupPage.goto(`chrome-extension://${_cachedExtensionId}/popup.html`, {
                waitUntil: 'domcontentloaded',
                timeout: 5000
            })
        } catch (_) { /* ignore */ }
        await wakeupPage.close()
    }

    return await waitPromise
}

/**
 * Get the extension ID (cached after first lookup)
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<string>} The extension ID
 */
async function getExtensionId(browser) {
    if (_cachedExtensionId) return _cachedExtensionId

    const serviceWorkerTarget = await getExtensionServiceWorker(browser)
    if (!serviceWorkerTarget) {
        throw new Error('Extension service worker not found')
    }
    const match = serviceWorkerTarget.url().match(/chrome-extension:\/\/([a-z]+)/)
    if (!match) {
        throw new Error('Could not parse extension ID from service worker URL')
    }
    _cachedExtensionId = match[1]
    return _cachedExtensionId
}

/**
 * Open the extension popup
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Page} page - Current page (needed for context)
 * @returns {Promise<Page>} The popup page
 */
async function openExtensionPopup(browser, page) {
    const extensionId = await getExtensionId(browser)
    const popupUrl = `chrome-extension://${extensionId}/popup.html`

    // Open popup in a new page
    const popupPage = await browser.newPage()
    await popupPage.goto(popupUrl)
    await popupPage.waitForSelector('body', { timeout: 5000 })

    return popupPage
}

/**
 * Get an extension page that has access to chrome.storage API
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<Page>} Page with chrome.storage access
 */
async function getExtensionPage(browser) {
    const extensionId = await getExtensionId(browser)
    const popupUrl = `chrome-extension://${extensionId}/popup.html`

    // browser.newPage() can throw ProtocolError ("Session with given id not found")
    // if Chrome's CDP session is momentarily stale. Retry with backoff before giving up.
    let extPage
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            extPage = await browser.newPage()
            break
        } catch (e) {
            if (attempt === 2) throw e
            await new Promise(r => setTimeout(r, 100 * (attempt + 1)))
        }
    }
    await extPage.goto(popupUrl, { waitUntil: 'networkidle0' })

    return extPage
}

/**
 * Set phobia words via extension storage
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Array<string>} words - Array of phobia words
 */
async function setPhobiaWords(browser, words) {
    const extPage = await getExtensionPage(browser)

    await extPage.evaluate((words) => {
        return new Promise((resolve) => {
            chrome.storage.sync.set({ targetWords: words }, resolve)
        })
    }, words)

    await extPage.close()

    // Wait for content scripts to receive storage change and process
    // Content scripts need time to: receive event, expand words with NLP, process DOM
    await new Promise(resolve => setTimeout(resolve, 1000))
}

/**
 * Get current phobia words from storage
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<Array<string>>} Array of phobia words
 */
async function getPhobiaWords(browser) {
    const extPage = await getExtensionPage(browser)

    const words = await extPage.evaluate(() => {
        return new Promise((resolve) => {
            chrome.storage.sync.get(['targetWords'], (result) => {
                resolve(result.targetWords || [])
            })
        })
    })

    await extPage.close()
    return words
}

/**
 * Enable or disable the extension
 * @param {Browser} browser - Puppeteer browser instance
 * @param {boolean} enabled - Whether to enable or disable
 */
async function setExtensionEnabled(browser, enabled) {
    const extPage = await getExtensionPage(browser)

    await extPage.evaluate((enabled) => {
        return new Promise((resolve) => {
            chrome.storage.sync.set({ phobiaBlockerEnabled: enabled }, resolve)
        })
    }, enabled)

    await extPage.close()

    // Wait for content script to react
    await new Promise(resolve => setTimeout(resolve, 200))
}

/**
 * Set blur amount
 * @param {Browser} browser - Puppeteer browser instance
 * @param {number} amount - Blur amount (0-5+)
 */
async function setBlurAmount(browser, amount) {
    const extPage = await getExtensionPage(browser)

    await extPage.evaluate((amount) => {
        return new Promise((resolve) => {
            chrome.storage.sync.set({ blurValueAmount: amount }, resolve)
        })
    }, amount)

    await extPage.close()
}

/**
 * Set blur always on mode
 * @param {Browser} browser - Puppeteer browser instance
 * @param {boolean} alwaysOn - Whether to always blur
 */
async function setBlurAlwaysOn(browser, alwaysOn) {
    const extPage = await getExtensionPage(browser)

    await extPage.evaluate((alwaysOn) => {
        return new Promise((resolve) => {
            chrome.storage.sync.set({ blurIsAlwaysOn: alwaysOn }, resolve)
        })
    }, alwaysOn)

    await extPage.close()

    // Wait for content script to react
    await new Promise(resolve => setTimeout(resolve, 500))
}

/**
 * Check if an element is blurred
 * @param {Page} page - Page containing the element
 * @param {string} selector - CSS selector for the element
 * @returns {Promise<boolean>} True if element has blur filter
 */
async function isElementBlurred(page, selector) {
    return await page.evaluate((sel) => {
        const element = document.querySelector(sel)
        if (!element) return false

        const filter = window.getComputedStyle(element).filter
        // blur(0px) is visually transparent (extension disabled sets --blurValueAmount:0px)
        // so only count filters with a non-zero radius as "blurred"
        const m = filter && filter.match(/blur\(([\d.]+)px\)/)
        return m ? parseFloat(m[1]) > 0 : false
    }, selector)
}

/**
 * Wait for element to be blurred or unblurred
 * @param {Page} page - Page containing the element
 * @param {string} selector - CSS selector for the element
 * @param {boolean} shouldBeBlurred - Expected state
 * @param {number} timeout - Timeout in milliseconds
 */
async function waitForBlurState(page, selector, shouldBeBlurred, timeout = 5000) {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
        const isBlurred = await isElementBlurred(page, selector)
        if (isBlurred === shouldBeBlurred) {
            return true
        }
        await page.waitForTimeout(100)
    }

    throw new Error(
        `Element ${selector} did not reach expected blur state (${shouldBeBlurred}) within ${timeout}ms`
    )
}

/**
 * Get test page URL
 * @param {string} filename - Name of the test HTML file
 * @returns {string} file:// URL to the test page
 */
function getTestPageUrl(filename) {
    return `file://${path.join(TEST_PAGES_PATH, filename)}`
}

/**
 * Load test page content into a page
 * @param {Page} page - Puppeteer page
 * @param {string} filename - Name of the test HTML file
 */
async function loadTestPage(page, filename) {
    const fileUrl = getTestPageUrl(filename)
    try {
        await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 10000 })
    } catch (err) {
        // If goto fails, try setContent as fallback
        const filePath = path.join(TEST_PAGES_PATH, filename)
        const content = fs.readFileSync(filePath, 'utf8')
        await page.setContent(content, { waitUntil: 'domcontentloaded' })
    }
}

/**
 * Clear all extension storage
 * @param {Browser} browser - Puppeteer browser instance
 */
async function clearExtensionStorage(browser) {
    const extPage = await getExtensionPage(browser)

    await extPage.evaluate(() => {
        return new Promise((resolve) => {
            chrome.storage.sync.clear(resolve)
        })
    })

    await extPage.close()
}

/**
 * Send message to content script
 * @param {Page} page - Page with content script
 * @param {Object} message - Message to send
 */
async function sendMessageToContentScript(page, message) {
    await page.evaluate((msg) => {
        window.postMessage(msg, '*')
    }, message)

    await page.waitForTimeout(100)
}

/**
 * Count blurred images on page
 * @param {Page} page - Page to check
 * @returns {Promise<number>} Number of blurred images
 */
async function countBlurredImages(page) {
    return await page.evaluate(() => {
        function hasRealBlur(el) {
            const filter = window.getComputedStyle(el).filter
            const m = filter && filter.match(/blur\(([\d.]+)px\)/)
            return m ? parseFloat(m[1]) > 0 : false
        }

        let count = 0
        document.querySelectorAll('img, video, iframe').forEach(el => {
            if (hasRealBlur(el)) count++
        })
        document.querySelectorAll('[style*="background-image"]').forEach(el => {
            if (hasRealBlur(el)) count++
        })
        return count
    })
}

/**
 * Get all images on page (including background images)
 * @param {Page} page - Page to check
 * @returns {Promise<Array>} Array of image info objects
 */
async function getAllVisualElements(page) {
    return await page.evaluate(() => {
        function hasRealBlur(el) {
            const filter = window.getComputedStyle(el).filter
            const m = filter && filter.match(/blur\(([\d.]+)px\)/)
            return m ? parseFloat(m[1]) > 0 : false
        }

        const elements = []

        // Regular images
        document.querySelectorAll('img').forEach((img, index) => {
            elements.push({
                type: 'img',
                id: img.id || `img-${index}`,
                isBlurred: hasRealBlur(img),
                selector: img.id ? `#${img.id}` : null
            })
        })

        // Videos
        document.querySelectorAll('video').forEach((video, index) => {
            elements.push({
                type: 'video',
                id: video.id || `video-${index}`,
                isBlurred: hasRealBlur(video),
                selector: video.id ? `#${video.id}` : null
            })
        })

        // Iframes
        document.querySelectorAll('iframe').forEach((iframe, index) => {
            elements.push({
                type: 'iframe',
                id: iframe.id || `iframe-${index}`,
                isBlurred: hasRealBlur(iframe),
                selector: iframe.id ? `#${iframe.id}` : null
            })
        })

        // Background images
        document.querySelectorAll('[style*="background-image"]').forEach((el, index) => {
            elements.push({
                type: 'background',
                id: el.id || `bg-${index}`,
                isBlurred: hasRealBlur(el),
                selector: el.id ? `#${el.id}` : null
            })
        })

        return elements
    })
}

/**
 * Set whitelisted sites
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Array<string>} sites - Array of site patterns
 */
async function setWhitelistedSites(browser, sites) {
    const extPage = await getExtensionPage(browser)

    await extPage.evaluate((sites) => {
        return new Promise((resolve) => {
            chrome.storage.sync.set({ whitelistedSites: sites }, resolve)
        })
    }, sites)

    await extPage.close()

    // Wait for content script to react
    await new Promise(resolve => setTimeout(resolve, 300))
}

/**
 * Set blacklisted sites
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Array<string>} sites - Array of site patterns
 */
async function setBlacklistedSites(browser, sites) {
    const extPage = await getExtensionPage(browser)

    await extPage.evaluate((sites) => {
        return new Promise((resolve) => {
            chrome.storage.sync.set({ blacklistedSites: sites }, resolve)
        })
    }, sites)

    await extPage.close()

    // Wait for content script to react
    await new Promise(resolve => setTimeout(resolve, 300))
}

/**
 * Get whitelisted sites from storage
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<Array<string>>} Array of whitelisted sites
 */
async function getWhitelistedSites(browser) {
    const extPage = await getExtensionPage(browser)

    const sites = await extPage.evaluate(() => {
        return new Promise((resolve) => {
            chrome.storage.sync.get(['whitelistedSites'], (result) => {
                resolve(result.whitelistedSites || [])
            })
        })
    })

    await extPage.close()
    return sites
}

/**
 * Get blacklisted sites from storage
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<Array<string>>} Array of blacklisted sites
 */
async function getBlacklistedSites(browser) {
    const extPage = await getExtensionPage(browser)

    const sites = await extPage.evaluate(() => {
        return new Promise((resolve) => {
            chrome.storage.sync.get(['blacklistedSites'], (result) => {
                resolve(result.blacklistedSites || [])
            })
        })
    })

    await extPage.close()
    return sites
}

/**
 * Enable or disable hover preview
 * @param {Browser} browser - Puppeteer browser instance
 * @param {boolean} enabled - Whether hover preview is enabled
 */
async function setPreviewEnabled(browser, enabled) {
    const extPage = await getExtensionPage(browser)

    await extPage.evaluate((enabled) => {
        return new Promise((resolve) => {
            chrome.storage.sync.set({ previewEnabled: enabled }, () => {
                // Send previewSettingsChanged to all tabs so the content script
                // updates --previewBlurAmount live (without a page reload).
                chrome.tabs.query({}, (tabs) => {
                    for (const tab of tabs) {
                        chrome.tabs.sendMessage(
                            tab.id,
                            { type: 'previewSettingsChanged', previewEnabled: enabled },
                            () => { void chrome.runtime.lastError }
                        )
                    }
                    resolve()
                })
            })
        })
    }, enabled)

    await extPage.close()
    await new Promise(resolve => setTimeout(resolve, 300))
}

/**
 * Set hover preview blur strength
 * @param {Browser} browser - Puppeteer browser instance
 * @param {number} strength - Blur strength in px (0-20)
 */
async function setPreviewBlurStrength(browser, strength) {
    const extPage = await getExtensionPage(browser)

    await extPage.evaluate((strength) => {
        return new Promise((resolve) => {
            chrome.storage.sync.set({ previewBlurStrength: strength }, () => {
                // Send previewSettingsChanged to all tabs so the content script
                // updates --previewBlurAmount live (without a page reload).
                chrome.tabs.query({}, (tabs) => {
                    for (const tab of tabs) {
                        chrome.tabs.sendMessage(
                            tab.id,
                            { type: 'previewSettingsChanged', previewBlurStrength: strength },
                            () => { void chrome.runtime.lastError }
                        )
                    }
                    resolve()
                })
            })
        })
    }, strength)

    await extPage.close()
    await new Promise(resolve => setTimeout(resolve, 300))
}

/**
 * Get previewEnabled from storage (returns undefined if not set)
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<boolean|undefined>}
 */
async function getPreviewEnabled(browser) {
    const extPage = await getExtensionPage(browser)

    const value = await extPage.evaluate(() => {
        return new Promise((resolve) => {
            chrome.storage.sync.get(['previewEnabled'], (result) => {
                resolve(result.previewEnabled)
            })
        })
    })

    await extPage.close()
    return value
}

/**
 * Get previewBlurStrength from storage (returns undefined if not set)
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<number|undefined>}
 */
async function getPreviewBlurStrength(browser) {
    const extPage = await getExtensionPage(browser)

    const value = await extPage.evaluate(() => {
        return new Promise((resolve) => {
            chrome.storage.sync.get(['previewBlurStrength'], (result) => {
                resolve(result.previewBlurStrength)
            })
        })
    })

    await extPage.close()
    return value
}

/**
 * Wait until an element has the phobia-blur class (blur was detected by the extension).
 * Much faster than a fixed wait(3000) — resolves as soon as the class appears (~0.5–1 s).
 * @param {Page} page - Puppeteer page
 * @param {string} selector - CSS selector for the element
 * @param {number} timeout - Max wait in ms (default 8000)
 */
async function waitForPhobiaBlur(page, selector, timeout = 8000) {
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel)
            return el != null && el.classList.contains('phobia-blur')
        },
        { timeout, polling: 100 },
        selector
    )
}

/**
 * Wait until an element has the phobia-noblur class (no match found, unveil timer fired).
 * The extension's unveil timer is 2 s, so this resolves at ~2.1 s instead of a fixed 3 s.
 * @param {Page} page - Puppeteer page
 * @param {string} selector - CSS selector for the element
 * @param {number} timeout - Max wait in ms (default 8000)
 */
async function waitForPhobiaNoblur(page, selector, timeout = 8000) {
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel)
            return el != null && el.classList.contains('phobia-noblur')
        },
        { timeout, polling: 100 },
        selector
    )
}

/**
 * Send a message to all content scripts (mirrors what popup blur/unblur buttons do)
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Object} message - Message object to send
 */
async function sendMessageToAllContentScripts(browser, message) {
    const extPage = await getExtensionPage(browser)

    await extPage.evaluate((msg) => {
        return new Promise((resolve) => {
            chrome.tabs.query({}, (tabs) => {
                let pending = tabs.length
                if (pending === 0) { resolve(); return }
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, msg, () => {
                        void chrome.runtime.lastError
                        if (--pending === 0) resolve()
                    })
                })
            })
        })
    }, message)

    await extPage.close()
    await new Promise(r => setTimeout(r, 300))
}

/**
 * Query triggered words from the content script of a specific page.
 * Opens an extension page (with chrome.tabs access), finds the tab by URL,
 * sends a getTriggeredWords message, and returns the words array.
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Page} page - The page whose content script to query
 * @returns {Promise<Array<{word: string, count: number}>>}
 */
async function queryTriggeredWords(browser, page) {
    const pageUrl = page.url()
    // Use the service worker context to send the message. This avoids opening popup.html
    // (getExtensionPage), which runs popup.js and broadcasts targetWordsChanged to all
    // content scripts — restarting analysis and causing a race condition where
    // _triggerWords may not yet be set on the new ImageNode instances.
    const swTarget = await getExtensionServiceWorker(browser)
    const swWorker = await swTarget.worker()

    const words = await swWorker.evaluate((targetUrl) => {
        return new Promise((resolve) => {
            chrome.tabs.query({}, (tabs) => {
                const tab = tabs.find(t => t.url === targetUrl)
                if (!tab) { resolve([]); return }
                chrome.tabs.sendMessage(tab.id, { type: 'getTriggeredWords' }, (response) => {
                    void chrome.runtime.lastError
                    resolve(response && response.words ? response.words : [])
                })
            })
        })
    }, pageUrl)

    return words
}

/**
 * Send a message to all content scripts via the service worker context.
 * Unlike sendMessageToAllContentScripts, this does NOT open popup.html, so it
 * avoids the popup.js side-effect of broadcasting targetWordsChanged to all tabs.
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Object} message - Message object to send
 */
async function sendMessageViaServiceWorker(browser, message) {
    const swTarget = await getExtensionServiceWorker(browser)
    const swWorker = await swTarget.worker()

    await swWorker.evaluate((msg) => {
        return new Promise((resolve) => {
            chrome.tabs.query({}, (tabs) => {
                let pending = tabs.length
                if (pending === 0) { resolve(); return }
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, msg, () => {
                        void chrome.runtime.lastError
                        if (--pending === 0) resolve()
                    })
                })
            })
        })
    }, message)

    await new Promise(r => setTimeout(r, 300))
}

module.exports = {
    launchBrowserWithExtension,
    getExtensionServiceWorker,
    getExtensionId,
    getExtensionPage,
    openExtensionPopup,
    setPhobiaWords,
    getPhobiaWords,
    setExtensionEnabled,
    setBlurAmount,
    setBlurAlwaysOn,
    isElementBlurred,
    waitForBlurState,
    getTestPageUrl,
    loadTestPage,
    clearExtensionStorage,
    sendMessageToContentScript,
    countBlurredImages,
    getAllVisualElements,
    setWhitelistedSites,
    setBlacklistedSites,
    getWhitelistedSites,
    getBlacklistedSites,
    setPreviewEnabled,
    setPreviewBlurStrength,
    getPreviewEnabled,
    getPreviewBlurStrength,
    sendMessageToAllContentScripts,
    sendMessageViaServiceWorker,
    queryTriggeredWords,
    waitForPhobiaBlur,
    waitForPhobiaNoblur
}
