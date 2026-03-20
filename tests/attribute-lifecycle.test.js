/**
 * Attribute Lifecycle Test Cases
 *
 * Tests verifying the data-phobia-blur attribute lifecycle and related
 * improvements made for correctness and performance:
 *
 * 1. data-phobia-blur attribute is set on detection, removed on unblur
 * 2. No premature .blur class before analysis (only CSS-layer blur)
 * 3. After detection: both .blur class AND data-phobia-blur attribute
 * 4. After no detection: .noblur class, no .blur, no data-phobia-blur
 * 5. Dynamically injected images (mutation/addedNodes path) are processed
 * 6. blurAll hotkey uses consistent blur amount (DEFAULT_BLUR_SLIDER_VALUE)
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    loadTestPage,
    setPhobiaWords,
    setExtensionEnabled,
    clearExtensionStorage,
    setBlurAmount,
    sendMessageToAllContentScripts
} = require('./test-utils')

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

describe('PhobiaBlocker - Attribute Lifecycle', () => {
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

    describe('data-phobia-blur attribute set on detection', () => {
        it('detected image should have data-phobia-blur attribute set after analysis', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const result = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (!img) return { found: false }
                return {
                    found: true,
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    dataPhobiaBlurValue: img.getAttribute('data-phobia-blur'),
                    hasBlurClass: img.classList.contains('phobia-blur')
                }
            })

            assert.ok(result.found, '#spider-image should exist')
            assert.ok(result.hasDataPhobiaBlur, 'detected image must have data-phobia-blur attribute')
            assert.strictEqual(result.dataPhobiaBlurValue, '1', 'data-phobia-blur value should be "1"')
            assert.ok(result.hasBlurClass, 'detected image must also have .blur class')
        })

        it('non-detected image should NOT have data-phobia-blur attribute', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#safe-image', { timeout: 5000 })
            await wait(3000)

            const result = await page.evaluate(() => {
                const img = document.querySelector('#safe-image')
                if (!img) return { found: false }
                return {
                    found: true,
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    hasBlurClass: img.classList.contains('phobia-blur'),
                    hasNoblurClass: img.classList.contains('phobia-noblur')
                }
            })

            assert.ok(result.found, '#safe-image should exist')
            assert.ok(!result.hasDataPhobiaBlur, 'non-detected image must NOT have data-phobia-blur attribute')
            assert.ok(!result.hasBlurClass, 'non-detected image must NOT have .blur class')
            assert.ok(result.hasNoblurClass, 'non-detected image should have .noblur class')
        })
    })

    describe('data-phobia-blur attribute removed on unblur', () => {
        it('data-phobia-blur should be removed after unblurAll', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            // Verify attribute is set before unblur
            const before = await page.evaluate(() =>
                document.querySelector('#spider-image').hasAttribute('data-phobia-blur')
            )
            assert.ok(before, 'data-phobia-blur should be set before unblurAll')

            await sendMessageToAllContentScripts(browser, { type: 'unblurAll' })
            await wait(500)

            const after = await page.evaluate(() =>
                document.querySelector('#spider-image').hasAttribute('data-phobia-blur')
            )
            assert.ok(!after, 'data-phobia-blur must be removed after unblurAll')
        })

        it('data-phobia-container should be removed from container when all images unblurred', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            await sendMessageToAllContentScripts(browser, { type: 'unblurAll' })
            await wait(500)

            // No element should have data-phobia-container after all images unblurred
            const containerCount = await page.evaluate(() =>
                document.querySelectorAll('[data-phobia-container]').length
            )
            assert.strictEqual(containerCount, 0,
                'data-phobia-container should be removed from all containers after unblurAll')
        })
    })

    describe('No premature .blur class before analysis (flash prevention)', () => {
        it('detected image should NOT have .blur class before analysis completes', async () => {
            await setPhobiaWords(browser, ['spider'])

            // Navigate and check blur state IMMEDIATELY after load, before JS analysis runs
            await page.goto(`file://${require('path').join(__dirname, 'test-pages', 'simple-image.html')}`,
                { waitUntil: 'domcontentloaded' })

            // Check synchronously right after DOMContentLoaded — JS analysis not done yet
            const stateAtLoad = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (!img) return { found: false }
                return {
                    found: true,
                    hasBlurClass: img.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    // CSS-layer blur (img:not(.noblur)) should be active
                    filter: window.getComputedStyle(img).filter
                }
            })

            assert.ok(stateAtLoad.found, '#spider-image should exist at load time')
            // The extension must NOT add .blur before analysis — only CSS-layer blur
            assert.ok(!stateAtLoad.hasBlurClass,
                'image must NOT have .blur class before JS analysis completes (CSS-only blur phase)')
            assert.ok(!stateAtLoad.hasDataPhobiaBlur,
                'image must NOT have data-phobia-blur before JS analysis completes')
            // But CSS blur should still be active (flash prevention)
            assert.ok(stateAtLoad.filter.includes('blur'),
                'image should still be visually blurred by CSS even without .blur class')
        })

        it('after analysis: detected image gets both .blur class and data-phobia-blur', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const state = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (!img) return { found: false }
                return {
                    found: true,
                    hasBlurClass: img.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    hasNoblurClass: img.classList.contains('phobia-noblur')
                }
            })

            assert.ok(state.found, '#spider-image should exist')
            assert.ok(state.hasBlurClass, 'detected image should have .blur class after analysis')
            assert.ok(state.hasDataPhobiaBlur, 'detected image should have data-phobia-blur after analysis')
            assert.ok(!state.hasNoblurClass, 'detected image should NOT have .noblur class')
        })

        it('after analysis: non-detected image gets .noblur and no .blur or data-phobia-blur', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#safe-image', { timeout: 5000 })
            await wait(3000)

            const state = await page.evaluate(() => {
                const img = document.querySelector('#safe-image')
                if (!img) return { found: false }
                return {
                    found: true,
                    hasBlurClass: img.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    hasNoblurClass: img.classList.contains('phobia-noblur')
                }
            })

            assert.ok(state.found, '#safe-image should exist')
            assert.ok(!state.hasBlurClass, 'non-detected image should NOT have .blur class after analysis')
            assert.ok(!state.hasDataPhobiaBlur, 'non-detected image should NOT have data-phobia-blur')
            assert.ok(state.hasNoblurClass, 'non-detected image should have .noblur class after analysis')
        })
    })

    describe('Dynamically injected images (mutation / addedNodes path)', () => {
        it('dynamically added image with phobia text nearby should be detected and get data-phobia-blur', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'dynamic-content.html')
            await page.waitForSelector('#add-spider-content', { timeout: 5000 })
            await wait(1000)  // Let initial analysis complete

            // Click the button to dynamically add spider content via DOM mutation
            await page.click('#add-spider-content')

            // Wait for the mutation observer to pick up the new node and run analysis
            await wait(4000)

            const result = await page.evaluate(() => {
                const img = document.querySelector('.dynamic-spider')
                if (!img) return { found: false }
                return {
                    found: true,
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    hasBlurClass: img.classList.contains('phobia-blur'),
                    filter: window.getComputedStyle(img).filter
                }
            })

            assert.ok(result.found, 'dynamically added .dynamic-spider image should exist')
            assert.ok(result.hasDataPhobiaBlur,
                'dynamically added image with spider text should have data-phobia-blur')
            assert.ok(result.hasBlurClass,
                'dynamically added image with spider text should have .blur class')
        })

        it('dynamically added safe image should get .noblur and no data-phobia-blur', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'dynamic-content.html')
            await page.waitForSelector('#add-safe-content', { timeout: 5000 })
            await wait(1000)

            await page.click('#add-safe-content')
            await wait(4000)

            const result = await page.evaluate(() => {
                const img = document.querySelector('.dynamic-safe')
                if (!img) return { found: false }
                return {
                    found: true,
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    hasBlurClass: img.classList.contains('phobia-blur'),
                    hasNoblurClass: img.classList.contains('phobia-noblur')
                }
            })

            assert.ok(result.found, 'dynamically added .dynamic-safe image should exist')
            assert.ok(!result.hasDataPhobiaBlur,
                'dynamically added safe image should NOT have data-phobia-blur')
            assert.ok(!result.hasBlurClass, 'dynamically added safe image should NOT have .blur class')
            assert.ok(result.hasNoblurClass, 'dynamically added safe image should have .noblur class')
        })
    })

    describe('blurAll hotkey uses consistent blur amount', () => {
        it('blurAll should apply the default blur amount even when blurValueAmount not stored', async () => {
            await clearExtensionStorage(browser)
            await setExtensionEnabled(browser, true)
            // Intentionally do NOT call setBlurAmount — storage has no blurValueAmount
            await setPhobiaWords(browser, ['butterfly'])  // word not on page → images start unblurred

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            // Verify images are unblurred (no phobia match)
            const blurBefore = await page.evaluate(() => {
                const f = window.getComputedStyle(document.querySelector('#spider-image')).filter
                const m = f && f.match(/blur\(([\d.]+)px\)/)
                return m ? parseFloat(m[1]) : 0
            })
            assert.strictEqual(blurBefore, 0, 'image should be unblurred before blurAll (no phobia match)')

            // Send blurAll (same as Ctrl+Alt+B hotkey)
            await sendMessageToAllContentScripts(browser, { type: 'blurAll' })
            await wait(500)

            const blurAfter = await page.evaluate(() => {
                const f = window.getComputedStyle(document.querySelector('#spider-image')).filter
                const m = f && f.match(/blur\(([\d.]+)px\)/)
                return m ? parseFloat(m[1]) : 0
            })

            // blurAll should produce a non-zero blur regardless of whether blurValueAmount is in storage
            assert.ok(blurAfter > 0,
                `blurAll should apply a non-zero blur amount even without stored blurValueAmount, got ${blurAfter}px`)
        })

        it('blurAll and analysis-based blur should produce the same blur amount for the same slider value', async () => {
            await clearExtensionStorage(browser)
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 50)  // DEFAULT_BLUR_SLIDER_VALUE

            // Page with detection: measure analysis-based blur
            await setPhobiaWords(browser, ['spider'])
            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            const analysisBluePx = await page.evaluate(() => {
                const f = window.getComputedStyle(document.querySelector('#spider-image')).filter
                const m = f && f.match(/blur\(([\d.]+)px\)/)
                return m ? parseFloat(m[1]) : 0
            })

            // Page without detection + blurAll: measure hotkey blur
            await setPhobiaWords(browser, ['butterfly'])
            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            await sendMessageToAllContentScripts(browser, { type: 'blurAll' })
            await wait(500)

            const hotkeyBlurPx = await page.evaluate(() => {
                const f = window.getComputedStyle(document.querySelector('#spider-image')).filter
                const m = f && f.match(/blur\(([\d.]+)px\)/)
                return m ? parseFloat(m[1]) : 0
            })

            assert.ok(analysisBluePx > 0, 'analysis blur should be non-zero')
            assert.ok(hotkeyBlurPx > 0, 'hotkey blur should be non-zero')
            assert.ok(
                Math.abs(analysisBluePx - hotkeyBlurPx) < 1,
                `blurAll (${hotkeyBlurPx}px) and analysis blur (${analysisBluePx}px) should match for the same slider value`
            )
        })
    })
})
