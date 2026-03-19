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
    setBlurAlwaysOn,
    sendMessageToAllContentScripts,
    sendMessageViaServiceWorker
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

    describe('Context Menu Unblur', () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms))

        it('should unblur an image that has the .blur class (normal case)', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 3)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            // Simulate contextmenu event fired directly on the .blur image (pointer-events: auto)
            await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (img) img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
            })

            await sendMessageToAllContentScripts(browser, { type: 'unblur' })
            await wait(300)

            const result = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return {
                    hasBlur: img.classList.contains('blur'),
                    hasNoblur: img.classList.contains('noblur'),
                    hasPermament: img.classList.contains('permamentUnblur')
                }
            })

            assert.ok(!result.hasBlur, 'image should not have .blur after context menu unblur')
            assert.ok(result.hasNoblur, 'image should have .noblur after context menu unblur')
            assert.ok(result.hasPermament, 'image should have .permamentUnblur after context menu unblur')
        })

        it('should unblur a CSS-only-blurred image (no .blur class, contextmenu on parent)', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 3)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            // Remove .blur class to simulate a CSS-only-blurred image (pre-analysis state or
            // a page where mutations haven't been processed yet). The image remains visually
            // blurred by the CSS rule `img:not(.noblur):not(.permamentUnblur)`.
            // With no .blur class, pointer-events: none kicks in, so the contextmenu event
            // lands on the parent element rather than the image itself.
            await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (img) {
                    img.classList.remove('blur', 'noblur', 'permamentUnblur')
                    // Fire contextmenu on the parent — same as what Chrome does when
                    // pointer-events: none makes the image transparent to pointer events
                    const parent = img.parentElement
                    if (parent) parent.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
                }
            })

            await sendMessageViaServiceWorker(browser, { type: 'unblur' })
            await wait(300)

            const result = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return {
                    hasBlur: img.classList.contains('blur'),
                    hasNoblur: img.classList.contains('noblur'),
                    hasPermament: img.classList.contains('permamentUnblur'),
                    filterPx: (() => {
                        const f = window.getComputedStyle(img).filter
                        const m = f && f.match(/blur\(([\d.]+)px\)/)
                        return m ? parseFloat(m[1]) : 0
                    })()
                }
            })

            assert.ok(!result.hasBlur, 'image should not have .blur after fallback unblur')
            assert.ok(result.hasNoblur, 'image should have .noblur after fallback unblur')
            assert.ok(result.hasPermament, 'image should have .permamentUnblur after fallback unblur')
            assert.strictEqual(result.filterPx, 0, `image should be visually unblurred (got ${result.filterPx}px)`)
        })
    })
})
