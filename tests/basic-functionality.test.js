const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    getTestPageUrl,
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

    it('should unblur all images when extension is disabled', async () => {
        // Set phobia words and load page
        await setPhobiaWords(browser, ['spider'])
        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        // Verify image is blurred
        let isBlurred = await isElementBlurred(page, '#spider-image')
        assert.ok(isBlurred, 'Image should be blurred when extension is enabled')

        // Disable extension
        await setExtensionEnabled(browser, false)
        await new Promise(r => setTimeout(r, 1000))

        // Verify image is unblurred
        isBlurred = await isElementBlurred(page, '#spider-image')
        assert.strictEqual(isBlurred, false, 'Image should be unblurred when extension is disabled')

        // Re-enable for other tests
        await setExtensionEnabled(browser, true)
    })

    it('should respond to manual blur all command', async () => {
        // Clear phobia words so images wouldn't be blurred automatically
        await setPhobiaWords(browser, [])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000)) // Wait for unveil timers

        // Verify images are not blurred initially
        let blurredCount = await countBlurredImages(page)
        assert.strictEqual(blurredCount, 0, 'Images should not be blurred initially without phobia words')

        // Send manual blur all command via chrome.runtime.sendMessage
        await page.evaluate(() => {
            chrome.runtime.sendMessage({ type: 'blurAll' })
        })
        await new Promise(r => setTimeout(r, 500))

        // Verify images are now blurred
        blurredCount = await countBlurredImages(page)
        assert.ok(blurredCount >= 2, 'All images should be blurred after manual blur command')
    })

    it('should respond to manual unblur all command', async () => {
        // Set phobia words to blur images
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        // Verify at least spider image is blurred
        let isSpiderBlurred = await isElementBlurred(page, '#spider-image')
        assert.ok(isSpiderBlurred, 'Spider image should be blurred initially')

        // Send manual unblur all command
        await page.evaluate(() => {
            chrome.runtime.sendMessage({ type: 'unblurAll' })
        })
        await new Promise(r => setTimeout(r, 500))

        // Verify images are unblurred
        isSpiderBlurred = await isElementBlurred(page, '#spider-image')
        assert.strictEqual(isSpiderBlurred, false, 'All images should be unblurred after manual unblur command')
    })

    it('should update blur amount when setting changes', async () => {
        await setPhobiaWords(browser, ['spider'])

        // Set blur amount to 5
        await setBlurAmount(browser, 5)

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('#spider-image', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        // Check if image has blur filter
        const filterValue = await page.evaluate(() => {
            const img = document.querySelector('#spider-image')
            return window.getComputedStyle(img).filter
        })

        assert.ok(filterValue && filterValue.includes('blur'), 'Image should have blur filter applied')
        assert.ok(filterValue.includes('5px') || filterValue.includes('blur(5'), 'Blur amount should reflect the setting')
    })
})
