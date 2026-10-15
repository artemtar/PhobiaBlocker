// Historical Puppeteer end-to-end suite, kept for reference. It is not a release gate:
// root `npm test` fails on purpose and the gate is `npm run test:unit` (tests/README.md).
// Pages load over file://, whose URL has no hostname, so no site rule can ever match here
// and the cases below only prove storage round-trips. Matching and mode precedence are
// covered by tests/unit/policy-analysis.test.js against parseSiteRule / matchesSiteRule.
const { describe, it, before, beforeEach, after, afterEach } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    loadTestPage,
    setPhobiaWords,
    setExtensionEnabled,
    setBlurAlwaysOn,
    clearExtensionStorage,
    countBlurredImages,
    setWhitelistedSites,
    setBlacklistedSites,
    getWhitelistedSites,
    getBlacklistedSites,
    getAllVisualElements,
    openExtensionPopup,
    wait
} = require('./test-utils')

describe('PhobiaBlocker - Site Rules (Whitelist/Blacklist)', () => {
    let browser
    let page

    before(async () => {
        // Launch browser once (expensive operation)
        browser = await launchBrowserWithExtension()

        // Clear storage before tests
        await clearExtensionStorage(browser)

        // Set default settings
        await setExtensionEnabled(browser, true)
        await setPhobiaWords(browser, ['spider', 'snake'])
    })

    // Create a fresh page before each test to avoid detached frame errors
    beforeEach(async () => {
        page = await browser.newPage()
    })

    // Close the page after each test to free resources
    afterEach(async () => {
        if (page) {
            await page.close()
        }
    })

    after(async () => {
        if (browser) {
            await browser.close()
        }
    })

    describe('Storage Operations', () => {
        // The helpers write the raw array straight to chrome.storage.sync, bypassing the
        // parseSiteRule validation the popup and settings pages apply, so values round-trip
        // verbatim. '*.google.com' is stored as typed; the '*.' is stripped at match time
        // because a rule already covers every subdomain of its host.
        it('should store and retrieve whitelisted sites', async () => {
            const testSites = ['example.com', 'test.org', '*.google.com']
            await setWhitelistedSites(browser, testSites)

            const retrieved = await getWhitelistedSites(browser)
            assert.deepStrictEqual(retrieved, testSites, 'Whitelisted sites should match')

            // Clean up
            await setWhitelistedSites(browser, [])
        })

        it('should store and retrieve blacklisted sites', async () => {
            const testSites = ['badsite.com', 'evil.org']
            await setBlacklistedSites(browser, testSites)

            const retrieved = await getBlacklistedSites(browser)
            assert.deepStrictEqual(retrieved, testSites, 'Blacklisted sites should match')

            // Clean up
            await setBlacklistedSites(browser, [])
        })

        it('should handle empty site lists', async () => {
            await setWhitelistedSites(browser, [])
            await setBlacklistedSites(browser, [])

            const whitelist = await getWhitelistedSites(browser)
            const blacklist = await getBlacklistedSites(browser)

            assert.deepStrictEqual(whitelist, [], 'Empty whitelist should be empty array')
            assert.deepStrictEqual(blacklist, [], 'Empty blacklist should be empty array')
        })
    })

    describe('Whitelist Functionality', () => {
        it('should not blur content on whitelisted sites', async () => {
            // Load test page with images and phobia-related text
            await loadTestPage(page, 'basic-images.html')
            await wait(2000)

            // Add phobia words that would normally trigger blur
            // A targetWords change after load reaches the content script through
            // storage.onChanged and re-runs the whole protection pipeline, so the blur
            // asserted next does not depend on the words being present at page load.
            await setPhobiaWords(browser, ['spider', 'test'])
            await wait(1000)

            // Initially, content should be blurred
            let blurredCount = await countBlurredImages(page)
            assert.ok(blurredCount > 0, 'Images should be blurred before whitelisting')

            // Add current page domain to whitelist (file protocol)
            // For file:// URLs, we'll use a simulated domain test
            await setWhitelistedSites(browser, ['example.com'])

            // Rewriting the title does not simulate a domain: matchesSiteRule reads only the
            // frame URL's hostname, so the whitelist written above is never exercised on this
            // file:// page and nothing after the first assertion is checked.
            await page.evaluate(() => {
                document.title = 'Test page - example.com'
            })

            // Clear storage and test with actual domain matching
            await setWhitelistedSites(browser, [])
        })

        it('should ignore blur always on when site is whitelisted', async () => {
            await loadTestPage(page, 'basic-images.html')

            // Enable blur always on
            // blurIsAlwaysOn resolves to ALWAYS_BLUR mode, which blurs without any verdict.
            // resolveProtectionMode checks the whitelist before this toggle, which is the
            // precedence the title refers to; only the toggle half is observable here.
            await setBlurAlwaysOn(browser, true)
            await wait(1000)

            let blurredCount = await countBlurredImages(page)
            assert.ok(blurredCount > 0, 'All images should be blurred with blur always on')

            // Note: File protocol testing has limitations
            // In production, whitelisted sites would not blur even with blur always on

            // Clean up
            await setBlurAlwaysOn(browser, false)
            await setWhitelistedSites(browser, [])
        })

        it('should not trigger analysis when popup is opened on whitelisted site', async () => {
            // This test verifies the fix for popup triggering blur on whitelisted sites
            await loadTestPage(page, 'basic-images.html')

            // Clear any existing site rules
            await setWhitelistedSites(browser, [])
            await setBlacklistedSites(browser, [])

            // Initially blur content
            await setPhobiaWords(browser, ['spider', 'test'])
            await wait(1000)

            let initialBlurCount = await countBlurredImages(page)

            // Open popup. Today it only reads storage and polls the active tab with the
            // read-only getTriggeredWords query; the setBlurAmount message it once sent on
            // open no longer exists. This opens popup.html in a tab, not Chrome's native
            // action popup (tests/live/popup-sizing.js covers that one).
            const popupPage = await openExtensionPopup(browser, page)
            await wait(500)

            // Count should remain the same
            let afterPopupBlurCount = await countBlurredImages(page)

            // Close popup
            await popupPage.close()

            // In a whitelisted scenario, blur count should stay at 0
            // For non-whitelisted, it should remain consistent
            assert.strictEqual(
                afterPopupBlurCount,
                initialBlurCount,
                'Blur count should not change when popup opens'
            )
        })
    })

    describe('Blacklist Functionality', () => {
        it('should blur all content on blacklisted sites regardless of settings', async () => {
            // Disable extension BEFORE loading the page so the content script
            // reads phobiaBlockerEnabled=false on startup (no message needed).
            // Note the blacklist is never set in this case despite the title: the
            // "regardless of settings" half (blacklist beats the global off switch) is
            // only provable with a matching hostname.
            await setExtensionEnabled(browser, false)
            await wait(200)

            await loadTestPage(page, 'basic-images.html')
            await wait(1000)

            // Verify nothing is blurred when extension is disabled
            let blurredCount = await countBlurredImages(page)
            assert.strictEqual(blurredCount, 0, 'No images should be blurred when extension is disabled')

            // Note: Blacklist would override this in production
            // File protocol has testing limitations

            // Clean up
            await setExtensionEnabled(browser, true)
            await setBlacklistedSites(browser, [])
        })

        it('should keep content blurred on blacklist even without phobia words', async () => {
            // Clear phobia words BEFORE loading the page so the content script starts with
            // empty targetWords and the first verdict is already clear. A change after load
            // would also be applied (storage.onChanged re-runs protection), but the empty
            // list at startup keeps the initial state unambiguous for the count below.
            await setPhobiaWords(browser, [])
            await wait(200)

            await loadTestPage(page, 'basic-images.html')
            await wait(1000)

            // Without phobia words and no blacklist, nothing should blur
            let blurredCount = await countBlurredImages(page)
            assert.strictEqual(blurredCount, 0, 'No images should be blurred without phobia words')

            // Note: With blacklist, all content would be blurred
            // File protocol testing has limitations
        })

        // No assertion at all: with a file:// URL neither list matches, so this case only
        // documents the rule. resolveProtectionMode tests the blacklist first, and
        // tests/unit/policy-analysis.test.js proves it with both lists holding one rule.
        it('blacklist should take precedence over whitelist', async () => {
            await loadTestPage(page, 'basic-images.html')

            // Add site to both whitelist and blacklist
            await setWhitelistedSites(browser, ['example.com'])
            await setBlacklistedSites(browser, ['example.com'])
            await wait(1000)

            // Blacklist should win - content should be blurred
            // Note: File protocol testing has limitations
            // In production with real domains, blacklist takes precedence

            // Clean up
            await setWhitelistedSites(browser, [])
            await setBlacklistedSites(browser, [])
        })
    })

    describe('Pattern Matching', () => {
        it('should match exact domain patterns', async () => {
            const sites = ['example.com', 'test.org']
            await setWhitelistedSites(browser, sites)

            const retrieved = await getWhitelistedSites(browser)
            assert.deepStrictEqual(retrieved, sites, 'Exact domains should be stored correctly')

            await setWhitelistedSites(browser, [])
        })

        it('should match wildcard subdomain patterns', async () => {
            const sites = ['*.google.com', '*.facebook.com']
            await setWhitelistedSites(browser, sites)

            const retrieved = await getWhitelistedSites(browser)
            assert.deepStrictEqual(retrieved, sites, 'Wildcard patterns should be stored correctly')

            await setWhitelistedSites(browser, [])
        })

        // A path rule covers that directory and everything below it, never a sibling that
        // merely shares the prefix (example.com/path2). That is matchesSiteRule behaviour;
        // here only the storage write is observed.
        it('should match domain with path patterns', async () => {
            const sites = ['example.com/path', 'test.org/admin']
            await setWhitelistedSites(browser, sites)

            const retrieved = await getWhitelistedSites(browser)
            assert.deepStrictEqual(retrieved, sites, 'Domain with path patterns should be stored')

            await setWhitelistedSites(browser, [])
        })

        it('should handle base domain matching subdomains', async () => {
            // matchesSiteRule makes google.com match www.google.com: a rule covers its exact
            // host and every subdomain (hostname === host || hostname.endsWith('.' + host)).
            const sites = ['google.com']
            await setWhitelistedSites(browser, sites)

            // In production, this would match:
            // - google.com
            // - www.google.com
            // - mail.google.com
            // - any.subdomain.google.com

            const retrieved = await getWhitelistedSites(browser)
            assert.deepStrictEqual(retrieved, sites, 'Base domain should be stored')

            await setWhitelistedSites(browser, [])
        })
    })

    describe('Integration with Extension Features', () => {
        it('should respect whitelist when extension is toggled', async () => {
            await loadTestPage(page, 'basic-images.html')

            await setPhobiaWords(browser, ['spider'])
            await setExtensionEnabled(browser, true)
            await wait(1000)

            // Toggle extension off then on
            await setExtensionEnabled(browser, false)
            await wait(500)
            await setExtensionEnabled(browser, true)
            await wait(1000)

            // Whitelisted sites should remain unblurred through toggles
            // Non-whitelisted sites should respect toggle
            let blurredCount = await countBlurredImages(page)

            // Verify consistent behavior
            // countBlurredImages cannot return a negative number, so this assertion is
            // vacuous; the enable/disable toggle itself is only exercised, not checked.
            assert.ok(blurredCount >= 0, 'Extension toggle should work correctly')

            await setWhitelistedSites(browser, [])
        })

        // blurCount1 and blurCount2 are read but never compared: without a matching host
        // the page is in ANALYZE mode, where a word change legitimately may change the count.
        it('should respect blacklist when phobia words change', async () => {
            await loadTestPage(page, 'basic-images.html')

            // On blacklist, changing phobia words should not affect blur state
            await setBlacklistedSites(browser, ['example.com'])
            await setPhobiaWords(browser, ['spider'])
            await wait(1000)

            let blurCount1 = await countBlurredImages(page)

            // Change phobia words
            await setPhobiaWords(browser, ['snake', 'clown'])
            await wait(1000)

            let blurCount2 = await countBlurredImages(page)

            // On blacklisted sites, content stays blurred regardless of words
            // On normal sites, this might change blur state

            await setBlacklistedSites(browser, [])
        })

        it('should handle multiple sites in whitelist', async () => {
            const multipleSites = [
                'example.com',
                'test.org',
                '*.google.com',
                'github.com/user',
                'news.ycombinator.com'
            ]

            await setWhitelistedSites(browser, multipleSites)
            const retrieved = await getWhitelistedSites(browser)

            assert.strictEqual(retrieved.length, multipleSites.length, 'Should store multiple sites')
            assert.deepStrictEqual(retrieved, multipleSites, 'All sites should be preserved')

            await setWhitelistedSites(browser, [])
        })

        it('should handle multiple sites in blacklist', async () => {
            const multipleSites = [
                'spam.com',
                'ads.example.org',
                '*.malware.com'
            ]

            await setBlacklistedSites(browser, multipleSites)
            const retrieved = await getBlacklistedSites(browser)

            assert.strictEqual(retrieved.length, multipleSites.length, 'Should store multiple sites')
            assert.deepStrictEqual(retrieved, multipleSites, 'All sites should be preserved')

            await setBlacklistedSites(browser, [])
        })
    })

    describe('Edge Cases', () => {
        it('should handle case-insensitive domain matching', async () => {
            // parseSiteRule lowercases the rule host and matchesSiteRule lowercases the URL
            // hostname, so case never affects a match; the stored strings keep their case.
            await setWhitelistedSites(browser, ['Example.COM', 'TEST.org'])

            const retrieved = await getWhitelistedSites(browser)

            // Storage stores as entered, but matching is case-insensitive
            assert.ok(retrieved.length === 2, 'Should store both domains')

            await setWhitelistedSites(browser, [])
        })

        // '*.co.uk' passes parseSiteRule (host 'co.uk' after the wildcard is stripped, one
        // dot is enough) and would match every .co.uk site: there is no public-suffix check,
        // which is a trap for users, not a bug this suite guards.
        it('should handle special characters in domain patterns', async () => {
            const specialPatterns = [
                '*.co.uk',
                'example.com',
                'test-site.org'
            ]

            await setWhitelistedSites(browser, specialPatterns)
            const retrieved = await getWhitelistedSites(browser)

            assert.deepStrictEqual(retrieved, specialPatterns, 'Special characters should be preserved')

            await setWhitelistedSites(browser, [])
        })

        it('should clear site rules correctly', async () => {
            // Add sites
            await setWhitelistedSites(browser, ['example.com'])
            await setBlacklistedSites(browser, ['spam.com'])

            // Verify added
            let whitelist = await getWhitelistedSites(browser)
            let blacklist = await getBlacklistedSites(browser)
            assert.ok(whitelist.length > 0, 'Whitelist should have items')
            assert.ok(blacklist.length > 0, 'Blacklist should have items')

            // Clear
            await setWhitelistedSites(browser, [])
            await setBlacklistedSites(browser, [])

            // Verify cleared
            whitelist = await getWhitelistedSites(browser)
            blacklist = await getBlacklistedSites(browser)
            assert.strictEqual(whitelist.length, 0, 'Whitelist should be empty')
            assert.strictEqual(blacklist.length, 0, 'Blacklist should be empty')
        })
    })

    describe('Popup Interaction with Site Rules', () => {
        it('should not blur whitelisted site when popup toggle is used', async () => {
            await loadTestPage(page, 'basic-images.html')

            // Set up phobia words
            await setPhobiaWords(browser, ['spider'])
            await wait(1000)

            // Open popup and toggle settings
            const popupPage = await openExtensionPopup(browser, page)
            await wait(500)

            // Simulate toggle in popup by changing storage
            // This is faithful: the popup's own switch writes blurIsAlwaysOn to storage and
            // the content script reacts to storage.onChanged, so the popup page being open
            // adds nothing to the mechanism.
            await setBlurAlwaysOn(browser, true)
            await wait(500)

            // On whitelisted site, this should not trigger blur
            // On normal site, this would blur everything

            await popupPage.close()
            await setBlurAlwaysOn(browser, false)
        })

        it('should maintain blur on blacklisted site when popup is closed', async () => {
            await loadTestPage(page, 'basic-images.html')

            const popupPage = await openExtensionPopup(browser, page)
            await wait(500)

            let blurredBefore = await countBlurredImages(page)

            // Close popup
            await popupPage.close()
            await wait(300)

            let blurredAfter = await countBlurredImages(page)

            // On blacklisted sites, blur should be maintained
            // This test verifies popup doesn't interfere with blacklist

            // Vacuous: the count is never negative and blurredBefore is not compared. The
            // popup never sends a command on close, so there is no mechanism to interfere.
            assert.ok(blurredAfter >= 0, 'Blur state should be consistent')
        })
    })
})
