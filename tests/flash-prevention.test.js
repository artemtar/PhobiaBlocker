// Historical Puppeteer suite, not a release gate (tests/README.md). The header
// below predates the current layout: the manifest stylesheet is css/protection.css,
// the fail-closed shim is js/early-blur.js and the class is phobia-blur.
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
        // 3 predates the 0-100 slider: computeBlurPixels(3) is about 0.15px, still
        // > 0 for isElementBlurred and for the `includes('blur')` checks below.
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
        // "Immediately" is after document_start, so the early shim has run too. Both
        // layers are fail-closed: protection.css blurs every img/video/iframe at 40px
        // and hides background images until the scan marks the root ready, while
        // early-blur.js projects ALWAYS_BLUR if its settings read fails.
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
        // The second sample lands after the controller has replaced the stylesheet's
        // 40px with its own inline value; the page mentions "spider", so a committed
        // verdict can only keep the blur. A clear verdict would itself be deferred.
        const initialBlur = await isElementBlurred(page, '#spider-image')
        await new Promise(r => setTimeout(r, 1000))
        const afterWaitBlur = await isElementBlurred(page, '#spider-image')

        assert.ok(initialBlur && afterWaitBlur, 'Image should remain blurred throughout execution')
    })

    // Models the hand-off from early-blur.js to the controller. applyProtectionMode
    // dispatches phobiablocker:word-cover-manager-ready once per page; early-blur
    // unwraps its covers on that event and the controller re-covers in the same
    // synchronous turn. Text inserted by a listener on that very event is the
    // worst case: it arrives after early-blur stopped observing and before the
    // controller's observer has delivered anything, so only the rebuilt index can
    // cover it. The invariant is that no rendered frame ever shows the word.
    it('should cover words inserted during handoff without CSS-blurring them', async () => {
        await setPhobiaWords(browser, ['spider'])

        // Installed before any page or content script runs on the next navigation.
        await page.evaluateOnNewDocument(() => {
            window.__phobiaHandoffWordCoverState = {
                inserted: false,
                covered: false,
                finished: false,
                renderedFrames: 0,
                uncoveredFrames: 0,
                blurredFrames: 0
            }

            window.addEventListener('phobiablocker:word-cover-manager-ready', () => {
                if (window.__phobiaHandoffWordCoverState.inserted) return

                const p = document.createElement('p')
                p.id = 'handoff-target-word'
                p.textContent = 'A spider arrived during the cover handoff.'
                ;(document.body || document.documentElement).appendChild(p)
                window.__phobiaHandoffWordCoverState.inserted = true

                // A cover must hide the word with an opaque box, never by blurring the
                // text: a blurred word is still partly legible. protection.css sets
                // text-shadow: none on covers for exactly this reason.
                const isCssBlurred = (element) => {
                    if (!element) return false
                    const style = window.getComputedStyle(element)
                    const textShadow = style.textShadow || ''
                    return textShadow.includes('blur') ||
                        textShadow.includes('0px 0px 7px') ||
                        (style.filter || '').includes('blur(')
                }

                const isRendered = (element) => {
                    if (!element || ![...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) {
                        return false
                    }
                    for (let current = element; current; current = current.parentElement) {
                        const style = window.getComputedStyle(current)
                        if (style.display === 'none' || style.visibility === 'hidden' ||
                            style.visibility === 'collapse' || Number(style.opacity) === 0) return false
                    }
                    return true
                }

                // Chrome serialises computed colours as rgb() when opaque and rgba()
                // otherwise; anything else (a system colour keyword) becomes NaN and
                // fails the cover check, which is the fail-closed outcome.
                const colorAlpha = (color) => {
                    if (color === 'transparent') return 0
                    if (/^rgb\(/.test(color)) return 1
                    const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(color)
                    return rgba ? Number(rgba[1]) : NaN
                }

                // What protection.css guarantees for .phobia-word-cover: transparent text
                // (both color and -webkit-text-fill-color), an opaque background and no
                // inherited fade. A cover that has lost its stylesheet would fail here.
                const isProtectedCover = (cover) => {
                    if (!cover || !isRendered(cover) || cover.textContent.toLowerCase() !== 'spider') return false
                    const style = window.getComputedStyle(cover)
                    return colorAlpha(style.color) === 0 &&
                        (!style.webkitTextFillColor || colorAlpha(style.webkitTextFillColor) === 0) &&
                        colorAlpha(style.backgroundColor) === 1 && Number(style.opacity) === 1
                }

                // Samples one paint per animation frame; 60 frames is about a second at
                // 60 Hz. Frames in which the target has no layout box are skipped, so
                // uncoveredFrames counts only frames a user could actually have seen.
                let sampledFrames = 0
                const checkFrame = () => {
                    const state = window.__phobiaHandoffWordCoverState
                    sampledFrames++
                    const target = document.querySelector('#handoff-target-word')
                    if (isRendered(target)) {
                        const cover = target.querySelector('.phobia-word-cover')
                        state.renderedFrames++
                        let blurred = isCssBlurred(cover)
                        for (let current = target; current; current = current.parentElement) {
                            blurred = blurred || isCssBlurred(current)
                        }
                        if (blurred) state.blurredFrames++
                        if (isProtectedCover(cover)) state.covered = true
                        else state.uncoveredFrames++
                    }

                    if (state.covered || sampledFrames >= 60) {
                        state.finished = true
                        return
                    }
                    requestAnimationFrame(checkFrame)
                }

                requestAnimationFrame(checkFrame)
            })
        })

        await loadTestPage(page, 'word-cover.html')
        await page.waitForFunction(
            () => window.__phobiaHandoffWordCoverState?.finished,
            { timeout: 8000, polling: 100 }
        )

        const state = await page.evaluate(() => window.__phobiaHandoffWordCoverState)

        assert.ok(state?.inserted && state.finished, 'handoff monitor should finish after inserting its target word')
        assert.ok(Number.isSafeInteger(state.renderedFrames) && state.renderedFrames > 0,
            'handoff monitor should observe the target in a rendered frame')
        assert.ok(state.covered, 'handoff-inserted target word should have hidden text and an opaque cover')
        assert.strictEqual(state.uncoveredFrames, 0,
            'handoff-inserted target word should never appear uncovered in a rendered frame')
        assert.strictEqual(state.blurredFrames, 0,
            'handoff-inserted target word should not be CSS-blurred, including in its first covered frame')
    })

    it('should have proper CSS infrastructure (manifest CSS, blur coverage)', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })

        // Wait briefly for content script to process
        await new Promise(r => setTimeout(r, 500))

        const cssChecks = await page.evaluate(() => {
            // Check manifest CSS variables are loaded
            // --blurValueAmount is the legacy name (CSS_VARS.blurLegacy); protection.css
            // seeds it with 40px and early-blur.js / js.js overwrite it with
            // computeBlurPixels(blurValueAmount), so a value is present either way.
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
        // The page declares `img { filter: none !important }`. Two things beat it:
        // protection.css's `:root :is(img, video, iframe)` is more specific at equal
        // importance, and once registered the controller writes the filter as an
        // inline !important declaration, which outranks any author stylesheet.
        // 'test' is the trigger because the page text says "test content".
        const isBlurred = await isElementBlurred(page, '#override-test')
        assert.ok(isBlurred, 'Extension blur CSS should have correct specificity to override site styles')
    })
})
