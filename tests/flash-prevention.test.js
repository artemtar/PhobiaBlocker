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

    it('should have proper CSS infrastructure (manifest CSS, blur coverage)', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })

        // Wait briefly for content script to process
        await new Promise(r => setTimeout(r, 500))

        const cssChecks = await page.evaluate(() => {
            // Check manifest CSS variables are loaded
            const blurAmount = getComputedStyle(document.documentElement)
                .getPropertyValue('--blurValueAmount')
            const hasManifestCSS = blurAmount !== ''

            // Check that images are actually blurred (proves CSS system works)
            const img = document.querySelector('img')
            const filter = img ? window.getComputedStyle(img).filter : ''
            const isBlurred = filter.includes('blur')

            // Check CSS variable has a numeric value > 0 (parseFloat handles decimals)
            const blurValue = parseFloat(blurAmount) || 0
            const hasValidBlurValue = blurValue > 0

            return { hasManifestCSS, isBlurred, hasValidBlurValue, blurAmount }
        })

        assert.ok(cssChecks.hasManifestCSS, 'Manifest CSS variable --blurValueAmount should be defined')
        assert.ok(cssChecks.hasValidBlurValue, `Blur value should be > 0, got: ${cssChecks.blurAmount}`)
        assert.ok(cssChecks.isBlurred, 'Images should be blurred via CSS (proves blur infrastructure works)')
    })

    // Note: Detailed safe/dangerous content differentiation is tested
    // in nlp-analysis.test.js and visual-content.test.js. The core flash
    // prevention mechanism (CSS applied before JS) is validated above.

    it('should apply blur with correct CSS specificity (overrides site styles)', async () => {
        await setPhobiaWords(browser, ['test'])

        await loadTestPage(page, 'css-specificity-test.html')
        await page.waitForSelector('#override-test', { timeout: 5000 })

        // Wait for content script to analyze and apply blur
        await new Promise(r => setTimeout(r, 3000))

        // Extension's !important rules should win over site's !important
        const isBlurred = await isElementBlurred(page, '#override-test')
        assert.ok(isBlurred, 'Extension blur CSS should have correct specificity to override site styles')
    })
})
