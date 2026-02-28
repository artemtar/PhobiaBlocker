const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    loadTestPage,
    setPhobiaWords,
    getPhobiaWords,
    setExtensionEnabled,
    clearExtensionStorage,
    isElementBlurred,
    countBlurredImages,
    setBlurAmount,
    setBlurAlwaysOn
} = require('./test-utils')

describe('PhobiaBlocker - Basic Functionality', () => {
    let browser
    let page

    before(async () => {
        browser = await launchBrowserWithExtension()
        page = await browser.newPage()

        // Clear storage before tests
        await clearExtensionStorage(browser)

        // Set default settings
        await setExtensionEnabled(browser, true)
        await setBlurAmount(browser, 3)
    })

    after(async () => {
        if (browser) {
            await browser.close()
        }
    })

    it('should load extension successfully', async () => {
        const targets = await browser.targets()
        const extensionTarget = targets.find(target =>
            target.type() === 'service_worker' &&
            target.url().includes('chrome-extension://')
        )

        assert.ok(extensionTarget, 'Extension service worker should be loaded')
    })

    it('should store and retrieve phobia words', async () => {
        const testWords = ['spider', 'snake', 'heights']
        await setPhobiaWords(browser, testWords)

        const retrievedWords = await getPhobiaWords(browser)
        assert.deepStrictEqual(retrievedWords, testWords, 'Phobia words should be stored and retrieved correctly')
    })

    it('should blur images when phobia words are detected', async () => {
        // Set phobia words
        await setPhobiaWords(browser, ['spider', 'spiders'])

        // Navigate to test page with spider content
        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })

        // Wait for content script to process (give it up to 5 seconds)
        await new Promise(r => setTimeout(r, 3000))

        // Check if spider image is blurred
        const isSpiderBlurred = await isElementBlurred(page, '#spider-image')
        assert.ok(isSpiderBlurred, 'Image with spider text should be blurred')
    })

    it('should not blur images when no phobia words are detected', async () => {
        // Set phobia words that won't match
        await setPhobiaWords(browser, ['clown', 'needle'])

        // Navigate to test page
        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('#safe-image', { timeout: 5000 })

        // Wait for content script to process and unveil timer (2 seconds + buffer)
        await new Promise(r => setTimeout(r, 3000))

        // Check if safe image is not blurred
        const isSafeBlurred = await isElementBlurred(page, '#safe-image')
        assert.strictEqual(isSafeBlurred, false, 'Image without phobia words should not be blurred')
    })

    it('should blur all images when "always blur" mode is enabled', async () => {
        // Enable "always blur" mode
        await setBlurAlwaysOn(browser, true)

        // Clear phobia words
        await setPhobiaWords(browser, [])

        // Navigate to test page
        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        // Count blurred images
        const blurredCount = await countBlurredImages(page)
        assert.ok(blurredCount >= 2, 'All images should be blurred in always-on mode')

        // Disable always blur mode
        await setBlurAlwaysOn(browser, false)
    })

    // Note: Tests for manual blur/unblur commands and settings changes
    // are covered in the integration workflow. Individual unit tests for these
    // features require service worker availability which becomes unreliable
    // in long-running test suites. The core functionality tested above
    // (blur detection, always-on mode, storage) validates the extension works.
})
