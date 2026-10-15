// Historical Puppeteer suite, not a release gate (tests/README.md); the icon
// plumbing it inspects lives in js/background.js (_preloadTintedIcons) and the
// reportIconStatus calls in js/js.js.
/**
 * Icon Status Test Cases
 *
 * Tests that the extension toolbar icon changes color correctly:
 * - All icon variants (idle/processing/detected × 16/24/32/48/128px) are preloaded in the
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
    wait,
} = require('./test-utils')

// ── Tracker helpers ──────────────────────────────────────────────────────────
//
// Open a persistent extension page (popup.html) and attach a
// chrome.runtime.onMessage listener.  Because chrome.runtime.sendMessage()
// from a content script is delivered to ALL onMessage listeners in the same
// extension (background, popup, options page, …), this page captures every
// 'iconStatus' message without any changes to the extension's own code.

// Only the top frame reports (reportIconStatus returns early in sub-frames), and
// popup.js never sends iconStatus, so the tracker page adds nothing of its own;
// the log holds only what the top frame of the page under test sent.
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
        // Alpha > 64 skips the transparent padding and most anti-aliased edge
        // pixels, which the 'destination-in' pass keeps identical in every variant
        // and which would otherwise dilute the tint difference.
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
        // Needed only by the 'icon preloading' tests: they read globalThis._tintedIcons
        // directly, while setIcon itself awaits the preload promise before using it.
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
        it('should preload all fifteen icon variants in the service worker', async () => {
            const swTarget = await getExtensionServiceWorker(browser)
            assert.ok(swTarget, 'service worker target should be accessible')
            const swWorker = await swTarget.worker()
            assert.ok(swWorker, 'service worker worker instance should be available')

            const keys = await swWorker.evaluate(() =>
                globalThis._tintedIcons ? Object.keys(globalThis._tintedIcons) : []
            )

            for (const variant of ['idle', 'processing', 'detected']) {
                for (const size of [16, 24, 32, 48, 128]) {
                    const key = `${variant}_${size}`
                    assert.ok(keys.includes(key), `missing preloaded icon: ${key}`)
                }
            }
        })

        // The tints are #F5A623 (processing) and #E53935 (detected) applied with the
        // 'color' composite, which keeps the icon's luminance and changes only hue and
        // saturation. The margins are small on purpose: a dark icon absorbs most of
        // the tint, so channel averages move by tens of units, not hundreds.
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

        // idle_* is the untinted PNG drawn as-is; this guards against a tint pass
        // that silently became a no-op (wrong composite mode, fill skipped).
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
            // Allow: content-script init (~500ms) + NLP analysis + the 250ms delay
            // reportIconStatus puts on idle/detected (processing is sent at once).
            // A clear verdict is also deferred and re-analysed while the page still
            // produces text, so the idle may arrive several round trips after load.
            await wait(3000)

            // Order is not asserted because each deferred re-analysis sends another
            // processing; only the final state matters to the user.
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

        // DISABLED mode never analyses: disableProtection reports idle directly, and
        // the page already open re-applies on the storage change, hence the clear.
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

            // Not in a finally: a failure above leaves the extension disabled, and the
            // always-on test below then fails for the wrong reason.
            await setExtensionEnabled(browser, true)
        })

        it('should send detected (no processing) when blurIsAlwaysOn is active', async () => {
            await setBlurAlwaysOn(browser, true)
            await clearIconLog(trackerPage)

            await page.bringToFront()
            await loadTestPage(page, 'simple-image.html')
            // applyProtectionMode's ALWAYS_BLUR branch reports 'detected' without ever
            // calling analyzeCurrentPage, after reportIconStatus's 250ms delay.
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
