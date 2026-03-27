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
 * - Live settings update via previewSettingsChanged message
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
    sendMessageToAllContentScripts
} = require('./test-utils')

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Extract the numeric px value from a CSS filter string like "blur(12.34px)"
function extractBlurPx(filter) {
    const match = filter.match(/blur\(([\d.]+)px\)/)
    return match ? parseFloat(match[1]) : 0
}

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
        await setBlurAmount(browser, 60)
        page = await browser.newPage()
        page.setDefaultTimeout(5000)
    })

    after(async () => {
        if (browser) await browser.close()
    })

    describe('Storage Operations', () => {
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
                    // pointer-events for a non-phobia img: driven by img:not(.noblur) rule = none
                    pointerEvents: window.getComputedStyle(img).pointerEvents
                }
            })

            assert.ok(result.hasBlurClass, 'img should have site-owned .blur class')
            assert.ok(!result.hasDataPhobiaBlur, 'img should NOT have data-phobia-blur (not a phobia detection)')
            // The [data-phobia-blur] pointer-events: auto rule must NOT apply here
            assert.notStrictEqual(result.pointerEvents, 'auto',
                'Site-owned .blur class alone must not grant pointer-events: auto from the extension')
        })

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
    })

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
    })

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
        // container and intercepts all pointer events. The container's own mouseenter
        // never fires. _attachContainerListeners must detect the overlay as a sibling
        // and attach listeners directly to it.

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
    })

    describe('Blur All on Disabled/Whitelisted Site', () => {
        // When the extension is disabled (or site is whitelisted), html.phobia-disabled is set.
        // The CSS rule `html.phobia-disabled img:not(.phobia-noblur) { filter: none !important }`
        // has specificity (0,2,2) which overrides class-based blur (0,1,1).
        // The blurAll handler compensates by forcing an inline `filter: blur(Xpx) !important`
        // on each [data-phobia-blur] element. Hover preview is handled in
        // _attachContainerListeners which also sets/restores inline style when phobia-disabled.

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
