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
    getAllVisualElements,
    setBlurAmount
} = require('./test-utils')

describe('PhobiaBlocker - Visual Content Types', () => {
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

    it('should blur regular img elements', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('#spider-image', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#spider-image')
        assert.ok(isBlurred, 'Regular img elements should be blurred')
    })

    it('should blur background images', async () => {
        await setPhobiaWords(browser, ['snake'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('#bg-image-snake', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#bg-image-snake')
        assert.ok(isBlurred, 'Elements with background images should be blurred')
    })

    it('should blur video elements', async () => {
        await setPhobiaWords(browser, ['spider', 'spiders'])

        await loadTestPage(page, 'video-iframe.html')
        await page.waitForSelector('#spider-video', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#spider-video')
        assert.ok(isBlurred, 'Video elements should be blurred')
    })

    it('should blur iframe elements', async () => {
        await setPhobiaWords(browser, ['embedded'])

        // Create test page with iframe and matching text
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>This is an embedded video about nature.</p>
                <iframe id="test-iframe" width="400" height="300" src="about:blank"></iframe>
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#test-iframe', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#test-iframe')
        assert.ok(isBlurred, 'Iframe elements should be blurred')
    })

    it('should handle GIF images', async () => {
        await setPhobiaWords(browser, ['animated'])

        // Create test page with GIF
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>This is an animated GIF image.</p>
                <img id="gif-img" src="https://via.placeholder.com/300x200.gif" alt="Animated GIF">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#gif-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#gif-img')
        assert.ok(isBlurred, 'GIF images should be blurred')
    })

    it('should handle multiple images on the same page', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        const elements = await getAllVisualElements(page)
        const spiderImage = elements.find(el => el.id === 'spider-image')
        const safeImage = elements.find(el => el.id === 'safe-image')

        assert.ok(spiderImage && spiderImage.isBlurred, 'Spider image should be blurred')
        assert.ok(safeImage && !safeImage.isBlurred, 'Safe image should not be blurred')
    })

    it('should detect and blur dynamically added images', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'dynamic-content.html')
        await page.waitForSelector('#add-spider-content', { timeout: 5000 })

        // Click button to add spider content
        await page.click('#add-spider-content')
        await new Promise(r => setTimeout(r, 2000)) // Wait for MutationObserver and processing

        // Check if dynamically added image is blurred
        const isBlurred = await page.evaluate(() => {
            const dynamicImg = document.querySelector('.dynamic-spider')
            if (!dynamicImg) return false

            const filter = window.getComputedStyle(dynamicImg).filter
            return filter && filter.includes('blur')
        })

        assert.ok(isBlurred, 'Dynamically added images with phobia words should be blurred')
    })

    it('should not blur dynamically added safe images', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'dynamic-content.html')
        await page.waitForSelector('#add-safe-content', { timeout: 5000 })

        // Click button to add safe content
        await page.click('#add-safe-content')
        await new Promise(r => setTimeout(r, 3000)) // Wait for MutationObserver, processing, and unveil timer

        // Check if dynamically added image is not blurred
        const isBlurred = await page.evaluate(() => {
            const dynamicImg = document.querySelector('.dynamic-safe')
            if (!dynamicImg) return false

            const filter = window.getComputedStyle(dynamicImg).filter
            return filter && filter.includes('blur')
        })

        assert.strictEqual(isBlurred, false, 'Dynamically added images without phobia words should not be blurred')
    })

    it('should handle images without alt text', async () => {
        await setPhobiaWords(browser, ['test'])

        // Create test page with image without alt text
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>This is a test page.</p>
                <img id="no-alt-img" src="https://via.placeholder.com/300x200">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#no-alt-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#no-alt-img')
        assert.ok(isBlurred, 'Images without alt text should still be processed and blurred')
    })

    it('should handle images with empty src', async () => {
        await setPhobiaWords(browser, ['spider'])

        // Create test page with image with empty src
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>This is about spiders.</p>
                <img id="empty-src-img" src="" alt="Empty">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#empty-src-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        // Should still blur even with empty src
        const isBlurred = await isElementBlurred(page, '#empty-src-img')
        assert.ok(isBlurred, 'Images with empty src should still be blurred if phobia words are detected')
    })

    it('should handle nested elements with background images', async () => {
        await setPhobiaWords(browser, ['nested'])

        // Create test page with nested elements with background images
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <div class="container">
                    <p>This is a nested background image.</p>
                    <div id="nested-bg" style="width: 300px; height: 200px; background-image: url('https://via.placeholder.com/300x200'); background-size: cover;">
                        <div>Content</div>
                    </div>
                </div>
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#nested-bg', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#nested-bg')
        assert.ok(isBlurred, 'Nested elements with background images should be blurred')
    })

    it('should handle SVG images', async () => {
        await setPhobiaWords(browser, ['vector'])

        // Create test page with SVG
        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>This is a vector graphic image.</p>
                <img id="svg-img" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Ccircle cx='50' cy='50' r='40' fill='red'/%3E%3C/svg%3E" alt="SVG">
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('#svg-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const isBlurred = await isElementBlurred(page, '#svg-img')
        assert.ok(isBlurred, 'SVG images should be blurred')
    })

    it('should count all visual element types correctly', async () => {
        await setPhobiaWords(browser, ['spider'])

        await loadTestPage(page, 'simple-image.html')
        await page.waitForSelector('img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 2000))

        const elements = await getAllVisualElements(page)

        // Should find img elements
        const imgElements = elements.filter(el => el.type === 'img')
        assert.ok(imgElements.length > 0, 'Should detect img elements')

        // Should find background image elements
        const bgElements = elements.filter(el => el.type === 'background')
        assert.ok(bgElements.length > 0, 'Should detect background image elements')
    })

    it('should handle pages with many images efficiently', async () => {
        await setPhobiaWords(browser, ['test'])

        // Create test page with many images
        const images = Array(20).fill(0).map((_, i) =>
            `<img id="img-${i}" src="https://via.placeholder.com/100x100?text=Image${i}" alt="Image ${i}">`
        ).join('\n')

        const testHtml = `
            <!DOCTYPE html>
            <html><body>
                <p>This is a test page with many images.</p>
                ${images}
            </body></html>
        `

        await page.setContent(testHtml)
        await page.waitForSelector('img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        const elements = await getAllVisualElements(page)
        const blurredCount = elements.filter(el => el.isBlurred).length

        assert.ok(blurredCount === 20, `All 20 images should be blurred, but ${blurredCount} were blurred`)
    })
})
