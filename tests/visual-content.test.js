const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    getTestPageUrl,
    loadTestPage,
    setPhobiaWords,
    setExtensionEnabled,
    clearExtensionStorage,
    isElementBlurred,
    getAllVisualElements,
    setBlurAmount
} = require('./test-utils')

describe('PhobiaBlocker - Visual Content Types', () => {
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

    it('should blur regular img elements', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('#spider-image', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#spider-image')
        assert.ok(isBlurred, 'Regular img elements should be blurred')
    })

    it('should blur background images', async () => {
        await setPhobiaWords(browser, ['snake'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('#bg-image-snake', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#bg-image-snake')
        assert.ok(isBlurred, 'Elements with background images should be blurred')
    })

    it('should blur video elements', async () => {
        await setPhobiaWords(browser, ['spider', 'spiders'])

        await loadTestPage(page, 'video-iframe.html')
        await page.waitForSelector('#spider-video', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#spider-video')
        assert.ok(isBlurred, 'Video elements should be blurred')
    })

    it('should keep cross-origin iframes blurred even when page text has no phobia words', async () => {
        // No phobia words set - page text analysis will find nothing
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'cross-origin-iframe.html')
        await page.waitForSelector('#cross-origin-iframe', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#cross-origin-iframe')
        assert.ok(isBlurred, 'Cross-origin iframe should stay blurred - content cannot be analyzed')
    })

    it('should unblur same-origin iframes when page text has no phobia words', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'cross-origin-iframe.html')
        await page.waitForSelector('#same-origin-iframe', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#same-origin-iframe')
        assert.ok(!isBlurred, 'Same-origin iframe should be unblurred when no phobia words in page text')
    })

    it('should keep cross-origin iframes blurred when page text has no phobia words (empty target words)', async () => {
        await setPhobiaWords(browser, [])

        await loadTestPage(page, 'cross-origin-iframe.html')
        await page.waitForSelector('#cross-origin-iframe', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#cross-origin-iframe')
        assert.ok(isBlurred, 'Cross-origin iframe should stay blurred regardless of phobia word list')
    })
})
