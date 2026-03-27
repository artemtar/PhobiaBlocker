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
            // Use a word NOT present anywhere in simple-image.html body.
            // onLoad() analyzes the full body text, so using 'spider' (which IS in the body)
            // would blur ALL images. 'butterfly' produces no match → all images get phobia-noblur.
            await setPhobiaWords(browser, ['butterfly'])

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
        it('CSS flash prevention: #phobiablocker-early-blur style is injected on page load', async () => {
            await setPhobiaWords(browser, ['spider'])

            // Install a MutationObserver BEFORE navigation so we can record whether
            // the early-blur style was ever added — even if it's removed synchronously
            // during analysis before Puppeteer gets to evaluate the DOM.
            await page.evaluateOnNewDocument(() => {
                window._earlyBlurSeen = false
                window._earlyBlurContent = ''
                const observer = new MutationObserver((mutations) => {
                    for (const m of mutations) {
                        for (const node of m.addedNodes) {
                            if (node.nodeType === 1 && node.id === 'phobiablocker-early-blur') {
                                window._earlyBlurSeen = true
                                window._earlyBlurContent = node.textContent || ''
                                observer.disconnect()
                            }
                        }
                    }
                })
                // Observe `document` (not `document.documentElement`) because
                // documentElement may be null when evaluateOnNewDocument first runs.
                // `document` is always a valid Node; subtree:true covers all descendants.
                observer.observe(document, { childList: true, subtree: true })
            })

            await page.goto(`file://${require('path').join(__dirname, 'test-pages', 'simple-image.html')}`,
                { waitUntil: 'domcontentloaded' })

            const state = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (!img) return { found: false }
                return {
                    found: true,
                    earlyStyleSeen: !!window._earlyBlurSeen,
                    earlyStyleContent: window._earlyBlurContent
                }
            })

            assert.ok(state.found, '#spider-image should exist at load time')
            assert.ok(state.earlyStyleSeen,
                '#phobiablocker-early-blur style must be injected at some point during page load to prevent unblurred flash')
            assert.ok(state.earlyStyleContent.includes('phobia-noblur'),
                'Early blur CSS should target images not yet classified as phobia-noblur')
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
            await setPhobiaWords(browser, ['butterfly'])

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

    describe('src attribute mutation re-blur', () => {
        // When a site sets a new src on an already-analyzed element (e.g. YouTube preview
        // hover or lazy-load), the extension must re-blur immediately and re-analyze.
        // The observer watches attributeFilter: ['src'] to catch this.

        it('changing src on a phobia-noblur image re-blurs it when body text matches', async () => {
            // Use a phobia word NOT in the body so safe-image starts with phobia-noblur.
            // Then inject that word into the body and change src simultaneously —
            // the src mutation triggers re-analysis using document.body.textContent,
            // which now contains the phobia word → safe-image gets phobia-blur.
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#safe-image', { timeout: 5000 })
            await wait(3000)

            // Confirm safe image has phobia-noblur before changes
            const stateBefore = await page.evaluate(() => {
                const img = document.querySelector('#safe-image')
                return {
                    hasNoblur: img.classList.contains('phobia-noblur'),
                    hasBlur: img.classList.contains('phobia-blur')
                }
            })
            assert.ok(stateBefore.hasNoblur, '#safe-image should have phobia-noblur before src change')
            assert.ok(!stateBefore.hasBlur, '#safe-image should NOT have phobia-blur before src change')

            // Inject the phobia word into body text AND change src.
            // The src mutation fires the observer which re-analyzes using document.body.textContent
            // (now containing 'butterfly') → safe-image should be blurred.
            await page.evaluate(() => {
                const span = document.createElement('span')
                span.id = 'injected-phobia-text'
                span.textContent = 'butterfly'
                document.body.appendChild(span)

                const img = document.querySelector('#safe-image')
                img.src = 'https://via.placeholder.com/300x200/0000ff/ffffff?text=New+Image'
            })

            // Wait for MutationObserver to fire and re-analysis to complete
            await wait(3500)

            const stateAfter = await page.evaluate(() => {
                const img = document.querySelector('#safe-image')
                return {
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    hasNoblur: img.classList.contains('phobia-noblur')
                }
            })

            assert.ok(
                stateAfter.hasBlur,
                'Image should be blurred after src change (body text now contains phobia word)'
            )
            assert.ok(
                stateAfter.hasDataPhobiaBlur,
                'Image should have data-phobia-blur after src mutation re-analysis'
            )
        })

        it('changing src on an already-blurred image keeps it blurred', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.waitForSelector('#spider-image', { timeout: 5000 })
            await wait(3000)

            // Confirm spider image is blurred before src change
            const before = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return img.hasAttribute('data-phobia-blur')
            })
            assert.ok(before, '#spider-image should have data-phobia-blur before src change')

            // Change the src
            await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                img.src = 'https://via.placeholder.com/300x200/880000/ffffff?text=Spider2'
            })

            await wait(3500)

            const after = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return {
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur')
                }
            })

            assert.ok(after.hasBlur, 'Blurred image should stay blurred after src change')
            assert.ok(after.hasDataPhobiaBlur, 'data-phobia-blur should remain after src change')
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
