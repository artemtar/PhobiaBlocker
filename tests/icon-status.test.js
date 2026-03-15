/**
 * Icon Status Test Cases
 *
 * Tests that the extension toolbar icon changes color correctly:
 * - All icon variants (idle/processing/detected × 16/48/128px) are preloaded in the
 *   service worker at startup so setIcon can be called synchronously.
 * - The processing icon has a yellow/amber pixel tint.
 * - The detected icon has a red pixel tint.
 * - The idle icon is visually distinct from the tinted variants.
 * - A page with images but no phobia content → processing then idle (not stuck yellow).
 * - A page with phobia content → processing then detected.
 * - Extension disabled → idle immediately, no processing.
 * - blurIsAlwaysOn → detected immediately, no processing.
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    loadTestPage,
    setPhobiaWords,
    setExtensionEnabled,
    setBlurAlwaysOn,
    clearExtensionStorage,
    getExtensionServiceWorker,
    getExtensionPage,
} = require('./test-utils')

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ── Tracker helpers ──────────────────────────────────────────────────────────
//
// Open a persistent extension page (popup.html) and attach a
// chrome.runtime.onMessage listener.  Because chrome.runtime.sendMessage()
// from a content script is delivered to ALL onMessage listeners in the same
// extension (background, popup, options page, …), this page captures every
// 'iconStatus' message without any changes to the extension's own code.

async function setupIconTracker(browser) {
    const page = await getExtensionPage(browser)
    await page.evaluate(() => {
        window._iconLog = []
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg && msg.type === 'iconStatus') {
                window._iconLog.push(msg.status)
            }
        })
    })
    return page
}

async function readIconLog(trackerPage) {
    return trackerPage.evaluate(() => window._iconLog || [])
}

async function clearIconLog(trackerPage) {
    return trackerPage.evaluate(() => { window._iconLog = [] })
}

// ── Service-worker pixel helpers ─────────────────────────────────────────────
//
// Evaluate code inside the service worker to read the pre-rendered ImageData
// objects stored in globalThis._tintedIcons.  Returns the mean RGB of all
// non-transparent pixels, or null if the key is missing.

async function getIconAverageColor(browser, iconKey) {
    const swTarget = await getExtensionServiceWorker(browser)
    if (!swTarget) return null
    const swWorker = await swTarget.worker()
    if (!swWorker) return null
    return swWorker.evaluate((key) => {
        const imgData = globalThis._tintedIcons && globalThis._tintedIcons[key]
        if (!imgData) return null
        const d = imgData.data  // Uint8ClampedArray: R,G,B,A,R,G,B,A,…
        let r = 0, g = 0, b = 0, n = 0
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 64) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++ }
        }
        return n > 0 ? { r: r / n, g: g / n, b: b / n } : null
    }, iconKey)
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Icon Status', () => {
    let browser, page, trackerPage

    before(async () => {
        browser = await launchBrowserWithExtension()
        await clearExtensionStorage(browser)
        // Use 'spider' as the sole phobia word — simple-image.html contains it
        await setPhobiaWords(browser, ['spider'])
        // Give the service worker time to finish preloading all icon variants
        await wait(2000)
        trackerPage = await setupIconTracker(browser)
        page = await browser.newPage()
    })

    after(async () => {
        if (browser) await browser.close()
    })

    beforeEach(async () => {
        await clearIconLog(trackerPage)
    })

    // ── Icon preloading ───────────────────────────────────────────────────────

    describe('icon preloading', () => {
        it('should preload all nine icon variants in the service worker', async () => {
            const swTarget = await getExtensionServiceWorker(browser)
            assert.ok(swTarget, 'service worker target should be accessible')
            const swWorker = await swTarget.worker()
            assert.ok(swWorker, 'service worker worker instance should be available')

            const keys = await swWorker.evaluate(() =>
                globalThis._tintedIcons ? Object.keys(globalThis._tintedIcons) : []
            )

            for (const variant of ['idle', 'processing', 'detected']) {
                for (const size of [16, 48, 128]) {
                    const key = `${variant}_${size}`
                    assert.ok(keys.includes(key), `missing preloaded icon: ${key}`)
                }
            }
        })

        it('processing icon should have a yellow/amber tint (red channel > blue channel)', async () => {
            const c = await getIconAverageColor(browser, 'processing_48')
            assert.ok(c, 'processing_48 ImageData should exist in service worker')
            assert.ok(
                c.r > c.b + 20,
                `processing icon: red avg (${c.r.toFixed(0)}) should exceed blue avg (${c.b.toFixed(0)}) by >20 for yellow tint`
            )
        })

        it('detected icon should have a red tint (red channel > green channel)', async () => {
            const c = await getIconAverageColor(browser, 'detected_48')
            assert.ok(c, 'detected_48 ImageData should exist in service worker')
            assert.ok(
                c.r > c.g + 10,
                `detected icon: red avg (${c.r.toFixed(0)}) should exceed green avg (${c.g.toFixed(0)}) by >10 for red tint`
            )
        })

        it('idle icon should be visually distinct from both tinted variants', async () => {
            const idle = await getIconAverageColor(browser, 'idle_48')
            const proc = await getIconAverageColor(browser, 'processing_48')
            const det  = await getIconAverageColor(browser, 'detected_48')
            assert.ok(idle && proc && det, 'all three idle/processing/detected variants should exist')

            const diffProc = Math.abs(idle.r - proc.r) + Math.abs(idle.g - proc.g) + Math.abs(idle.b - proc.b)
            const diffDet  = Math.abs(idle.r - det.r)  + Math.abs(idle.g - det.g)  + Math.abs(idle.b - det.b)

            assert.ok(diffProc > 5,
                `idle icon should differ from processing (total channel diff: ${diffProc.toFixed(1)})`)
            assert.ok(diffDet > 5,
                `idle icon should differ from detected (total channel diff: ${diffDet.toFixed(1)})`)
        })
    })

    // ── Status message flow ───────────────────────────────────────────────────

    describe('status message flow', () => {
        it('should send processing then idle on a page with images but no phobia content', async () => {
            // nlp-case-test.html has one <img> and only "SNAKE" text — not a phobia word
            await page.bringToFront()
            await loadTestPage(page, 'nlp-case-test.html')
            // Allow: content-script init (~500ms) + NLP analysis + 800ms debounce
            await wait(3000)

            const log = await readIconLog(trackerPage)
            assert.ok(log.includes('processing'),
                `expected 'processing' in icon log (got: [${log}])`)
            assert.ok(log.includes('idle'),
                `expected 'idle' in icon log (got: [${log}])`)
            assert.notStrictEqual(log[log.length - 1], 'processing',
                'icon must not be stuck on processing after analysis completes')
        })

        it('should send processing then detected on a page with phobia content', async () => {
            // simple-image.html contains "spider" text — matches the 'spider' phobia word
            await page.bringToFront()
            await loadTestPage(page, 'simple-image.html')
            await wait(3000)

            const log = await readIconLog(trackerPage)
            assert.ok(log.includes('processing'),
                `expected 'processing' in icon log (got: [${log}])`)
            assert.ok(log.includes('detected'),
                `expected 'detected' in icon log (got: [${log}])`)
            assert.notStrictEqual(log[log.length - 1], 'processing',
                'icon must not be stuck on processing after phobia content is detected')
        })

        it('should send idle (no processing) when the extension is disabled', async () => {
            await setExtensionEnabled(browser, false)
            await clearIconLog(trackerPage)  // discard any idle from the disable action

            await page.bringToFront()
            await loadTestPage(page, 'simple-image.html')
            await wait(2000)

            const log = await readIconLog(trackerPage)
            assert.ok(!log.includes('processing'),
                `should not send 'processing' when extension is disabled (got: [${log}])`)
            assert.ok(log.includes('idle'),
                `should send 'idle' when extension is disabled (got: [${log}])`)

            await setExtensionEnabled(browser, true)
        })

        it('should send detected (no processing) when blurIsAlwaysOn is active', async () => {
            await setBlurAlwaysOn(browser, true)
            await clearIconLog(trackerPage)

            await page.bringToFront()
            await loadTestPage(page, 'simple-image.html')
            // onLoadBlurAll() → reportIconStatus('detected') with 800ms debounce
            await wait(2000)

            const log = await readIconLog(trackerPage)
            assert.ok(log.includes('detected'),
                `blur-always-on should send 'detected' (got: [${log}])`)
            assert.ok(!log.includes('processing'),
                `blur-always-on should not send 'processing' — NLP is skipped (got: [${log}])`)

            await setBlurAlwaysOn(browser, false)
        })
    })
})
