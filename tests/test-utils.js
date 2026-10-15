// Helpers for the historical Puppeteer suites (tests/*.test.js). They drive a
// headed Chrome with the unpacked extension and are not part of the release gate;
// the unit suite under tests/unit/ is. See tests/README.md before reviving them.
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
// Radius of a computed `filter: blur(Npx)`; the extension writes literal px values.
const BLUR_PX_RE = /blur\(([\d.]+)px\)/

// Cached extension ID - MV3 service workers get killed between tests,
// so we cache the ID to avoid re-discovering it on every storage call
let _cachedExtensionId = null

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

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
    // Trap: the manifest name is now "PhobiaBlur — Blur Images & Videos", so the
    // 'PhobiaBlocker' comparisons in strategies A and D never match any more. The
    // lookup only succeeds through strategies B and C, which need exactly one
    // extension directory and therefore rely on --disable-extensions-except.
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
    // 30-second idle timer before puppeteer.launch() returned, so waitForTarget()
    // (which only catches *new* target events) would miss it entirely.
    // A bare "chrome-extension://" is 19 characters; a real extension URL carries a
    // 32-letter id, so the length check skips targets that have no id to read yet.
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
        if (attempt > 0) await wait(500)
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

    // The wake-up page is closed again at once so it does not stay open as a tab
    // beside the page under test; the waitForTarget above already observes the worker.
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

async function getServiceWorkerHandle(browser) {
    const swTarget = await getExtensionServiceWorker(browser)
    return swTarget.worker()
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
            await wait(100 * (attempt + 1))
        }
    }
    await extPage.goto(popupUrl, { waitUntil: 'networkidle0' })

    return extPage
}

/**
 * Run `task` against a short-lived extension page and close it afterwards.
 * chrome.storage.sync is only reachable from an extension context, and the MV3
 * service worker is killed when idle, so a popup page is the reliable host.
 */
async function withExtensionPage(browser, task) {
    const extPage = await getExtensionPage(browser)
    try {
        return await task(extPage)
    } finally {
        await extPage.close()
    }
}

/**
 * Write values to chrome.storage.sync, then give content scripts time to react.
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Object} values - Key/value pairs to store
 * @param {number} settleMs - How long content scripts need to apply the change
 */
async function setSyncStorage(browser, values, settleMs = 0) {
    await withExtensionPage(browser, page => page.evaluate(
        entries => new Promise(resolve => chrome.storage.sync.set(entries, resolve)),
        values
    ))
    if (settleMs > 0) await wait(settleMs)
}

/**
 * Read one key from chrome.storage.sync (undefined when unset).
 * @param {Browser} browser - Puppeteer browser instance
 * @param {string} key - Storage key
 */
function getSyncStorage(browser, key) {
    return withExtensionPage(browser, page => page.evaluate(
        name => new Promise(resolve => chrome.storage.sync.get([name], result => resolve(result[name]))),
        key
    ))
}

// Settle delays reflect how long each setting takes to propagate: target words
// trigger NLP expansion and a full re-analysis; the rest only re-style.
// These are fixed sleeps, not condition waits: storage.onChanged re-reads the
// settings in every open frame, and nothing here confirms that the re-read landed.
// The suites add their own waits after navigation for the same reason.
const setPhobiaWords = (browser, words) => setSyncStorage(browser, { targetWords: words }, 1000)
const setExtensionEnabled = (browser, enabled) => setSyncStorage(browser, { phobiaBlockerEnabled: enabled }, 200)
const setBlurAmount = (browser, amount) => setSyncStorage(browser, { blurValueAmount: amount })
const setBlurAlwaysOn = (browser, alwaysOn) => setSyncStorage(browser, { blurIsAlwaysOn: alwaysOn }, 500)
const setWhitelistedSites = (browser, sites) => setSyncStorage(browser, { whitelistedSites: sites }, 300)
const setBlacklistedSites = (browser, sites) => setSyncStorage(browser, { blacklistedSites: sites }, 300)
const setPreviewEnabled = (browser, enabled) => setSyncStorage(browser, { previewEnabled: enabled }, 300)
const setPreviewBlurStrength = (browser, strength) => setSyncStorage(browser, { previewBlurStrength: strength }, 300)

