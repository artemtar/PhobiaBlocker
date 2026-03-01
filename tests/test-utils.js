const puppeteer = require('puppeteer')
const path = require('path')
const fs = require('fs')

const EXTENSION_PATH = path.resolve(__dirname, '..')
const TEST_PAGES_PATH = path.resolve(__dirname, 'test-pages')

/**
 * Launch Chrome with the PhobiaBlocker extension loaded
 * @param {Object} options - Puppeteer launch options
 * @returns {Promise<Browser>} Puppeteer browser instance
 */
async function launchBrowserWithExtension(options = {}) {
    const browser = await puppeteer.launch({
        headless: false, // Extensions don't work in headless mode
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            ...( options.args || [])
        ],
        ...options
    })

    // Wait for extension to load (service worker takes a moment to initialize)
    await new Promise(resolve => setTimeout(resolve, 3000))

    return browser
}

/**
 * Get the extension's service worker (background script) target
 * @param {Browser} browser - Puppeteer browser instance
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<Target>} The service worker target
 */
async function getExtensionServiceWorker(browser, timeout = 10000) {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
        const targets = await browser.targets()
        const extensionTarget = targets.find(target =>
            target.type() === 'service_worker' &&
            target.url().includes('chrome-extension://')
        )

        if (extensionTarget) {
            return extensionTarget
        }

        // Wait a bit before trying again
        await new Promise(resolve => setTimeout(resolve, 200))
    }

    return null
}

/**
 * Get the extension ID
 * @param {Browser} browser - Puppeteer browser instance
 * @param {number} retries - Number of retries
 * @returns {Promise<string>} The extension ID
 */
async function getExtensionId(browser, retries = 3) {
    for (let i = 0; i < retries; i++) {
        const serviceWorkerTarget = await getExtensionServiceWorker(browser, 15000)
        if (serviceWorkerTarget) {
            const extensionUrl = serviceWorkerTarget.url()
            const match = extensionUrl.match(/chrome-extension:\/\/([a-z]+)/)
            if (match) return match[1]
        }

        // If not found and we have retries left, wait and try again
        if (i < retries - 1) {
            console.log(`Service worker not found, retrying ${i + 1}/${retries}...`)
            await new Promise(resolve => setTimeout(resolve, 2000))
        }
    }

    throw new Error('Extension service worker not found after retries')
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

    const extPage = await browser.newPage()
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
        return filter && filter.includes('blur')
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
        const images = document.querySelectorAll('img, video, iframe')
        let count = 0

        images.forEach(img => {
            const filter = window.getComputedStyle(img).filter
            if (filter && filter.includes('blur')) {
                count++
            }
        })

        // Check for background images with blur
        const bgElements = document.querySelectorAll('[style*="background-image"]')
        bgElements.forEach(el => {
            const filter = window.getComputedStyle(el).filter
            if (filter && filter.includes('blur')) {
                count++
            }
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
        const elements = []

        // Regular images
        document.querySelectorAll('img').forEach((img, index) => {
            const filter = window.getComputedStyle(img).filter
            elements.push({
                type: 'img',
                id: img.id || `img-${index}`,
                isBlurred: filter && filter.includes('blur'),
                selector: img.id ? `#${img.id}` : null
            })
        })

        // Videos
        document.querySelectorAll('video').forEach((video, index) => {
            const filter = window.getComputedStyle(video).filter
            elements.push({
                type: 'video',
                id: video.id || `video-${index}`,
                isBlurred: filter && filter.includes('blur'),
                selector: video.id ? `#${video.id}` : null
            })
        })

        // Iframes
        document.querySelectorAll('iframe').forEach((iframe, index) => {
            const filter = window.getComputedStyle(iframe).filter
            elements.push({
                type: 'iframe',
                id: iframe.id || `iframe-${index}`,
                isBlurred: filter && filter.includes('blur'),
                selector: iframe.id ? `#${iframe.id}` : null
            })
        })

        // Background images
        document.querySelectorAll('[style*="background-image"]').forEach((el, index) => {
            const filter = window.getComputedStyle(el).filter
            elements.push({
                type: 'background',
                id: el.id || `bg-${index}`,
                isBlurred: filter && filter.includes('blur'),
                selector: el.id ? `#${el.id}` : null
            })
        })

        return elements
    })
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
    getAllVisualElements
}
