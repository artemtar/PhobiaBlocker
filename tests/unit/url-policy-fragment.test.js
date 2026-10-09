const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

// Site rules match origin and path only and a fragment change never replaces
// the document, so hashchange, scrollspy and #! routers must not pulse every
// cleared element back to blur or repeat an analysis of unchanged text.

const clean = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
const ANALYSIS_DEBOUNCE_MS = 200

async function clearedPage() {
    const env = createContentHarness()
    env.document.readyState = 'complete'
    const image = env.image()
    image.setAttribute('src', 'safe.jpg')
    env.text('a quiet garden')
    const analyses = []
    env.context.chrome.runtime.sendMessage = async (message) => {
        if (message.type === 'PB_ANALYZE_WORDS') analyses.push([...message.words])
        return clean
    }
    env.storage.getWithDefaults = async () => ({ ...env.Policy.DEFAULTS, wordCoverEnabled: false })
    await env.readAndApplySettings()
    // The first clear verdict is deferred once while the word count settles.
    await env.runTimers(ANALYSIS_DEBOUNCE_MS)
    assert.equal(image.style.getPropertyValue('filter'), 'none', 'fixture must start from a cleared page')
    return { env, image, analyses, analysesBefore: analyses.length }
}

test('a fragment change on a cleared page neither re-blurs media nor re-analyses', async () => {
    // Arrange
    const { env, image, analyses, analysesBefore } = await clearedPage()

    // Act: scrollspy updates the hash.
    env.context.location.href = 'https://example.com/safe#section-2'
    env.window.dispatchEvent({ type: 'hashchange' })

    // Assert: no blur pulse, no repeated analysis.
    assert.equal(image.style.getPropertyValue('filter'), 'none', 'a hash change must not blur cleared media')
    await env.settle()
    await env.runTimers(ANALYSIS_DEBOUNCE_MS)
    assert.equal(image.style.getPropertyValue('filter'), 'none')
    assert.equal(analyses.length, analysesBefore, 'a hash change must not re-analyse unchanged text')
})

test('a DOM mutation after a fragment change does not re-apply protection', async () => {
    // Arrange
    const { env, image, analyses, analysesBefore } = await clearedPage()
    env.context.location.href = 'https://example.com/safe#section-3'

    // Act: an unrelated attribute change is observed with the new hash.
    image.setAttribute('alt', 'garden')
    env.dispatchMutations([{ type: 'attributes', target: image, attributeName: 'alt', oldValue: null }])

    // Assert
    assert.equal(image.style.getPropertyValue('filter'), 'none')
    await env.settle()
    await env.runTimers(ANALYSIS_DEBOUNCE_MS)
    assert.equal(image.style.getPropertyValue('filter'), 'none')
    assert.equal(analyses.length, analysesBefore)
})

test('cleared media keep their clearance across a fragment change while new text is analysed', async () => {
    // Arrange
    const { env, image } = await clearedPage()
    env.context.location.href = 'https://example.com/safe#more'
    env.window.dispatchEvent({ type: 'hashchange' })

    // Act: the page appends text, which starts a new analysis.
    const text = env.text('another tree')
    env.dispatchMutations([{ type: 'childList', target: env.body, addedNodes: [text], removedNodes: [] }])

    // Assert: media cleared on this document stay clear during the re-check.
    assert.equal(image.style.getPropertyValue('filter'), 'none')
})

test('a path change still re-applies protection and re-analyses the new document', async () => {
    // Arrange
    const { env, image, analyses, analysesBefore } = await clearedPage()

    // Act: pushState to a different route.
    env.context.location.href = 'https://example.com/other'
    env.window.dispatchEvent({ type: 'popstate' })

    // Assert: fail-closed first, then a fresh analysis.
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
    await env.settle()
    assert.equal(analyses.length, analysesBefore + 1)
})

test('a path change with an unchanged mode is also re-applied from a mutation', async () => {
    // Arrange
    const { env, image, analyses, analysesBefore } = await clearedPage()
    env.context.location.href = 'https://example.com/other#top'

    // Act
    image.setAttribute('alt', 'garden')
    env.dispatchMutations([{ type: 'attributes', target: image, attributeName: 'alt', oldValue: null }])

    // Assert
    assert.match(image.style.getPropertyValue('filter'), /^blur\(/)
    await env.settle()
    assert.equal(analyses.length, analysesBefore + 1)
})