const getPhobiaWords = async (browser) => (await getSyncStorage(browser, 'targetWords')) || []
const getWhitelistedSites = async (browser) => (await getSyncStorage(browser, 'whitelistedSites')) || []
const getBlacklistedSites = async (browser) => (await getSyncStorage(browser, 'blacklistedSites')) || []
const getPreviewEnabled = (browser) => getSyncStorage(browser, 'previewEnabled')
const getPreviewBlurStrength = (browser) => getSyncStorage(browser, 'previewBlurStrength')

/**
 * Clear all extension storage
 * @param {Browser} browser - Puppeteer browser instance
 */
function clearExtensionStorage(browser) {
    return withExtensionPage(browser, page => page.evaluate(
        () => new Promise(resolve => chrome.storage.sync.clear(resolve))
    ))
}

/**
 * Radius of the blur() in a computed filter string, 0 when there is none.
 * blur(0px) is visually transparent, so callers treat only > 0 as blurred.
 */
function blurPxOf(filter) {
    const match = typeof filter === 'string' && filter.match(BLUR_PX_RE)
    return match ? parseFloat(match[1]) : 0
}

function getComputedFilter(page, selector) {
    return page.evaluate((sel) => {
        const element = document.querySelector(sel)
        return element ? window.getComputedStyle(element).filter : null
    }, selector)
}

/**
 * Check if an element is blurred
 * @param {Page} page - Page containing the element
 * @param {string} selector - CSS selector for the element
 * @returns {Promise<boolean>} True if element has a non-zero blur filter
 */
async function isElementBlurred(page, selector) {
    return blurPxOf(await getComputedFilter(page, selector)) > 0
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
        // Trap: setContent leaves the page at about:blank, so the content scripts run
        // against that URL instead of the file URL. Site rules keyed on the test page's
        // host or path and queryTriggeredWords' URL match no longer apply to it.
        const filePath = path.join(TEST_PAGES_PATH, filename)
        const content = fs.readFileSync(filePath, 'utf8')
        await page.setContent(content, { waitUntil: 'domcontentloaded' })
    }
}

/**
 * Count blurred images on page
 * @param {Page} page - Page to check
 * @returns {Promise<number>} Number of blurred images
 */
// Only inline-style backgrounds are counted. The controller also blurs elements
// whose background comes from a stylesheet, but those are invisible to this
// selector, so the count is a lower bound on what the extension protects.
async function countBlurredImages(page) {
    const filters = await page.evaluate(() => [
        ...document.querySelectorAll('img, video, iframe'),
        ...document.querySelectorAll('[style*="background-image"]'),
    ].map(element => window.getComputedStyle(element).filter))
    return filters.filter(filter => blurPxOf(filter) > 0).length
}

/**
 * Get all images on page (including background images)
 * @param {Page} page - Page to check
 * @returns {Promise<Array>} Array of image info objects
 */
async function getAllVisualElements(page) {
    const elements = await page.evaluate(() => {
        const elements = []

        function addElements(selector, type, idPrefix = type) {
            document.querySelectorAll(selector).forEach((element, index) => {
                elements.push({
                    type,
                    id: element.id || `${idPrefix}-${index}`,
                    filter: window.getComputedStyle(element).filter,
                    selector: element.id ? `#${element.id}` : null
                })
            })
        }

        addElements('img', 'img')
        addElements('video', 'video')
        addElements('iframe', 'iframe')
        addElements('[style*="background-image"]', 'background', 'bg')

        return elements
    })
    return elements.map(({ filter, ...info }) => ({ ...info, isBlurred: blurPxOf(filter) > 0 }))
}

/**
 * Wait until an element carries one of the extension's projection classes.
 * Resolves as soon as the class appears instead of sleeping a fixed time.
 * @param {Page} page - Puppeteer page
 * @param {string} selector - CSS selector for the element
 * @param {string} className - Class to wait for
 * @param {number} timeout - Max wait in ms (default 8000)
 */
