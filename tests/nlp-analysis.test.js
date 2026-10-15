// Historical Puppeteer suite, not a release gate (tests/README.md). Exercises the
// offscreen analyser end to end: compromise.js expands each target into its
// plural, singular and verb forms, page tokens are lower-cased letter runs
// (WORD_RE) of at least three letters, and the verdict is page-wide.
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
        // 3 predates the 0-100 slider: computeBlurPixels(3) is about 0.15px, which
        // isElementBlurred still counts as blurred (> 0).
        await setExtensionEnabled(browser, true)
        await setBlurAmount(browser, 3)

        // Set phobia words once for most tests
        // Every positive case below must pass with this whole list, and the negative
        // case relies on none of the six matching its page; a word added here can
        // silently turn the partial-match page into a blur verdict.
        await setPhobiaWords(browser, ['spider', 'crawl', 'mouse', 'snake', 'clown', 'cat'])
    })

    after(async () => {
        if (browser) {
            await browser.close()
        }
    })

    // Blur assertions here are weak evidence on their own: media start blurred by
    // the stylesheet, so they also pass if analysis never finishes. They prove
    // matching only together with the negative case below, which shows a clear
    // verdict is committed within the same wait when nothing matches.
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
        // "mice" is not derivable by suffix rules; it depends on compromise's
        // irregular-noun table, so this is the case a lighter tokenizer would miss.
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
        // Handled by tokenization, not NLP: the apostrophe is not a letter, so
        // WORD_RE splits "spider's" into "spider" and "s", and the one-letter
        // fragment is dropped by the three-letter minimum.
        await loadTestPage(page, 'nlp-possessive-test.html')
        await page.waitForSelector('#possessive-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        isBlurred = await isElementBlurred(page, '#possessive-test')
        assert.ok(isBlurred, 'Should detect possessive forms like "spider\'s"')

        // Test detection in page title
        // <title> has no layout box and would fail the index's visibility test, so
        // PageTextIndex tokenizes document.title separately ("Clown Performance
        // Tonight" carries the only trigger on this page).
        await loadTestPage(page, 'nlp-title-test.html')
        await page.waitForSelector('#title-test', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        isBlurred = await isElementBlurred(page, '#title-test')
        assert.ok(isBlurred, 'Should detect phobia words in page title')

        // The verdict is page-wide: a section with no trigger text of its own is
        // blurred because the title matched, not because of anything near it.
        const isSiblingScopeBlurred = await isElementBlurred(page, '#title-test-secondary')
        assert.ok(isSiblingScopeBlurred, 'Page title matches should apply across sibling scopes')
    })

    it('should not trigger on partial word matches', async () => {
        // Using phobia word 'cat' set in before()

        // Load test page with words containing "cat" but not the word "cat"
        await loadTestPage(page, 'nlp-partial-match-test.html')
        await page.waitForSelector('#test-img', { timeout: 5000 })

        // FLASH PREVENTION: Image starts blurred, wait for analysis + the deferred
        // clear verdict ("unveil timer" is this suite's old name for it: a clear
        // verdict is re-analysed up to MAX_DEFERRED_CLEAR_VERDICTS times while the
        // page still produces text, and only the committed one writes filter: none).
        // "education" and "catalogue" contain "cat" but are whole tokens of their own;
        // a substring match anywhere in the pipeline would turn this page into a blur.
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
        // "Spider!!!" and "spider..." tokenize to "spider" because punctuation is not
        // a letter; WORD_RE keeps only letters and internal hyphens.
        await loadTestPage(page, 'nlp-special-chars-test.html')
        await page.waitForSelector('#test-img', { timeout: 5000 })
        await new Promise(r => setTimeout(r, 3000))

        const isBlurred = await isElementBlurred(page, '#test-img')
        assert.ok(isBlurred, 'Should detect words even with special characters around them')
    })
})
