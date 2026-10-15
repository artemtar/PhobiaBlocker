const assert = require('node:assert/strict')
const test = require('node:test')
const { createContentHarness } = require('./helpers/content-harness')

// Site rules match origin and path only and a fragment change never replaces
// the document, so hashchange, scrollspy and #! routers must not pulse every
// cleared element back to blur or repeat an analysis of unchanged text.

const clean = { shouldBlur: false, matchedWords: [], matchedInputWords: [] }
const ANALYSIS_DEBOUNCE_MS = 200

// Reaches a committed clear verdict through the real settings read rather than
// hand-built state; see the deferral note below for why the timer runs once.
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
    // hashchange runs applyCurrentUrlPolicy, which compares fragment-stripped URLs.
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
    // The mutation handler's URL branch uses the same fragment-stripped comparison.
    env.dispatchMutations([{ type: 'attributes', target: image, attributeName: 'alt', oldValue: null }])

    // Assert
    assert.equal(image.style.getPropertyValue('filter'), 'none')
    await env.settle()
    await env.runTimers(ANALYSIS_DEBOUNCE_MS)
    assert.equal(image.style.getPropertyValue('filter'), 'none')
    assert.equal(analyses.length, analysesBefore)
})

// The clearance record compares URLs without their fragment. Any new vocabulary
// drops the clearance outright (only the offscreen analyser can recognise an
// inflected trigger), so the comparison cannot be observed through media state
// on a page that is being re-analysed; it is checked directly here instead.
test('a clearance is recorded without the fragment and survives a fragment change only', async () => {
    // Arrange
    const { env, image } = await clearedPage()
    const node = env.controller._registry.get(image)
    assert.ok(node, 'the cleared image must be a registered visual')
    assert.equal(env.controller._clearedUrl, 'https://example.com/safe')

    // Act: scrollspy updates the hash.
    env.context.location.href = 'https://example.com/safe#more'
    env.window.dispatchEvent({ type: 'hashchange' })

    // Assert: the clearance belongs to the same document.
    assert.notEqual(env.context.location.href, env.controller._clearedUrl, 'the stored URL must not carry the fragment')
    assert.equal(env.controller._canRetainClearance(node), true, 'a fragment change must not void the clearance')

    // Act: the router moves to another path without reloading.
    env.context.location.href = 'https://example.com/other'

    // Assert: the clearance does not follow the page to a different document.
    assert.equal(env.controller._canRetainClearance(node), false, 'a path change must void the clearance')
})

test('a path change still re-applies protection and re-analyses the new document', async () => {
    // Arrange
    const { env, image, analyses, analysesBefore } = await clearedPage()

    // Act: pushState to a different route.
    env.context.location.href = 'https://example.com/other'
    // popstate is the direct listener; pushState itself reaches the content script
    // through the worker's PB_URL_CHANGED relay, which runs the same policy check.
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
