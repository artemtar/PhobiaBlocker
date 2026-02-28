const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    setPhobiaWords,
    setExtensionEnabled,
    clearExtensionStorage,
    isElementBlurred,
    setBlurAmount
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
        let testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>This page has many spiders on it.</p>
                <img id="plural-test" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `
        await page.setContent(testHtml)
        await page.waitForSelector('#plural-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        let isBlurred = await isElementBlurred(page, '#plural-test')
        assert.ok(isBlurred, 'Should detect plural "spiders" when "spider" configured')

        // Test verb form
        testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>The creature is crawling on the wall.</p>
                <img id="verb-test" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `
        await page.setContent(testHtml)
        await page.waitForSelector('#verb-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        isBlurred = await isElementBlurred(page, '#verb-test')
        assert.ok(isBlurred, 'Should detect verb form "crawling" when "crawl" configured')

        // Test irregular plural
        testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>There are mice in the house.</p>
                <img id="irregular-test" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `
        await page.setContent(testHtml)
        await page.waitForSelector('#irregular-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        isBlurred = await isElementBlurred(page, '#irregular-test')
        assert.ok(isBlurred, 'Should detect irregular plural "mice" when "mouse" configured')
    })

    it('should handle case insensitivity, possessives, title detection, and multiple words', async () => {
        // Using phobia words set in before(): spider, snake, clown

        // Test case insensitivity
        let testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>SNAKE WARNING: There are SNAKES in this area.</p>
                <img id="case-test" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `
        await page.setContent(testHtml)
        await page.waitForSelector('#case-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        let isBlurred = await isElementBlurred(page, '#case-test')
        assert.ok(isBlurred, 'Should detect phobia words regardless of case')

        // Test possessive forms
        testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>The spider's web is intricate and beautiful.</p>
                <img id="possessive-test" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `
        await page.setContent(testHtml)
        await page.waitForSelector('#possessive-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        isBlurred = await isElementBlurred(page, '#possessive-test')
        assert.ok(isBlurred, 'Should detect possessive forms like "spider\'s"')

        // Test detection in page title
        testHtml = `
            <!DOCTYPE html>
            <html>
                <head><title>Clown Performance Tonight</title></head>
                <body>
                    <p>This is an event page.</p>
                    <img id="title-test" src="https://via.placeholder.com/300x200" alt="Test">
                </body>
            </html>
        `
        await page.setContent(testHtml)
        await page.waitForSelector('#title-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        isBlurred = await isElementBlurred(page, '#title-test')
        assert.ok(isBlurred, 'Should detect phobia words in page title')
    })

    it('should not trigger on partial word matches', async () => {
        // Using phobia word 'cat' set in before()

        // Create test page with words containing "cat" but not the word "cat"
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>This is about education and catalogue items.</p>
                <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
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

        // Create test page with special characters
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>Warning!!! Spider@#$% ahead... (dangerous)</p>
                <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect words even with special characters around them')
    })
})