// The class appears in the same synchronous turn as the inline filter write, but
// protection.css transitions filter over 0.2 s, so a computed blur radius read
// right after this resolves can still be mid-transition (or frozen at the
// stylesheet's 40px while the tab is hidden). Bring the page to front and wait.
async function waitForPhobiaClass(page, selector, className, timeout = 8000) {
    await page.waitForFunction(
        (sel, name) => {
            const el = document.querySelector(sel)
            return el != null && el.classList.contains(name)
        },
        { timeout, polling: 100 },
        selector,
        className
    )
}

const waitForPhobiaBlur = (page, selector, timeout) => waitForPhobiaClass(page, selector, 'phobia-blur', timeout)
const waitForPhobiaNoblur = (page, selector, timeout) => waitForPhobiaClass(page, selector, 'phobia-noblur', timeout)

// Runs inside an extension context (popup page or service worker) and resolves
// once every tab has been offered the message.
function broadcastToTabs(msg) {
    return new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
            let pending = tabs.length
            if (pending === 0) { resolve(); return }
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, msg, () => {
                    // Tabs without a content script (chrome://, the popup tab itself)
                    // reject the message; reading lastError marks it handled so Chrome
                    // does not log "Unchecked runtime.lastError" for each of them.
                    void chrome.runtime.lastError
                    if (--pending === 0) resolve()
                })
            })
        })
    })
}

/**
 * Send a message to all content scripts (mirrors what popup blur/unblur buttons do)
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Object} message - Message object to send
 */
// Messages carry no target, so the content script's `target !== 'content'` filter
// lets them through. The 300 ms outlasts protection.css's 0.2 s filter transition,
// so a computed filter read afterwards is the settled value, not an interpolation.
async function sendMessageToAllContentScripts(browser, message) {
    await withExtensionPage(browser, page => page.evaluate(broadcastToTabs, message))
    await wait(300)
}

/**
 * Send a message to all content scripts via the service worker context, so no
 * popup page is opened alongside the page under test.
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Object} message - Message object to send
 */
async function sendMessageViaServiceWorker(browser, message) {
    const swWorker = await getServiceWorkerHandle(browser)
    await swWorker.evaluate(broadcastToTabs, message)
    await wait(300)
}

/**
 * Query triggered words from the content script of a specific page.
 * Uses the service worker context so no popup page is opened alongside the
 * page under test.
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Page} page - The page whose content script to query
 * @returns {Promise<Array<{word: string, count: number}>>}
 */
async function queryTriggeredWords(browser, page) {
    const pageUrl = page.url()
    const swWorker = await getServiceWorkerHandle(browser)

    // Trap: tab.url is only populated for hosts the extension has permission for.
    // The manifest grants http(s) host permissions and no "tabs" permission, and the
    // test pages are file:// URLs, so tab.url is undefined there and this resolves []
    // even though the content script would answer. Match by active tab to fix it.
    return swWorker.evaluate((targetUrl) => new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
            const tab = tabs.find(t => t.url === targetUrl)
            if (!tab) { resolve([]); return }
            chrome.tabs.sendMessage(tab.id, { type: 'getTriggeredWords' }, (response) => {
                void chrome.runtime.lastError
                resolve(response && response.words ? response.words : [])
            })
        })
    }), pageUrl)
}

module.exports = {
    wait,
    launchBrowserWithExtension,
    getExtensionServiceWorker,
    getExtensionId,
    getExtensionPage,
    openExtensionPopup,
    setSyncStorage,
    getSyncStorage,
    setPhobiaWords,
    getPhobiaWords,
    setExtensionEnabled,
    setBlurAmount,
    setBlurAlwaysOn,
    blurPxOf,
    isElementBlurred,
    getTestPageUrl,
    loadTestPage,
    clearExtensionStorage,
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
    waitForPhobiaClass,
    waitForPhobiaBlur,
    waitForPhobiaNoblur
}
