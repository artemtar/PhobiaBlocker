// Historical Puppeteer end-to-end suite, kept for reference. It is not a release gate:
// root `npm test` fails on purpose and the gate is `npm run test:unit` (tests/README.md).
// Some cases still describe pre-1.3.1 behaviour; the notes below mark where that is so.
/**
 * Hover Preview Test Cases
 *
 * Tests for the hover preview feature:
 * - Storage: previewEnabled and previewBlurStrength persist correctly
 * - CSS variable --previewBlurAmount is set/unset based on settings
 * - Blurred elements have pointer-events: auto (fixes hover detection)
 * - Hovering a blurred image shows reduced blur when preview is enabled
 * - Hovering shows full blur (no change) when preview is disabled
 * - Blur strength slider controls the hover blur amount
 * - Live settings update via chrome.storage.onChanged
 */

const { describe, it, before, beforeEach, after, afterEach } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    loadTestPage,
    setPhobiaWords,
    setExtensionEnabled,
    clearExtensionStorage,
    isElementBlurred,
    setBlurAmount,
    setPreviewEnabled,
    setPreviewBlurStrength,
    getPreviewEnabled,
    getPreviewBlurStrength,
    sendMessageToAllContentScripts,
    waitForPhobiaBlur,
    blurPxOf: extractBlurPx,
    wait
} = require('./test-utils')

// Bring the tab to the foreground, scroll the element into view, then hover.
//
// page.hover() uses scrollIntoViewIfNeeded() + IntersectionObserver internally.
// When the tab is in the background Chrome throttles rendering so the
// IntersectionObserver callback never fires → 180s CDP timeout.
// bringToFront() moves the tab to the foreground so rendering is unthrottled
// and page.hover() completes immediately.
//
// page.mouse.move() alone does NOT trigger CSS :hover state — page.hover()
// is required for the hit-test that Chrome uses to apply :hover rules.
async function hoverElement(page, selector) {
    await page.bringToFront()
    await page.$eval(selector, el => el.scrollIntoView({ block: 'center', inline: 'center' }))
    await page.hover(selector)
}

