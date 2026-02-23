const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const {
    launchBrowserWithExtension,
    getTestPageUrl,
    loadTestPage,
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
    })

    after(async () => {
        if (browser) {
            await browser.close()
        }
    })

    it('should detect singular form when plural is configured', async () => {
        // Configure with plural form
        await setPhobiaWords(browser, ['spiders'])

        // Create test page with singular form
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>This page has a spider on it.</p>
                <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect singular "spider" when "spiders" is configured')
    })

    it('should detect plural form when singular is configured', async () => {
        // Configure with singular form
        await setPhobiaWords(browser, ['spider'])

        // Create test page with plural form
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>This page has many spiders on it.</p>
                <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect plural "spiders" when "spider" is configured')
    })

    it('should detect verb forms', async () => {
        // Configure with base verb form
        await setPhobiaWords(browser, ['crawl'])

        // Create test page with verb variation
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>The creature is crawling on the wall.</p>
                <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect verb form "crawling" when "crawl" is configured')
    })

    it('should handle irregular plurals (mouse/mice)', async () => {
        // Configure with singular form
        await setPhobiaWords(browser, ['mouse'])

        // Create test page with irregular plural
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>There are mice in the house.</p>
                <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect irregular plural "mice" when "mouse" is configured')
    })

    it('should be case insensitive', async () => {
        await setPhobiaWords(browser, ['snake'])

        // Create test page with uppercase text
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>SNAKE WARNING: There are SNAKES in this area.</p>
                <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect phobia words regardless of case')
    })

    it('should not trigger on partial word matches', async () => {
        await setPhobiaWords(browser, ['cat'])

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
        await new Promise(r => setTimeout(r, 3000)) // Wait for unveil timer

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.strictEqual(isBlurred, false, 'Should not trigger on partial word matches like "education"')
    })

    it('should detect words in page title', async () => {
        await setPhobiaWords(browser, ['horror'])

        // Navigate to page with phobia word in title
        const testHtml = `
            <!DOCTYPE html>
            <html>
                <head><title>Horror Movie Review</title></head>
                <body>
                    <p>This is a movie review page.</p>
                    <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
                </body>
            </html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect phobia words in page title')
    })

    it('should handle multiple phobia words', async () => {
        await setPhobiaWords(browser, ['spider', 'snake', 'clown'])

        // Create test page with one of the words
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>Watch out for the clown in this video.</p>
                <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect any of the configured phobia words')
    })

    it('should handle possessive forms', async () => {
        await setPhobiaWords(browser, ['spider'])

        // Create test page with possessive form
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>The spider's web is intricate and beautiful.</p>
                <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect possessive forms like "spider\'s"')
    })

    it('should filter out stop words', async () => {
        await setPhobiaWords(browser, ['the', 'and', 'is'])

        // Create test page with only stop words
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>The document is about mountains and rivers.</p>
                <img id="test-img" src="https://via.placeholder.com/300x200" alt="Test">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000)) // Wait for unveil timer

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.strictEqual(isBlurred, false, 'Should not trigger on stop words')
    })

    it('should handle empty phobia word list', async () => {
        await setPhobiaWords(browser, [])

        // Navigate to test page
        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000)) // Wait for unveil timer

        // Check that no images are blurred
        const blurredCount = await page.evaluate(() => {
            const images = document.querySelectorAll('img')
            let count = 0
            images.forEach(img => {
                const filter = window.getComputedStyle(img).filter
                if (filter && filter.includes('blur')) count++
            })
            return count
        })

        assert.strictEqual(blurredCount, 0, 'No images should be blurred with empty phobia word list')
    })

    it('should handle special characters in text', async () => {
        await setPhobiaWords(browser, ['spider'])

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
