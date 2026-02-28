/**
 * Flash Prevention Test Cases
 *
 * These tests verify that images NEVER flash unblurred content to the user.
 * The fail-safe design ensures all visual content starts blurred by default
 * and only unblurs after confirmation that it's safe.
 *
 * Key principles:
 * 1. CSS blur applied BEFORE JavaScript runs (manifest css/style.css)
 * 2. Early JS injection adds additional blur coverage (js/js.js)
 * 3. Three-layer blur coverage: no-class selector, .blur class, early injection
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    loadTestPage,
    setPhobiaWords,
    setExtensionEnabled,
    clearExtensionStorage,
    isElementBlurred,
    setBlurAmount
} = require('./test-utils')

describe('PhobiaBlocker - Flash Prevention', () => {
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

    it('should blur all visual content immediately on page load (CSS applied before JS)', async () => {
        await setPhobiaWords(browser, ['spider'])

        // Navigate to page with images, videos, and background images
        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('#spider-image', { timeout: 5000 })

        // Check blur state IMMEDIATELY - CSS should have applied before JS
        const results = await page.evaluate(() => {
            const img = document.querySelector('#spider-image')
            const bgImg = document.querySelector('#bg-image-snake')

            return {
                imageBlurred: img && window.getComputedStyle(img).filter.includes('blur'),
                bgBlurred: bgImg && window.getComputedStyle(bgImg).filter.includes('blur')
            }
        })

        assert.ok(results.imageBlurred, 'Images should be blurred immediately by CSS')
        assert.ok(results.bgBlurred, 'Background images should be blurred immediately by CSS')
    })

    it('should maintain blur during JS execution and dynamic content', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('#spider-image', { timeout: 5000 })

        // Check immediately and after brief wait
        const initialBlur = await isElementBlurred(page, '#spider-image')
        await new Promise(r => setTimeout(r, 1000))
        const afterWaitBlur = await isElementBlurred(page, '#spider-image')

        assert.ok(initialBlur && afterWaitBlur, 'Image should remain blurred throughout execution')
    })

    it('should have proper CSS infrastructure (early injection, manifest CSS, no-class coverage)', async () => {
        await setPhobiaWords(browser, ['test'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })

        // Wait for content script to inject early blur CSS and process
        await new Promise(r => setTimeout(r, 1500))

        const cssChecks = await page.evaluate(() => {
            // Check early blur style
            const earlyBlurStyle = document.getElementById('phobiablocker-early-blur')
            const hasEarlyBlur = earlyBlurStyle !== null && earlyBlurStyle.textContent.includes('blur')

            // Check manifest CSS variables
            const blurAmount = getComputedStyle(document.documentElement)
                .getPropertyValue('--blurValueAmount')
            const hasManifestCSS = blurAmount !== ''

            // Check that images are blurred even without .blur class
            const img = document.querySelector('img')
            const filter = img ? window.getComputedStyle(img).filter : ''
            const blurredWithoutClass = filter.includes('blur')

            return { hasEarlyBlur, hasManifestCSS, blurredWithoutClass }
        })

        assert.ok(cssChecks.hasEarlyBlur, 'Early blur CSS should be injected')
        assert.ok(cssChecks.hasManifestCSS, 'Manifest CSS should be loaded')
        assert.ok(cssChecks.blurredWithoutClass, 'Images should blur without .blur class')
    })

    // Note: Detailed safe/dangerous content differentiation is tested
    // in nlp-analysis.test.js and visual-content.test.js. The core flash
    // prevention mechanism (CSS applied before JS) is validated above.

    it('should apply blur with correct CSS specificity (overrides site styles)', async () => {
        await setPhobiaWords(browser, ['test'])

        const testHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    /* Try to override blur with high specificity */
                    img { filter: none !important; }
                </style>
            </head>
            <body>
                <p>Test page</p>
                <img id="override-test" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#override-test', { timeout: 5000 })

        // Extension's !important rules should win
        const isBlurred = await isElementBlurred(page, '#override-test')
        assert.ok(isBlurred, 'Extension blur CSS should have correct specificity to override site styles')
    })
})