describe('PhobiaBlocker - Hover Preview', () => {
    let browser
    let page

    before(async () => {
        browser = await launchBrowserWithExtension()
        await clearExtensionStorage(browser)
        await setExtensionEnabled(browser, true)
        // Slider 60 is about 14.9px under the current curve (101^0.6 - 1, computeBlurPixels);
        // every preview strength used below (0-12) stays under it, so "reduced blur" holds.
        // The pre-1.3.1 curve rendered the same value at roughly 42px.
        await setBlurAmount(browser, 60)
        page = await browser.newPage()
        page.setDefaultTimeout(5000)
    })

    after(async () => {
        if (browser) await browser.close()
    })

    describe('Storage Operations', () => {
        // getSyncStorage reads the raw key, not Storage.getWithDefaults, so a fresh store
        // yields undefined even though DEFAULTS.previewEnabled is true. Only the content
        // scripts and the UI pages apply defaults.
        it('should return undefined for previewEnabled when storage is fresh', async () => {
            await clearExtensionStorage(browser)
            const enabled = await getPreviewEnabled(browser)
            assert.strictEqual(enabled, undefined, 'previewEnabled should be undefined in fresh storage')
        })

        it('should store and retrieve previewEnabled=true', async () => {
            await setPreviewEnabled(browser, true)
            const enabled = await getPreviewEnabled(browser)
            assert.strictEqual(enabled, true)
        })

        it('should store and retrieve previewEnabled=false', async () => {
            await setPreviewEnabled(browser, false)
            const enabled = await getPreviewEnabled(browser)
            assert.strictEqual(enabled, false)
        })

        it('should return undefined for previewBlurStrength when storage is fresh', async () => {
            await clearExtensionStorage(browser)
            const strength = await getPreviewBlurStrength(browser)
            assert.strictEqual(strength, undefined, 'previewBlurStrength should be undefined in fresh storage')
        })

        it('should store and retrieve previewBlurStrength', async () => {
            await setPreviewBlurStrength(browser, 8)
            assert.strictEqual(await getPreviewBlurStrength(browser), 8)
        })

        it('should store previewBlurStrength at minimum value (0)', async () => {
            await setPreviewBlurStrength(browser, 0)
            assert.strictEqual(await getPreviewBlurStrength(browser), 0)
        })

        // 20 is the settings slider's max (settings.html). Storage validation only requires
        // a finite number, so the bound is enforced by the UI, not by isValidStoredValue.
        it('should store previewBlurStrength at maximum value (20)', async () => {
            await setPreviewBlurStrength(browser, 20)
            assert.strictEqual(await getPreviewBlurStrength(browser), 20)
        })

        it('should independently update previewEnabled without changing previewBlurStrength', async () => {
            await setPreviewBlurStrength(browser, 7)
            await setPreviewEnabled(browser, false)
            assert.strictEqual(await getPreviewBlurStrength(browser), 7, 'strength should be unchanged')
            assert.strictEqual(await getPreviewEnabled(browser), false)
        })
    })

    // --previewBlurAmount is the legacy name of --phobiablocker-previewBlurAmount; both are
    // written on <html> by early-blur.js and the controller (CSS_VARS in shared-policy.js).
    // No stylesheet consumes it today: the hover filter is written inline per element, so
    // these cases check the projection, not what the user sees.
    describe('CSS Variable --previewBlurAmount', () => {
        it('should set --previewBlurAmount to the configured strength when preview is enabled', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 6)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(2500)

            const previewAmount = await page.evaluate(() => {
                return getComputedStyle(document.documentElement).getPropertyValue('--previewBlurAmount').trim()
            })

            assert.ok(previewAmount !== '', '--previewBlurAmount should be set on the page')
            assert.strictEqual(previewAmount, '6px', `--previewBlurAmount should be 6px, got: "${previewAmount}"`)
        })

        // 5 is DEFAULTS.previewBlurStrength in shared-policy.js, applied by getWithDefaults
        // when the key is missing after clearExtensionStorage.
        it('should set --previewBlurAmount to 5px by default when previewBlurStrength is not stored', async () => {
            await clearExtensionStorage(browser)
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(2500)

            const previewAmount = await page.evaluate(() => {
                return getComputedStyle(document.documentElement).getPropertyValue('--previewBlurAmount').trim()
            })

            assert.strictEqual(previewAmount, '5px', `Default --previewBlurAmount should be 5px, got: "${previewAmount}"`)
        })

        // With previews off, previewBlurCssValue falls back to the page-wide blur variable
        // (ultimately the 40px stylesheet default), never to the stored strength, so a hover
        // can never reveal more than the full blur allows. Only that negative is asserted;
        // blurAmount and normalFilter are collected for diagnostics.
        it('should override --previewBlurAmount to full blur value when preview is disabled', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, false)
            await setPreviewBlurStrength(browser, 6)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(2500)

            // When disabled, the hover blur should equal the full blur (no visible change on hover)
            const result = await page.evaluate(() => {
                const style = getComputedStyle(document.documentElement)
                const previewAmount = style.getPropertyValue('--previewBlurAmount').trim()
                const blurAmount = style.getPropertyValue('--blurValueAmount').trim()
                // Compute actual blur values on the element before and during a synthetic hover
                const img = document.querySelector('#spider-image')
                const normalFilter = img ? window.getComputedStyle(img).filter : ''
                return { previewAmount, blurAmount, normalFilter }
            })

            // previewAmount should not be the configured 6px when disabled
            assert.notStrictEqual(result.previewAmount, '6px', '--previewBlurAmount should not be 6px when preview is disabled')
        })
    })

    describe('Pointer Events', () => {
        // protection.css gives blurred media `pointer-events: auto !important` under
        // :root:not(.phobia-disabled). The preview is driven by elementsFromPoint, which
        // skips pointer-events:none elements, so a page that disables pointer events on
        // its images (lightboxes, galleries) would otherwise make them un-previewable.
        it('detected images with [data-phobia-blur] attribute should have pointer-events: auto', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const result = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (!img) return { found: false }
                return {
                    found: true,
                    hasBlurClass: img.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    pointerEvents: window.getComputedStyle(img).pointerEvents
                }
            })

            assert.ok(result.found, '#spider-image should exist')
            assert.ok(result.hasBlurClass, '#spider-image should have .blur class after detection')
            assert.ok(result.hasDataPhobiaBlur, '#spider-image should have data-phobia-blur attribute after detection')
            assert.strictEqual(result.pointerEvents, 'auto', 'Elements with [data-phobia-blur] must have pointer-events: auto for hover to work')
        })

        it('images with only site-owned .blur class (no data-phobia-blur) should not have extension pointer-events', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            // Use a word not on the page so the extension leaves images alone
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('body', { timeout: 5000 })
            await wait(2000)

            // Inject an img with only the site-owned .blur class (no data-phobia-blur)
            const result = await page.evaluate(() => {
                const img = document.createElement('img')
                img.id = 'site-blur-only'
                img.className = 'blur'  // site-owned class, not extension-owned
                img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
                document.body.appendChild(img)
                // Read pointer-events right away (before extension mutation observer fires)
                return {
                    hasBlurClass: img.classList.contains('blur'),  // site-owned class
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    // The current protection.css only forces pointer-events:none on unregistered
                    // media until the root is marked background-ready, so after the 2 s wait this
                    // reads the UA default (auto). The assertion below relied on the ungated rule
                    // of 47819e1 and earlier (`:root[data-phobiablocker-frame="top"] :is(img, video)
                    // :not([data-phobiablocker-media]) { pointer-events: none }`), which kept any
                    // unregistered image non-interactive; the gate was added in f2a1c1f (1.3.0).
                    pointerEvents: window.getComputedStyle(img).pointerEvents
                }
            })

            assert.ok(result.hasBlurClass, 'img should have site-owned .blur class')
            assert.ok(!result.hasDataPhobiaBlur, 'img should NOT have data-phobia-blur (not a phobia detection)')
            // The [data-phobia-blur] pointer-events: auto rule must NOT apply here
            assert.notStrictEqual(result.pointerEvents, 'auto',
                'Site-owned .blur class alone must not grant pointer-events: auto from the extension')
        })

        // A clear verdict may be deferred while the page is still producing text
        // (MAX_DEFERRED_CLEAR_VERDICTS in js.js), whereas a blur verdict is applied at once,
        // so phobia-noblur can arrive several analysis rounds after phobia-blur would have;
        // the 3 s wait has to cover those re-runs, not just the first verdict.
        it('safe images with .noblur class should remain interactive', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            // Use a word not on the page so global analysis returns no match → all images get .noblur
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#safe-image', { timeout: 5000 })
            await wait(3000)

            const result = await page.evaluate(() => {
                const img = document.querySelector('#safe-image')
                if (!img) return { found: false }
                return {
                    found: true,
                    hasNoblurClass: img.classList.contains('phobia-noblur'),
                    isBlurred: window.getComputedStyle(img).filter.includes('blur')
                }
            })

            assert.ok(result.found, '#safe-image should exist')
            assert.ok(result.hasNoblurClass, '#safe-image should have .noblur class')
            assert.strictEqual(result.isBlurred, false, 'Safe image should not be blurred')
        })
    })

    describe('Hover Blur Behavior', () => {
        // The preview is VisualNode.showPreview: the phobia-preview class plus an inline
        // `filter: blur(<previewBlurStrength>px) !important`. The hit test runs on the
        // pointermove event with a 30 ms throttle (HOVER_HIT_TEST_INTERVAL_MS) and the
        // stylesheet transition is 0.2 s, so 300 ms is enough for a settled read.
        it('hovering a blurred image should show reduced blur when preview is enabled', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 4)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            // Get filter when not hovering
            const blurBefore = await page.evaluate(() => {
                return window.getComputedStyle(document.querySelector('#spider-image')).filter
            })

            // Hover and get filter
            await hoverElement(page, '#spider-image')
            await wait(300)
            const blurDuring = await page.evaluate(() => {
                return window.getComputedStyle(document.querySelector('#spider-image')).filter
            })

            const beforePx = extractBlurPx(blurBefore)
            const duringPx = extractBlurPx(blurDuring)

            assert.ok(blurBefore.includes('blur'), 'Image should be blurred before hover')
            assert.ok(blurDuring.includes('blur'), 'Image should still be blurred on hover (reduced, not removed)')
            assert.ok(duringPx < beforePx, `Hover blur (${duringPx}px) should be less than full blur (${beforePx}px)`)
        })

        it('hover blur should equal previewBlurStrength exactly', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            await hoverElement(page, '#spider-image')
            await wait(300)

            const hoverBlur = await page.evaluate(() => {
                return window.getComputedStyle(document.querySelector('#spider-image')).filter
            })

            assert.strictEqual(extractBlurPx(hoverBlur), 5, `Hover blur should be exactly 5px, got ${extractBlurPx(hoverBlur)}px`)
        })

        // Fail-closed: _updateHoverPreview bails out when previewEnabled !== true, so no
        // preview class or filter is ever written. The <1px tolerance absorbs CSSOM rounding
        // of the inline px value, not a real difference.
        it('hover should not change blur amount when preview is disabled', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, false)
            await setPreviewBlurStrength(browser, 4)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            await hoverElement(page, '#spider-image')
            await wait(300)

            const blurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(
                Math.abs(blurDuring - blurBefore) < 1,
                `When preview is disabled, hover blur (${blurDuring}px) should equal full blur (${blurBefore}px)`
            )
        })

        it('higher previewBlurStrength should produce more blur on hover', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPhobiaWords(browser, ['spider'])

            // Measure hover blur at strength 2
            await setPreviewBlurStrength(browser, 2)
            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)
            await hoverElement(page, '#spider-image')
            await wait(300)
            const blurAt2 = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            // Measure hover blur at strength 12
            await setPreviewBlurStrength(browser, 12)
            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)
            await hoverElement(page, '#spider-image')
            await wait(300)
            const blurAt12 = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(blurAt12 > blurAt2, `Strength 12 (${blurAt12}px) should produce more blur than strength 2 (${blurAt2}px)`)
        })

        // Strength 0 writes blur(0px): the media is fully visible while hovered. That is the
        // user's explicit choice; the invariant is only that the full blur returns on leave,
        // which the next case covers.
        it('previewBlurStrength of 0 should show no blur on hover', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 0)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            await hoverElement(page, '#spider-image')
            await wait(300)

            const hoverBlur = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.strictEqual(hoverBlur, 0, 'Strength 0 should produce no blur on hover')
        })

        it('moving mouse away should restore full blur', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 4)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            // Bring tab to front so Chrome stops throttling JS execution — the
            // content script's chrome.storage.sync.get() callback is deferred
            // while the tab is in the background, which causes blurBefore to
            // read the CSS default (40px) rather than the stored value.
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            await hoverElement(page, '#spider-image')
            await wait(300)

            // Move mouse away from image
            // (10, 10) lands on the page heading. The hit test re-runs on pointer moves, scrolls
            // and settings changes, never on a timer, so this move is what makes
            // _updateHoverPreview call hidePreview on the image.
            await page.mouse.move(10, 10)
            await wait(400)

            const blurAfter = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(blurAfter > 0, 'Blur should be restored after mouse moves away')
            assert.ok(
                Math.abs(blurAfter - blurBefore) < 1,
                `Blur after hover (${blurAfter}px) should match original blur (${blurBefore}px)`
            )
        })

        // Regression for the old per-container listeners: mouseenter/mouseleave on the
        // positioned ancestor kept the preview alive anywhere inside the card. The hit test
        // previews only what is under the pointer, so an empty zone in the same card must
        // restore the blur. blurAll first puts the node in the manual-blur state, which
        // the hit test must treat exactly like a verdict blur.
        it('moving off media inside the same positioned card should restore full blur after blurAll', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 4)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'hover-large-container.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            await sendMessageToAllContentScripts(browser, { type: 'blurAll' })
            await wait(500)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            await hoverElement(page, '#spider-image')
            await wait(300)

            const blurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            const point = await page.$eval('#same-card-empty-zone', (el) => {
                const rect = el.getBoundingClientRect()
                return { x: rect.left + 20, y: rect.top + 20 }
            })
            await page.mouse.move(point.x, point.y)
            await wait(400)

            const result = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                const filter = window.getComputedStyle(img).filter
                const match = filter.match(/blur\(([\d.]+)px\)/)
                return {
                    blurAfter: match ? parseFloat(match[1]) : 0,
                    hasPreviewClass: img.classList.contains('phobia-preview')
                }
            })

            assert.ok(blurBefore > 0, `Image should be fully blurred before hover (got ${blurBefore}px)`)
            assert.ok(blurDuring < blurBefore, `Hover preview (${blurDuring}px) should reduce blur from ${blurBefore}px`)
            assert.ok(!result.hasPreviewClass, 'Preview class should be removed after pointer leaves the media bounds')
            assert.ok(
                Math.abs(result.blurAfter - blurBefore) < 1,
                `Moving within the same card but outside media should restore full blur (${result.blurAfter}px vs ${blurBefore}px)`
            )
        })
    })

    // The content script reacts to chrome.storage.onChanged; the preview keys are
    // visual-only, so readAndApplySettings runs the visualOnly path and setSettings clears
    // and re-schedules the hover preview without re-analysing the page. The 800 ms waits
    // cover the storage read round trip after the helper's own 300 ms settle.
    describe('Live Settings Update (no page reload)', () => {
        it('increasing previewBlurStrength updates hover blur immediately', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 3)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            await hoverElement(page, '#spider-image')
            await wait(300)
            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            // Move away, update strength, hover again
            await page.mouse.move(10, 10)
            await wait(200)
            await setPreviewBlurStrength(browser, 12)
            await wait(800)

            await hoverElement(page, '#spider-image')
            await wait(300)
            const blurAfter = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(
                blurAfter > blurBefore,
                `After increasing strength, hover blur (${blurAfter}px) should be greater than before (${blurBefore}px)`
            )
        })

        // Two mechanisms are in play: _updateHoverPreview stops selecting a node once
        // previewEnabled is false, and _applyPreviewFilter would use the full blurPixels
        // anyway, so even a preview still active at the moment of the change collapses.
        it('disabling preview mid-session removes hover effect', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 4)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            // Confirm hover preview is working
            await hoverElement(page, '#spider-image')
            await wait(300)
            const blurWithPreview = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )
            await page.mouse.move(10, 10)
            await wait(200)

            const fullBlur = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )
            assert.ok(blurWithPreview < fullBlur, 'Preview should show less blur than full blur')

            // Disable preview
            await setPreviewEnabled(browser, false)
            await wait(800)

            // Hover again - should now show full blur
            await hoverElement(page, '#spider-image')
            await wait(300)
            const blurAfterDisable = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(
                Math.abs(blurAfterDisable - fullBlur) < 1,
                `After disabling preview, hover blur (${blurAfterDisable}px) should equal full blur (${fullBlur}px)`
            )
        })

        it('re-enabling preview mid-session restores hover effect', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, false)
            await setPreviewBlurStrength(browser, 4)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const fullBlur = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            // Enable preview
            await setPreviewEnabled(browser, true)
            await wait(800)

            await hoverElement(page, '#spider-image')
            await wait(300)
            const blurAfterEnable = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(
                blurAfterEnable < fullBlur,
                `After re-enabling preview, hover blur (${blurAfterEnable}px) should be less than full blur (${fullBlur}px)`
            )
        })

        // Regression: blur() early-returns when the node is already blurred, so a
        // blurValueAmount change used to reach the element only after a hover
        // cycle rewrote the inline filter. The oracle is a fresh load at the new
        // amount, which keeps the test independent of the slider-to-px formula.
        it('changing blurValueAmount updates already-blurred media without a hover', async () => {
            await setExtensionEnabled(browser, true)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 4)
            await setPhobiaWords(browser, ['spider'])

            const readBlurPx = selector => page.evaluate(
                sel => window.getComputedStyle(document.querySelector(sel)).filter,
                selector
            ).then(extractBlurPx)

            // Reference: what a page loaded at the target amount renders.
            await setBlurAmount(browser, 20)
            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#spider-image')
            await waitForPhobiaBlur(page, '#bg-image-snake')
            // Let the 0.2s filter transition from the stylesheet default settle.
            await wait(500)
            const expectedImg = await readBlurPx('#spider-image')
            const expectedBg = await readBlurPx('#bg-image-snake')

            // Load at a stronger amount, park the pointer away from all media,
            // then change the amount live.
            await setBlurAmount(browser, 60)
            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.mouse.move(5, 5)
            await waitForPhobiaBlur(page, '#spider-image')
            await waitForPhobiaBlur(page, '#bg-image-snake')
            await wait(500)
            const before = await readBlurPx('#spider-image')
            assert.ok(
                before > expectedImg,
                `Precondition: slider 60 (${before}px) must blur more than slider 20 (${expectedImg}px)`
            )

            await setBlurAmount(browser, 20)
            await wait(800)

            // Background nodes carry their own inline filter (VisualNode kind 'background'),
            // so refreshBlurFilter must reach them too; checking only the <img> would miss a
            // refresh that walked a media-only list. The 0.01px tolerance is tight because
            // both reads come from the same computeBlurPixels output.
            const afterImg = await readBlurPx('#spider-image')
            const afterBg = await readBlurPx('#bg-image-snake')
            assert.ok(
                Math.abs(afterImg - expectedImg) < 0.01,
                `Image blur should follow the new amount without a hover: got ${afterImg}px, expected ${expectedImg}px`
            )
            assert.ok(
                Math.abs(afterBg - expectedBg) < 0.01,
                `Background blur should follow the new amount without a hover: got ${afterBg}px, expected ${expectedBg}px`
            )
        })
    })

    // Guardian-style markup: an <a> with inset:0 sits over the <picture>, so no pointer
    // event ever reaches the <img>. elementsFromPoint returns the whole stack under the
    // pointer and the controller previews the first registered, blurred node in it, which
    // is why listening on the media element itself was abandoned.
    describe('Sibling Overlay Hover (picture + overlay structure)', () => {
        it('hovering sibling overlay of <picture> should show preview blur on the img', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'picture-overlay.html')
            await page.waitForSelector('#picture-spider-image', { timeout: 5000 })
            await wait(3000)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#picture-spider-image')).filter)
            )

            // Hover the sibling overlay, not the image itself
            await hoverElement(page, '#lightbox-overlay')
            await wait(300)

            const blurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#picture-spider-image')).filter)
            )

            assert.ok(blurBefore > 0, 'Image should be blurred before hover')
            assert.ok(
                blurDuring < blurBefore,
                `Hovering overlay (${blurDuring}px) should show less blur than full blur (${blurBefore}px)`
            )
        })

        it('moving mouse away from sibling overlay should restore full blur', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'picture-overlay.html')
            await page.waitForSelector('#picture-spider-image', { timeout: 5000 })
            await wait(3000)

            const blurFull = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#picture-spider-image')).filter)
            )

            await hoverElement(page, '#lightbox-overlay')
            await wait(300)

            await page.mouse.move(10, 10)
            await wait(400)

            const blurAfter = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#picture-spider-image')).filter)
            )

            assert.ok(
                Math.abs(blurAfter - blurFull) < 1,
                `Blur after moving away (${blurAfter}px) should match original full blur (${blurFull}px)`
            )
        })

        it('hovering sibling overlay when preview is disabled should not change blur', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, false)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'picture-overlay.html')
            await page.waitForSelector('#picture-spider-image', { timeout: 5000 })
            await wait(3000)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#picture-spider-image')).filter)
            )

            await hoverElement(page, '#lightbox-overlay')
            await wait(300)

            const blurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#picture-spider-image')).filter)
            )

            assert.ok(
                Math.abs(blurDuring - blurBefore) < 1,
                `When preview is disabled, hovering overlay (${blurDuring}px) should not change blur (${blurBefore}px)`
            )
        })

        it('hovering sibling overlay of plain img (no picture) should show preview blur', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'picture-overlay.html')
            await page.waitForSelector('#direct-spider-image', { timeout: 5000 })
            await wait(3000)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#direct-spider-image')).filter)
            )

            await hoverElement(page, '#direct-overlay')
            await wait(300)

            const blurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#direct-spider-image')).filter)
            )

            assert.ok(blurBefore > 0, 'Image should be blurred before hover')
            assert.ok(
                blurDuring < blurBefore,
                `Hovering direct overlay (${blurDuring}px) should show less blur than full blur (${blurBefore}px)`
            )
        })
    })

    describe('Hover After Unblur All', () => {
        // unblurAll records every registered element as an explicit reveal and renders it
        // with unblur({ explicit: true }): phobia-permanent-unblur is added and
        // data-phobia-blur is restored to what the page had (absent). An explicit reveal
        // is the user's action, so it holds through later blur verdicts and settings
        // changes; only blurAll, or the element showing different content, withdraws it.
        it('images should have permamentUnblur class after unblurAll and data-phobia-blur removed', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 4)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            // Confirm image is blurred before unblurAll — both .blur class and data-phobia-blur set
            const stateBefore = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return {
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur')
                }
            })
            assert.ok(stateBefore.hasBlur, '#spider-image should have .blur class before unblurAll')
            assert.ok(stateBefore.hasDataPhobiaBlur, '#spider-image should have data-phobia-blur attribute before unblurAll')

            await sendMessageToAllContentScripts(browser, { type: 'unblurAll' })
            await wait(500)

            const result = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return {
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasNoblur: img.classList.contains('phobia-noblur'),
                    hasPermament: img.classList.contains('phobia-permanent-unblur'),
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur')
                }
            })

            assert.ok(!result.hasBlur, 'image should not have .blur class after unblurAll')
            assert.ok(result.hasNoblur, 'image should have .noblur class after unblurAll')
            assert.ok(result.hasPermament, 'image should have .permamentUnblur class after unblurAll')
            assert.ok(!result.hasDataPhobiaBlur, 'image should not have data-phobia-blur attribute after unblurAll')
        })

        // The hit test only previews nodes whose isBlurred is true; a revealed node is
        // skipped entirely, so no preview filter (which would look like a re-blur) is written.
        it('hovering after unblurAll should not re-blur the image', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 4)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            await sendMessageToAllContentScripts(browser, { type: 'unblurAll' })
            await wait(500)

            // Image should be clear after unblurAll
            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )
            assert.strictEqual(blurBefore, 0, `image should be unblurred after unblurAll, got ${blurBefore}px`)

            // Hover should not re-blur it
            await hoverElement(page, '#spider-image')
            await wait(300)

            const blurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )
            assert.strictEqual(blurDuring, 0,
                `hovering after unblurAll should not blur the image (got ${blurDuring}px)`)
        })
    })

    describe('Absolute-Positioned Sibling Overlay Hover (IMDB-style)', () => {
        // In IMDB-style cards, an absolutely-positioned <a> overlay covers the image
        // container and intercepts all pointer events, so no event reaches the image or
        // its container. The controller attaches no per-element listeners: it hit-tests
        // the pointer position with elementsFromPoint and previews the first blurred
        // registered node in the stack, so the overlay's shape and nesting do not matter.

        it('hovering the absolute overlay should show preview blur on the image', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'imdb-style-overlay.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            // Hover the absolute overlay, not the image itself
            await hoverElement(page, '#lockup-overlay')
            await wait(300)

            const blurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(blurBefore > 0, 'Image should be blurred before hover')
            assert.ok(
                blurDuring < blurBefore,
                `Hovering absolute overlay (${blurDuring}px) should show less blur than full blur (${blurBefore}px)`
            )
        })

        it('moving mouse away from the overlay should restore full blur', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'imdb-style-overlay.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const blurFull = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            await hoverElement(page, '#lockup-overlay')
            await wait(300)

            // Move completely outside the card
            await page.mouse.move(10, 10)
            await wait(400)

            const blurAfter = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(
                Math.abs(blurAfter - blurFull) < 1,
                `Blur after moving away (${blurAfter}px) should match original full blur (${blurFull}px)`
            )
        })

        it('hovering overlay when preview is disabled should not change blur', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, false)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'imdb-style-overlay.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            await hoverElement(page, '#lockup-overlay')
            await wait(300)

            const blurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(
                Math.abs(blurDuring - blurBefore) < 1,
                `When preview is disabled, hovering overlay (${blurDuring}px) should not change blur (${blurBefore}px)`
            )
        })

        // The verdict is page-wide, so #safe-image is blurred as well and hovering its
        // overlay previews that image. The invariant is that a preview never leaks to a
        // node that is not under the pointer.
        it('safe image overlay should not trigger preview on unrelated card', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'imdb-style-overlay.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const spiderBlurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            // Hover the safe card's overlay — should not affect the spider image
            await hoverElement(page, '#safe-overlay')
            await wait(300)

            const spiderBlurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(
                Math.abs(spiderBlurDuring - spiderBlurBefore) < 1,
                `Hovering safe card overlay should not affect spider image blur (before: ${spiderBlurBefore}px, during: ${spiderBlurDuring}px)`
            )
        })

        // _updateHoverPreview prefers img/video over a background node and uses the
        // background only as a fallback when no real media is in the stack; the poster is
        // a plain div, not a root or editing-surface background, so it may be previewed.
        it('hovering reel-style overlay should show preview blur on a background poster', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'reel-background-overlay.html')
            await page.waitForSelector('#reel-poster', { timeout: 5000 })
            await wait(3000)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#reel-poster')).filter)
            )

            await hoverElement(page, '#reel-overlay')
            await wait(300)

            const result = await page.evaluate(() => {
                const poster = document.querySelector('#reel-poster')
                const filter = window.getComputedStyle(poster).filter
                const match = filter.match(/blur\(([\d.]+)px\)/)
                return {
                    blurDuring: match ? parseFloat(match[1]) : 0,
                    hasPreviewClass: poster.classList.contains('phobia-preview')
                }
            })

            assert.ok(blurBefore > 0, 'Background poster should be blurred before hover')
            assert.ok(result.hasPreviewClass, 'Background poster should receive phobia-preview while hovering overlay')
            assert.strictEqual(result.blurDuring, 5, `Background poster preview should stay blurred at 5px, got ${result.blurDuring}px`)
            assert.ok(
                result.blurDuring < blurBefore,
                `Hovering reel overlay (${result.blurDuring}px) should reduce poster blur from ${blurBefore}px`
            )
        })

        // The outer overlay shell has pointer-events:none and only the inner control is
        // hit-testable; elementsFromPoint still returns the <video> beneath it. The controller
        // previews a <video> only when it has a poster or loaded frame data (_canRenderPreview,
        // added for YouTube's empty hover layer in b55c9ba). This fixture's video has neither,
        // so the case cannot pass as written even though it was added after that guard
        // (05ec451); give the video a poster before relying on it.
        it('hovering nested Instagram-style video overlay control should show preview blur on the video', async () => {
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'instagram-video-overlay.html')
            await page.waitForSelector('#instagram-video', { timeout: 5000 })
            await wait(3000)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#instagram-video')).filter)
            )

            await hoverElement(page, '#instagram-overlay-control')
            await wait(300)

            const result = await page.evaluate(() => {
                const video = document.querySelector('#instagram-video')
                const filter = window.getComputedStyle(video).filter
                const match = filter.match(/blur\(([\d.]+)px\)/)
                return {
                    blurDuring: match ? parseFloat(match[1]) : 0,
                    hasPreviewClass: video.classList.contains('phobia-preview')
                }
            })

            assert.ok(blurBefore > 0, 'Video should be blurred before hover')
            assert.ok(result.hasPreviewClass, 'Video should receive phobia-preview while hovering nested overlay control')
            assert.strictEqual(result.blurDuring, 5, `Video preview should stay blurred at 5px, got ${result.blurDuring}px`)
            assert.ok(
                result.blurDuring < blurBefore,
                `Hovering nested Instagram overlay (${result.blurDuring}px) should reduce video blur from ${blurBefore}px`
            )
        })
    })

    describe('Blur All on Disabled/Whitelisted Site', () => {
        // Disabled extension or whitelisted site means DISABLED mode: <html> carries
        // phobia-disabled and _showMediaWhileDisabled writes `filter: none !important` inline
        // on every media element to cancel the stylesheet blur. blurAll still registers the
        // media and VisualNode.blur() overwrites that inline filter, so the manual command
        // works on a disabled page. Hover preview does not: since the hit-test rewrite
        // (b55c9ba, 1.3.0) _updateHoverPreview returns early in DISABLED mode, so the two
        // cases below that expect a reduced blur on hover cannot pass, and the move-away
        // case passes only because nothing changes.

        // Fail-closed is not at stake here (blurAll only ever adds blur). The regression
        // guarded is the opposite one: a disabled page silently ignoring the user's
        // explicit blur command from the popup, hotkey or context menu.
        it('blurAll should visibly blur images even when extension is disabled', async () => {
            await setExtensionEnabled(browser, false)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            await sendMessageToAllContentScripts(browser, { type: 'blurAll' })
            await wait(500)

            const result = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (!img) return { found: false }
                const filter = window.getComputedStyle(img).filter
                return {
                    found: true,
                    filter,
                    blurPx: (() => {
                        const m = filter.match(/blur\(([\d.]+)px\)/)
                        return m ? parseFloat(m[1]) : 0
                    })(),
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    hasPhobiaDisabled: document.documentElement.classList.contains('phobia-disabled')
                }
            })

            assert.ok(result.found, '#spider-image should exist')
            assert.ok(result.hasPhobiaDisabled, 'html.phobia-disabled should be set when extension is disabled')
            assert.ok(result.hasDataPhobiaBlur, '#spider-image should have data-phobia-blur after blurAll')
            assert.ok(result.blurPx > 0,
                `blurAll on disabled site should visibly blur the image (got ${result.blurPx}px, filter: "${result.filter}")`)
        })

        it('hovering a blurred image on a disabled site should show preview blur', async () => {
            await setExtensionEnabled(browser, false)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            await sendMessageToAllContentScripts(browser, { type: 'blurAll' })
            await wait(500)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            await hoverElement(page, '#spider-image')
            await wait(300)

            const blurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(blurBefore > 0, `Image should be blurred before hover (got ${blurBefore}px)`)
            assert.ok(
                blurDuring < blurBefore,
                `Hover preview on disabled site (${blurDuring}px) should be less than full blur (${blurBefore}px)`
            )
        })

        it('hover preview should still work after unblurAll then blurAll on a disabled site', async () => {
            await setExtensionEnabled(browser, false)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            // blurAll → unblurAll → blurAll cycle
            await sendMessageToAllContentScripts(browser, { type: 'blurAll' })
            await wait(300)
            await sendMessageToAllContentScripts(browser, { type: 'unblurAll' })
            await wait(300)
            await sendMessageToAllContentScripts(browser, { type: 'blurAll' })
            await wait(500)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            await hoverElement(page, '#spider-image')
            await wait(300)

            const blurDuring = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(blurBefore > 0, `Image should be blurred after second blurAll (got ${blurBefore}px)`)
            assert.ok(
                blurDuring < blurBefore,
                `After unblurAll+blurAll on disabled site, hover preview (${blurDuring}px) should be less than full blur (${blurBefore}px)`
            )
        })

        it('moving mouse away on disabled site should restore full blur', async () => {
            await setExtensionEnabled(browser, false)
            await setBlurAmount(browser, 60)
            await setPreviewEnabled(browser, true)
            await setPreviewBlurStrength(browser, 5)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            await sendMessageToAllContentScripts(browser, { type: 'blurAll' })
            await wait(500)

            const blurBefore = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            await hoverElement(page, '#spider-image')
            await wait(300)

            await page.mouse.move(10, 10)
            await wait(400)

            const blurAfter = extractBlurPx(
                await page.evaluate(() => window.getComputedStyle(document.querySelector('#spider-image')).filter)
            )

            assert.ok(
                Math.abs(blurAfter - blurBefore) < 1,
                `Blur after moving away (${blurAfter}px) should restore to full blur (${blurBefore}px)`
            )
        })

        afterEach(async () => {
            // Re-enable the extension after each disabled-site test so other describes work normally
            await setExtensionEnabled(browser, true)
        })
    })

    // video-iframe.html mentions spiders, so the page-wide verdict blurs the video and the
    // "safe" about:blank iframe alike. The not-found branches assert nothing; they only keep
    // the case from failing if the element was never registered.
    describe('Video and Iframe Pointer Events', () => {
        it('blurred video elements should have pointer-events: auto', async () => {
            await setExtensionEnabled(browser, true)
            await setPreviewEnabled(browser, true)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'video-iframe.html')
            await page.waitForSelector('video', { timeout: 5000 })
            await wait(3000)

            const result = await page.evaluate(() => {
                const video = document.querySelector('video[data-phobia-blur]')
                if (!video) return { found: false }
                return {
                    found: true,
                    pointerEvents: window.getComputedStyle(video).pointerEvents
                }
            })

            if (result.found) {
                assert.strictEqual(result.pointerEvents, 'auto', 'Blurred video should have pointer-events: auto')
            } else {
                // If no blurred video on this page, test passes (no phobia content)
                assert.ok(true, 'No blurred video found - acceptable if page has no matching content')
            }
        })

        it('blurred iframe elements should have pointer-events: auto', async () => {
            await setExtensionEnabled(browser, true)
            await setPreviewEnabled(browser, true)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'video-iframe.html')
            await page.waitForSelector('iframe', { timeout: 5000 })
            await wait(3000)

            const result = await page.evaluate(() => {
                const iframe = document.querySelector('iframe[data-phobia-blur]')
                if (!iframe) return { found: false }
                return {
                    found: true,
                    pointerEvents: window.getComputedStyle(iframe).pointerEvents
                }
            })

            if (result.found) {
                assert.strictEqual(result.pointerEvents, 'auto', 'Blurred iframe should have pointer-events: auto')
            } else {
                assert.ok(true, 'No blurred iframe found - acceptable if page has no matching content')
            }
        })
    })
})
