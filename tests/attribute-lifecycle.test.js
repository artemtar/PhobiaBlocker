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
    sendMessageViaServiceWorker,
    queryTriggeredWords,
    waitForPhobiaBlur,
    waitForPhobiaNoblur,
    getExtensionServiceWorker,
    setBlurAlwaysOn,
    getSyncStorage,
    wait
} = require('./test-utils')

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
            await waitForPhobiaBlur(page, '#spider-image')

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
            // Use a word not present in the image's local scope so the sibling scope stays clean.
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'simple-image.html')
            await waitForPhobiaNoblur(page, '#safe-image')

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

    describe('Scope-aware matching', () => {
        it('matching text in one scope should not blur a clean sibling scope', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await waitForPhobiaBlur(page, '#spider-image')
            await waitForPhobiaNoblur(page, '#safe-image')

            const state = await page.evaluate(() => {
                const spider = document.querySelector('#spider-image')
                const safe = document.querySelector('#safe-image')
                return {
                    spiderHasBlur: spider.classList.contains('phobia-blur'),
                    spiderHasDataPhobiaBlur: spider.hasAttribute('data-phobia-blur'),
                    safeHasBlur: safe.classList.contains('phobia-blur'),
                    safeHasDataPhobiaBlur: safe.hasAttribute('data-phobia-blur'),
                    safeHasNoblur: safe.classList.contains('phobia-noblur')
                }
            })

            assert.ok(state.spiderHasBlur, 'matching scope image should be blurred')
            assert.ok(state.spiderHasDataPhobiaBlur, 'matching scope image should set data-phobia-blur')
            assert.ok(!state.safeHasBlur, 'clean sibling scope image should stay unblurred')
            assert.ok(!state.safeHasDataPhobiaBlur, 'clean sibling scope image should not set data-phobia-blur')
            assert.ok(state.safeHasNoblur, 'clean sibling scope image should end in phobia-noblur')
        })

        it('dynamic text injection should only reclassify the affected scope', async () => {
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'simple-image.html')
            await waitForPhobiaNoblur(page, '#safe-image')
            await waitForPhobiaNoblur(page, '#spider-image')

            await page.evaluate(() => {
                const text = document.createElement('p')
                text.id = 'injected-local-phobia-text'
                text.textContent = 'A bright butterfly just landed in this scope.'
                document.querySelector('#safe-scope').appendChild(text)
            })

            await waitForPhobiaBlur(page, '#safe-image')

            const state = await page.evaluate(() => {
                const spider = document.querySelector('#spider-image')
                const safe = document.querySelector('#safe-image')
                return {
                    safeHasBlur: safe.classList.contains('phobia-blur'),
                    safeHasDataPhobiaBlur: safe.hasAttribute('data-phobia-blur'),
                    spiderHasBlur: spider.classList.contains('phobia-blur'),
                    spiderHasNoblur: spider.classList.contains('phobia-noblur')
                }
            })

            assert.ok(state.safeHasBlur, 'injected scope image should be blurred after local text mutation')
            assert.ok(state.safeHasDataPhobiaBlur, 'injected scope image should set data-phobia-blur')
            assert.ok(!state.spiderHasBlur, 'unaffected sibling scope image should remain unblurred')
            assert.ok(state.spiderHasNoblur, 'unaffected sibling scope image should remain phobia-noblur')
        })
    })

    describe('data-phobia-blur attribute removed on unblur', () => {
        it('data-phobia-blur should be removed after unblurAll', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await waitForPhobiaBlur(page, '#spider-image')

            // Verify attribute is set before unblur
            const before = await page.evaluate(() =>
                document.querySelector('#spider-image').hasAttribute('data-phobia-blur')
            )
            assert.ok(before, 'data-phobia-blur should be set before unblurAll')

            await sendMessageViaServiceWorker(browser, { type: 'unblurAll' })
            await wait(300)

            const after = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return {
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    hasBlurClass: img.classList.contains('phobia-blur'),
                    hasNoblur: img.classList.contains('phobia-noblur'),
                    hasPermanentUnblur: img.classList.contains('phobia-permanent-unblur')
                }
            })
            assert.ok(!after.hasDataPhobiaBlur, 'data-phobia-blur must be removed after unblurAll')
            assert.ok(!after.hasBlurClass, 'phobia-blur class must be removed after unblurAll')
            assert.ok(after.hasNoblur, 'phobia-noblur class must be added after unblurAll')
            assert.ok(after.hasPermanentUnblur, 'phobia-permanent-unblur class must be added after unblurAll')
        })

        it('data-phobia-container should be removed from container when all images unblurred', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await waitForPhobiaBlur(page, '#spider-image')

            await sendMessageViaServiceWorker(browser, { type: 'unblurAll' })
            await wait(300)

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
            await waitForPhobiaBlur(page, '#spider-image')

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
            await waitForPhobiaNoblur(page, '#safe-image')

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

            // Wait for mutation observer + batch debounce + NLP analysis + blur to apply
            await waitForPhobiaBlur(page, '.dynamic-spider')

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
            await waitForPhobiaNoblur(page, '.dynamic-safe')

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

        it('changing src on a phobia-noblur image re-blurs it when text is injected into the same scope', async () => {
            // Use a phobia word not present in the safe scope so it starts phobia-noblur.
            // Then inject that word into the safe scope and change src together.
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'simple-image.html')
            await waitForPhobiaNoblur(page, '#safe-image')

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

            // Inject the phobia word into the same scope AND change src.
            await page.evaluate(() => {
                const span = document.createElement('span')
                span.id = 'injected-phobia-text'
                span.textContent = 'butterfly'
                document.querySelector('#safe-scope').appendChild(span)

                const img = document.querySelector('#safe-image')
                img.src = 'https://via.placeholder.com/300x200/0000ff/ffffff?text=New+Image'
            })

            // Wait for MutationObserver to fire and re-analysis to complete
            await waitForPhobiaBlur(page, '#safe-image')

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
                'Image should be blurred after src change when its local scope now contains the phobia word'
            )
            assert.ok(
                stateAfter.hasDataPhobiaBlur,
                'Image should have data-phobia-blur after src mutation re-analysis'
            )
        })

        it('changing src on a phobia-noblur image keeps it unblurred when scope text is unchanged', async () => {
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'simple-image.html')
            await waitForPhobiaNoblur(page, '#safe-image')

            await page.evaluate(() => {
                const img = document.querySelector('#safe-image')
                img.src = 'https://via.placeholder.com/300x200/11aa11/ffffff?text=Safe+Reloaded'
            })

            await wait(2000)

            const after = await page.evaluate(() => {
                const img = document.querySelector('#safe-image')
                return {
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: img.hasAttribute('data-phobia-blur'),
                    hasNoblur: img.classList.contains('phobia-noblur')
                }
            })

            assert.ok(!after.hasBlur, 'Clean scope image should stay unblurred after src change')
            assert.ok(!after.hasDataPhobiaBlur, 'Clean scope image should not gain data-phobia-blur after src change')
            assert.ok(after.hasNoblur, 'Clean scope image should remain phobia-noblur after src change')
        })

        it('changing src on an already-blurred image keeps it blurred when scope text is unchanged', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await waitForPhobiaBlur(page, '#spider-image')

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

            // Allow the src-triggered re-analysis to settle.
            await wait(2000)

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

    describe('safe-to-matched re-blur for non-img media', () => {
        it('background-image span should be discovered and re-blur when local scope text starts matching', async () => {
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'simple-image.html')
            await waitForPhobiaNoblur(page, '#safe-image')

            await page.evaluate(() => {
                const span = document.createElement('span')
                span.id = 'safe-span-bg'
                span.style.display = 'inline-block'
                span.style.width = '220px'
                span.style.height = '140px'
                span.style.backgroundImage = "url('https://via.placeholder.com/220x140/3366aa/ffffff?text=Safe+Span')"
                span.style.backgroundSize = 'cover'
                document.querySelector('#safe-scope').appendChild(span)
            })

            await waitForPhobiaNoblur(page, '#safe-span-bg')

            await page.evaluate(() => {
                const text = document.createElement('p')
                text.id = 'safe-span-bg-phobia-text'
                text.textContent = 'A butterfly appeared inside this exact scope.'
                document.querySelector('#safe-scope').appendChild(text)
            })

            await waitForPhobiaBlur(page, '#safe-span-bg')

            const state = await page.evaluate(() => {
                const el = document.querySelector('#safe-span-bg')
                return {
                    hasBlur: el.classList.contains('phobia-blur'),
                    hasNoblur: el.classList.contains('phobia-noblur')
                }
            })

            assert.ok(state.hasBlur, 'descendant span background image should re-blur after matching text appears')
            assert.ok(!state.hasNoblur, 'descendant span background image should no longer be phobia-noblur after matching text appears')
        })

        it('video should re-blur when local scope text starts matching', async () => {
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'video-iframe.html')
            await waitForPhobiaNoblur(page, '#cat-image')

            await page.evaluate(() => {
                const video = document.createElement('video')
                video.id = 'dynamic-safe-video'
                video.width = 320
                video.height = 180
                video.setAttribute('poster', 'https://via.placeholder.com/320x180/228822/ffffff?text=Safe+Video')
                document.querySelector('#pets-scope').appendChild(video)
            })

            await waitForPhobiaNoblur(page, '#dynamic-safe-video')

            await page.evaluate(() => {
                const text = document.createElement('p')
                text.id = 'dynamic-safe-video-phobia-text'
                text.textContent = 'The pets area now mentions a butterfly nearby.'
                document.querySelector('#pets-scope').appendChild(text)
            })

            await waitForPhobiaBlur(page, '#dynamic-safe-video')

            const state = await page.evaluate(() => {
                const video = document.querySelector('#dynamic-safe-video')
                return {
                    hasBlur: video.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: video.hasAttribute('data-phobia-blur'),
                    hasNoblur: video.classList.contains('phobia-noblur')
                }
            })

            assert.ok(state.hasBlur, 'video should re-blur after matching text appears in its scope')
            assert.ok(state.hasDataPhobiaBlur, 'video should restore data-phobia-blur after matching text appears in its scope')
            assert.ok(!state.hasNoblur, 'video should no longer be phobia-noblur after matching text appears in its scope')
        })

        it('same-origin iframe should re-blur when local scope text starts matching', async () => {
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'cross-origin-iframe.html')
            await waitForPhobiaNoblur(page, '#same-origin-iframe')

            await page.evaluate(() => {
                const text = document.createElement('p')
                text.id = 'same-origin-iframe-phobia-text'
                text.textContent = 'A butterfly warning was added to this iframe scope.'
                document.querySelector('#same-origin-scope').appendChild(text)
            })

            await waitForPhobiaBlur(page, '#same-origin-iframe')

            const state = await page.evaluate(() => {
                const iframe = document.querySelector('#same-origin-iframe')
                return {
                    hasBlur: iframe.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: iframe.hasAttribute('data-phobia-blur'),
                    hasNoblur: iframe.classList.contains('phobia-noblur')
                }
            })

            assert.ok(state.hasBlur, 'same-origin iframe should re-blur after matching text appears in its scope')
            assert.ok(state.hasDataPhobiaBlur, 'same-origin iframe should restore data-phobia-blur after matching text appears in its scope')
            assert.ok(!state.hasNoblur, 'same-origin iframe should no longer be phobia-noblur after matching text appears in its scope')
        })
    })

    describe('unblurAll covers BgImageNode (background-image div) elements', () => {
        it('BgImageNode div should have phobia-blur class after detection', async () => {
            await setPhobiaWords(browser, ['snake'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#bg-image-snake')

            const result = await page.evaluate(() => {
                const el = document.querySelector('#bg-image-snake')
                if (!el) return { found: false }
                return {
                    found: true,
                    hasBlurClass: el.classList.contains('phobia-blur'),
                    filterPx: (() => {
                        const f = window.getComputedStyle(el).filter
                        const m = f && f.match(/blur\(([\d.]+)px\)/)
                        return m ? parseFloat(m[1]) : 0
                    })()
                }
            })

            assert.ok(result.found, '#bg-image-snake should exist')
            assert.ok(result.hasBlurClass, 'BgImageNode div should have phobia-blur class after detection')
            assert.ok(result.filterPx > 0, `BgImageNode should be visually blurred (got ${result.filterPx}px)`)
        })

        it('unblurAll should remove phobia-blur from BgImageNode div and add phobia-permanent-unblur', async () => {
            await setPhobiaWords(browser, ['snake'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#bg-image-snake')

            const before = await page.evaluate(() =>
                document.querySelector('#bg-image-snake').classList.contains('phobia-blur')
            )
            assert.ok(before, '#bg-image-snake should have phobia-blur before unblurAll')

            await sendMessageViaServiceWorker(browser, { type: 'unblurAll' })
            await wait(300)

            const after = await page.evaluate(() => {
                const el = document.querySelector('#bg-image-snake')
                return {
                    hasBlurClass: el.classList.contains('phobia-blur'),
                    hasNoblur: el.classList.contains('phobia-noblur'),
                    hasPermanentUnblur: el.classList.contains('phobia-permanent-unblur'),
                    filterPx: (() => {
                        const f = window.getComputedStyle(el).filter
                        const m = f && f.match(/blur\(([\d.]+)px\)/)
                        return m ? parseFloat(m[1]) : 0
                    })()
                }
            })

            assert.ok(!after.hasBlurClass, 'phobia-blur must be removed from BgImageNode after unblurAll')
            assert.ok(after.hasNoblur, 'phobia-noblur must be added to BgImageNode after unblurAll')
            assert.ok(after.hasPermanentUnblur,
                'phobia-permanent-unblur must be added to BgImageNode after unblurAll')
            assert.strictEqual(after.filterPx, 0,
                `BgImageNode should be visually unblurred after unblurAll (got ${after.filterPx}px)`)
        })

        it('new video added after unblurAll should still blur when page text matches', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#spider-image')

            await sendMessageViaServiceWorker(browser, { type: 'unblurAll' })
            await wait(300)

            await page.evaluate(() => {
                const video = document.createElement('video')
                video.id = 'dynamic-preview-video'
                video.width = 320
                video.height = 180
                document.body.appendChild(video)
            })

            await waitForPhobiaBlur(page, '#dynamic-preview-video')

            const state = await page.evaluate(() => {
                const video = document.querySelector('#dynamic-preview-video')
                return {
                    hasBlur: video.classList.contains('phobia-blur'),
                    hasDataPhobiaBlur: video.hasAttribute('data-phobia-blur'),
                    hasNoblur: video.classList.contains('phobia-noblur'),
                    hasPermanentUnblur: video.classList.contains('phobia-permanent-unblur')
                }
            })

            assert.ok(state.hasBlur, 'new video should blur after matching page analysis')
            assert.ok(state.hasDataPhobiaBlur, 'new video should get data-phobia-blur after matching page analysis')
            assert.ok(!state.hasNoblur, 'new video should not stay phobia-noblur after matching page analysis')
            assert.ok(!state.hasPermanentUnblur, 'new video should not inherit page-wide permanent unblur')
        })
    })

    describe('right-click unblur (context menu)', () => {
        it('unblur message on a phobia-blur img removes class, attribute, inline filter and adds permanent-unblur', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#spider-image')

            // Confirm it's blurred first
            const before = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return {
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasDataAttr: img.hasAttribute('data-phobia-blur')
                }
            })
            assert.ok(before.hasBlur, '#spider-image should have phobia-blur before right-click unblur')
            assert.ok(before.hasDataAttr, '#spider-image should have data-phobia-blur before right-click unblur')

            // Simulate contextmenu on the blurred image (pointer-events: auto on .phobia-blur)
            await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (img) img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
            })

            await sendMessageViaServiceWorker(browser, { type: 'unblur' })
            await wait(300)

            const after = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return {
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasNoblur: img.classList.contains('phobia-noblur'),
                    hasPermanentUnblur: img.classList.contains('phobia-permanent-unblur'),
                    hasDataAttr: img.hasAttribute('data-phobia-blur'),
                    filterPx: (() => {
                        const f = window.getComputedStyle(img).filter
                        const m = f && f.match(/blur\(([\d.]+)px\)/)
                        return m ? parseFloat(m[1]) : 0
                    })()
                }
            })

            assert.ok(!after.hasBlur, 'phobia-blur must be removed after right-click unblur')
            assert.ok(after.hasNoblur, 'phobia-noblur must be added after right-click unblur')
            assert.ok(after.hasPermanentUnblur, 'phobia-permanent-unblur must be added after right-click unblur')
            assert.ok(!after.hasDataAttr, 'data-phobia-blur must be removed after right-click unblur')
            assert.strictEqual(after.filterPx, 0,
                `image should be visually unblurred after right-click unblur (got ${after.filterPx}px)`)
        })

        it('unblur message on an img with no phobia-blur class falls back to last-resort and unblurs', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#spider-image')

            // Remove phobia-blur (and noblur/permanent) to simulate a CSS-only-blurred image
            // (pre-analysis state, or an element not yet processed by the extension).
            // Also remove data-phobia-blur so pointer-events:none applies (no data attr rule).
            // The image is still visually blurred by: img:not(.phobia-noblur):not(.phobia-permanent-unblur)
            // Contextmenu fires on the image — the last-resort code in the unblur handler
            // walks ancestors looking for any img:not(.phobia-noblur):not(.phobia-permanent-unblur).
            await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                if (img) {
                    img.classList.remove('phobia-blur', 'phobia-noblur', 'phobia-permanent-unblur')
                    img.removeAttribute('data-phobia-blur')
                    img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
                }
            })

            await sendMessageViaServiceWorker(browser, { type: 'unblur' })
            await wait(500)

            const after = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                return {
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasNoblur: img.classList.contains('phobia-noblur'),
                    hasPermanentUnblur: img.classList.contains('phobia-permanent-unblur'),
                    filterPx: (() => {
                        const f = window.getComputedStyle(img).filter
                        const m = f && f.match(/blur\(([\d.]+)px\)/)
                        return m ? parseFloat(m[1]) : 0
                    })()
                }
            })

            assert.ok(!after.hasBlur, 'phobia-blur must not be present after last-resort right-click unblur')
            assert.ok(after.hasNoblur, 'phobia-noblur must be added after last-resort right-click unblur')
            assert.ok(after.hasPermanentUnblur,
                'phobia-permanent-unblur must be added after last-resort right-click unblur')
            assert.strictEqual(after.filterPx, 0,
                `image should be visually unblurred after last-resort unblur (got ${after.filterPx}px)`)
        })

        it('overlay right-click unblur should unblur the background poster underneath', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'reel-background-overlay.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#reel-poster')

            await page.evaluate(() => {
                const card = document.querySelector('.feed-card')
                const shell = document.createElement('div')
                shell.id = 'nested-bg-overlay-shell'
                shell.style.position = 'absolute'
                shell.style.left = '0'
                shell.style.top = '0'
                shell.style.width = '360px'
                shell.style.height = '450px'
                shell.style.zIndex = '5'
                shell.style.pointerEvents = 'none'

                const control = document.createElement('button')
                control.id = 'nested-bg-overlay-control'
                control.type = 'button'
                control.style.position = 'absolute'
                control.style.inset = '0'
                control.style.pointerEvents = 'auto'
                control.style.border = '0'
                control.style.padding = '0'
                control.style.background = 'transparent'
                shell.appendChild(control)
                card.appendChild(shell)
            })

            await page.evaluate(() => {
                const control = document.querySelector('#nested-bg-overlay-control')
                const rect = control.getBoundingClientRect()
                control.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2
                }))
            })

            await sendMessageViaServiceWorker(browser, { type: 'unblur' })
            await wait(300)

            const after = await page.evaluate(() => {
                const poster = document.querySelector('#reel-poster')
                const filter = window.getComputedStyle(poster).filter
                const match = filter && filter.match(/blur\(([\d.]+)px\)/)
                return {
                    posterHasBlur: poster.classList.contains('phobia-blur'),
                    posterHasNoblur: poster.classList.contains('phobia-noblur'),
                    posterHasPermanentUnblur: poster.classList.contains('phobia-permanent-unblur'),
                    posterFilterPx: match ? parseFloat(match[1]) : 0
                }
            })

            assert.ok(!after.posterHasBlur, 'background poster should not have phobia-blur after overlay unblur')
            assert.ok(after.posterHasNoblur, 'background poster should have phobia-noblur after overlay unblur')
            assert.ok(after.posterHasPermanentUnblur,
                'background poster should have phobia-permanent-unblur after overlay unblur')
            assert.strictEqual(after.posterFilterPx, 0,
                `background poster should be visually unblurred after overlay unblur (got ${after.posterFilterPx}px)`)
        })

        it('overlay right-click unblur should still work if the overlay node is replaced before the message', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'reel-background-overlay.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#reel-poster')

            await page.evaluate(() => {
                const card = document.querySelector('.feed-card')
                const shell = document.createElement('div')
                shell.id = 'transient-bg-overlay-shell'
                shell.style.position = 'absolute'
                shell.style.left = '0'
                shell.style.top = '0'
                shell.style.width = '360px'
                shell.style.height = '450px'
                shell.style.zIndex = '5'
                shell.style.pointerEvents = 'none'

                const control = document.createElement('button')
                control.id = 'transient-bg-overlay-control'
                control.type = 'button'
                control.style.position = 'absolute'
                control.style.inset = '0'
                control.style.pointerEvents = 'auto'
                control.style.border = '0'
                control.style.padding = '0'
                control.style.background = 'transparent'
                shell.appendChild(control)
                card.appendChild(shell)
            })

            await page.evaluate(() => {
                const control = document.querySelector('#transient-bg-overlay-control')
                const rect = control.getBoundingClientRect()
                control.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2
                }))
                document.querySelector('#transient-bg-overlay-shell').remove()
            })

            await sendMessageViaServiceWorker(browser, { type: 'unblur' })
            await wait(300)

            const after = await page.evaluate(() => {
                const poster = document.querySelector('#reel-poster')
                const filter = window.getComputedStyle(poster).filter
                const match = filter && filter.match(/blur\(([\d.]+)px\)/)
                return {
                    posterHasBlur: poster.classList.contains('phobia-blur'),
                    posterHasNoblur: poster.classList.contains('phobia-noblur'),
                    posterHasPermanentUnblur: poster.classList.contains('phobia-permanent-unblur'),
                    posterFilterPx: match ? parseFloat(match[1]) : 0
                }
            })

            assert.ok(!after.posterHasBlur, 'background poster should not have phobia-blur after stale-overlay unblur')
            assert.ok(after.posterHasNoblur, 'background poster should have phobia-noblur after stale-overlay unblur')
            assert.ok(after.posterHasPermanentUnblur,
                'background poster should have phobia-permanent-unblur after stale-overlay unblur')
            assert.strictEqual(after.posterFilterPx, 0,
                `background poster should be visually unblurred after stale-overlay unblur (got ${after.posterFilterPx}px)`)
        })

        it('overlay right-click unblur should unblur a video underneath', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'instagram-video-overlay.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#instagram-video')

            await page.evaluate(() => {
                const control = document.querySelector('#instagram-overlay-control')
                const rect = control.getBoundingClientRect()
                control.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2
                }))
            })

            await sendMessageViaServiceWorker(browser, { type: 'unblur' })
            await wait(300)

            const after = await page.evaluate(() => {
                const video = document.querySelector('#instagram-video')
                const filter = window.getComputedStyle(video).filter
                const match = filter && filter.match(/blur\(([\d.]+)px\)/)
                return {
                    videoHasBlur: video.classList.contains('phobia-blur'),
                    videoHasNoblur: video.classList.contains('phobia-noblur'),
                    videoHasPermanentUnblur: video.classList.contains('phobia-permanent-unblur'),
                    videoHasDataAttr: video.hasAttribute('data-phobia-blur'),
                    videoFilterPx: match ? parseFloat(match[1]) : 0
                }
            })

            assert.ok(!after.videoHasBlur, 'video should not have phobia-blur after overlay unblur')
            assert.ok(after.videoHasNoblur, 'video should have phobia-noblur after overlay unblur')
            assert.ok(after.videoHasPermanentUnblur,
                'video should have phobia-permanent-unblur after overlay unblur')
            assert.ok(!after.videoHasDataAttr, 'video should not keep data-phobia-blur after overlay unblur')
            assert.strictEqual(after.videoFilterPx, 0,
                `video should be visually unblurred after overlay unblur (got ${after.videoFilterPx}px)`)
        })
    })

    describe('getTriggeredWords message', () => {
        it('returns detected words with counts when images are blurred', async () => {
            await setBlurAmount(browser, 60)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#spider-image')

            const words = await queryTriggeredWords(browser, page)

            assert.ok(words.length > 0, 'getTriggeredWords should return at least one word when images are blurred')
            const spiderEntry = words.find(w => w.word === 'spider')
            assert.ok(spiderEntry, 'getTriggeredWords should return "spider" as a trigger word')
            assert.ok(spiderEntry.count >= 1, `spider count should be >= 1, got ${spiderEntry.count}`)
        })

        it('returns empty when blur amount is set to 0', async () => {
            await setPhobiaWords(browser, ['spider'])
            await setBlurAmount(browser, 0)

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            // With blur amount 0px, phobia-blur class is still applied (just visually transparent).
            // Wait for that class so we know analysis is done before overriding the CSS variable.
            await waitForPhobiaBlur(page, '#spider-image')

            // Set --blurValueAmount to 0px directly on the page to simulate slider at 0
            await page.evaluate(() => {
                document.documentElement.style.setProperty('--blurValueAmount', '0px')
            })

            const words = await queryTriggeredWords(browser, page)
            assert.deepStrictEqual(words, [],
                'getTriggeredWords should return empty array when blur amount is 0px')

            // Restore blur amount for subsequent tests
            await setBlurAmount(browser, 60)
        })

        it('returns empty after unblurAll (elements no longer have phobia-blur)', async () => {
            await setBlurAmount(browser, 60)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#spider-image')

            // Verify words are returned before unblur
            const before = await queryTriggeredWords(browser, page)
            assert.ok(before.length > 0, 'should have triggered words before unblurAll')

            await sendMessageViaServiceWorker(browser, { type: 'unblurAll' })
            await wait(300)

            const after = await queryTriggeredWords(browser, page)
            assert.deepStrictEqual(after, [],
                'getTriggeredWords should return empty array after unblurAll (no phobia-blur elements remain)')
        })

        it('returns empty when extension is disabled on the page', async () => {
            await setBlurAmount(browser, 60)
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#spider-image')

            // Simulate extension disabled by adding the phobia-disabled class
            await page.evaluate(() => {
                document.documentElement.classList.add('phobia-disabled')
            })

            const words = await queryTriggeredWords(browser, page)
            assert.deepStrictEqual(words, [],
                'getTriggeredWords should return empty when phobia-disabled class is present')

            // Cleanup
            await page.evaluate(() => {
                document.documentElement.classList.remove('phobia-disabled')
            })
        })
    })

    describe('target word cover', () => {
        const waitForWordCovers = async (expectedMin = 1) => {
            await page.waitForFunction(
                (min) => document.querySelectorAll('.phobia-word-cover').length >= min,
                { timeout: 8000, polling: 100 },
                expectedMin
            )
        }

        const queryAnalysisDebugState = async () => {
            const swTarget = await getExtensionServiceWorker(browser)
            const swWorker = await swTarget.worker()

            const state = await swWorker.evaluate((targetUrl) => {
                return new Promise((resolve, reject) => {
                    chrome.tabs.query({}, (tabs) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message))
                            return
                        }
                        const tab = tabs.find(tab => tab.url === targetUrl)
                        if (!tab) {
                            reject(new Error(`No tab found for analysis debug query: ${targetUrl}`))
                            return
                        }
                        chrome.tabs.sendMessage(tab.id, {
                            target: 'content',
                            type: 'getAnalysisDebugState'
                        }, { frameId: 0 }, (response) => {
                            if (chrome.runtime.lastError) {
                                reject(new Error(chrome.runtime.lastError.message))
                                return
                            }
                            resolve(response)
                        })
                    })
                })
            }, page.url())

            assert.ok(state && typeof state === 'object', 'content script should return analysis debug state')
            for (const field of ['pageAnalysisRequests', 'mutationBatches', 'directWordCovers',
                'mediaCount', 'pageWordCount', 'policyGeneration']) {
                assert.ok(Number.isSafeInteger(state[field]) && state[field] >= 0,
                    `analysis debug state ${field} should be a nonnegative integer`)
            }
            assert.ok(['ANALYZE', 'ALWAYS_BLUR', 'DISABLED'].includes(state.protectionMode),
                'analysis debug state should include a valid protection mode')
            return state
        }

        const waitForPageAnalysis = async (minimumRequests = 1) => {
            const deadline = Date.now() + 8000
            while (Date.now() < deadline) {
                const state = await queryAnalysisDebugState()
                if (state.pageAnalysisRequests >= minimumRequests) {
                    // Also observe beyond the 200 ms mutation debounce so a
                    // duplicate request is included in the count assertion.
                    await wait(500)
                    return queryAnalysisDebugState()
                }
                await wait(50)
            }
            assert.fail(`page analysis did not reach ${minimumRequests} requests`)
        }

        it('covers exact and smart-variant target words on text-only pages', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await page.waitForFunction(() => {
                const coveredWords = [...document.querySelectorAll('.phobia-word-cover')]
                    .map(el => el.textContent.toLowerCase())
                return coveredWords.includes('spider') && coveredWords.includes('spiders')
            }, { timeout: 8000, polling: 100 })

            const state = await page.evaluate(() => {
                const coveredWords = [...document.querySelectorAll('.phobia-word-cover')]
                    .map(el => el.textContent.toLowerCase())
                return {
                    coveredWords,
                    mediaCount: document.querySelectorAll('img, video, iframe').length,
                    inputWrapperCount: document.querySelectorAll('input .phobia-word-cover, textarea .phobia-word-cover, [contenteditable] .phobia-word-cover').length
                }
            })

            assert.strictEqual(state.mediaCount, 0, 'test page should not need media for word covers')
            assert.ok(state.coveredWords.includes('spider'), 'exact target word should be covered')
            assert.ok(state.coveredWords.includes('spiders'), 'smart plural variant should be covered')
            assert.strictEqual(state.inputWrapperCount, 0, 'form/editor text should not be wrapped')
        })

        it('covers a single-word IMDb-style card title', async () => {
            await setPhobiaWords(browser, ['short'])

            await loadTestPage(page, 'imdb-short-card.html')
            await page.waitForFunction(() =>
                Boolean(document.querySelector('#imdb-card-title .phobia-word-cover')),
            { timeout: 8000, polling: 100 })

            const state = await page.evaluate(() => {
                const title = document.querySelector('#imdb-card-title')
                const cover = title && title.querySelector('.phobia-word-cover')
                return {
                    titleHtml: title && title.outerHTML,
                    coveredText: cover && cover.textContent,
                    imageBlurred: document.querySelector('#imdb-card-image')?.classList.contains('phobia-blur') || false
                }
            })

            assert.strictEqual(state.coveredText, 'Short',
                `IMDb-style title should be covered, got ${state.titleHtml}`)
        })

        it('re-covers words after targetWordsChanged while blur-always mode is active', async () => {
            await setBlurAlwaysOn(browser, true)

            try {
                await setPhobiaWords(browser, ['spider'])

                await loadTestPage(page, 'imdb-short-card.html')
                await wait(700)

                let coverCount = await page.evaluate(() =>
                    document.querySelectorAll('#imdb-card-title .phobia-word-cover').length
                )
                assert.strictEqual(coverCount, 0,
                    'Short title should not be covered before Short is a target word')

                await setPhobiaWords(browser, ['short'])
                await sendMessageViaServiceWorker(browser, { type: 'targetWordsChanged' })

                await page.waitForFunction(() =>
                    Boolean(document.querySelector('#imdb-card-title .phobia-word-cover')),
                { timeout: 8000, polling: 100 })

                const coveredText = await page.evaluate(() =>
                    document.querySelector('#imdb-card-title .phobia-word-cover')?.textContent
                )

                assert.strictEqual(coveredText, 'Short',
                    'targetWordsChanged should restart word covering even when blur-always mode is active')
            } finally {
                await setBlurAlwaysOn(browser, false)
            }
        })

        it('covers target words before the first visible animation frame', async () => {
            await setPhobiaWords(browser, ['spider'])

            await page.evaluateOnNewDocument(() => {
                window.__phobiaWordVisibleFrames = 0
                window.__phobiaWordCoverFrames = 0

                const check = () => {
                    const exactText = document.querySelector('#exact-text')
                    if (exactText) {
                        if (exactText.querySelector('.phobia-word-cover')) {
                            window.__phobiaWordCoverFrames += 1
                        } else if (/\bspider\b/i.test(exactText.textContent || '')) {
                            window.__phobiaWordVisibleFrames += 1
                        }
                    }

                    if (window.__phobiaWordCoverFrames === 0 && window.__phobiaWordVisibleFrames < 60) {
                        requestAnimationFrame(check)
                    }
                }

                requestAnimationFrame(check)
            })

            await loadTestPage(page, 'word-cover.html')
            await waitForWordCovers(1)

            const visibleFrames = await page.evaluate(() => window.__phobiaWordVisibleFrames || 0)
            assert.strictEqual(visibleFrames, 0,
                'target word should not be visible for a rendered frame before being covered')
        })

        it('does not blur non-target text while word-cover analysis runs', async () => {
            await setPhobiaWords(browser, ['spider'])

            await page.evaluateOnNewDocument(() => {
                window.__phobiaSafeWordBlurredFrames = 0

                const isCssBlurred = (element) => {
                    if (!element) return false
                    const style = window.getComputedStyle(element)
                    const textShadow = style.textShadow || ''
                    const filter = style.filter || ''
                    return textShadow.includes('blur') ||
                        textShadow.includes('0px 0px 7px') ||
                        filter.includes('blur(')
                }

                const check = () => {
                    const customText = document.querySelector('#custom-text')
                    if (customText && isCssBlurred(customText)) {
                        window.__phobiaSafeWordBlurredFrames += 1
                    }

                    if (window.__phobiaSafeWordBlurredFrames === 0 && !document.querySelector('.phobia-word-cover')) {
                        requestAnimationFrame(check)
                    }
                }

                requestAnimationFrame(check)
            })

            await loadTestPage(page, 'word-cover.html')
            await waitForWordCovers(1)

            const blurredFrames = await page.evaluate(() => window.__phobiaSafeWordBlurredFrames || 0)
            assert.strictEqual(blurredFrames, 0,
                'non-target text should never be CSS-blurred while word-cover analysis runs')
        })

        it('does not blur dynamically added safe text while word-cover re-analysis is pending', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await page.waitForFunction(() => {
                const coveredWords = [...document.querySelectorAll('.phobia-word-cover')]
                    .map(el => el.textContent.toLowerCase())
                return coveredWords.includes('spider') && coveredWords.includes('spiders')
            }, { timeout: 8000, polling: 100 })

            await page.evaluate(() => {
                const p = document.createElement('p')
                p.id = 'dynamic-safe-text'
                p.textContent = 'A butterfly arrived after the first word analysis.'
                document.querySelector('#dynamic-host').appendChild(p)
            })

            // The extension exposes no page-visible "re-analysis pending" signal,
            // so watch the added text for the whole window in which the
            // re-analysis runs and count every frame where it was masked.
            const masked = await page.evaluate(() => new Promise((resolve) => {
                const dynamicText = document.querySelector('#dynamic-safe-text')
                const frames = { filter: 0, textShadow: 0, textFill: 0, covers: 0 }
                const startedAt = performance.now()
                const check = () => {
                    const style = window.getComputedStyle(dynamicText)
                    const textShadow = style.textShadow || ''
                    if ((style.filter || '').includes('blur(')) frames.filter += 1
                    if (textShadow.includes('blur') || textShadow.includes('0px 0px 7px')) frames.textShadow += 1
                    if (style.webkitTextFillColor === 'rgba(0, 0, 0, 0)') frames.textFill += 1
                    if (dynamicText.querySelectorAll('.phobia-word-cover').length > 0) frames.covers += 1
                    if (performance.now() - startedAt < 1500) requestAnimationFrame(check)
                    else resolve(frames)
                }
                requestAnimationFrame(check)
            }))

            assert.strictEqual(masked.filter, 0,
                'dynamically added safe text should not receive CSS filter blur while pending')
            assert.strictEqual(masked.textShadow, 0,
                'dynamically added safe text should not receive blurred text-shadow while pending')
            assert.strictEqual(masked.textFill, 0,
                'dynamically added safe text should not be made transparent by the pending mask')
            assert.strictEqual(masked.covers, 0,
                'safe dynamic text should not be covered before analysis marks it as a target word')
        })

        it('covers parser-inserted target words during the early mutation pass', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await waitForWordCovers(1)

            const state = await page.evaluate(() => window.__phobiaParserInsertedWordCoverState)

            assert.ok(state.observed,
                'test page should observe the parser-time inserted target word')
            assert.strictEqual(state.visibleDuringMutation, false,
                'parser-inserted target word should not remain plain text through the early mutation callback')
            assert.strictEqual(state.coveredDuringMutation, true,
                'parser-inserted target word should already be covered during the early mutation callback')
        })

        it('covers custom target words before the first visible animation frame', async () => {
            await setPhobiaWords(browser, ['butterfly'])

            await page.evaluateOnNewDocument(() => {
                window.__phobiaCustomWordVisibleFrames = 0
                window.__phobiaCustomWordCoverFrames = 0

                const check = () => {
                    const customText = document.querySelector('#custom-text')
                    if (customText) {
                        if (customText.querySelector('.phobia-word-cover')) {
                            window.__phobiaCustomWordCoverFrames += 1
                        } else if (/\bbutterfly\b/i.test(customText.textContent || '')) {
                            window.__phobiaCustomWordVisibleFrames += 1
                        }
                    }

                    if (window.__phobiaCustomWordCoverFrames === 0 && window.__phobiaCustomWordVisibleFrames < 60) {
                        requestAnimationFrame(check)
                    }
                }

                requestAnimationFrame(check)
            })

            await loadTestPage(page, 'word-cover.html')
            await waitForWordCovers(1)

            const visibleFrames = await page.evaluate(() => window.__phobiaCustomWordVisibleFrames || 0)
            assert.strictEqual(visibleFrames, 0,
                'custom target word should not be visible for a rendered frame before being covered')
        })

        it('uses default target words when storage has not populated targetWords yet', async () => {
            await clearExtensionStorage(browser)
            const swTarget = await getExtensionServiceWorker(browser)
            const swWorker = await swTarget.worker()
            await swWorker.evaluate(() => new Promise((resolve) => {
                chrome.storage.sync.set({
                    phobiaBlockerEnabled: true,
                    blurValueAmount: 60,
                    wordCoverEnabled: true
                }, resolve)
            }))

            await loadTestPage(page, 'word-cover.html')
            await waitForWordCovers(1)

            const coveredWords = await page.evaluate(() =>
                [...document.querySelectorAll('.phobia-word-cover')]
                    .map(el => el.textContent.toLowerCase())
            )

            assert.ok(coveredWords.includes('spider'),
                'default target word "spider" should be active without opening the popup first')
        })

        it('hover does not reveal a covered word', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await waitForWordCovers(1)

            const before = await page.evaluate(() => {
                const word = document.querySelector('.phobia-word-cover')
                const style = window.getComputedStyle(word)
                return {
                    color: style.color,
                    backgroundColor: style.backgroundColor,
                    backgroundImage: style.backgroundImage,
                    cursor: style.cursor,
                    title: word.getAttribute('title'),
                    ariaLabel: word.getAttribute('aria-label')
                }
            })

            await page.hover('.phobia-word-cover')
            await wait(150)

            const after = await page.evaluate(() => {
                const word = document.querySelector('.phobia-word-cover')
                const style = window.getComputedStyle(word)
                return {
                    color: style.color,
                    backgroundColor: style.backgroundColor
                }
            })

            assert.notStrictEqual(before.backgroundColor, 'rgba(0, 0, 0, 0)',
                'covered word should have an opaque background before hover')
            assert.strictEqual(before.color, 'rgba(0, 0, 0, 0)',
                'covered word text should be transparent before hover')
            assert.ok(before.backgroundImage.includes('repeating-linear-gradient'),
                'covered word should use an intentional redaction pattern')
            assert.strictEqual(before.cursor, 'help',
                'covered word cursor should indicate explanatory help is available')
            assert.strictEqual(before.title, 'Covered by PhobiaBlur',
                'covered word should expose a tooltip explaining the cover')
            assert.strictEqual(before.ariaLabel, 'Covered by PhobiaBlur',
                'covered word should expose an accessible explanation')
            assert.notStrictEqual(after.backgroundColor, 'rgba(0, 0, 0, 0)',
                'covered word background should remain opaque on hover')
            assert.strictEqual(after.color, 'rgba(0, 0, 0, 0)',
                'covered word text should remain hidden on hover')
        })

        it('keeps existing word covers stable after unrelated page mutations', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await page.waitForFunction(() => {
                const coveredWords = [...document.querySelectorAll('.phobia-word-cover')]
                    .map(el => el.textContent.toLowerCase())
                return coveredWords.includes('spider') &&
                    coveredWords.includes('spiders')
            }, { timeout: 8000, polling: 100 })

            const before = await page.evaluate(() =>
                document.querySelectorAll('.phobia-word-cover').length
            )

            await page.evaluate(() => {
                const p = document.createElement('p')
                p.id = 'unrelated-dynamic-text'
                p.textContent = 'This unrelated update should not change covered words.'
                document.querySelector('#dynamic-host').appendChild(p)
            })
            await wait(1200)

            const after = await page.evaluate(() =>
                document.querySelectorAll('.phobia-word-cover').length
            )

            assert.strictEqual(after, before,
                'covered words should not unwrap and re-cover after unrelated mutations')
        })

        it('does not re-run analysis for unrelated DOM churn after stable state', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await page.waitForFunction(() => {
                const coveredWords = [...document.querySelectorAll('.phobia-word-cover')]
                    .map(el => el.textContent.toLowerCase())
                return coveredWords.includes('spider')
            }, { timeout: 8000, polling: 100 })

            const before = await waitForPageAnalysis()

            await page.evaluate(() => {
                const host = document.querySelector('#dynamic-host')
                for (let i = 0; i < 12; i++) {
                    const marker = document.createElement('span')
                    marker.className = 'unrelated-layout-marker'
                    marker.setAttribute('data-cycle-marker', String(i))
                    host.appendChild(marker)
                    marker.classList.toggle('active')
                    marker.setAttribute('style', `--x:${i}`)
                }
            })
            await wait(1200)

            const after = await queryAnalysisDebugState()
            assert.strictEqual(after.pageAnalysisRequests, before.pageAnalysisRequests,
                'unchanged page text should not trigger another page analysis')
            assert.strictEqual(after.directWordCovers, before.directWordCovers,
                'unrelated DOM churn should not recreate direct word covers')
        })

        it('does not re-run media analysis for unrelated DOM churn after stable state', async () => {
            await setPhobiaWords(browser, ['butterfly'])

            await loadTestPage(page, 'simple-image.html')
            await waitForPhobiaNoblur(page, '#spider-image')
            await waitForPhobiaNoblur(page, '#safe-image')

            const before = await waitForPageAnalysis()
            const beforeClasses = await page.evaluate(() => ({
                spider: [...document.querySelector('#spider-image').classList],
                safe: [...document.querySelector('#safe-image').classList],
                spiderBlur: document.querySelector('#spider-image').hasAttribute('data-phobia-blur'),
                safeBlur: document.querySelector('#safe-image').hasAttribute('data-phobia-blur')
            }))

            await page.evaluate(() => {
                for (let i = 0; i < 12; i++) {
                    const marker = document.createElement('span')
                    marker.className = 'media-layout-marker'
                    marker.setAttribute('style', `--media-marker:${i}`)
                    document.body.appendChild(marker)
                    marker.classList.toggle('active')
                }
            })
            await wait(1200)

            const after = await queryAnalysisDebugState()
            const afterClasses = await page.evaluate(() => ({
                spider: [...document.querySelector('#spider-image').classList],
                safe: [...document.querySelector('#safe-image').classList],
                spiderBlur: document.querySelector('#spider-image').hasAttribute('data-phobia-blur'),
                safeBlur: document.querySelector('#safe-image').hasAttribute('data-phobia-blur')
            }))

            assert.strictEqual(after.pageAnalysisRequests, before.pageAnalysisRequests,
                'unchanged page text should not trigger another offscreen page analysis')
            assert.deepStrictEqual(afterClasses, beforeClasses,
                'unrelated DOM churn should not flip cached media blur classes')
        })

        it('analyzes dynamically added safe text once and keeps it stable', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await page.waitForFunction(() => {
                const coveredWords = [...document.querySelectorAll('.phobia-word-cover')]
                    .map(el => el.textContent.toLowerCase())
                return coveredWords.includes('spider')
            }, { timeout: 8000, polling: 100 })

            const before = await waitForPageAnalysis()

            await page.evaluate(() => {
                const p = document.createElement('p')
                p.id = 'dynamic-safe-once'
                p.textContent = 'An orchid arrived after the cached word analysis.'
                document.querySelector('#dynamic-host').appendChild(p)
            })

            const afterAnalysis = await waitForPageAnalysis(before.pageAnalysisRequests + 1)
            const coverCount = await page.evaluate(() =>
                document.querySelectorAll('.phobia-word-cover').length
            )

            // Existing spider matches remain: this is still a blur verdict.
            // Only a clear verdict with media can need a stabilization request.
            assert.strictEqual(afterAnalysis.pageAnalysisRequests, before.pageAnalysisRequests + 1,
                'new safe vocabulary should trigger exactly one additional page analysis')
            assert.strictEqual(afterAnalysis.directWordCovers, before.directWordCovers,
                'new safe text should not create direct word covers')

            await page.evaluate(() => {
                const host = document.querySelector('#dynamic-host')
                for (let i = 0; i < 6; i++) {
                    const marker = document.createElement('span')
                    marker.className = 'safe-stability-marker'
                    host.appendChild(marker)
                    marker.classList.toggle('active')
                }
            })
            await wait(1000)

            const afterChurn = await queryAnalysisDebugState()
            const finalState = await page.evaluate(() => ({
                coverCount: document.querySelectorAll('.phobia-word-cover').length
            }))

            assert.strictEqual(afterChurn.pageAnalysisRequests, afterAnalysis.pageAnalysisRequests,
                'unchanged dynamic safe text should not be analyzed again')
            assert.strictEqual(afterChurn.directWordCovers, afterAnalysis.directWordCovers,
                'layout-only churn after dynamic text should not recreate direct word covers')
            assert.strictEqual(finalState.coverCount, coverCount,
                'safe dynamic text should not change covered target-word count')
        })

        it('covers dynamically added target text once without cycling', async () => {
            await setPhobiaWords(browser, ['snake'])

            await loadTestPage(page, 'word-cover.html')
            await page.waitForFunction(() =>
                document.querySelectorAll('.phobia-word-cover').length === 0,
            { timeout: 8000, polling: 100 })

            const before = await waitForPageAnalysis()

            await page.evaluate(() => {
                const p = document.createElement('p')
                p.id = 'dynamic-target-once'
                p.textContent = 'A snake appeared after the first clean analysis.'
                document.querySelector('#dynamic-host').appendChild(p)
            })

            await page.waitForFunction(
                () => {
                    const dynamic = document.querySelector('#dynamic-target-once')
                    return dynamic &&
                        dynamic.querySelectorAll('.phobia-word-cover').length === 1
                },
                { timeout: 8000, polling: 100 }
            )

            const afterAnalysis = await waitForPageAnalysis(before.pageAnalysisRequests + 1)
            // The inserted snake produces a blur verdict, which is accepted
            // immediately rather than retried for clear-media stabilization.
            assert.strictEqual(afterAnalysis.pageAnalysisRequests, before.pageAnalysisRequests + 1,
                'new target vocabulary should trigger exactly one additional page analysis')
            assert.strictEqual(afterAnalysis.directWordCovers, before.directWordCovers + 1,
                'the new target occurrence should create exactly one direct word cover')

            await page.evaluate(() => {
                const dynamic = document.querySelector('#dynamic-target-once')
                for (let i = 0; i < 6; i++) {
                    const marker = document.createElement('span')
                    marker.className = 'target-stability-marker'
                    dynamic.appendChild(marker)
                    marker.classList.toggle('active')
                }
            })
            await wait(1000)

            const afterChurn = await queryAnalysisDebugState()
            const finalState = await page.evaluate(() => ({
                dynamicCoverCount: document.querySelectorAll('#dynamic-target-once .phobia-word-cover').length
            }))

            assert.strictEqual(afterChurn.pageAnalysisRequests, afterAnalysis.pageAnalysisRequests,
                'covered dynamic target text should not be re-analyzed after unrelated churn')
            assert.strictEqual(afterChurn.directWordCovers, afterAnalysis.directWordCovers,
                'covered dynamic target text should not be wrapped again after unrelated churn')
            assert.strictEqual(finalState.dynamicCoverCount, 1,
                'only the dynamic target occurrence should remain covered')
        })

        it('toggle-word-cover command is registered and toggles covers', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await waitForWordCovers(1)

            const extPage = await require('./test-utils').getExtensionPage(browser)
            const commandInfo = await extPage.evaluate(() => {
                const commands = chrome.runtime.getManifest().commands || {}
                return commands['toggle-word-cover'] || null
            })
            assert.ok(commandInfo, 'manifest should register toggle-word-cover command')

            const firstToggle = await extPage.evaluate(() => {
                return new Promise((resolve) => {
                    chrome.runtime.sendMessage({
                        target: 'background',
                        type: 'toggleWordCover'
                    }, (response) => {
                        void chrome.runtime.lastError
                        resolve(response)
                    })
                })
            })
            assert.deepStrictEqual(firstToggle, { ok: true, wordCoverEnabled: false },
                'first toggle should disable word cover')
            await wait(500)

            let coverCount = await page.evaluate(() =>
                document.querySelectorAll('.phobia-word-cover').length
            )
            assert.strictEqual(coverCount, 0, 'toggle command should unwrap covered words when disabling')

            const secondToggle = await extPage.evaluate(() => {
                return new Promise((resolve) => {
                    chrome.runtime.sendMessage({
                        target: 'background',
                        type: 'toggleWordCover'
                    }, (response) => {
                        void chrome.runtime.lastError
                        resolve(response)
                    })
                })
            })
            assert.deepStrictEqual(secondToggle, { ok: true, wordCoverEnabled: true },
                'second toggle should enable word cover')
            await extPage.close()

            await waitForWordCovers(1)
            coverCount = await page.evaluate(() =>
                document.querySelectorAll('.phobia-word-cover').length
            )
            assert.ok(coverCount > 0, 'toggle command should re-cover words when enabling')
        })

        it('Alt+Shift+W toggles word covers off when the page has focus', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await waitForWordCovers(1)
            await page.bringToFront()

            await page.keyboard.down('Alt')
            await page.keyboard.down('Shift')
            await page.keyboard.press('KeyW')
            await page.keyboard.up('Shift')
            await page.keyboard.up('Alt')

            await page.waitForFunction(
                () => document.querySelectorAll('.phobia-word-cover').length === 0,
                { timeout: 5000, polling: 100 }
            )

            const wordCoverEnabledAfterDisable = await getSyncStorage(browser, 'wordCoverEnabled')

            assert.strictEqual(wordCoverEnabledAfterDisable, false,
                'Alt+Shift+W should disable the global word-cover setting')

            await page.keyboard.down('Alt')
            await page.keyboard.down('Shift')
            await page.keyboard.press('KeyW')
            await page.keyboard.up('Shift')
            await page.keyboard.up('Alt')

            await waitForWordCovers(1)
        })

        it('word cover toggle off unwraps covered words', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await waitForWordCovers(1)

            await sendMessageViaServiceWorker(browser, {
                type: 'wordCoverSettingsChanged',
                wordCoverEnabled: false
            })
            await wait(300)

            const state = await page.evaluate(() => ({
                coverCount: document.querySelectorAll('.phobia-word-cover').length,
                text: document.querySelector('#exact-text').textContent
            }))

            assert.strictEqual(state.coverCount, 0, 'turning word cover off should remove wrappers')
            assert.ok(state.text.includes('spider'), 'original text should remain readable')
        })

        it('unblurAll reveals all covered words and blurAll covers them again', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await waitForWordCovers(1)

            await sendMessageViaServiceWorker(browser, { type: 'unblurAll' })

            await page.evaluate(() => {
                const p = document.createElement('p')
                p.id = 'dynamic-spider-text'
                p.textContent = 'A new spider appeared after unblur all.'
                document.querySelector('#dynamic-host').appendChild(p)
            })
            await wait(700)

            let coverCount = await page.evaluate(() =>
                document.querySelectorAll('.phobia-word-cover').length
            )
            assert.strictEqual(coverCount, 0,
                'unblurAll should reveal current and newly added covered words on this page')

            await sendMessageViaServiceWorker(browser, { type: 'blurAll' })
            await waitForWordCovers(1)

            coverCount = await page.evaluate(() =>
                document.querySelectorAll('.phobia-word-cover').length
            )
            assert.ok(coverCount > 0, 'blurAll should re-cover target words after unblurAll')
        })

        it('right-click unblur reveals only the clicked covered word occurrence', async () => {
            await setPhobiaWords(browser, ['spider'])

            await loadTestPage(page, 'word-cover.html')
            await page.waitForFunction(() =>
                document.querySelectorAll('#repeat-text .phobia-word-cover').length === 2,
            { timeout: 8000, polling: 100 })

            const before = await page.evaluate(() =>
                document.querySelectorAll('#repeat-text .phobia-word-cover').length
            )
            assert.strictEqual(before, 2, 'repeat text should start with two covered word occurrences')

            await page.evaluate(() => {
                const word = document.querySelector('#repeat-text .phobia-word-cover')
                const rect = word.getBoundingClientRect()
                word.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2
                }))
            })
            await sendMessageViaServiceWorker(browser, { type: 'unblur' })

            const after = await page.evaluate(() => ({
                coveredInRepeat: document.querySelectorAll('#repeat-text .phobia-word-cover').length,
                revealedInRepeat: document.querySelectorAll('#repeat-text .phobia-word-permanent-uncover').length
            }))

            assert.strictEqual(after.coveredInRepeat, 1,
                'right-click unblur should reveal only one covered word occurrence')
            assert.strictEqual(after.revealedInRepeat, 1,
                'revealed word occurrence should be marked permanent for this page')
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
            // 'butterfly' matches nothing → wait for noblur (2s unveil timer) to confirm analysis done
            await waitForPhobiaNoblur(page, '#spider-image')

            // Verify images are unblurred (no phobia match)
            const blurBefore = await page.evaluate(() => {
                const f = window.getComputedStyle(document.querySelector('#spider-image')).filter
                const m = f && f.match(/blur\(([\d.]+)px\)/)
                return m ? parseFloat(m[1]) : 0
            })
            assert.strictEqual(blurBefore, 0, 'image should be unblurred before blurAll (no phobia match)')

            // Send blurAll (same as Ctrl+Alt+B hotkey)
            await sendMessageViaServiceWorker(browser, { type: 'blurAll' })
            await wait(300)

            const blurAfter = await page.evaluate(() => {
                const f = window.getComputedStyle(document.querySelector('#spider-image')).filter
                const m = f && f.match(/blur\(([\d.]+)px\)/)
                return m ? parseFloat(m[1]) : 0
            })

            // blurAll should produce a non-zero blur regardless of whether blurValueAmount is in storage
            assert.ok(blurAfter > 0,
                `blurAll should apply a non-zero blur amount even without stored blurValueAmount, got ${blurAfter}px`)
        })

        it('blurAll should stay blurred when later clean-page analysis finishes', async () => {
            await clearExtensionStorage(browser)
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 50)
            await setPhobiaWords(browser, ['butterfly'])  // word not on page → analysis would normally unblur

            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaNoblur(page, '#spider-image')

            await sendMessageViaServiceWorker(browser, { type: 'blurAll' })
            await page.evaluate(() => {
                const p = document.createElement('p')
                p.textContent = 'An unrelated clean update after the manual blur command.'
                document.body.appendChild(p)
            })
            await wait(3500)

            const state = await page.evaluate(() => {
                const img = document.querySelector('#spider-image')
                const filter = window.getComputedStyle(img).filter
                const match = filter && filter.match(/blur\(([\d.]+)px\)/)
                return {
                    hasBlur: img.classList.contains('phobia-blur'),
                    hasNoblur: img.classList.contains('phobia-noblur'),
                    hasDataAttr: img.hasAttribute('data-phobia-blur'),
                    blurPx: match ? parseFloat(match[1]) : 0
                }
            })

            assert.ok(state.hasBlur, 'image should keep phobia-blur after clean analysis completes')
            assert.ok(state.hasDataAttr, 'image should keep data-phobia-blur after clean analysis completes')
            assert.ok(!state.hasNoblur, 'image should not be marked phobia-noblur after manual blurAll')
            assert.ok(state.blurPx > 0, `image should remain visually blurred, got ${state.blurPx}px`)
        })

        it('blurAll and analysis-based blur should produce the same blur amount for the same slider value', async () => {
            await clearExtensionStorage(browser)
            await setExtensionEnabled(browser, true)
            await setBlurAmount(browser, 50)  // DEFAULT_BLUR_SLIDER_VALUE

            // Page with detection: measure analysis-based blur
            await setPhobiaWords(browser, ['spider'])
            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaBlur(page, '#spider-image')

            const analysisBluePx = await page.evaluate(() => {
                const f = window.getComputedStyle(document.querySelector('#spider-image')).filter
                const m = f && f.match(/blur\(([\d.]+)px\)/)
                return m ? parseFloat(m[1]) : 0
            })

            // Page without detection + blurAll: measure hotkey blur
            await setPhobiaWords(browser, ['butterfly'])
            await loadTestPage(page, 'simple-image.html')
            await page.bringToFront()
            await waitForPhobiaNoblur(page, '#spider-image')

            await sendMessageViaServiceWorker(browser, { type: 'blurAll' })
            await wait(300)

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
