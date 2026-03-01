const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    setPhobiaWords,
    setExtensionEnabled,
    clearExtensionStorage,
    isElementBlurred,
    setBlurAmount,
    loadTestPage
} = require('./test-utils')

describe('PhobiaBlocker - NLP Text Analysis', () => {
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

        // Set phobia words once for most tests
        await setPhobiaWords(browser, ['spider', 'crawl', 'mouse', 'snake', 'clown', 'cat'])
    })

    after(async () => {
        if (browser) {
            await browser.close()
        }
    })

    it('should handle word variations (plurals, verbs, irregular plurals)', async () => {
        // Using phobia words set in before(): spider, crawl, mouse

        // Test singular when plural configured
        await loadTestPage(page, 'nlp-plural-test.html')
        await page.waitForSelector('#plural-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        let isBlurred = await isElementBlurred(page, '#plural-test')
        assert.ok(isBlurred, 'Should detect plural "spiders" when "spider" configured')

        // Test verb form
        await loadTestPage(page, 'nlp-verb-test.html')
        await page.waitForSelector('#verb-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        isBlurred = await isElementBlurred(page, '#verb-test')
        assert.ok(isBlurred, 'Should detect verb form "crawling" when "crawl" configured')

        // Test irregular plural
        await loadTestPage(page, 'nlp-irregular-plural-test.html')
        await page.waitForSelector('#irregular-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        isBlurred = await isElementBlurred(page, '#irregular-test')
        assert.ok(isBlurred, 'Should detect irregular plural "mice" when "mouse" configured')
    })

    it('should handle case insensitivity, possessives, title detection, and multiple words', async () => {
        // Using phobia words set in before(): spider, snake, clown

        // Test case insensitivity
        await loadTestPage(page, 'nlp-case-test.html')
        await page.waitForSelector('#case-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        let isBlurred = await isElementBlurred(page, '#case-test')
        assert.ok(isBlurred, 'Should detect phobia words regardless of case')

        // Test possessive forms
        await loadTestPage(page, 'nlp-possessive-test.html')
        await page.waitForSelector('#possessive-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        isBlurred = await isElementBlurred(page, '#possessive-test')
        assert.ok(isBlurred, 'Should detect possessive forms like "spider\'s"')

        // Test detection in page title
        await loadTestPage(page, 'nlp-title-test.html')
        await page.waitForSelector('#title-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        isBlurred = await isElementBlurred(page, '#title-test')
        assert.ok(isBlurred, 'Should detect phobia words in page title')
    })

    it('should not trigger on partial word matches', async () => {
        // Using phobia word 'cat' set in before()

        // Load test page with words containing "cat" but not the word "cat"
        await loadTestPage(page, 'nlp-partial-match-test.html')
        await page.waitForSelector('#test-img', { timeout: 5000 })

        // FLASH PREVENTION: Image starts blurred, wait for analysis + unveil timer
        await new Promise(r => setTimeout(r, 3500)) // Wait for analysis and unveil timer

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.strictEqual(isBlurred, false, 'Should not trigger on partial word matches like "education"')
    })

    // Note: Tests for stop words filtering and empty phobia word lists
    // are covered in integration testing. These edge cases require
    // different storage configurations which cause service worker
    // availability issues in long-running test suites.

    it('should handle special characters in text', async () => {
        // Using phobia word 'spider' set in before()

        // Load test page with special characters
        await loadTestPage(page, 'nlp-special-chars-test.html')
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect words even with special characters around them')
    })
})
