// Historical Puppeteer suite, not a release gate: it needs a headed Chrome outside
// the sandbox and some cases assume behaviour the extension no longer has (see
// tests/README.md). Covers loading, word storage, the page-wide verdict and unblur.
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
    sendMessageViaServiceWorker,
    wait
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
        // 3 predates the 0-100 slider: computeBlurPixels(3) is about 0.15px, which
        // isElementBlurred still counts as blurred (> 0). Media show the stylesheet's
        // 40px fail-closed blur until the controller writes that inline value.
        await setExtensionEnabled(browser, true)
        await setBlurAmount(browser, 3)
    })

    after(async () => {
        if (browser) {
            await browser.close()
        }
    })

    it('should load extension successfully', async () => {
        // Snapshot only: an MV3 worker is killed when idle, so this passes because the
        // storage helpers in before() just woke it through a popup page.
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
        // Fail-closed invariant: the image is blurred by protection.css before any
        // script runs, so this would pass even if analysis never finished. The wait
        // only makes the assertion read the controller's committed blur verdict.
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

        // Wait for the controller to commit a clear verdict. The "unveil timer" the
        // suite was written against is gone: a clear verdict is now deferred and
        // re-analysed (MAX_DEFERRED_CLEAR_VERDICTS times) while the page still
        // produces text, and only the committed verdict writes filter: none.
        // The page is one verdict: "spider" is nowhere on it, so every image clears.
        // #safe-image is only distinct from #spider-image in the markup, not for
        // the extension, whose analysis is page-wide rather than per element.
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
        // ALWAYS_BLUR skips analysis entirely, so an empty word list cannot clear
        // anything. simple-image.html has two <img> plus one inline background div;
        // >= 2 tolerates the div, whose blur waits for the background scan.
        const blurredCount = await countBlurredImages(page)
        assert.ok(blurredCount >= 2, 'All images should be blurred in always-on mode')

        // Disable always blur mode
        await setBlurAlwaysOn(browser, false)
    })

    describe('Context Menu Unblur', () => {
        it('should unblur an image that has the .blur class (normal case)', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 3)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            // Models the right-click: the content script's capture-phase contextmenu
            // listener records the event target and pointer position, and the service
            // worker later sends 'unblur' when the menu item is clicked. The synthetic
            // event has no coordinates, so the hit test by point fails and the visual
            // is resolved by walking up from the recorded target, here the image itself.
            // Simulate contextmenu event fired directly on the .phobia-blur image
            // ([data-phobia-blur] gives it pointer-events: auto)
            await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (img) img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
            })

            // Mirrors the service worker's menu-click message. An explicit reveal is a
            // user action, so it may unblur without a clear verdict; it sets
            // phobia-noblur plus phobia-permanent-unblur so later automatic
            // re-applies leave the element alone.
            await sendMessageToAllContentScripts(browser, { type: 'unblur' })
            await wait(300)

            const result = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return {
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasNoblur: img.classList.contains('phobia-noblur'),
                    hasPermament: img.classList.contains('phobia-permanent-unblur')
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

            // Meant to model an image that is blurred only by the stylesheet (not yet
            // registered by the controller), where pointer-events: none would make the
            // right-click land on the parent. Today that state is produced by
            // protection.css (`:root :is(img, video, iframe)` at 40px, pointer-events:
            // none only until the background scan is ready), not by these class names:
            // blur/noblur/permamentUnblur are legacy and never set, so the image keeps
            // phobia-blur and stays registered. With a synthetic event (no coordinates)
            // the resolver only walks up from the parent, which owns no visual, so the
            // unblur is refused and this case fails on unmodified code (tests/README.md).
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
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasNoblur: img.classList.contains('phobia-noblur'),
                    hasPermament: img.classList.contains('phobia-permanent-unblur'),
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
