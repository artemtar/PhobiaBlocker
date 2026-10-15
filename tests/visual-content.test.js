// Historical Puppeteer suite, not a release gate (tests/README.md). Covers the
// media kinds the controller registers (img, video, iframe, inline backgrounds)
// and the iframe policy behind keepCrossOriginIframesBlurred.
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
        // 3 predates the 0-100 slider: computeBlurPixels(3) is about 0.15px, which
        // isElementBlurred still counts as blurred (> 0).
        await setExtensionEnabled(browser, true)
        await setBlurAmount(browser, 3)
    })

    after(async () => {
        if (browser) {
            await browser.close()
        }
    })

    // The positive cases below are fail-closed by construction: protection.css
    // blurs img/video/iframe and hides background images before any script runs,
    // so they also pass if analysis never commits. The iframe cases carry the
    // real evidence, since only a committed clear verdict can reveal anything.
    it('should blur regular img elements', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('#spider-image', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#spider-image')
        assert.ok(isBlurred, 'Regular img elements should be blurred')
    })

    // Backgrounds are found by a computed-style scan, not by selector, and are
    // hidden outright (background-image: none) until the scan marks the root
    // ready; afterwards the div carries data-phobiablocker-background and the
    // same blur as other media.
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

    // data-phobia-blur is what protection.css keys the interactive state on:
    // `[data-phobia-blur]` restores pointer-events: auto and a pointer cursor so
    // the hover preview can receive events, while unregistered media are
    // click-locked until the first pass. VisualNode.blur sets it and unblur
    // restores the page's original value.
    it('should set data-phobia-blur attribute on blurred video elements', async () => {
        await setPhobiaWords(browser, ['spider', 'spiders'])

        await loadTestPage(page, 'video-iframe.html')
        await page.waitForSelector('#spider-video', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        const result = await page.evaluate(() => {
            const video = document.querySelector('#spider-video')
            if (!video) return { found: false }
            return {
                found: true,
                hasBlurClass: video.classList.contains('phobia-blur'),
                hasDataPhobiaBlur: video.hasAttribute('data-phobia-blur'),
                dataValue: video.getAttribute('data-phobia-blur'),
                pointerEvents: window.getComputedStyle(video).pointerEvents
            }
        })

        assert.ok(result.found, '#spider-video should exist')
        assert.ok(result.hasBlurClass, 'Blurred video should have .phobia-blur class')
        assert.ok(result.hasDataPhobiaBlur,
            'Blurred video must have data-phobia-blur attribute (required for CSS hover/pointer-events rules)')
        assert.strictEqual(result.dataValue, '1', 'data-phobia-blur value should be "1"')
        assert.strictEqual(result.pointerEvents, 'auto',
            'Video with data-phobia-blur must have pointer-events: auto for hover to work')
    })

    // The iframe is gated by keepCrossOriginIframesBlurred (default true), not by
    // the page verdict: isCrossOriginIframe answers true for https://www.example.com
    // on a file:// page, so a clear verdict leaves it blurred. Under the current
    // frame protocol the service worker may still release it once every frame
    // inside it reports clear, or a clearance ticket matches it; this case
    // predates that protocol and holds only while no such release arrives.
    it('should keep cross-origin iframes blurred even when page text has no phobia words', async () => {
        // 'spider' is configured but cross-origin-iframe.html never mentions it, so
        // the page verdict is clear and only the iframe policy keeps the blur.
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'cross-origin-iframe.html')
        await page.waitForSelector('#cross-origin-iframe', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#cross-origin-iframe')
        assert.ok(isBlurred, 'Cross-origin iframe should stay blurred - content cannot be analyzed')
    })

    // about:blank inherits the parent origin and needs no navigation, so
    // isCrossOriginIframe answers false and the iframe follows the page verdict.
    // The unblur still waits for the committed clear verdict, and a content script
    // runs inside the frame too (match_about_blank); the 2 s covers both.
    it('should unblur same-origin iframes when page text has no phobia words', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'cross-origin-iframe.html')
        await page.waitForSelector('#same-origin-iframe', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#same-origin-iframe')
        assert.ok(!isBlurred, 'Same-origin iframe should be unblurred when no phobia words in page text')
    })

    // With no valid targets the service worker answers CLEAR itself without asking
    // the offscreen analyser, so every other media element is revealed; the
    // iframe policy must hold on its own, independent of any word list.
    it('should keep cross-origin iframes blurred when page text has no phobia words (empty target words)', async () => {
        await setPhobiaWords(browser, [])

        await loadTestPage(page, 'cross-origin-iframe.html')
        await page.waitForSelector('#cross-origin-iframe', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#cross-origin-iframe')
        assert.ok(isBlurred, 'Cross-origin iframe should stay blurred regardless of phobia word list')
    })
})
